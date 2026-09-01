/**
 * @ppl/machine — Statement lowering pass
 *
 * Converts a parsed AST fragment (Statement[]) into a ResolvedProc with
 * numerical register indices and flattened control flow: walk the
 * statements, allocating a register per declaration (scope.ts) and
 * emitting each expression through `lowerExpression` below.
 *
 * `lowerProc` handles one standalone body; `lowerProgram` handles a
 * `Procedure` plus everything it transitively calls, resolving each `CALL`
 * to a procedure-table index on the fly as that callee is first discovered
 * (ROADMAP.md item 2).
 */

import type {
    Statement, ControlBody, IfStatement, WhileStatement,
    ForStatement, SwitchStatement, VariableDeclaration, ReturnStatement,
    ExpressionStatement, Expression,
} from "./ast"
import {RtlProc, RtlProgram, RtlInstr, bare, brTable, CONST, PUSH, LOAD, opImm} from "./rtl"
import type {ExtOpPayload} from "./rtl"
import type {RtlNode} from "./east"
import type {Procedure} from "./ir"
import assert from "assert"
import {RegAlloc} from "./scope"
import {desugar} from "./desugar"
import {lift} from "./lift"
import {tileExpression, isTrapCall} from "./expr"
import type {TileRequest} from "./expr"
import type {Extension} from "./extension"

// ─────────────────────────────────────────────────────────────────────────────
// The expression pipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every expression in the DSL is lowered here and nowhere else, in four
 * phases: rewrite the derived operators (desugar.ts), lift what cannot be
 * tiled in place into code ahead of the expression (lift.ts), annotate
 * types and optionally invert for a dispatch test (expr.ts), tile under the
 * demand (orchestrator.ts). Sites differ only in that demand, and in
 * whether the value is used at all, so they say only that.
 *
 * `fragment` is the whole thing in order, lifted branches first. `node` is
 * the tiling, for the one caller that needs its stack effect.
 */
function lowerExpression<E extends { ext: string } = ExtOpPayload>(expr: Expression, scope: RegAlloc<E>, req: TileRequest): {fragment: RtlInstr<E>[]; node: RtlNode<E>}
{
    const lifted = lift(desugar(expr, req.demand !== "statement"), scope)
    const node = tileExpression(lifted.expr, scope, req)

    return {fragment: [...lifted.prelude, ...node.fragment], node}
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
        const alloc = new RegAlloc<E>(undefined, (name, argCount) =>
        {
            const callee = target.fragment.calls.get(name)
            if(!callee) return undefined

            // `argCount` is a plain `CALL` site's own arity. An extension op
            // that resolves a name to an index without passing one (a codec
            // invocation) has its own ABI, and is not checked here.
            if(argCount !== undefined && argCount !== callee.args.length)
                throw new Error(`Call to '${name}' passes ${argCount} argument(s), but it takes ${callee.args.length}`)

            return resolve(callee)
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
    return lowerExpression(s.expression, alloc,
        {demand: "statement", what: "expression statement"}).fragment
}

function lowerVarDecl<E extends { ext: string } = ExtOpPayload>(s: VariableDeclaration, alloc: RegAlloc<E>): RtlInstr<E>[]
{
    return s.declarations.map(d =>
    {
        // No initializer: the slot still has to exist, and `PUSH` needs a
        // value in acc to establish it — the ISA has no "reserve
        // uninitialized". Zero, rather than whatever acc happened to hold,
        // which may not even be live here (isa-core.md §8.7).
        if(!d.init)
        {
            alloc.alloc(d.id.name, d.varType)
            return [CONST<E>(0), PUSH<E>()]
        }

        const {fragment, node} = lowerExpression(d.init, alloc,
            {demand: "tos", into: d.varType, what: `variable initializer for ${d.id.name}`})

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

        return fragment
    }).flat()
}

function lowerReturn<E extends { ext: string } = ExtOpPayload>(s: ReturnStatement, alloc: RegAlloc<E>): RtlInstr<E>[]
{
    if(s.argument)
    {
        const {fragment} = lowerExpression(s.argument, alloc,
            {demand: "acc", what: "return expression"})
        return [...fragment, bare("RETURN")]
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
    // A scope snapshots its parent's numbering at construction, so the test
    // is lowered before either branch's: a ternary in it allocates a slot
    // one built earlier would renumber over.
    const test = lowerExpression(s.test, alloc,
        {demand: "acc", invert: true, what: "if test expression"})

    const thenTerm = lowerControlBody(s.consequent, new RegAlloc<E>(alloc))
    assert.ok(thenTerm, `Failed to lower then branch`)

    if(s.alternate)
    {
        const elseTerm = lowerControlBody(s.alternate, new RegAlloc<E>(alloc))
        assert.ok(elseTerm, `Failed to lower else branch`)

        return [
            ...test.fragment,
            brTable(2),
            ...closeControlBody(s.consequent, thenTerm),
            ...closeControlBody(s.alternate, elseTerm),
        ]
    }

    return [
        ...test.fragment,
        brTable(1),
        ...closeControlBody(s.consequent, thenTerm),
    ]
}

/**
 * Roughly what one link of the compare chain costs in bytes: a `LOAD` of
 * the discriminant, the comparison, the `BR_TABLE 2`, and the two
 * `BLOCK_END`s that close its arms.
 *
 * It is the whole grouping rule. A gap inside a table costs exactly one
 * byte per missing label (an empty case is a lone `BLOCK_END`), so two
 * runs are worth merging into one table whenever the gap between them is
 * cheaper than the chain link that would otherwise separate them.
 */
const CHAIN_LINK_BYTES = 8

/** Ascending labels into runs — a label is a *value*, not a position, so
 *  only consecutive ones map onto `BR_TABLE`'s index directly. */
function switchGroups(labels: readonly number[]): number[][]
{
    const groups: number[][] = [[labels[0]!]]

    for(const label of labels.slice(1))
    {
        const group = groups[groups.length - 1]!
        const gap = label - group[group.length - 1]! - 1

        if(gap < CHAIN_LINK_BYTES) group.push(label)
        else groups.push([label])
    }

    return groups
}

function caseLabel(test: Expression): number
{
    if(test.type !== "Literal")
        throw new Error(`A switch case label must be an integer literal`)

    return test.value >>> 0
}

function lowerSwitch<E extends { ext: string } = ExtOpPayload>(s: SwitchStatement, alloc: RegAlloc<E>): RtlInstr<E>[]
{
    const disc = lowerExpression(s.discriminant, alloc,
        {demand: "acc", what: "switch discriminant expression"})

    const labelled = s.cases.filter(c => c.test !== null)
    const defaults = s.cases.filter(c => c.test === null)

    if(defaults.length > 1) throw new Error(`A switch has more than one default clause`)
    if(labelled.length === 0) throw new Error(`A switch needs at least one case`)

    const seen = new Set<number>()
    const sorted = labelled
        .map(c =>
        {
            const label = caseLabel(c.test!)

            if(seen.has(label)) throw new Error(`Duplicate switch case label ${label}`)
            seen.add(label)

            // In C this would fall through into the next case. There is no
            // opcode for that (isa-core.md §4.5) and no way to reach one
            // case's code from another, so the idiom is rejected rather
            // than silently lowered as "do nothing for this label".
            if(c.consequent.length === 0)
                throw new Error(`Empty body for case ${label}: this DSL has no fallthrough — give the label its own statements, ` +
                    `or omit it to let that value reach the default`)

            return {label, stmts: c.consequent}
        })
        .sort((a, b) => a.label - b.label)

    const groups = switchGroups(sorted.map(c => c.label))

    // A chain needs the discriminant more than once, and acc does not
    // survive the first split (isa-core.md §8.7) — so it goes to a slot,
    // reserved by the `PUSH` that stores it. One group needs no chain, so
    // it dispatches straight out of acc.
    const chained = groups.length > 1
    const slot = chained ? alloc.alloc(`?${alloc.depth}`) : -1

    // Case scopes are built after that allocation: a scope snapshots its
    // parent's numbering (scope.ts), so one built earlier would sit on the
    // discriminant's own slot.
    const bodyOf = new Map<number, RtlInstr<E>[]>()
    for(const c of sorted)
    {
        const body = lowerBlock(c.stmts, new RegAlloc<E>(alloc))
        assert.ok(body, `Failed to lower switch case ${c.label}`)
        bodyOf.set(c.label, closeBlock(c.stmts, body))
    }

    const load = (): RtlInstr<E>[] => [LOAD<E>(slot)]
    const shift = (lo: number): RtlInstr<E>[] => lo === 0 ? [] : [opImm<E>("SUB", lo)]

    /** One group as a `BR_TABLE` over `label - lo`, gaps included: an
     *  absent label's slot is an empty case, which exits the construct
     *  exactly as an out-of-range discriminant does. */
    function table(group: number[], from: RtlInstr<E>[]): RtlInstr<E>[]
    {
        const lo = group[0]!
        const span = group[group.length - 1]! - lo + 1
        const filled = [...Array(span)].map((_, i) =>
            bodyOf.get(lo + i) ?? [bare<E>("BLOCK_END")])

        return [...from, ...shift(lo), brTable(span), ...filled.flat()]
    }

    /** Groups after the first are reached through a test on the previous
     *  one's failure. The last needs none: `BR_TABLE`'s own out-of-range
     *  case already means "none of these", which is what the default is. */
    function chain(index: number): RtlInstr<E>[]
    {
        const group = groups[index]!
        if(index === groups.length - 1) return table(group, load())

        const lo = group[0]!
        const span = group[group.length - 1]! - lo + 1

        // Complementary test, as everywhere a `BR_TABLE` dispatches
        // (isa-core.md §7.3): acc = 0 selects case[0], this group.
        //
        // A lone label needs no table behind its test — passing it *is* the
        // dispatch, so case[0] is the body itself.
        if(span === 1)
            return [
                ...load(), opImm<E>("NE", lo),
                brTable(2),
                ...bodyOf.get(lo)!,
                ...chain(index + 1), bare("BLOCK_END"),
            ]

        return [
            ...load(), ...shift(lo), opImm<E>("GT_U", span - 1),
            brTable(2),
            ...table(group, load()), bare("BLOCK_END"),
            ...chain(index + 1), bare("BLOCK_END"),
        ]
    }

    return [
        ...disc.fragment,
        ...(chained ? [PUSH<E>(), ...chain(0)] : table(groups[0]!, [])),
        ...(defaults[0] ? lowerBlock(defaults[0].consequent, new RegAlloc<E>(alloc)) : []),
    ]
}

function lowerWhile<E extends { ext: string } = ExtOpPayload>(s: WhileStatement, alloc: RegAlloc<E>): RtlInstr<E>[]
{
    // The condition sub-block is a block of its own: a ternary in the test
    // re-reserves its slot on every pass and the sub-block's `BLOCK_END`
    // drops it again (isa-core.md §8.1), so the scope holding it must be a
    // child, or the body would number its locals above a slot that is gone
    // by the time the body runs.
    const test = lowerExpression(s.test, new RegAlloc<E>(alloc),
        {demand: "acc", what: "while test expression"})

    const bodyTerm = lowerControlBody(s.body, new RegAlloc<E>(alloc))
    assert.ok(bodyTerm, `Failed to lower while body`)

    return [
        bare("LOOP"),
        ...test.fragment,
        bare("BLOCK_END"),
        ...closeControlBody(s.body, bodyTerm),
    ]
}

function lowerFor<E extends { ext: string } = ExtOpPayload>(s: ForStatement, alloc: RegAlloc<E>): RtlInstr<E>[]
{
    // C scopes a `for` init's declarations to the loop, but their registers
    // live until the enclosing block ends — nothing pops them at the
    // back-edge. So they get a scope of their own for name visibility, and
    // the enclosing scope is told to number past them at the end.
    const loop = new RegAlloc<E>(alloc)

    const init: RtlInstr<E>[] = (s.init) ?
        (s.init.type === "VariableDeclaration")
            ? lowerVarDecl(s.init, loop)
            : lowerExprStmt({type: "ExpressionStatement", expression: s.init}, loop)
        : []

    // Unlike init/update (discarded), the condition's value feeds the
    // LOOP's condition-block test directly — it must land in acc, same as
    // lowerWhile's test. Demanding acc specifically (not lowerExprStmt's
    // relaxed "any TOS-neutral output") is required here, not optional.
    // An omitted test is C's `for(;;)`: always true. The condition block
    // must still produce a value — its `BLOCK_END` is the dispatch and
    // reads acc (isa-core.md §8.7), so leaving it empty would branch on
    // whatever happened to be live.
    const testExpr: Expression = s.test ?? {type: "Literal", value: 1, raw: "1"}
    const test = lowerExpression(testExpr, new RegAlloc<E>(loop),
        {demand: "acc", what: "for-loop test expression"}).fragment

    const bodyScope = new RegAlloc<E>(loop)
    const body = lowerControlBody(s.body, bodyScope)
    const bodyStmts = s.body.type === "BlockStatement" ? s.body.body : [s.body]

    // The update runs at the end of the body block, with the body's own
    // locals still pushed — so a ternary in it must number its slot above
    // them, while its names still resolve in the enclosing scope the way
    // C's do.
    const update = s.update
        ? lowerExprStmt({type: "ExpressionStatement", expression: s.update},
            new RegAlloc<E>(loop, undefined, undefined, bodyScope.depth))
        : []

    alloc.consume(loop.depth - alloc.depth)

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
