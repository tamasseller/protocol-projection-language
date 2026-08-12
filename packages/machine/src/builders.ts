/**
 * @ppl/machine — Rule builder utilities
 *
 * Small helpers for rule bodies: viability/ordering, SU scoring, and a
 * constructor for the RtlNode invariants (clobbers/tosDelta/maxStack). Rule
 * bodies inline everything else — child extraction, fragment concatenation,
 * op-instruction construction — because the rule author already knows what
 * the pattern matched and writing it inline documents the rule.
 */

import { COMBO } from "./rtl"
import type { ComboName, OutputLocation, Resource, ExtOpPayload } from "./rtl"
import type { RtlNode } from "./east"

// ——————————————————————————————————————————————
// Viability — does this ordering avoid clobber conflicts?
// ——————————————————————————————————————————————

/** Does `loc` name a register slot (`{reg: number}`) rather than `acc`/`tos`? */
const isRegLocation = (loc: OutputLocation): loc is { reg: number } =>
    typeof loc === "object"

/**
 * Does executing `later`'s fragment destroy the value at `loc` produced by
 * an earlier sibling?
 *
 * Registers are not tracked — `reg` outputs are never "destroyed" at this
 * stage (register-identity conflicts are deferred to allocation). `acc` and
 * `tos` are: a later fragment that clobbers them, or that has a net-negative
 * tos delta (pops), destroys the value.
 */
export const destroys = <E extends { ext: string } = ExtOpPayload>(later: RtlNode<E>, loc: OutputLocation): boolean =>
    !isRegLocation(loc) &&
    (later.clobbers.includes(loc) || (loc === "tos" && later.tosDelta < 0))

/** Does `later` destroy any of `earlier`'s declared outputs? */
export const destroysAny = <E extends { ext: string } = ExtOpPayload>(later: RtlNode<E>, earlier: RtlNode<E>): boolean =>
    earlier.output.some(loc => destroys(later, loc))

/**
 * Worst-case TOS depth for a two-element ordering `[a, b]`, relative to entry.
 * SU weight of the combined fragment. Lower is better.
 */
export const pairMaxStack = <E extends { ext: string } = ExtOpPayload>(a: RtlNode<E>, b: RtlNode<E>): number =>
    Math.max(a.maxStack, a.tosDelta + b.maxStack)

/**
 * Pick a valid ordering of two children for a binary op. Returns the
 * SU-better of `[a, b]` / `[b, a]` if both are viable; the viable one if
 * only one is; `undefined` if neither is (rule prunes the variant).
 *
 * This is the only ordering decision the lowerer ever makes: binary ops have
 * two children, and call args are pushed in source order (no reordering).
 */
export function pickBinaryOrder<E extends { ext: string } = ExtOpPayload>(a: RtlNode<E>, b: RtlNode<E>): [RtlNode<E>, RtlNode<E>] | undefined
{
    if (destroysAny(b, a))
    {
        if (destroysAny(a, b)) return undefined
        return [b, a]
    }
    if (destroysAny(a, b)) return [a, b]
    return pairMaxStack(a, b) <= pairMaxStack(b, a) ? [a, b] : [b, a]
}

// ——————————————————————————————————————————————
// RtlNode invariant construction
// ——————————————————————————————————————————————

/**
 * Compute the four RtlNode invariants from the rule's perspective:
 * `output`, `clobbers`, `tosDelta`, `maxStack`. The rule body supplies the
 * raw materials (child clobbers, child tos deltas, the combo, the output
 * location, the fragment's max stack if known); this helper applies the
 * uniform arithmetic (subtract output footprint, sum deltas, attach the
 * combo's own contribution).
 *
 * `fragment` is passed through unchanged.
 */
export function nodeInvariants<E extends { ext: string } = ExtOpPayload>(args: {
    children: RtlNode<E>[]
    combo: ComboName
    output: OutputLocation | OutputLocation[]
    fragment: RtlNode<E>["fragment"]
    /** Optional extra tos delta beyond children+combo (e.g. a trailing PUSH). */
    extraTosDelta?: number
    /** Optional extra max-stack contribution (e.g. a trailing PUSH reaching
     *  one slot above the running delta). */
    extraMaxStack?: number
}): RtlNode<E>
{
    const { children, combo, output, fragment } = args
    const meta = COMBO[combo]
    const outLocs = Array.isArray(output) ? output : [output]

    // Clobbers: union of children + the op's own, minus the output's footprint.
    const clobbers = new Set<Resource>(children.flatMap(c => c.clobbers))
    for (const r of meta.clobbers) clobbers.add(r)
    for (const loc of outLocs)
    {
        if (!isRegLocation(loc)) clobbers.delete(loc)
    }

    // tosDelta: children + op + optional extra.
    const tosDelta =
        children.reduce((s, c) => s + c.tosDelta, 0)
        + meta.tosDelta
        + (args.extraTosDelta ?? 0)

    // maxStack: SU weight across the children, then any extra beyond the
    // combo itself. The combo's own tosDelta is never positive (every
    // binary-class combo either writes back in place or pops — see
    // ir-engine.md, "Every stack-read combo also reclaims its operand"),
    // so it can only ever draw down from a peak the children already
    // established, never raise one — no separate term needed for it here.
    let running = 0
    let maxStack = 0
    for (const c of children)
    {
        maxStack = Math.max(maxStack, running + c.maxStack)
        running += c.tosDelta
    }
    running += meta.tosDelta
    if (args.extraMaxStack !== undefined)
    {
        maxStack = Math.max(maxStack, running + args.extraMaxStack)
    }

    return { type: "RtlNode", output: outLocs, fragment, clobbers: [...clobbers], tosDelta, maxStack }
}
