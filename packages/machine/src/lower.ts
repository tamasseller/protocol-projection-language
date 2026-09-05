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
    Statement, ControlBody, BlockStatement, IfStatement, WhileStatement,
    DoWhileStatement, ForStatement, SwitchStatement, SwitchCase,
    VariableDeclaration, ReturnStatement, ExpressionStatement, Expression,
} from "./ast"
import {RtlProc, RtlProgram, RtlInstr, bare, brTable, drop, CONST, PUSH, LOAD, opImm, trap, fallsThrough, reachesEnd} from "./rtl"
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

/**
 * Statements after one that cannot fall through are dropped rather than
 * emitted: §8.4 rejects an instruction following a terminator in the same
 * block, and C says such a statement can never run anyway. Only a
 * construct that emits no block of its own — a `do`/`while` whose body
 * always terminates — reaches this, since every real block structurally
 * continues into its own merge whatever its arms do.
 */
function lowerBlock<E extends { ext: string } = ExtOpPayload>(stmts: readonly Statement[], alloc: RegAlloc<E>): RtlInstr<E>[]
{
    const ret: RtlInstr<E>[] = []

    for(const s of stmts)
    {
        ret.push(...lowerStmt(s, alloc))
        if(!fallsThrough(ret)) break
    }

    return ret
}

function lowerStmt<E extends { ext: string } = ExtOpPayload>(stmt: Statement, alloc: RegAlloc<E>): RtlInstr<E>[]
{
    switch(stmt.type)
    {
        case "ExpressionStatement": return lowerExprStmt(stmt, alloc)
        case "VariableDeclaration": return lowerVarDecl(stmt, alloc)
        case "BlockStatement": return lowerBareBlock(stmt, alloc)
        case "IfStatement": return lowerIf(stmt, alloc)
        case "SwitchStatement": return lowerSwitch(stmt, alloc)
        case "WhileStatement": return lowerWhile(stmt, alloc)
        case "DoWhileStatement": return lowerDoWhile(stmt, alloc)
        case "ForStatement": return lowerFor(stmt, alloc)
        case "BreakStatement": throw new Error(`break outside a switch case: the ISA has no opcode for irregular exit (isa-core.md §4.5, §10.3)`)
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

/**
 * A standalone `{ ... }`, backed by no block construct at all: its locals
 * are ordinary pushes in the enclosing block, and `DROP #n` is what ends
 * the scope (isa-core.md §4.4). The enclosing scope's own numbering is
 * therefore unchanged — the slots are genuinely reclaimed, not skipped
 * past. Nothing is dropped where no path reaches the end, which would be
 * dead code (§8.4).
 */
function lowerBareBlock<E extends { ext: string } = ExtOpPayload>(s: BlockStatement, alloc: RegAlloc<E>): RtlInstr<E>[]
{
    const scope = new RegAlloc<E>(alloc)
    const body = lowerBlock(s.body, scope)
    return [...body, ...scopeCleanup(scope.depth - alloc.depth, fallsThrough(body))]
}

/** `DROP #n` closing a scope that no `BLOCK_END` closes — omitted when
 *  there is nothing to reclaim, or when nothing reaches here (§8.4). */
function scopeCleanup<E extends { ext: string } = ExtOpPayload>(slots: number, reached: boolean = true): RtlInstr<E>[]
{
    return slots > 0 && reached ? [drop<E>(slots)] : []
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

/** What one missing label inside a merged span costs. A gap cannot share
 *  `case[N]`'s code — `BR_TABLE`'s index is exact below `N` — so it needs a
 *  case of its own: a lone `DEFAULT` (two bytes) to reach the `default:`
 *  clause, or a lone `BLOCK_END` (one) where there is no clause to reach
 *  and falling out of the construct is already what "no label matched"
 *  means. Neither depends on how big the clause itself is, which is what
 *  makes merging worth considering at all for a switch that has one. */
const gapCost = (hasDefault: boolean): number => hasDefault ? 2 : 1

/** Ascending labels into runs — a label is a *value*, not a position, so
 *  only consecutive ones map onto `BR_TABLE`'s index directly.
 *
 *  Two runs are worth merging into one table whenever the gaps between them
 *  cost less than the second table that would otherwise separate them. */
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

/**
 * A clause's statements with a trailing `break;` taken off. That `break` is
 * not an irregular exit — it is exactly this case block's own `BLOCK_END`
 * (isa-core.md §10.3), so removing it here is all it takes. One anywhere
 * else in the body would be a jump to the merge from inside a nested
 * block, which nothing encodes; `lowerStmt` rejects those where it finds
 * them.
 */
function trimBreak(c: SwitchCase): {stmts: Statement[]; breaks: boolean}
{
    const last = c.consequent[c.consequent.length - 1]

    return last?.type === "BreakStatement"
        ? {stmts: c.consequent.slice(0, -1), breaks: true}
        : {stmts: c.consequent, breaks: false}
}

type SwitchClause = {label: number | null; stmts: Statement[]; breaks: boolean}

/**
 * What closes clause `i`, from C's rule that a case body with no `break`
 * runs on into whatever is written *next in the source*.
 *
 * Emission order is label-value order, and `FALLTHROUGH` continues into the
 * case physically next in the table (isa-core.md §4.5), so the two only
 * agree when the source-next clause is the value-next label. `DEFAULT`
 * covers the one other direction that is expressible — into a `default:`
 * clause, which is `case[N]` wherever it was written. Everything else wants
 * a branch naming a block, and is rejected rather than mis-lowered (§7.1).
 */
function caseCloser(clauses: readonly SwitchClause[], i: number): "BLOCK_END" | "FALLTHROUGH" | "DEFAULT"
{
    const self = clauses[i]!
    const next = clauses[i + 1]

    // A `break`, or nothing written after this clause at all: C leaves the
    // switch either way.
    if(self.breaks || !next) return "BLOCK_END"

    if(next.label === null) return "DEFAULT"

    if(self.label === null)
        throw new Error(`The default clause falls through into case ${next.label}: ` +
            `write it last, or end it with break — nothing names a specific case to continue into`)

    if(next.label !== self.label + 1)
        throw new Error(`case ${self.label} falls through into case ${next.label}, which is not the next value: ` +
            `a case continues into the one physically next in the table (isa-core.md §7.1), so only ` +
            `case ${self.label + 1} would work — end it with break, or repeat the statements`)

    return "FALLTHROUGH"
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
    const clauses = s.cases.map(c =>
    {
        if(c.test === null) return {label: null, ...trimBreak(c)}

        const label = caseLabel(c.test)
        if(seen.has(label)) throw new Error(`Duplicate switch case label ${label}`)
        seen.add(label)

        return {label, ...trimBreak(c)}
    })

    const sorted = clauses.filter(c => c.label !== null).sort((a, b) => a.label! - b.label!)
    const groups = switchGroups(sorted.map(c => c.label!), gapCost(defaults.length > 0))

    // A chain needs the discriminant more than once, and acc does not
    // survive the first split (isa-core.md §8.7) — so it goes to a slot,
    // reserved by the `PUSH` that stores it. One group needs no chain, so
    // it dispatches straight out of acc.
    // The discriminant's own slot is reclaimed after the construct, so it
    // gets a scope of its own — the enclosing scope must go on numbering
    // from where it already was, not past a slot that is gone.
    const chained = groups.length > 1
    const disc_ = new RegAlloc<E>(alloc)
    const slot = chained ? disc_.alloc(`?${disc_.depth}`) : -1

    // Case scopes are built after that allocation: a scope snapshots its
    // parent's numbering (scope.ts), so one built earlier would sit on the
    // discriminant's own slot.
    const bodyOf = new Map<number, RtlInstr<E>[]>()
    let otherwise: RtlInstr<E>[] = [bare<E>("BLOCK_END")]

    for(const [i, c] of clauses.entries())
    {
        const body = lowerBlock(c.stmts, new RegAlloc<E>(disc_))
        assert.ok(body, `Failed to lower switch ${c.label === null ? "default clause" : `case ${c.label}`}`)

        const closed = fallsThrough(body) ? [...body, bare<E>(caseCloser(clauses, i))] : body

        if(c.label === null) otherwise = closed
        else bodyOf.set(c.label, closed)
    }

    const load = (): RtlInstr<E>[] => [LOAD<E>(slot)]
    const shift = (lo: number): RtlInstr<E>[] => lo === 0 ? [] : [opImm<E>("SUB", lo)]

    /** A missing label inside a merged span: `BR_TABLE`'s index is exact
     *  below `N`, so it cannot share `case[N]`'s code and needs a block of
     *  its own — `DEFAULT` to reach the clause, or a plain exit where there
     *  is none. What `gapCost` prices, and nothing bigger. */
    const gap = (): RtlInstr<E>[] => [bare<E>(defaults.length > 0 ? "DEFAULT" : "BLOCK_END")]

    /** One group as a `BR_TABLE` over `label - lo`. */
    function table(group: number[], from: RtlInstr<E>[], dflt: RtlInstr<E>[]): RtlInstr<E>[]
    {
        const lo = group[0]!
        const span = group[group.length - 1]! - lo + 1
        const filled = [...Array(span)].map((_, i) => bodyOf.get(lo + i) ?? gap())

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

    const construct = chained ? [PUSH<E>(), ...chain(0)] : table(groups[0]!, [], otherwise)

    return [
        ...disc.fragment,
        ...construct,
        // The chain's own discriminant slot outlives the construct — every
        // case reset TOS to a depth above it — so it is dropped here, the
        // same way any other scope that no block boundary closes ends
        // (isa-core.md §4.4).
        ...scopeCleanup<E>(disc_.depth - alloc.depth, reachesEnd(construct)),
    ]
}

/**
 * Both loop forms, which differ only in the opener (isa-core.md §7.2):
 * `LOOP_PRE` for `while`/`for`, `LOOP_POST` for `do`/`while`. The body
 * block is emitted first and the condition second.
 *
 * The condition sub-block is a block of its own: a ternary in the test
 * re-reserves its slot on every pass and the sub-block's `BLOCK_END` drops
 * it again (§8.1), so the scope holding it must be a child of the loop's,
 * not shared with the body's.
 */
function lowerLoop<E extends { ext: string } = ExtOpPayload>(
    opener: "LOOP_PRE" | "LOOP_POST",
    test: Expression,
    what: string,
    body: RtlInstr<E>[],
    alloc: RegAlloc<E>,
): RtlInstr<E>[]
{
    const cond = lowerExpression(test, new RegAlloc<E>(alloc),
        {demand: "acc", what}).fragment

    return [
        bare(opener),
        ...closeBlock(body),
        ...cond,
        bare("BLOCK_END"),
    ]
}

function lowerWhile<E extends { ext: string } = ExtOpPayload>(s: WhileStatement, alloc: RegAlloc<E>): RtlInstr<E>[]
{
    const body = lowerControlBody(s.body, new RegAlloc<E>(alloc))
    assert.ok(body, `Failed to lower while body`)

    return lowerLoop("LOOP_PRE", s.test, "while test expression", body, alloc)
}

function lowerDoWhile<E extends { ext: string } = ExtOpPayload>(s: DoWhileStatement, alloc: RegAlloc<E>): RtlInstr<E>[]
{
    const body = lowerControlBody(s.body, new RegAlloc<E>(alloc))
    assert.ok(body, `Failed to lower do-while body`)

    // §8.5: a `LOOP_POST` body closed by a terminator leaves the condition
    // unreachable. The construct is then pointless rather than wrong, so
    // the body is emitted on its own and what follows never runs the test.
    if(!fallsThrough(body))
        return body

    return lowerLoop("LOOP_POST", s.test, "do-while test expression", body, alloc)
}

function lowerFor<E extends { ext: string } = ExtOpPayload>(s: ForStatement, alloc: RegAlloc<E>): RtlInstr<E>[]
{
    // C scopes a `for` init's declarations to the loop, and so does this:
    // they get a scope of their own for name visibility, and a `DROP #n`
    // after the whole construct reclaims their slots (isa-core.md §4.4) —
    // no block boundary sits where that scope ends.
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

    // The update runs at the end of the body block, with the body's own
    // locals still pushed — so a ternary in it must number its slot above
    // them, while its names still resolve in the enclosing scope the way
    // C's do. It is dead code when the body always terminates first (e.g.
    // every path `return`s), and omitted then (§8.4).
    const update = s.update && fallsThrough(body)
        ? lowerExprStmt({type: "ExpressionStatement", expression: s.update},
            new RegAlloc<E>(loop, undefined, undefined, bodyScope.depth))
        : []

    const construct = [...body, ...update]

    return [
        ...init,
        bare("LOOP_PRE"),
        ...closeBlock(construct),
        ...test,
        bare("BLOCK_END"),
        ...scopeCleanup(loop.depth - alloc.depth),
    ]
}
