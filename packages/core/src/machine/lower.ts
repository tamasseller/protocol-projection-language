/**
 * @ppl/core/machine — Statement lowering pass
 *
 * Converts a parsed AST fragment (Statement[]) into a ResolvedProc with
 * numerical register indices and flattened control flow.
 *
 * Pipeline:
 *   1. Walk declarations to allocate registers (name → index).
 *   2. Walk statements, emitting RtlInstr[] with control flow.
 *   3. Expression sub-trees lowered via lowerExpr + register resolution.
 */

import {lowerExpr, lowerStatementExpr} from "./orchestrator"
import type {EastExpression} from "./east"
import type {
    Statement, ControlBody, IfStatement, WhileStatement,
    ForStatement, SwitchStatement, VariableDeclaration, ReturnStatement,
    ExpressionStatement,
} from "./ast"
import {RtlProc, RtlInstr, bare, brTable} from "./rtl"
import assert from "assert"
import {Rule, ruleset} from "./rules"

// ─────────────────────────────────────────────────────────────────────────────
// Register allocator
// ─────────────────────────────────────────────────────────────────────────────

class RegAlloc
{
    private map = new Map<string, number>()
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
    constructor(private _parent?: RegAlloc)
    {
        this.next = _parent?.next ?? 0
    }

    get parent(): RegAlloc | undefined {return this._parent}

    /** Allocate a named variable, returning its index. Idempotent. */
    alloc(name: string): number
    {
        let idx = this.map.get(name)
        if(idx === undefined)
        {
            idx = this.next++
            this.map.set(name, idx)
        }
        return idx
    }

    /** Map a string register name to its allocated index. */
    resolve(name: string): number | undefined
    {
        const own = this.map.get(name)
        if(own !== undefined) return own
        return this._parent?.resolve(name)
    }

    rules(): Rule[]
    {
        return ruleset(name => this.resolve(name) ?? (() => {throw new Error(`Unresolved variable: ${name}`)})())
    }
}

export class ProgramLowerer
{
    private procedures = new Map<symbol, RtlProc>()

    lower(args: string[], stmts: readonly Statement[]): RtlProc
    {
        const alloc = new RegAlloc()

        for(const arg of args)
        {
            alloc.alloc(arg)
        }

        const proc: RtlProc =
        {
            argCount: args.length,
            body: lowerBlock(stmts, alloc)
        }

        this.procedures.set(Symbol(), proc)
        return proc
    }
}

/** Lower a single procedure body with no arguments — the common case for
 *  tests and standalone fragments. */
export function lowerProc(stmts: readonly Statement[], args: string[] = []): RtlProc
{
    return new ProgramLowerer().lower(args, stmts)
}

function lowerBlock(stmts: readonly Statement[], alloc: RegAlloc): RtlInstr[]
{
    const ret: RtlInstr[] = []

    for(const s of stmts)
        ret.push(...lowerStmt(s, alloc))

    return ret
}

function lowerStmt(stmt: Statement, alloc: RegAlloc): RtlInstr[]
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
function lowerControlBody(body: ControlBody, alloc: RegAlloc): RtlInstr[]
{
    return body.type === "BlockStatement"
        ? lowerBlock(body.body, alloc)
        : lowerStmt(body, alloc)
}

function lowerExprStmt(s: ExpressionStatement, alloc: RegAlloc): RtlInstr[]
{
    // The statement's value is discarded, so demand "acc" specifically
    // would be needlessly strict — it would exclude a cheaper tiling whose
    // result lands directly in a register write-back (e.g. `x = x op e`,
    // rules.ts). lowerStatementExpr allows any TOS-neutral output instead.
    const e = lowerStatementExpr(s.expression as EastExpression, alloc.rules())
    assert.ok(e, `Failed to lower expression statement`)

    return e.fragment
}

function lowerVarDecl(s: VariableDeclaration, alloc: RegAlloc): RtlInstr[]
{
    return s.declarations.map(d =>
    {
        const node = lowerExpr(d.init as EastExpression, alloc.rules(), "tos")
        assert.ok(node, `Failed to lower variable initializer for ${d.id.name}`)

        // A "tos"-demand tiling's cheapest winner always nets exactly one
        // push: every stack-combining rule only ever offers net-neutral
        // combos (PEEK_PEEK/POP_ACC, isa-core.md §4.1) — there is no
        // competing combo that nets positive by reading a stack operand
        // without reclaiming it (ir-engine.md, "Every stack-read combo
        // also reclaims its operand"), so nothing can ever outbid the
        // single net push a "tos" demand needs. A different value here
        // means that invariant broke somewhere — a real lowerer bug, not a
        // shape to accommodate.
        assert.equal(node.tosDelta, 1,
            `"tos"-demand initializer for ${d.id.name} nets tosDelta=${node.tosDelta}, expected exactly 1 — ` +
            `the winning tiling should always be a single net push; this indicates a lowerer bug, not a case to handle`)
        alloc.alloc(d.id.name)

        return node.fragment
    }).flat()
}

function lowerReturn(s: ReturnStatement, alloc: RegAlloc): RtlInstr[] 
{
    if(s.argument)
    {
        const node = lowerExpr(s.argument as EastExpression, alloc.rules(), "acc")
        assert.ok(node, `Failed to lower return expression`)
        return [...node.fragment, bare("RETURN")]
    }

    return [bare("RETURN")]
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

/**
 * Does this statement list unconditionally end control flow (so a
 * following `BLOCK_END` would be unreachable dead code)? Only the *last*
 * statement matters — anything after an unconditional terminator would
 * already be dead code in a well-formed program.
 *
 * This must be an AST-level check, not "does the compiled fragment's last
 * *instruction* happen to be RETURN/TRAP" — an `if` without an `else` can
 * end its emitted fragment with a RETURN that only fires along one path
 * (the other being the BR_TABLE implicit default), so the instruction tail
 * alone doesn't tell you whether the block truly always terminates.
 */
function alwaysTerminates(stmts: readonly Statement[]): boolean
{
    const last = stmts[stmts.length - 1]
    if(!last) return false

    switch(last.type)
    {
        case "ReturnStatement": return true
        case "IfStatement":
            return last.alternate !== null
                && controlBodyAlwaysTerminates(last.consequent)
                && controlBodyAlwaysTerminates(last.alternate)
        default: return false
    }
}

function controlBodyAlwaysTerminates(body: ControlBody): boolean
{
    return alwaysTerminates(body.type === "BlockStatement" ? body.body : [body])
}

/** Close a branch/case/loop-body fragment: omit the `BLOCK_END` when the
 *  statements it was lowered from already end control flow unconditionally
 *  (§14.3/§14.4 of isa-core.md — a terminator closes its block on its own;
 *  an explicit `BLOCK_END` after one would be dead code the validator
 *  rejects, and would find no open construct left to close). */
function closeBlock(stmts: readonly Statement[], fragment: RtlInstr[]): RtlInstr[]
{
    return alwaysTerminates(stmts) ? fragment : [...fragment, bare("BLOCK_END")]
}

function closeControlBody(body: ControlBody, fragment: RtlInstr[]): RtlInstr[]
{
    return closeBlock(body.type === "BlockStatement" ? body.body : [body], fragment)
}

function lowerIf(s: IfStatement, alloc: RegAlloc): RtlInstr[]
{
    const thenTerm = lowerControlBody(s.consequent, new RegAlloc(alloc))
    assert.ok(thenTerm, `Failed to lower then branch`)

    if(s.alternate)
    {
        const test = lowerExpr(s.test as EastExpression, alloc.rules(), "acc")
        assert.ok(test, `Failed to lower if test expression`)

        const elseTerm = lowerControlBody(s.alternate, new RegAlloc(alloc))
        assert.ok(elseTerm, `Failed to lower else branch`)

        return [
            ...test.fragment,
            brTable(2),
            ...closeControlBody(s.alternate, elseTerm),
            ...closeControlBody(s.consequent, thenTerm),
        ]
    }
    else
    {
        const test = lowerExpr(logicInvertRoot(s.test as EastExpression), alloc.rules(), "acc")
        assert.ok(test, `Failed to lower if test expression`)

        return [
            ...test.fragment,
            brTable(1),
            ...closeControlBody(s.consequent, thenTerm),
        ]
    }
}

function lowerSwitch(s: SwitchStatement, alloc: RegAlloc): RtlInstr[] 
{
    const disc = lowerExpr(s.discriminant as EastExpression, alloc.rules(), "acc")
    assert.ok(disc, `Failed to lower switch discriminant expression`)

    const cases = s.cases.filter(c => c.test !== null)
    const defaultCase = s.cases.find(c => c.test === null)
    const N = cases.length

    return [
        ...disc.fragment,
        brTable(N),
        ...cases.flatMap(c =>
        {
            const blockTerm = lowerBlock(c.consequent, new RegAlloc(alloc))
            assert.ok(blockTerm, `Failed to lower switch case`)
            return closeBlock(c.consequent, blockTerm)
        }),
        ...(defaultCase ? lowerBlock(defaultCase.consequent, new RegAlloc(alloc)) : []),
    ]
}

function lowerWhile(s: WhileStatement, alloc: RegAlloc): RtlInstr[] 
{
    const test = lowerExpr(s.test as EastExpression, alloc.rules(), "acc")
    assert.ok(test, `Failed to lower while test expression`)

    const bodyTerm = lowerControlBody(s.body, new RegAlloc(alloc))
    assert.ok(bodyTerm, `Failed to lower while body`)

    return [
        bare("LOOP"),
        ...test.fragment,
        bare("BLOCK_END"),
        ...closeControlBody(s.body, bodyTerm),
    ]
}

function lowerFor(s: ForStatement, alloc: RegAlloc): RtlInstr[] 
{
    const init: RtlInstr[] | undefined = (s.init) ? 
        (s.init.type === "VariableDeclaration") 
            ? lowerVarDecl(s.init, alloc)
            : lowerExprStmt({type: "ExpressionStatement", expression: s.init}, alloc)
        : []

    // Unlike init/update (discarded), the condition's value feeds the
    // LOOP's condition-block test directly — it must land in acc, same as
    // lowerWhile's test. Demanding acc specifically (not lowerExprStmt's
    // relaxed "any TOS-neutral output") is required here, not optional.
    const test = s.test ? (() =>
    {
        const node = lowerExpr(s.test as EastExpression, alloc.rules(), "acc")
        assert.ok(node, `Failed to lower for-loop test expression`)
        return node.fragment
    })() : []
    const update = s.update ? lowerExprStmt({type: "ExpressionStatement", expression: s.update}, alloc) : []

    const body = lowerControlBody(s.body, new RegAlloc(alloc))
    const bodyStmts = s.body.type === "BlockStatement" ? s.body.body : [s.body]

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