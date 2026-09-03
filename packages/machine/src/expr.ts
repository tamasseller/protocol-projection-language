/**
 * @ppl/machine — Expression lowering, everything after the lift
 *
 * `tileExpression` is the back half of the expression pipeline (desugar.ts
 * and lift.ts are the front, lower.ts's `lowerExpression` the caller):
 * annotate types, then tile under a demand. Every expression site in the
 * DSL goes through it, differing only in that demand; when nothing tiles,
 * explain.ts works out why.
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
    /** Names this site in the failure message. */
    what: string
}

export function tileExpression<E extends { ext: string } = ExtOpPayload>(expr: Expression, scope: RegAlloc<E>, req: TileRequest): RtlNode<E>
{
    const typed = req.into !== undefined
        ? annotateInto(expr, scope, req.into)
        : annotate(expr, scope, req.demand !== "statement")

    const east = typed as EastExpression<E>
    const node = req.demand === "statement"
        ? lowerStatementExpr(east, scope.rules())
        : lowerExpr(east, scope.rules(), req.demand)

    if(!node) throw new Error(`Failed to lower ${req.what}: ${explainFailure(typed, scope, req.demand)}`)

    return node
}

/** `trap(code)` — like `return`, a terminator (isa-core.md §4.5), but
 *  parsed as an ordinary call (§10.5: `trap` is a function, not a
 *  keyword), so there's no dedicated AST node to switch on; it's
 *  recognized structurally by callee name instead. */
export function isTrapCall(expr: Expression): boolean
{
    return expr.type === "CallExpression" && expr.callee.name === "trap"
}

/** Terminates instead of producing a value — a `trap`, or a ternary whose
 *  every arm is one, which §4.5 leaves with no edge into the merge. */
export function neverProduces(expr: Expression): boolean
{
    return isTrapCall(expr)
        || (expr.type === "ConditionalExpression" && neverProduces(expr.consequent) && neverProduces(expr.alternate))
}
