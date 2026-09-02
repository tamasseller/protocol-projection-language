/**
 * @ppl/machine — The lift, the expression pipeline's second phase
 *
 * Two constructs cannot be tiled where they stand, because each needs a
 * register of its own to carry a value the tiler has no way to hold. Both
 * are emitted ahead of the expression they sit in, leaving an ordinary
 * local reference behind:
 *
 *   a ? b : c   nothing in the tiler can emit control flow. One that *is*
 *               the whole expression keeps its value in acc across the
 *               merge (isa-core.md §8.7, `conditionalToAcc`); one nested
 *               inside a larger expression cannot, since something else
 *               runs before the consumer, so it writes a slot — reserved
 *               *before* the dispatch, since one pushed inside a case is
 *               dropped again by that case's own `BLOCK_END` (§8.1).
 *
 *   a++         the value is the one from *before* the step, so it has to
 *               be kept somewhere while `a` moves on. `PUSH` reserves the
 *               slot and fills it in the same instruction.
 */

import type {Expression, ConditionalExpression, UpdateExpression, Identifier} from "./ast"
import {recurseOver, mapOver} from "./ast"
import type {PrimType} from "./ast"
import type {ExtOpPayload, RtlInstr} from "./rtl"
import {bare, brTable, PUSH, STORE} from "./rtl"
import {RegAlloc} from "./scope"
import {tileExpression, isTrapCall, neverProduces} from "./expr"
import {typeOfExpr} from "./types"
import {desugar} from "./desugar"

/**
 * Lift what has to move out of `expr`, returning the code to emit ahead of
 * it and what is left once each lifted construct has become a reference to
 * the slot it wrote.
 *
 * Lifting only moves evaluation across operands of one expression, which C
 * leaves unsequenced; a lift inside a ternary's arm goes into that arm's
 * own block instead, so it stays conditional.
 */
export function lift<E extends { ext: string } = ExtOpPayload>(expr: Expression, alloc: RegAlloc<E>): {prelude: RtlInstr<E>[]; expr: Expression}
{
    if(!needsLift(expr)) return {prelude: [], expr}

    const prelude: RtlInstr<E>[] = []
    return {prelude, expr: hoist(expr, alloc, prelude)}
}

/** A prefix `++`/`--` never reaches here — desugar.ts rewrites it, as it
 *  does a postfix one whose value is discarded. What is left is a postfix
 *  step someone reads. */
function needsLift(e: Expression): boolean
{
    return e.type === "ConditionalExpression"
        || (e.type === "UpdateExpression" && !e.prefix)
        || recurseOver(e, needsLift, (...v) => v.includes(true), false)
}

function hoist<E extends { ext: string } = ExtOpPayload>(e: Expression, alloc: RegAlloc<E>, out: RtlInstr<E>[]): Expression
{
    if(!needsLift(e)) return e

    switch(e.type)
    {
        case "ConditionalExpression": return hoistConditional(e, alloc, out)
        case "UpdateExpression": return hoistPostfixStep(e, alloc, out)
        default: return mapOver(e, c => hoist(c, alloc, out))
    }
}

function hoistPostfixStep<E extends { ext: string } = ExtOpPayload>(e: UpdateExpression, alloc: RegAlloc<E>, out: RtlInstr<E>[]): Identifier
{
    // `LOAD a | PUSH`: the slot is reserved and holds the pre-step value,
    // one instruction each, before `a` is touched.
    const before = tileExpression(e.argument, alloc, {demand: "tos", what: `operand of postfix ${e.operator}`})

    const name = `?${alloc.depth}`
    alloc.alloc(name, typeOfExpr(e.argument, alloc))

    // `desugar(e, false)` is this same step with its value discarded —
    // exactly the assignment to emit, now that the old value is kept.
    const step = tileExpression(desugar(e, false), alloc, {demand: "statement", what: `postfix ${e.operator}`})

    out.push(...before.fragment, ...step.fragment)
    return {type: "Identifier", name}
}

/**
 * A ternary whose value the site wants in acc (or pushed from it): every
 * edge into a dispatch merge is a case body that establishes acc, so it
 * survives (isa-core.md §8.7). No slot, no `PUSH` ahead of the test, no
 * `STORE` per arm, no `LOAD` after — which is the whole difference between
 * this and `hoistConditional`.
 *
 * Only valid where nothing runs between the merge and the consumer, so
 * lower.ts calls it for a ternary that *is* the whole expression; one
 * nested inside a larger one still goes to a slot.
 */
export function conditionalToAcc<E extends { ext: string } = ExtOpPayload>(e: ConditionalExpression, alloc: RegAlloc<E>, into?: PrimType): RtlInstr<E>[]
{
    if(neverProduces(e)) throw new Error("A ternary whose arms all trap has no value to use")

    const out: RtlInstr<E>[] = []
    const test = tileExpression(hoist(e.test, alloc, out), alloc,
        {demand: "acc", what: "ternary condition"})

    return [
        ...out,
        ...test.fragment,
        brTable(1),
        ...accArm(e.alternate, new RegAlloc<E>(alloc), into),
        ...accArm(e.consequent, new RegAlloc<E>(alloc), into),
    ]
}

/**
 * `x = c ? a : b`: `conditionalToAcc`'s shape with the assignment's own
 * `STORE` once after the merge, in place of the `PUSH`, the `STORE` per arm
 * and the `LOAD` a slot costs. `STORE` leaves acc live, so a site wanting
 * the assignment's value as well still gets it.
 *
 * Undefined for anything else, and for a target `into` the caller has to
 * narrow to afterwards — the arms are already coerced to the variable's own
 * type, and there is nowhere left to apply a second conversion.
 */
export function assignedConditionalToAcc<E extends { ext: string } = ExtOpPayload>(e: Expression, alloc: RegAlloc<E>): RtlInstr<E>[] | undefined
{
    if(e.type !== "AssignmentExpression" || e.operator !== "=" || e.right.type !== "ConditionalExpression") return undefined

    const slot = alloc.resolve(e.left.name)
    if(slot === undefined) return undefined

    return [...conditionalToAcc(e.right, alloc, typeOfExpr(e, alloc)), STORE<E>(slot)]
}

/** Like `ternaryArm`, but the arm's value stays in acc rather than being
 *  stored — see `conditionalToAcc`. */
function accArm<E extends { ext: string } = ExtOpPayload>(arm: Expression, scope: RegAlloc<E>, into?: PrimType): RtlInstr<E>[]
{
    const inner: RtlInstr<E>[] = []
    const node = tileExpression(hoist(arm, scope, inner), scope, {demand: "acc", into, what: "ternary arm"})

    return isTrapCall(arm)
        ? [...inner, ...node.fragment]
        : [...inner, ...node.fragment, bare("BLOCK_END")]
}

function hoistConditional<E extends { ext: string } = ExtOpPayload>(e: ConditionalExpression, alloc: RegAlloc<E>, out: RtlInstr<E>[]): Identifier
{
    const test = tileExpression(hoist(e.test, alloc, out), alloc,
        {demand: "acc", what: "ternary condition"})

    // The reserving PUSH carries the test value — arbitrary, since both
    // arms overwrite the slot, and `PUSH` leaves acc live for the dispatch.
    const name = `?${alloc.depth}`
    const slot = alloc.alloc(name, typeOfExpr(e, alloc))

    out.push(
        ...test.fragment,
        PUSH<E>(),
        brTable(1),
        ...ternaryArm(e.alternate, slot, new RegAlloc<E>(alloc)),
        ...ternaryArm(e.consequent, slot, new RegAlloc<E>(alloc)),
    )

    return {type: "Identifier", name}
}

function ternaryArm<E extends { ext: string } = ExtOpPayload>(arm: Expression, slot: number, scope: RegAlloc<E>): RtlInstr<E>[]
{
    const inner: RtlInstr<E>[] = []
    const node = tileExpression(hoist(arm, scope, inner), scope, {demand: "acc", what: "ternary arm"})

    // A `trap(...)` arm closes its own case (isa-core.md §4.5); a
    // `STORE`/`BLOCK_END` after it would be unreachable, and the stray
    // `BLOCK_END` would be read as the *next* case's close.
    return isTrapCall(arm)
        ? [...inner, ...node.fragment]
        : [...inner, ...node.fragment, STORE<E>(slot), bare("BLOCK_END")]
}
