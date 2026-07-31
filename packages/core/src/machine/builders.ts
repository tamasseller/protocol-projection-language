/**
 * @ppl/core/machine — Rule builder utilities
 *
 * Small helpers for rule bodies: viability/ordering, SU scoring, and a
 * constructor for the RtlNode invariants (clobbers/tosDelta/maxStack). Rule
 * bodies inline everything else — child extraction, fragment concatenation,
 * op-instruction construction — because the rule author already knows what
 * the pattern matched and writing it inline documents the rule.
 */

import { COMBO } from "./combo-meta"
import type { ComboName, OutputLocation, Resource, RtlNode } from "./east"

// ——————————————————————————————————————————————
// Viability — does this ordering avoid clobber conflicts?
// ——————————————————————————————————————————————

/**
 * Does executing `later`'s fragment destroy the value at `loc` produced by
 * an earlier sibling?
 *
 * Registers are not tracked — `reg` outputs are never "destroyed" at this
 * stage (register-identity conflicts are deferred to allocation). `acc` and
 * `tos` are: a later fragment that clobbers them, or that has a net-negative
 * tos delta (pops), destroys the value.
 */
export const destroys = (later: RtlNode, loc: OutputLocation): boolean =>
    loc !== "reg" &&
    (later.clobbers.includes(loc) || (loc === "tos" && later.tosDelta < 0))

/** Does `later` destroy any of `earlier`'s declared outputs? */
export const destroysAny = (later: RtlNode, earlier: RtlNode): boolean =>
    earlier.output.some(loc => destroys(later, loc))

/**
 * Worst-case TOS depth for a two-element ordering `[a, b]`, relative to entry.
 * SU weight of the combined fragment. Lower is better.
 */
export const pairMaxStack = (a: RtlNode, b: RtlNode): number =>
    Math.max(a.maxStack, a.tosDelta + b.maxStack)

/**
 * Pick a valid ordering of two children for a binary op. Returns the
 * SU-better of `[a, b]` / `[b, a]` if both are viable; the viable one if
 * only one is; `undefined` if neither is (rule prunes the variant).
 *
 * This is the only ordering decision the lowerer ever makes: binary ops have
 * two children, and call args are pushed in source order (no reordering).
 */
export function pickBinaryOrder(a: RtlNode, b: RtlNode): [RtlNode, RtlNode] | undefined
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
export function nodeInvariants(args: {
    children: RtlNode[]
    combo: ComboName
    output: OutputLocation | OutputLocation[]
    fragment: RtlNode["fragment"]
    /** Optional extra tos delta beyond children+combo (e.g. a trailing PUSH). */
    extraTosDelta?: number
    /** Optional extra max-stack contribution (e.g. a trailing PUSH reaching
     *  one slot above the running delta). */
    extraMaxStack?: number
}): RtlNode
{
    const { children, combo, output, fragment } = args
    const meta = COMBO[combo]
    const outLocs = Array.isArray(output) ? output : [output]

    // Clobbers: union of children + the op's own, minus the output's footprint.
    const clobbers = new Set<Resource>(children.flatMap(c => c.clobbers))
    for (const r of meta.clobbers) clobbers.add(r)
    for (const loc of outLocs)
    {
        if (loc !== "reg") clobbers.delete(loc)
    }

    // tosDelta: children + op + optional extra.
    const tosDelta =
        children.reduce((s, c) => s + c.tosDelta, 0)
        + meta.tosDelta
        + (args.extraTosDelta ?? 0)

    // maxStack: SU weight across the children, then the extra contribution.
    let running = 0
    let maxStack = 0
    for (const c of children)
    {
        maxStack = Math.max(maxStack, running + c.maxStack)
        running += c.tosDelta
    }
    if (args.extraMaxStack !== undefined)
    {
        maxStack = Math.max(maxStack, running + args.extraMaxStack)
    }

    return { type: "RtlNode", output: outLocs, fragment, clobbers: [...clobbers], tosDelta, maxStack }
}
