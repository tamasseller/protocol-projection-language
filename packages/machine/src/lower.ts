/**
 * @ppl/machine — Statement lowering pass
 *
 * Converts a parsed AST fragment (Statement[]) into a ResolvedProc with
 * numerical register indices and flattened control flow.
 *
 * Pipeline:
 *   1. Walk declarations to allocate registers (name → index).
 *   2. Walk statements, emitting RtlInstr[] with control flow.
 *   3. Expression sub-trees lowered via lowerExpr + register resolution.
 *
 * `lowerProc` handles one standalone body; `lowerProgram` handles a
 * `Procedure` plus everything it transitively calls, resolving each `CALL`
 * to a procedure-table index on the fly as that callee is first discovered
 * (ROADMAP.md item 2).
 */

import {lowerExpr, lowerStatementExpr} from "./orchestrator"
import type {EastExpression} from "./east"
import type {
    Statement, ControlBody, IfStatement, WhileStatement,
    ForStatement, SwitchStatement, VariableDeclaration, ReturnStatement,
    ExpressionStatement, Expression, ConditionalExpression, Identifier,
} from "./ast"
import {recurseOver, mapOver} from "./ast"
import {RtlProc, RtlProgram, RtlInstr, bare, brTable, CONST, PUSH, STORE} from "./rtl"
import type {ExtOpPayload} from "./rtl"
import type {Procedure} from "./ir"
import assert from "assert"
import {Rule, ruleset} from "./rules"
import {annotate, annotateInto, typeOfExpr} from "./types"
import type {TypeEnv} from "./types"
import type {PrimType} from "./ast"
import type {Extension} from "./extension"

// ─────────────────────────────────────────────────────────────────────────────
// Register allocator
// ─────────────────────────────────────────────────────────────────────────────

class RegAlloc<E extends { ext: string } = ExtOpPayload> implements TypeEnv
{
    private map = new Map<string, number>()
    private types = new Map<string, PrimType>()
    private next: number

    /**
     * A nested scope's numbering continues from its parent's current count
     * rather than restarting at 0. This matters because the ISA resets TOS
     * to a block's entry depth at its `BLOCK_END` (isa-core.md §15.1): once
     * this scope's own block closes, its locals are gone and the parent
     * resumes allocating from exactly where it left off. If a child instead
     * renumbered from 0, its locals would alias whatever the parent (or an
     * argument) already put at those low indices.
     */
    constructor(
        private _parent?: RegAlloc<E>,
        private _resolveCallee?: (name: string) => number | undefined,
        private _extension?: Extension<E>,
        base?: number,
    )
    {
        this.next = base ?? _parent?.next ?? 0
    }

    /** How far TOS has grown by the time this scope's next allocation
     *  lands — the index that allocation will get. */
    get depth(): number {return this.next}

    get parent(): RegAlloc<E> | undefined {return this._parent}

    /** A nested scope (`new RegAlloc(alloc)`, no second argument) has no
     *  callee resolver of its own — it inherits the enclosing procedure's,
     *  the same way it inherits register numbering via `parent`. Returning
     *  `undefined` (rather than throwing) for a name it can't place is
     *  deliberate: `callRule` (rules.ts) treats that as "not a viable
     *  candidate here," which is what lets a builtin call (`clz`, `trap`,
     *  `revbits`) fall through to its own dedicated rule instead of every
     *  call site hard-failing on names that were never meant to resolve
     *  against a procedure table. */
    get resolveCallee(): (name: string) => number | undefined
    {
        return this._resolveCallee
            ?? this._parent?.resolveCallee
            ?? (() => undefined)
    }

    /** A nested scope has no `Extension` of its own — it inherits the
     *  enclosing procedure's, same as `resolveCallee`. */
    get extension(): Extension<E> | undefined
    {
        return this._extension ?? this._parent?.extension
    }

    /** Allocate a named variable, returning its index. Idempotent. */
    alloc(name: string, varType: PrimType = "u32"): number
    {
        let idx = this.map.get(name)
        if(idx === undefined)
        {
            idx = this.next++
            this.map.set(name, idx)
        }
        this.types.set(name, varType)
        return idx
    }

    /** The declared type of `name`, through enclosing scopes the way
     *  `resolve` goes. Undefined for a procedure argument, which is a plain
     *  word — types.ts supplies that default. */
    typeOf(name: string): PrimType | undefined
    {
        return this.types.get(name) ?? this._parent?.typeOf(name)
    }

    /** Map a string register name to its allocated index. */
    resolve(name: string): number | undefined
    {
        const own = this.map.get(name)
        if(own !== undefined) return own
        return this._parent?.resolve(name)
    }

    rules(): Rule<E>[]
    {
        return ruleset<E>(
            name => this.resolve(name) ?? (() => {throw new Error(`Unresolved variable: ${name}`)})(),
            this.resolveCallee,
            this.extension,
        )
    }
}

/** Lower a single, standalone procedure body — the common case for tests
 *  and fragments that don't call another procedure. There is no procedure
 *  table here, so any non-builtin call inside `stmts` fails to lower (no
 *  rule can produce a candidate for it); use {@link lowerProgram} for a
 *  fragment that references another `Procedure`. */
export function lowerProc<E extends { ext: string } = ExtOpPayload>(stmts: readonly Statement[], args: string[] = [], extension?: Extension<E>): RtlProc<E>
{
    const alloc = new RegAlloc<E>(undefined, () => undefined, extension)

    for(const arg of args) alloc.alloc(arg)

    return { argCount: args.length, body: lowerBlock(stmts, alloc) }
}

/**
 * Lower `entry` and every `Procedure` it transitively calls (via each
 * fragment's `calls` map) into one `RtlProgram`, discovering callees on
 * demand: the first time a `CALL` to a not-yet-seen `Procedure` is hit
 * during lowering, that procedure is assigned the next free table index
 * and its body is lowered right there, recursively — one pass, no
 * separate name-resolution step afterward. `entry` always lands at index
 * 0. The index is reserved *before* recursing into the callee's own body
 * (not after it returns) so that a self- or mutually-recursive reference
 * resolves to the reserved index instead of re-entering — isa-core.md
 * §8.2 forbids recursion outright, but that's enforced by the (not yet
 * built) whole-program validator, not this pass; this pass only needs to
 * not hang on such input.
 */
export function lowerProgram<E extends { ext: string } = ExtOpPayload>(entry: Procedure, extension?: Extension<E>): RtlProgram<E>
{
    const procedures: RtlProc<E>[] = []
    const indexOf = new Map<symbol, number>()

    function resolve(target: Procedure): number
    {
        const cached = indexOf.get(target.id)
        if(cached !== undefined) return cached

        const index = procedures.length
        indexOf.set(target.id, index)
        procedures.push(undefined as unknown as RtlProc<E>) // reserved — filled in below

        // A name absent from this fragment's own `calls` map isn't
        // necessarily an error — it may be a builtin (`clz`/`trap`/
        // `revbits`) or an extension call, which this pass knows nothing
        // about; returning `undefined` lets that call site's own rule win
        // instead (see RegAlloc.resolveCallee's doc comment).
        const alloc = new RegAlloc<E>(undefined, name =>
        {
            const callee = target.fragment.calls.get(name)
            return callee && resolve(callee)
        }, extension)
        for(const arg of target.args) alloc.alloc(arg)

        procedures[index] = { argCount: target.args.length, body: lowerBlock(target.fragment.body, alloc), header: target.header }
        return index
    }

    resolve(entry)
    return { procedures }
}

function lowerBlock<E extends { ext: string } = ExtOpPayload>(stmts: readonly Statement[], alloc: RegAlloc<E>): RtlInstr<E>[]
{
    const ret: RtlInstr<E>[] = []

    for(const s of stmts)
        ret.push(...lowerStmt(s, alloc))

    return ret
}

function lowerStmt<E extends { ext: string } = ExtOpPayload>(stmt: Statement, alloc: RegAlloc<E>): RtlInstr<E>[]
{
    switch(stmt.type)
    {
        case "ExpressionStatement": return lowerExprStmt(stmt, alloc)
        case "VariableDeclaration": return lowerVarDecl(stmt, alloc)
        case "IfStatement": return lowerIf(stmt, alloc)
        case "SwitchStatement": return lowerSwitch(stmt, alloc)
        case "WhileStatement": return lowerWhile(stmt, alloc)
        case "ForStatement": return lowerFor(stmt, alloc)
        case "ReturnStatement": return lowerReturn(stmt, alloc)
        default: throw new Error(`Unsupported statement type: ${stmt}`)
    }
}

/**
 * Lower the single construct governed by if/else/while/for. `alloc` is
 * already the fresh scope the caller created for this body — a
 * `BlockStatement` here lowers its statements directly into that same
 * scope (it does not get a further nested one) because the `Block` and the
 * branch/loop it belongs to are one RTL block, not two.
 */
function lowerControlBody<E extends { ext: string } = ExtOpPayload>(body: ControlBody, alloc: RegAlloc<E>): RtlInstr<E>[]
{
    return body.type === "BlockStatement"
        ? lowerBlock(body.body, alloc)
        : lowerStmt(body, alloc)
}

function lowerExprStmt<E extends { ext: string } = ExtOpPayload>(s: ExpressionStatement, alloc: RegAlloc<E>): RtlInstr<E>[]
{
    // The statement's value is discarded, so demand "acc" specifically
    // would be needlessly strict — it would exclude a cheaper tiling whose
    // result lands directly in a register write-back (e.g. `x = x op e`,
    // rules.ts). lowerStatementExpr allows any TOS-neutral output instead.
    const h = hoistTernaries(s.expression, alloc)
    const e = lowerStatementExpr(annotate(h.expr, alloc) as EastExpression<E>, alloc.rules())
    assert.ok(e, `Failed to lower expression statement`)

    return [...h.prelude, ...e.fragment]
}

function lowerVarDecl<E extends { ext: string } = ExtOpPayload>(s: VariableDeclaration, alloc: RegAlloc<E>): RtlInstr<E>[]
{
    return s.declarations.map(d =>
    {
        const h = hoistTernaries(d.init!, alloc)
        const init = annotateInto(h.expr, alloc, d.varType)
        const node = lowerExpr(init as EastExpression<E>, alloc.rules(), "tos")
        assert.ok(node, `Failed to lower variable initializer for ${d.id.name}`)

        // A "tos"-demand tiling's cheapest winner always nets exactly one
        // push: every stack-combining rule only ever offers net-neutral
        // combos (PEEK_PEEK/POP_ACC, isa-core.md §4.1) — there is no
        // competing combo that nets positive by reading a stack operand
        // without reclaiming it (isa-rationale.md, "Every stack-read combo
        // also reclaims its operand"), so nothing can ever outbid the
        // single net push a "tos" demand needs. A different value here
        // means that invariant broke somewhere — a real lowerer bug, not a
        // shape to accommodate.
        assert.equal(node.tosDelta, 1,
            `"tos"-demand initializer for ${d.id.name} nets tosDelta=${node.tosDelta}, expected exactly 1 — ` +
            `the winning tiling should always be a single net push; this indicates a lowerer bug, not a case to handle`)
        alloc.alloc(d.id.name, d.varType)

        return [...h.prelude, ...node.fragment]
    }).flat()
}

function lowerReturn<E extends { ext: string } = ExtOpPayload>(s: ReturnStatement, alloc: RegAlloc<E>): RtlInstr<E>[]
{
    if(s.argument)
    {
        const h = hoistTernaries(s.argument, alloc)
        const node = lowerExpr(annotate(h.expr, alloc) as EastExpression<E>, alloc.rules(), "acc")
        assert.ok(node, `Failed to lower return expression`)
        return [...h.prelude, ...node.fragment, bare("RETURN")]
    }

    // A bare `return;` has no source-level value, but the bytecode-level
    // RETURN opcode always reads acc regardless (isa-core.md §8.7 requires
    // it live, and the calling convention has no void variant). Previously
    // this relied on whatever residual value happened to precede it —
    // harmless under the old permissive spec, but exactly the pattern
    // §8.7 now rejects when the preceding code was a branch's own split
    // (e.g. `if (x == 0) { return; }`'s no-else-if lowering). An explicit
    // producer makes this correct regardless of what's live going in; the
    // value itself is never observed by any caller of a void return.
    return [CONST(0), bare("RETURN")]
}

function logicInvertRoot(expr: EastExpression): EastExpression
{
    if(expr.type === "BinaryExpression")
    {
        switch(expr.operator)
        {
            case "==": return {...expr, operator: "!="}
            case "!=": return {...expr, operator: "=="}
            case "<": return {...expr, operator: ">="}
            case "<=": return {...expr, operator: ">"}
            case ">": return {...expr, operator: "<="}
            case ">=": return {...expr, operator: "<"}
        }
    }

    // Fallback for a non-comparison test (e.g. `if (x) ...`, `if (foo()) ...`):
    // invert via `expr == 0`. There is no logical-NOT opcode; comparing
    // against zero is exactly the ISA's lenient truthy test (isa-core.md
    // §3.2) run in reverse, and reuses the existing EQ rules rather than
    // needing a dedicated `!` lowering rule.
    return {
        type: "BinaryExpression", operator: "==", left: expr,
        right: {type: "Literal", value: 0, raw: "0"},
    } as EastExpression
}

// ─────────────────────────────────────────────────────────────────────────────
// Ternary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lift every `ConditionalExpression` out of `expr`, returning the branch
 * code to emit ahead of it and what is left once each one has become a
 * reference to the slot its branch wrote.
 *
 * A split clobbers acc (isa-core.md §8.7), so a value-producing branch
 * cannot hand its result over in acc: the slot is reserved *before* the
 * dispatch, since one pushed inside a case is dropped again by that case's
 * own `BLOCK_END` (§8.1). Lifting only moves evaluation across operands of
 * one expression, which C leaves unsequenced; a ternary in another's arm
 * is lifted into that arm's block instead, so it stays conditional.
 */
function hoistTernaries<E extends { ext: string } = ExtOpPayload>(expr: Expression, alloc: RegAlloc<E>): {prelude: RtlInstr<E>[]; expr: Expression}
{
    if(!hasConditional(expr)) return {prelude: [], expr}

    const prelude: RtlInstr<E>[] = []
    return {prelude, expr: hoist(expr, alloc, prelude)}
}

function hasConditional(e: Expression): boolean
{
    return e.type === "ConditionalExpression"
        || recurseOver(e, hasConditional, (...v) => v.includes(true), false)
}

function hoist<E extends { ext: string } = ExtOpPayload>(e: Expression, alloc: RegAlloc<E>, out: RtlInstr<E>[]): Expression
{
    if(!hasConditional(e)) return e

    return e.type === "ConditionalExpression"
        ? hoistConditional(e, alloc, out)
        : mapOver(e, c => hoist(c, alloc, out))
}

function hoistConditional<E extends { ext: string } = ExtOpPayload>(e: ConditionalExpression, alloc: RegAlloc<E>, out: RtlInstr<E>[]): Identifier
{
    // Complementary test, exactly as `lowerIf`: `acc = 0` selects the
    // consequent, matching §7.1's arm order, and a comparison is what makes
    // acc exactly 0 or 1 for an index-exact `BR_TABLE 2`.
    const test = lowerExpr(logicInvertRoot(annotate(hoist(e.test, alloc, out), alloc) as EastExpression) as EastExpression<E>, alloc.rules(), "acc")
    assert.ok(test, `Failed to lower ternary condition`)

    // The reserving PUSH carries the test value — arbitrary, since both
    // arms overwrite the slot, and `PUSH` leaves acc live for the dispatch.
    const name = `?${alloc.depth}`
    const slot = alloc.alloc(name, typeOfExpr(e, alloc))

    out.push(
        ...test.fragment,
        PUSH<E>(),
        brTable(2),
        ...ternaryArm(e.consequent, slot, new RegAlloc<E>(alloc)),
        ...ternaryArm(e.alternate, slot, new RegAlloc<E>(alloc)),
    )

    return {type: "Identifier", name}
}

function ternaryArm<E extends { ext: string } = ExtOpPayload>(arm: Expression, slot: number, scope: RegAlloc<E>): RtlInstr<E>[]
{
    const inner: RtlInstr<E>[] = []
    const rewritten = hoist(arm, scope, inner)

    const node = lowerExpr(annotate(rewritten, scope) as EastExpression<E>, scope.rules(), "acc")
    assert.ok(node, `Failed to lower ternary arm`)

    // A `trap(...)` arm closes its own case (isa-core.md §4.5); a
    // `STORE`/`BLOCK_END` after it would be unreachable, and the stray
    // `BLOCK_END` would be read as the *next* case's close.
    return isTrapCall(arm)
        ? [...inner, ...node.fragment]
        : [...inner, ...node.fragment, STORE<E>(slot), bare("BLOCK_END")]
}

/**
 * Does this statement list's *own* fragment already end in a terminator
 * with nothing further needing a close — i.e. is a following `BLOCK_END`
 * both unnecessary and unreachable? Only the *last* statement matters, and
 * only when it's a *direct* terminator (`return`/`trap(...)`) — not a
 * compound construct (`if`, `switch`, a loop) whose branches merely happen
 * to all terminate.
 *
 * That distinction matters: `closeBlock`'s caller is always closing *this
 * block's own slot* among an enclosing construct's siblings (an if's
 * branch, a switch case, a loop's body sub-block) — never the true
 * top-level procedure body (`lowerBlock` never calls `closeBlock`). A
 * nested `if (a) return 1; else return 2;` as the last statement closes
 * *itself* fully (both its own branches end in RETURN, 2-for-2) — but
 * that says nothing about whether *this* (outer) slot has been closed;
 * omitting this slot's own `BLOCK_END` on that reasoning desyncs the
 * sibling-counting every consumer of the flat instruction stream relies
 * on (`vm.ts`'s `skipBlocks`, and the eventual validator) — a case after
 * this one gets misidentified as more of this case's own content. Only a
 * direct `return`/`trap` *is* this slot's own close, with nothing to
 * desync.
 */
/** `trap(code);` — like `return`, a terminator (isa-core.md §4.5), but
 *  parsed as an ordinary call (§10.5: `trap` is a function, not a
 *  keyword), so there's no dedicated AST node to switch on; it's
 *  recognized structurally by callee name instead. */
function isTrapCall(expr: Expression): boolean
{
    return expr.type === "CallExpression" && expr.callee.name === "trap"
}

function alwaysTerminates(stmts: readonly Statement[]): boolean
{
    const last = stmts[stmts.length - 1]
    if(!last) return false

    switch(last.type)
    {
        case "ReturnStatement": return true
        case "ExpressionStatement": return isTrapCall(last.expression)
        default: return false
    }
}

/** Close a branch/case/loop-body fragment: omit the `BLOCK_END` only when
 *  the statements it was lowered from end *directly* in `return`/`trap`
 *  (§14.3/§14.4 of isa-core.md — a terminator closes its own block on its
 *  own, so a `BLOCK_END` right after would be unreachable, per
 *  `alwaysTerminates`'s doc comment above). */
function closeBlock<E extends { ext: string } = ExtOpPayload>(stmts: readonly Statement[], fragment: RtlInstr<E>[]): RtlInstr<E>[]
{
    return alwaysTerminates(stmts) ? fragment : [...fragment, bare("BLOCK_END")]
}

function closeControlBody<E extends { ext: string } = ExtOpPayload>(body: ControlBody, fragment: RtlInstr<E>[]): RtlInstr<E>[]
{
    return closeBlock(body.type === "BlockStatement" ? body.body : [body], fragment)
}

function lowerIf<E extends { ext: string } = ExtOpPayload>(s: IfStatement, alloc: RegAlloc<E>): RtlInstr<E>[]
{
    // BR_TABLE is index-exact (isa-core.md §4.5), not lenient like a raw
    // truthy test, so `acc` must be forced to exactly 0/1 first. Arm order
    // then matches §7.1: case[0] = then, case[1] = else.
    //
    // A scope snapshots its parent's numbering at construction, so the test
    // is lowered before either branch's: a ternary in it allocates a slot
    // one built earlier would renumber over.
    const h = hoistTernaries(s.test, alloc)
    const test = lowerExpr(logicInvertRoot(annotate(h.expr, alloc) as EastExpression) as EastExpression<E>, alloc.rules(), "acc")
    assert.ok(test, `Failed to lower if test expression`)

    const thenTerm = lowerControlBody(s.consequent, new RegAlloc<E>(alloc))
    assert.ok(thenTerm, `Failed to lower then branch`)

    if(s.alternate)
    {
        const elseTerm = lowerControlBody(s.alternate, new RegAlloc<E>(alloc))
        assert.ok(elseTerm, `Failed to lower else branch`)

        return [
            ...h.prelude,
            ...test.fragment,
            brTable(2),
            ...closeControlBody(s.consequent, thenTerm),
            ...closeControlBody(s.alternate, elseTerm),
        ]
    }

    return [
        ...h.prelude,
        ...test.fragment,
        brTable(1),
        ...closeControlBody(s.consequent, thenTerm),
    ]
}

function lowerSwitch<E extends { ext: string } = ExtOpPayload>(s: SwitchStatement, alloc: RegAlloc<E>): RtlInstr<E>[]
{
    const h = hoistTernaries(s.discriminant, alloc)
    const disc = lowerExpr(annotate(h.expr, alloc) as EastExpression<E>, alloc.rules(), "acc")
    assert.ok(disc, `Failed to lower switch discriminant expression`)

    const cases = s.cases.filter(c => c.test !== null)
    const defaultCase = s.cases.find(c => c.test === null)
    const N = cases.length

    return [
        ...h.prelude,
        ...disc.fragment,
        brTable(N),
        ...cases.flatMap(c =>
        {
            const blockTerm = lowerBlock(c.consequent, new RegAlloc<E>(alloc))
            assert.ok(blockTerm, `Failed to lower switch case`)
            return closeBlock(c.consequent, blockTerm)
        }),
        ...(defaultCase ? lowerBlock(defaultCase.consequent, new RegAlloc<E>(alloc)) : []),
    ]
}

function lowerWhile<E extends { ext: string } = ExtOpPayload>(s: WhileStatement, alloc: RegAlloc<E>): RtlInstr<E>[]
{
    // The condition sub-block is a block of its own: a ternary in the test
    // re-reserves its slot on every pass and the sub-block's `BLOCK_END`
    // drops it again (isa-core.md §8.1), so the scope holding it must be a
    // child, or the body would number its locals above a slot that is gone
    // by the time the body runs.
    const cond = new RegAlloc<E>(alloc)
    const h = hoistTernaries(s.test, cond)
    const test = lowerExpr(annotate(h.expr, cond) as EastExpression<E>, cond.rules(), "acc")
    assert.ok(test, `Failed to lower while test expression`)

    const bodyTerm = lowerControlBody(s.body, new RegAlloc<E>(alloc))
    assert.ok(bodyTerm, `Failed to lower while body`)

    return [
        bare("LOOP"),
        ...h.prelude,
        ...test.fragment,
        bare("BLOCK_END"),
        ...closeControlBody(s.body, bodyTerm),
    ]
}

function lowerFor<E extends { ext: string } = ExtOpPayload>(s: ForStatement, alloc: RegAlloc<E>): RtlInstr<E>[]
{
    const init: RtlInstr<E>[] | undefined = (s.init) ?
        (s.init.type === "VariableDeclaration")
            ? lowerVarDecl(s.init, alloc)
            : lowerExprStmt({type: "ExpressionStatement", expression: s.init}, alloc)
        : []

    // Unlike init/update (discarded), the condition's value feeds the
    // LOOP's condition-block test directly — it must land in acc, same as
    // lowerWhile's test. Demanding acc specifically (not lowerExprStmt's
    // relaxed "any TOS-neutral output") is required here, not optional.
    const cond = new RegAlloc<E>(alloc)
    const test = s.test ? (() =>
    {
        const h = hoistTernaries(s.test!, cond)
        const node = lowerExpr(annotate(h.expr, cond) as EastExpression<E>, cond.rules(), "acc")
        assert.ok(node, `Failed to lower for-loop test expression`)
        return [...h.prelude, ...node.fragment]
    })() : []

    const bodyScope = new RegAlloc<E>(alloc)
    const body = lowerControlBody(s.body, bodyScope)
    const bodyStmts = s.body.type === "BlockStatement" ? s.body.body : [s.body]

    // The update runs at the end of the body block, with the body's own
    // locals still pushed — so a ternary in it must number its slot above
    // them, while its names still resolve in the enclosing scope the way
    // C's do.
    const update = s.update
        ? lowerExprStmt({type: "ExpressionStatement", expression: s.update},
            new RegAlloc<E>(alloc, undefined, undefined, bodyScope.depth))
        : []

    return [
        ...init,
        bare("LOOP"),
        ...test,
        bare("BLOCK_END"),
        ...body,
        // The increment is dead code when the body always terminates first
        // (e.g. every path `return`s) — omit it and the back-edge closer
        // with it, matching the terminator-closed body shape (§14.4).
        ...(alwaysTerminates(bodyStmts) ? [] : [...update, bare("BLOCK_END")]),
    ]
}
