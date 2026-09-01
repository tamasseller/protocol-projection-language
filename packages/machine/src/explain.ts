/**
 * @ppl/machine — Why a tiling failed
 *
 * A rule that does not apply returns no candidate, so by the time the
 * tiler gives up, the reason is gone: an operator with no opcode, a name
 * that resolves to nothing and operands that could not be arranged all
 * look alike from the inside. This reconstructs the reason from the
 * source, and runs only on the failure path (expr.ts's `tileExpression`).
 */

import type {Expression} from "./ast"
import {recurseOver} from "./ast"
import type {EastExpression} from "./east"
import type {RegAlloc} from "./scope"
import type {Demand} from "./expr"
import {tileExpr} from "./orchestrator"
import {LOWERED_BINARY_OPS, LOWERED_UNARY_OPS} from "./rules"
import type {Rule} from "./rules"
import type {BuiltinCallPattern} from "./matcher"

/** The reason `expr` could not be tiled, in terms of the source. */
export function explainFailure<E extends { ext: string }>(expr: Expression, scope: RegAlloc<E>, demand: Demand): string
{
    const rules = scope.rules()
    const culprit = deepestUntileable(expr, rules)

    if(culprit) return describeUntileable(culprit, scope, rules)

    // Every part of it tiles; what failed was the demand this site puts on
    // the whole — the value has to end up somewhere specific.
    return demand === "statement"
        ? `every tiling of it leaves a value on the stack, which nothing here would pop`
        : `no tiling leaves its value in ${demand}`
}

/** The innermost sub-expression nothing tiles at all: every failure above
 *  it is a consequence of that one. */
function deepestUntileable<E extends { ext: string }>(e: Expression, rules: readonly Rule<E>[]): Expression | undefined
{
    const inChild = recurseOver<Expression | undefined, Expression | undefined>(
        e, c => deepestUntileable(c, rules), (...v) => v.find(x => x !== undefined), undefined)

    if(inChild) return inChild

    try { return tileExpr(e as EastExpression<E>, rules).length === 0 ? e : undefined }
    catch { return e }
}

function describeUntileable<E extends { ext: string }>(node: Expression, scope: RegAlloc<E>, rules: readonly Rule<E>[]): string
{
    switch(node.type)
    {
        // `identifier:acc`/`:tos` are the only rules for one, and both
        // decline exactly when the name resolves to no register.
        case "Identifier":
            return `unknown variable '${node.name}'`

        case "BinaryExpression":
            return LOWERED_BINARY_OPS.has(node.operator)
                ? `nothing tiles '${node.operator}' with these operands`
                : `no lowering for '${node.operator}'${node.operator === "/" || node.operator === "%"
                    ? ` — the ISA has no divide (isa-core.md §4.1)` : ``}`

        case "UnaryExpression":
            return LOWERED_UNARY_OPS.has(node.operator)
                ? `nothing tiles unary '${node.operator}' with this operand`
                : `no lowering for unary '${node.operator}'`

        case "CallExpression":
            return describeCall(node.callee.name, node.arguments.length, scope, rules)

        default:
            return `nothing lowers a ${node.type}`
    }
}

const builtinFormsOf = <E extends { ext: string }>(name: string, rules: readonly Rule<E>[]): BuiltinCallPattern[] =>
    rules.map(r => r.pattern)
        .filter((p): p is BuiltinCallPattern => p.kind === "BuiltinCall" && p.name === name)

/** Built-ins (and an extension's own call-shaped ops) are matched by name
 *  and argument shape, so the ruleset itself says which forms exist. */
function describeCall<E extends { ext: string }>(name: string, argCount: number, scope: RegAlloc<E>, rules: readonly Rule<E>[]): string
{
    const forms = builtinFormsOf(name, rules)

    if(forms.length === 0)
        return scope.resolveCallee(name, argCount) === undefined
            ? `unknown procedure or built-in '${name}'`
            : `nothing tiles the arguments of '${name}'`

    const arities = [...new Set(forms.map(f => f.arguments.length))].sort()
    if(!arities.includes(argCount))
        return `'${name}' takes ${arities.join(" or ")} argument${arities.length === 1 && arities[0] === 1 ? "" : "s"}, not ${argCount}`

    return forms.some(f => f.arguments.some(a => a.kind === "Const"))
        ? `'${name}' needs a compile-time constant where this call has an expression`
        : `nothing tiles the arguments of '${name}'`
}
