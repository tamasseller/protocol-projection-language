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
import {RtlProc, RtlProgram, RtlInstr, bare, brTable, CONST, PUSH, LOAD, opImm, trap, fallsThrough, reachesEnd} from "./rtl"
import type {ExtOpPayload} from "./rtl"
import type {RtlNode} from "./east"
import type {Procedure} from "./ir"
import assert from "assert"
import {RegAlloc} from "./scope"
import {desugar} from "./desugar"
import {returnsValue} from "./signature"
import type {ProcSignature} from "./types"
import {lift, conditionalToAcc, assignedConditionalToAcc} from "./lift"
import {tileExpression} from "./expr"
import {instrBytes} from "./encoding"
import type {TileRequest} from "./expr"
import type {Extension} from "./extension"

// ─────────────────────────────────────────────────────────────────────────────
// The expression pipeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every expression in the DSL is lowered here and nowhere else, in four
 * phases: rewrite the derived operators (desugar.ts), lift what cannot be
 * tiled in place into code ahead of the expression (lift.ts), annotate
 * types (expr.ts), tile under the demand (orchestrator.ts). Sites differ
 * only in that demand, and in whether the value is used at all, so they
 * say only that.
 *
 * `fragment` is the whole thing in order, lifted branches first. `node` is
 * the tiling, for the one caller that needs its stack effect.
 */
function lowerExpression<E extends { ext: string } = ExtOpPayload>(expr: Expression, scope: RegAlloc<E>, req: TileRequest): {fragment: RtlInstr<E>[]; tosDelta: number}
{
    const sugared = desugar(expr, req.demand !== "statement")

    // A ternary that *is* the whole expression rides acc across the merge
    // (lift.ts) instead of writing a slot, and so does one that is the whole
    // right-hand side of an assignment.
    const inAcc = sugared.type === "ConditionalExpression" && req.demand !== "statement"
        ? conditionalToAcc(sugared, scope, req.into)
        : req.into === undefined ? assignedConditionalToAcc(sugared, scope) : undefined

    if(inAcc)
    {
        return req.demand === "tos"
            ? {fragment: [...inAcc, PUSH<E>()], tosDelta: 1}
            : {fragment: inAcc, tosDelta: 0}
    }

    const lifted = lift(sugared, scope)
    const node = tileExpression(lifted.expr, scope, req)

    return {fragment: [...lifted.prelude, ...node.fragment], tosDelta: node.tosDelta}
}

/** Lower a single, standalone procedure body — the common case for tests
 *  and fragments that don't call another procedure. There is no procedure
 *  table here, so any non-builtin call inside `stmts` fails to lower (no
 *  rule can produce a candidate for it); use {@link lowerProgram} for a
 *  fragment that references another `Procedure`. */
export function lowerProc<E extends { ext: string } = ExtOpPayload>(stmts: readonly Statement[], args: string[] = [], extension?: Extension<E>): RtlProc<E>
{
    const alloc = new RegAlloc<E>(undefined, () => undefined, extension, undefined,
        returnsValue(stmts, "procedure") ? "u32" : "void")

    for(const arg of args) alloc.alloc(arg)

    return { argCount: args.length, body: closeProcBody(lowerBlock(stmts, alloc), alloc.returns ?? "u32") }
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
    const signatures = new Map<symbol, ProcSignature>()

    /** Declared where the author said so, deduced from the body's own
     *  `return`s otherwise (signature.ts) — the C++14 `auto` rule, since an
     *  `ir` fragment has no signature position to write one in. */
    function signatureOf(target: Procedure): ProcSignature
    {
        const cached = signatures.get(target.id)
        if(cached !== undefined) return cached

        const returns = target.returns
            ?? (returnsValue(target.fragment.body, `procedure '${target.name}'`) ? "u32" : "void")
        const signature: ProcSignature = { argTypes: target.argTypes, returns }
        signatures.set(target.id, signature)
        return signature
    }

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
        }, extension, undefined, signatureOf(target).returns,
        name =>
        {
            const callee = target.fragment.calls.get(name)
            return callee && signatureOf(callee)
        })

        target.args.forEach((arg, i) => alloc.alloc(arg, target.argTypes[i]))

        procedures[index] = { argCount: target.args.length, body: closeProcBody(lowerBlock(target.fragment.body, alloc), signatureOf(target).returns), header: target.header }
        return index
    }

    resolve(entry)
    return { procedures }
}

/**
 * A procedure body has no enclosing block to close it, so it has to end in
 * a terminator of its own. One whose last statement is a construct every
 * case of which returns does end there — but a `BR_TABLE` structurally
 * continues into its merge whatever its cases do (rtl.ts's `blockClose`),
 * so the stream still needs something at that merge to close on. `TRAP #0`
 * is what goes there: isa-core.md §4.5 already reserves code 0 for
 * "unreachable", which is exactly what this is.
 *
 * A body that genuinely runs off its end returns nothing, which is exactly
 * what a void procedure does — so it gets the `RETURN` C would have implied,
 * and its callers get one less line of ceremony to write. One that owes a
 * value has nothing to put there, and says so here rather than as an
 * acc-liveness error further down.
 */
function closeProcBody<E extends { ext: string } = ExtOpPayload>(body: RtlInstr<E>[], returns: ProcSignature["returns"]): RtlInstr<E>[]
{
    if(!fallsThrough(body)) return body
    if(!reachesEnd(body)) return [...body, trap<E>(0)]

    if(returns !== "void")
        throw new Error(`procedure returns a value, but its body runs off the end without one`)

    return [...body, bare<E>("RETURN")]
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

        const {fragment, tosDelta} = lowerExpression(d.init, alloc,
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
        assert.equal(tosDelta, 1,
            `"tos"-demand initializer for ${d.id.name} nets tosDelta=${tosDelta}, expected exactly 1 — ` +
            `the winning tiling should always be a single net push; this indicates a lowerer bug, not a case to handle`)
        alloc.alloc(d.id.name, d.varType)

        return fragment
    }).flat()
}

function lowerReturn<E extends { ext: string } = ExtOpPayload>(s: ReturnStatement, alloc: RegAlloc<E>): RtlInstr<E>[]
{
    if(s.argument)
    {
        if(alloc.returns === "void")
            throw new Error(`return with a value in a procedure that returns none — declare a return type, or drop the value`)

        // The declared type is the callee's own to establish, exactly as in
        // C: narrowing happens here, not at every call site.
        const {fragment} = lowerExpression(s.argument, alloc,
            {demand: "acc", into: alloc.returns, what: "return expression"})
        return [...fragment, bare("RETURN")]
    }

    // A procedure whose every `return` is bare is void (isa-core.md §8.7),
    // and its RETURN needs no producer at all. One that returns a value
    // elsewhere would be returning none here, which signature.ts already
    // rejected at the definition — so the producer below is only for a
    // fragment lowered without a deduced signature.
    return alloc.returns === "void" ? [bare("RETURN")] : [CONST(0), bare("RETURN")]
}

/** Close a branch/case/loop-body fragment, unless it already closed itself
 *  (isa-core.md §4.5: a terminator closes its own block, and so does a
 *  construct no block of which reaches the merge). */
function closeBlock<E extends { ext: string } = ExtOpPayload>(fragment: RtlInstr<E>[]): RtlInstr<E>[]
{
    return fallsThrough(fragment) ? [...fragment, bare("BLOCK_END")] : fragment
}

function lowerIf<E extends { ext: string } = ExtOpPayload>(s: IfStatement, alloc: RegAlloc<E>): RtlInstr<E>[]
{
    // `if (A && B) S` with no `else` is `if (A) { if (B) S }`: A's false
    // edge lands on the empty arm either way, so nothing is duplicated. No
    // other short-circuit shape has that property — its exit lands on a
    // branch body, which a second edge would have to copy.
    if(!s.alternate && s.test.type === "LogicalExpression" && s.test.operator === "&&")
    {
        return lowerIf({
            type: "IfStatement",
            test: s.test.left,
            consequent: {type: "IfStatement", test: s.test.right, consequent: s.consequent, alternate: null},
            alternate: null,
        }, alloc)
    }

    // A scope snapshots its parent's numbering at construction, so the test
    // is lowered before either branch's: a ternary in it allocates a slot
    // one built earlier would renumber over.
    const test = lowerExpression(s.test, alloc,
        {demand: "acc", what: "if test expression"})

    const thenTerm = lowerControlBody(s.consequent, new RegAlloc<E>(alloc))
    assert.ok(thenTerm, `Failed to lower then branch`)

    // `BR_TABLE 1` is truthy (isa-core.md §4.5), so `case[0]` is the false
    // arm and `case[1]` the true one. With no `else` the false arm is an
    // empty block — one byte, and no complemented test to emit.
    let falseArm: RtlInstr<E>[] = [bare("BLOCK_END")]

    if(s.alternate)
    {
        const elseTerm = lowerControlBody(s.alternate, new RegAlloc<E>(alloc))
        assert.ok(elseTerm, `Failed to lower else branch`)
        falseArm = closeBlock(elseTerm)
    }

    return [
        ...test.fragment,
        brTable(1),
        ...falseArm,
        ...closeBlock(thenTerm),
    ]
}

/**
 * Roughly what starting a second table costs in bytes: a `LOAD` of the
 * discriminant, the `SUB` shifting it to that run's base, the `BR_TABLE`
 * itself, and the `BLOCK_END` closing the default case it sits in. No
 * range test — a group's own `case[N]` is where the next one goes
 * (isa-core.md §7.1).
 */
const CHAIN_LINK_BYTES = 7

/** Ascending labels into runs — a label is a *value*, not a position, so
 *  only consecutive ones map onto `BR_TABLE`'s index directly.
 *
 *  Two runs are worth merging into one table whenever the gap between them
 *  is cheaper than the second table that would otherwise separate them. A
 *  gap costs one copy of the default block per missing label (`gapBytes`),
 *  since `BR_TABLE`'s index is exact below `N` and a gap therefore cannot
 *  share `case[N]`'s code. With no `default:` clause that is a lone
 *  `BLOCK_END`; a substantial one makes merging never worth it, which is
 *  the right answer rather than a special case. */
function switchGroups(labels: readonly number[], gapBytes: number): number[][]
{
    const groups: number[][] = [[labels[0]!]]

    for(const label of labels.slice(1))
    {
        const group = groups[groups.length - 1]!
        const gap = label - group[group.length - 1]! - 1

        if(gap * gapBytes < CHAIN_LINK_BYTES) group.push(label)
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

            return {label, stmts: c.consequent}
        })
        .sort((a, b) => a.label - b.label)

    // C's `case 0: case 1: X` — an empty body shares the next label's.
    // `FALLTHROUGH` (isa-core.md §4.5) continues into the case physically
    // next in the table, so the shared label has to be the next one:
    // anything else would land in a gap filler, which exits to the default.
    for(const [i, c] of sorted.entries())
    {
        if(c.stmts.length > 0) continue

        const next = sorted[i + 1]
        if(!next || next.label !== c.label + 1)
            throw new Error(`Empty body for case ${c.label}: it can only share the body of case ${c.label + 1}, ` +
                `which this switch does not have — repeat the statements under each label instead`)
    }

    // The `default:` clause is a case block of its own — `case[N]`, run
    // only when no label matched, never also when a non-terminating case
    // fell out of the construct. A gap inside a group runs it too, so a
    // gap costs one copy of it and grouping cannot be decided without its
    // size; the throwaway scope here measures, the real one below emits.
    const lowerDefault = (scope: RegAlloc<E>): RtlInstr<E>[] =>
    {
        if(!defaults[0]) return [bare<E>("BLOCK_END")]

        const body = lowerBlock(defaults[0].consequent, scope)
        assert.ok(body, `Failed to lower switch default clause`)
        return closeBlock(body)
    }

    const gapBytes = lowerDefault(new RegAlloc<E>(alloc)).reduce((n, i) => n + instrBytes(i), 0)
    const groups = switchGroups(sorted.map(c => c.label), gapBytes)

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
        if(c.stmts.length === 0) { bodyOf.set(c.label, [bare<E>("FALLTHROUGH")]); continue }

        const body = lowerBlock(c.stmts, new RegAlloc<E>(alloc))
        assert.ok(body, `Failed to lower switch case ${c.label}`)
        bodyOf.set(c.label, closeBlock(body))
    }

    const otherwise = lowerDefault(new RegAlloc<E>(alloc))

    const load = (): RtlInstr<E>[] => [LOAD<E>(slot)]
    const shift = (lo: number): RtlInstr<E>[] => lo === 0 ? [] : [opImm<E>("SUB", lo)]

    /** One group as a `BR_TABLE` over `label - lo`. An absent label inside
     *  the span gets its own copy of the default block: `BR_TABLE`'s index
     *  is exact below `N`, so a gap cannot share `case[N]`'s code — which
     *  is exactly what `switchGroups` prices a gap at. */
    function table(group: number[], from: RtlInstr<E>[], dflt: RtlInstr<E>[]): RtlInstr<E>[]
    {
        const lo = group[0]!
        const span = group[group.length - 1]! - lo + 1
        const filled = [...Array(span)].map((_, i) => bodyOf.get(lo + i) ?? otherwise)

        return [...from, ...shift(lo), brTable(span), ...filled.flat(), ...dflt]
    }

    /** Groups after the first sit in the previous one's `case[N]`: "none of
     *  these" is a place code can go (isa-core.md §7.1), so no group needs
     *  a range test of its own. That default case is a block like any
     *  other, so what goes in it gets closed like any other. */
    function chain(index: number): RtlInstr<E>[]
    {
        return table(groups[index]!, load(),
            index === groups.length - 1 ? otherwise : closeBlock(chain(index + 1)))
    }

    return [
        ...disc.fragment,
        ...(chained ? [PUSH<E>(), ...chain(0)] : table(groups[0]!, [], otherwise)),
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
        ...closeBlock(bodyTerm),
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
        ...(fallsThrough(body) ? [...update, bare("BLOCK_END")] : []),
    ]
}
