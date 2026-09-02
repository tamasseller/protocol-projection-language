/**
 * @ppl/machine — Desugaring, the expression pipeline's first phase
 *
 * Pure AST → AST, no scope and no instructions: the operators that are
 * defined in terms of other operators are rewritten into them here, so
 * every later phase sees one spelling of each thing.
 *
 *   a op= e     →  a = a op e         (the target is always an Identifier,
 *                                      so evaluating it twice is free)
 *   ++a / --a   →  a = a ± 1          (yields the new value, as C does)
 *   a++ / a--   →  a = a ± 1          only where the value is discarded;
 *                                      otherwise left for the lift, which
 *                                      is what can keep the old one
 *   !e          →  e == 0             there is no logical-NOT opcode
 *   +e          →  e                  identity; the promotion it carries in
 *                                      C is types.ts's job either way
 *   a && b      →  a ? (b != 0) : 0   short-circuit, via the one construct
 *   a || b      →  a ? 1 : (b != 0)   that already evaluates conditionally;
 *                                     the `!= 0` is dropped where the right
 *                                     operand is a comparison, which §4.2
 *                                     already guarantees is 0 or 1
 */

import type {Expression, Identifier, AssignmentOperator, BinaryOperator, UpdateExpression} from "./ast"
import {mapOver} from "./ast"

const num = (value: number): Expression => ({type: "Literal", value, raw: String(value)})

const binary = (operator: BinaryOperator, left: Expression, right: Expression): Expression =>
    ({type: "BinaryExpression", operator, left, right})

const assign = (left: Identifier, right: Expression): Expression =>
    ({type: "AssignmentExpression", operator: "=", left, right})

const COMPARISONS: ReadonlySet<BinaryOperator> = new Set<BinaryOperator>(["==", "!=", "<=", ">=", "<", ">"])

/** Normalising to 0/1 is a no-op on something isa-core.md §4.2 already
 *  guarantees is 0 or 1. */
const normalize = (e: Expression): Expression =>
    e.type === "BinaryExpression" && COMPARISONS.has(e.operator) ? e : binary("!=", e, num(0))

/** `a op= e` → `a = a op e`: the compound operator's own name, minus `=`. */
const compoundOp = (op: AssignmentOperator): BinaryOperator =>
    op.slice(0, -1) as BinaryOperator

function stepTarget(e: UpdateExpression): Identifier
{
    if(e.argument.type !== "Identifier")
        throw new Error(`Operand of ${e.operator} must be a variable`)

    return e.argument
}

/** `a++` / `--a` where only the effect matters. */
function step(e: UpdateExpression): Expression
{
    const target = stepTarget(e)
    return assign(target, binary(e.operator === "++" ? "+" : "-", target, num(1)))
}

/**
 * `valueUsed` is false only for the one expression whose result is
 * discarded — an expression statement, or a `for` update. It is what makes
 * `i++` there an ordinary increment rather than something needing a slot
 * to hold the old value in.
 */
export function desugar(expr: Expression, valueUsed: boolean = true): Expression
{
    // Children first: `!(a && b)` has to see the rewritten `&&`, and an
    // arm of a `&&`'s own ternary has to be rewritten before it becomes one.
    const e = mapOver(expr, c => desugar(c, true))

    switch(e.type)
    {
        case "AssignmentExpression":
            return e.operator === "="
                ? e
                : assign(e.left, binary(compoundOp(e.operator), e.left, e.right))

        case "UpdateExpression":
            stepTarget(e)
            // A postfix step whose value *is* used keeps the old one, which
            // takes a slot — so it stays for the lift.
            return (e.prefix || !valueUsed) ? step(e) : e

        case "UnaryExpression":
            return e.operator === "!" ? binary("==", e.argument, num(0))
                : e.operator === "+" ? e.argument
                : e

        case "LogicalExpression":
            return {
                type: "ConditionalExpression",
                test: e.left,
                consequent: e.operator === "&&" ? normalize(e.right) : num(1),
                alternate: e.operator === "&&" ? num(0) : normalize(e.right),
            }

        default:
            return e
    }
}
