/**
 * @ppl/machine — Expression tiling orchestrator (bottom-up memoized)
 *
 * Bottom-up rewrite search — see docs/ir-engine.md for why pattern-rewrite
 * search is used instead of Sethi-Ullman. `tileNode` recursively computes
 * every viable tiling of an EAST subtree, memoized by node identity so a
 * subtree is only ever tiled once no matter how many rules or ancestors end
 * up asking for it.
 *
 * This is not a separate bottom-up pass that finishes children before a
 * parent's rules run: a pattern's own internal structure (e.g. `Binary`
 * nested inside `Binary`) is matched directly against the raw, untiled AST
 * shape, and only a pattern's `Rtl` leaves trigger `tileNode` on the
 * subtree underneath them (see matcher.ts's `matchAllEast`). That is what
 * lets a multi-level pattern still see an intermediate node's original
 * shape rather than only its already-reduced candidate set.
 *
 * Termination: the AST is a tree with no cycles, so the recursion is
 * strictly bounded by tree depth; each node's rule-application loop tries a
 * fixed ruleset, so total work is linear in tree size times ruleset size
 * (times the cross-product width of multi-candidate pattern slots, which is
 * bounded by how many rules can produce a given output tag — a ruleset
 * property, not something that grows with tree size).
 */

import type { Rule } from "./rules"
import { matchAllEast } from "./matcher"
import type { EastMatch } from "./matcher"
import type { EastExpression, RtlNode } from "./east"
import { isRtlNode, isLiteral } from "./east"
import type { OutputLocation, ExtOpPayload } from "./rtl"
import { outputHas } from "./rtl"
import {instrBytes} from "./encoding"

export function fragmentBytes<E extends { ext: string } = ExtOpPayload>(node: RtlNode<E>): number
{
    return node.fragment.reduce((s, i) => s + instrBytes(i), 0)
}

function collectRtlNodes<E extends { ext: string } = ExtOpPayload>(m: EastMatch<E>): RtlNode<E>[]
{
    switch (m.kind)
    {
        case "Rtl": return [m.node]
        case "Binary": return [...collectRtlNodes(m.leftMatch), ...collectRtlNodes(m.rightMatch)]
        case "Unary": return collectRtlNodes(m.argumentMatch)
        case "Assign": return collectRtlNodes(m.rightMatch)
        case "Call": return m.argNodes
        case "BuiltinCall": return [...m.argumentMatches.flatMap(collectRtlNodes), ...(m.tailMatches ?? []).flatMap(collectRtlNodes)]
        default: return [] // Literal, Identifier — no RTL children
    }
}

/**
 * Does `b` make `a` pointless — no worse on every axis a consumer further
 * up the tree can observe, and strictly better on at least one? Consumers
 * only ever look at `output` (as an exact-tag lookup), `fragment`'s byte
 * cost, `maxStack`, and `clobbers` (via `destroys`/`destroysAny`,
 * builders.ts) — `tosDelta` isn't a separate axis because it's already
 * fixed once `output` is fixed (every rule producing a given output tag
 * nets the same tos effect). Only candidates with the *same* `output` are
 * compared: a `{reg: N}`-tagged candidate doesn't compete with an
 * `"acc"`-tagged one, since a future demand for one can never be satisfied
 * by the other.
 */
function dominates<E extends { ext: string } = ExtOpPayload>(b: RtlNode<E>, a: RtlNode<E>): boolean
{
    if (!b.clobbers.every(r => a.clobbers.includes(r))) return false
    const bBytes = fragmentBytes(b), aBytes = fragmentBytes(a)
    if (bBytes > aBytes || b.maxStack > a.maxStack) return false
    return bBytes < aBytes || b.maxStack < a.maxStack || b.clobbers.length < a.clobbers.length
}

/**
 * Reduce `candidates` to a Pareto frontier per exact output tag-set. This
 * is what caps a node's contribution to a parent's cross product at a
 * small constant instead of letting it grow with the subtree underneath.
 *
 * Two steps, not one: first collapse exact cost ties (same bytes, maxStack,
 * *and* clobbers) to a single representative, then apply strict domination
 * across what's left. The first step matters on its own — a wide
 * commutative tree has many evaluation orders that cost exactly the same
 * (e.g. `x + y`'s `LOAD x; ADD y` and `LOAD y; ADD x`), and none of those
 * dominates another (`dominates` requires a strict improvement), so without
 * collapsing ties first, every one of them survives and multiplies at the
 * next level up. Once ties are collapsed, `clobbers ⊆ {"acc", "tos"}`
 * bounds the rest to at most 4 clobber-subsets per tag, each contributing
 * only its own (bytes, maxStack) frontier — a small constant, not something
 * that grows with the subtree.
 *
 * Safe to do locally, at every node, because `nodeInvariants` composes
 * bytes additively and maxStack/clobbers monotonically up the tree:
 * substituting a same-cost or dominating candidate for another anywhere
 * inside a larger tiling can only match or beat the original, never lose
 * to it — the same monotonicity argument optimal bottom-up tree-pattern
 * selection (BURS-style instruction selection) relies on. See
 * docs/ir-engine.md.
 */
/**
 * `candidates` may now mix real `RtlNode` tilings with `fold:*`-produced
 * `Literal`s (rules.ts) — the two aren't comparable (a folded constant has
 * no fragment/clobbers/maxStack to prune on) so they're handled separately:
 * the existing cost frontier runs over the `RtlNode`s only, and folded
 * candidates are just deduped by value (at most one distinct value can ever
 * apply per node — there's no cost dimension to break a tie on).
 */
function pruneToFrontier<E extends { ext: string } = ExtOpPayload>(candidates: EastExpression<E>[]): EastExpression<E>[]
{
    const rtlCandidates = candidates.filter(isRtlNode)
    const foldedCandidates = candidates.filter(c => !isRtlNode(c))

    const groups = new Map<string, RtlNode<E>[]>()
    for (const c of rtlCandidates)
    {
        const key = JSON.stringify(c.output)
        const group = groups.get(key)
        if (group) group.push(c)
        else groups.set(key, [c])
    }

    const kept: EastExpression<E>[] = []
    for (const group of groups.values())
    {
        const byCostPoint = new Map<string, RtlNode<E>>()
        for (const c of group)
        {
            const costKey = `${fragmentBytes(c)}|${c.maxStack}|${[...c.clobbers].sort()}`
            if (!byCostPoint.has(costKey)) byCostPoint.set(costKey, c)
        }
        const reps = [...byCostPoint.values()]
        for (const a of reps)
            if (!reps.some(b => b !== a && dominates(b, a)))
                kept.push(a)
    }

    const seenValues = new Set<number>()
    for (const c of foldedCandidates)
    {
        if (!isLiteral(c) || seenValues.has(c.value)) continue
        seenValues.add(c.value)
        kept.push(c)
    }

    return kept
}

/**
 * Every viable tiling of `node`, memoized by object identity in `memo`. An
 * already-tiled `RtlNode` (a leaf passed in as-is, e.g. by a caller that
 * pre-tiled part of the tree) is returned unchanged. Otherwise every rule
 * is tried against `node`; `matchAllEast` resolves each pattern's `Rtl`
 * leaves by recursing into this same function (memoized), so a subtree
 * shared by several rules' patterns — or asked for by both this node's own
 * rules and some rule higher up the tree — is only ever computed once. The
 * result is pruned to a Pareto frontier before caching, so a dominated
 * candidate (e.g. a stack-bridge combo that a register combo always beats
 * when both are available) never survives to inflate a parent's search —
 * see `pruneToFrontier`. This means `tileNode`/`tileExpr` no longer return
 * *every* structurally-realizable tiling, only the cost-relevant ones.
 */
function tileNode<E extends { ext: string } = ExtOpPayload>(node: EastExpression<E>, rules: readonly Rule<E>[], memo: WeakMap<EastExpression<E>, EastExpression<E>[]>): EastExpression<E>[]
{
    if (isRtlNode(node)) return [node]

    const cached = memo.get(node)
    if (cached) return cached

    const results: EastExpression<E>[] = []
    const tile = (n: EastExpression<E>) => tileNode(n, rules, memo)

    for (const r of rules)
    {
        const matches = matchAllEast(node, r.pattern, tile)
        for (const m of matches)
        {
            const built = r.build(m as any)
            if (!built) continue   // realizability prune

            const inherited = collectRtlNodes(m).flatMap(c => [...(nodeRuleNames.get(c) ?? [])])
            nodeRuleNames.set(built, new Set([r.name, ...inherited]))

            // A `fold:*` rule (rules.ts) has no cost-based "winner" the way
            // an RtlNode does — it either applies or it doesn't, so its
            // coverage is recorded the moment it successfully builds, not
            // via `pickCheapest`'s later selection (touchedRuleNames below).
            if (!isRtlNode(built)) touchedRuleNames.add(r.name)

            results.push(built)
        }
    }

    const pruned = pruneToFrontier(results)
    memo.set(node, pruned)
    return pruned
}

// ── Rule-coverage provenance ────────────────────────────────────────────────
//
// Keyed by rule *name* (rules.ts), not the Rule object itself: `ruleset()`
// builds fresh Rule objects (new closures) on every call — once per scope
// in the real lowerer, once for DEFAULT_RULESET in tests — so the same
// conceptual rule never has stable object identity across calls. The name
// does, by construction.

/** Which rule(s) — transitively, including children — built each tile
 *  candidate (`RtlNode` or `fold:*`'s `Literal`) ever produced by `tileNode`.
 *  Process-wide (not per-call): a WeakMap costs
 *  nothing once a node is unreferenced, and sharing it is what lets
 *  `touchedRuleNames` below accumulate across the whole test suite rather
 *  than one call at a time. */
const nodeRuleNames = new WeakMap<object, ReadonlySet<string>>()

/**
 * Rule names that have appeared in a node `lowerExpr` actually selected as
 * its winning tiling, accumulated across every `lowerExpr` call in the
 * process. This is the coverage signal: "did some real lowering choose
 * this rule's output," not merely "could the search construct a variant
 * using it" (most rules can construct *some* variant; most of those lose
 * on cost). See test/rule-coverage.test.ts.
 */
export const touchedRuleNames = new Set<string>()

export function tileExpr<E extends { ext: string } = ExtOpPayload>(expr: EastExpression<E>, rules: readonly Rule<E>[], demand?: OutputLocation): RtlNode<E>[]
{
    const memo = new WeakMap<EastExpression<E>, EastExpression<E>[]>()
    const results = tileNode(expr, rules, memo).filter(isRtlNode)
    return demand ? results.filter(n => outputHas(n.output, demand)) : results
}

/** Cheapest-by-byte-count pick among an already-filtered variant set, with
 *  the winner's rule provenance recorded into `touchedRuleNames`. Shared by
 *  `lowerExpr` (demand-filtered via `tileExpr`) and `lowerStatementExpr`
 *  (custom-filtered — see there for why demand filtering alone isn't right
 *  for a discarded-value expression statement). */
function pickCheapest<E extends { ext: string } = ExtOpPayload>(variants: readonly RtlNode<E>[]): RtlNode<E> | undefined
{
    if (variants.length === 0) return undefined

    const best = variants.reduce((best, v) =>
    {
        const vc = fragmentBytes(v), bc = fragmentBytes(best)
        if (vc < bc) return v
        if (vc > bc) return best
        if (v.fragment.length < best.fragment.length) return v
        if (v.fragment.length > best.fragment.length) return best
        return v.maxStack < best.maxStack ? v : best
    })

    for (const name of nodeRuleNames.get(best) ?? []) touchedRuleNames.add(name)

    return best
}

export function lowerExpr<E extends { ext: string } = ExtOpPayload>(expr: EastExpression<E>, rules: readonly Rule<E>[], demand?: OutputLocation): RtlNode<E> | undefined
{
    return pickCheapest(tileExpr(expr, rules, demand))
}

/**
 * Lower an expression whose value is discarded (an `ExpressionStatement`).
 * Demanding `"acc"` (as `lowerExpr` would) is *too strict* — it excludes
 * legitimately cheaper tilings whose result lands directly in a register
 * write-back (e.g. `x = x op e` folding to `regOperandRules`' REG_REG
 * variant, output `{reg: x}`, no `"acc"` at all — see rules.ts). But no
 * demand at all is *too loose*: a `"tos"`-only variant would leave a value
 * pushed with nothing to ever pop it, leaking a stack slot every time the
 * statement runs. The correct filter is structural: any output location
 * other than `"tos"` is TOS-neutral and safe to discard.
 */
export function lowerStatementExpr<E extends { ext: string } = ExtOpPayload>(expr: EastExpression<E>, rules: readonly Rule<E>[]): RtlNode<E> | undefined
{
    const variants = tileExpr(expr, rules).filter(v => v.output.some(loc => loc !== "tos"))
    return pickCheapest(variants)
}
