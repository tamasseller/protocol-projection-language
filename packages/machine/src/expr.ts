/**
 * @ppl/machine — Expression lowering, everything after the lift
 *
 * `tileExpression` is the back half of the expression pipeline (desugar.ts
 * and lift.ts are the front, lower.ts's `lowerExpression` the caller):
 * annotate types, optionally invert for a dispatch test, then tile under a
 * demand. Every expression site in the DSL goes through it, differing only
 * in that demand; when nothing tiles, explain.ts works out why.
 */

import type {Expression, PrimType} from "./ast"
import type {EastExpression} from "./east"
import type {RtlNode} from "./east"
import type {ExtOpPayload} from "./rtl"
import type {RegAlloc} from "./scope"
import {lowerExpr, lowerStatementExpr} from "./orchestrator"
import {annotate, annotateInto} from "./types"
import {explainFailure} from "./explain"

/**
 * Where a tiled value has to land.
 *
 * `"statement"` is the relaxed demand for a discarded value: not `"acc"`,
 * which would exclude a cheaper tiling that writes a register directly
 * (`x = x op e`, rules.ts), and not "no demand at all", which would admit
 * a `"tos"`-only variant that leaks a stack slot — see
 * `lowerStatementExpr`.
 */
export type Demand = "acc" | "tos" | "statement"

export interface TileRequest
{
    demand: Demand
    /** A declaration's declared type: narrow the value into it (types.ts). */
    into?: PrimType
    /** Emit the complementary comparison — for a value that is about to be
     *  a `BR_TABLE` dispatch index (isa-core.md §7.3). */
    invert?: boolean
    /** Names this site in the failure message. */
    what: string
}

export function tileExpression<E extends { ext: string } = ExtOpPayload>(expr: Expression, scope: RegAlloc<E>, req: TileRequest): RtlNode<E>
{
    const typed = req.into !== undefined
        ? annotateInto(expr, scope, req.into)
        : annotate(expr, scope)

    const east = (req.invert ? logicInvertRoot(typed as EastExpression) : typed) as EastExpression<E>

    const node = req.demand === "statement"
        ? lowerStatementExpr(east, scope.rules())
        : lowerExpr(east, scope.rules(), req.demand)

    if(!node) throw new Error(`Failed to lower ${req.what}: ${explainFailure(typed, scope, req.demand)}`)

    return node
}

/**
 * The complementary comparison (isa-core.md §7.3). `BR_TABLE` is
 * index-exact (§4.5), not a lenient truthy test, so a dispatch value must
 * be exactly 0 or 1 — which a comparison is — and inverting puts the
 * "true" arm at `case[0]`, §7.1's arm order.
 */
export function logicInvertRoot(expr: EastExpression): EastExpression
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

/** `trap(code)` — like `return`, a terminator (isa-core.md §4.5), but
 *  parsed as an ordinary call (§10.5: `trap` is a function, not a
 *  keyword), so there's no dedicated AST node to switch on; it's
 *  recognized structurally by callee name instead. */
export function isTrapCall(expr: Expression): boolean
{
    return expr.type === "CallExpression" && expr.callee.name === "trap"
}
