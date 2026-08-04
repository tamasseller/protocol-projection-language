/**
 * @ppl/core/machine — Expression tiling orchestrator (worklist-based)
 *
 * Bottom-up rewrite search — see docs/ir-engine.md for why pattern-rewrite
 * search is used instead of Sethi-Ullman. Maintains a worklist of
 * partially-tiled EAST trees; each iteration pops one, finds all rule
 * matches at any node,
 * rewrites one match site, and pushes the result. Fully-tiled trees (root
 * is an RtlNode) accumulate into the results set.
 *
 * Termination: every rule replaces ≥1 DSL node with exactly one RTL-AST
 * node, so the DSL-node count strictly decreases.
 *
 * Correct for deep/multi-level patterns and for restructuring rules — not
 * just shallow rules. Cost-pruning could be added to the worklist loop.
 */

import type { Rule } from "./rules"
import { matchEast } from "./matcher"
import type { EastMatch } from "./matcher"
import type { EastExpression, RtlNode, EastBinary, EastUnary, EastAssign, EastCall } from "./east"
import {
    isRtlNode,
    isLiteral,
    isIdentifier,
    isEastBinary,
    isEastUnary,
    isEastAssign,
} from "./east"
import type { RtlInstr, BinaryOpcode, OutputLocation, RtlProc } from "./rtl"
import { outputHas } from "./rtl"
import {instrBytes} from "./encoding"

export function fragmentBytes(node: RtlNode): number
{
    return node.fragment.reduce((s, i) => s + instrBytes(i), 0)
}

type ChildKey =
    | "root"
    | { kind: "Binary"; side: "left" | "right" }
    | { kind: "Unary"; role: "argument" }
    | { kind: "Assign"; role: "right" }
    | { kind: "Call"; role: "arg"; index: number }

interface Site
{
    node: EastExpression
    key: ChildKey
}

function* walk(node: EastExpression, key: ChildKey = "root"): Generator<Site>
{
    yield { node, key }
    if (node.type === "BinaryExpression")
    {
        yield* walk(node.left, { kind: "Binary", side: "left" })
        yield* walk(node.right, { kind: "Binary", side: "right" })
    }
    else if (node.type === "UnaryExpression")
    {
        yield* walk(node.argument, { kind: "Unary", role: "argument" })
    }
    else if (node.type === "AssignmentExpression")
    {
        yield* walk(node.right, { kind: "Assign", role: "right" })
    }
    else if (node.type === "CallExpression")
    {
        for (let i = 0; i < node.arguments.length; i++)
            yield* walk(node.arguments[i]!, { kind: "Call", role: "arg", index: i })
    }
}
 
function replaceInTree(root: EastExpression, target: EastExpression, replacement: EastExpression): EastExpression
{
    if (root === target) return replacement

    if (root.type === "BinaryExpression")
    {
        const left = root.left === target ? replacement : replaceInTree(root.left, target, replacement)
        const right = root.right === target ? replacement : replaceInTree(root.right, target, replacement)
        if (left === root.left && right === root.right) return root
        return { ...root, left, right }
    }
    if (root.type === "UnaryExpression")
    {
        const arg = root.argument === target ? replacement : replaceInTree(root.argument, target, replacement)
        if (arg === root.argument) return root
        return { ...root, argument: arg }
    }
    if (root.type === "AssignmentExpression")
    {
        const right = root.right === target ? replacement : replaceInTree(root.right, target, replacement)
        if (right === root.right) return root
        return { ...root, right }
    }
    if (root.type === "CallExpression")
    {
        let changed = false
        const args = root.arguments.map(a =>
        {
            if (a === target) { changed = true; return replacement }
            const r = replaceInTree(a, target, replacement)
            if (r !== a) changed = true
            return r
        })
        if (!changed) return root
        return { ...root, arguments: args }
    }
    return root
}
 
interface FoundMatch
{
    rule: Rule
    target: EastExpression
    /** Every RtlNode consumed by this match, however deep in the pattern
     *  shape (e.g. both sides of a Binary, or every call arg) — these are
     *  the children whose own rule-provenance folds into the replacement's. */
    childNodes: RtlNode[]
    build: () => RtlNode | undefined
}

function collectRtlNodes(m: EastMatch): RtlNode[]
{
    switch (m.kind)
    {
        case "Rtl": return [m.node]
        case "Binary": return [...collectRtlNodes(m.leftMatch), ...collectRtlNodes(m.rightMatch)]
        case "Unary": return collectRtlNodes(m.argumentMatch)
        case "Assign": return collectRtlNodes(m.rightMatch)
        case "Call": return m.argNodes
        default: return [] // Literal, Identifier — no RTL children
    }
}

function findMatches(root: EastExpression, rules: readonly Rule[]): FoundMatch[]
{
    const found: FoundMatch[] = []
    for (const { node } of walk(root))
    {
        for (const r of rules)
        {
            const m = matchEast(node, r.pattern)
            if (m)
            {
                found.push({
                    rule: r,
                    target: node,
                    childNodes: collectRtlNodes(m),
                    build: () => r.build(m as any),
                })
            }
        }
    }
    return found
}

/**
 * Canonical structural key for a (partially tiled) EAST tree — content-based,
 * not object-identity-based. Needed because `fm.build()` mints a fresh
 * `RtlNode` on every rule application, so two different rewrite *orders*
 * that reach the same combined tiling never share object references even
 * though they're the same state. Used by `tileExpr`'s worklist to turn tree
 * search (revisit the same reachable state once per path) into graph search
 * (visit each reachable state once) — see docs/ir-engine.md, "Dedup is
 * implemented; full memoization is not" for the analysis.
 *
 * `RtlNode` leaves are hashed by full content (`output`/`fragment`/
 * `clobbers`/`tosDelta`/`maxStack` are all JSON-safe plain data, no cycles),
 * since two structurally-identical fragments could in principle be tagged
 * with different metadata by different rules. EAST leaves/internal nodes are
 * hashed by their semantic content (name/value/operator + recursively-hashed
 * children), not by JS object identity.
 */
function hashTree(node: EastExpression): string
{
    if (isRtlNode(node)) return `R:${JSON.stringify(node)}`
    if (isLiteral(node)) return `L:${node.value}`
    if (isIdentifier(node)) return `I:${node.name}`
    if (isEastBinary(node)) return `B:${node.operator}(${hashTree(node.left)},${hashTree(node.right)})`
    if (isEastUnary(node)) return `U:${node.operator}(${hashTree(node.argument)})`
    if (isEastAssign(node)) return `A:${node.operator}(${node.left.name},${hashTree(node.right)})`
    return `C:${node.callee.name}(${node.arguments.map(hashTree).join(",")})`
}

// ── Rule-coverage provenance ────────────────────────────────────────────────
//
// Keyed by rule *name* (rules.ts), not the Rule object itself: `ruleset()`
// builds fresh Rule objects (new closures) on every call — once per scope
// in the real lowerer, once for DEFAULT_RULESET in tests — so the same
// conceptual rule never has stable object identity across calls. The name
// does, by construction.

/** Which rule(s) — transitively, including children — built each RtlNode
 *  ever produced by `tileExpr`. Process-wide (not per-call): a WeakMap costs
 *  nothing once a node is unreferenced, and sharing it is what lets
 *  `touchedRuleNames` below accumulate across the whole test suite rather
 *  than one call at a time. */
const nodeRuleNames = new WeakMap<RtlNode, ReadonlySet<string>>()

/**
 * Rule names that have appeared in a node `lowerExpr` actually selected as
 * its winning tiling, accumulated across every `lowerExpr` call in the
 * process. This is the coverage signal: "did some real lowering choose
 * this rule's output," not merely "could the search construct a variant
 * using it" (most rules can construct *some* variant; most of those lose
 * on cost). See test/rule-coverage.test.ts.
 */
export const touchedRuleNames = new Set<string>()
 
export function tileExpr(expr: EastExpression, rules: readonly Rule[], demand?: OutputLocation): RtlNode[]
{
    const results: RtlNode[] = []
    const worklist: EastExpression[] = [expr]
    // Turns tree search into graph search: many different rewrite orders
    // reach the same combined tiling (independent sites can be tiled in
    // either order), and without this every such order re-explores its own
    // copy of the remaining work. See hashTree's doc comment.
    const seen = new Set<string>([hashTree(expr)])

    while (worklist.length > 0)
    {
        const tree = worklist.pop()!

        // Fully tiled: root is an RtlNode → collect and continue.
        if (isRtlNode(tree))
        {
            results.push(tree)
            continue
        }

        const matches = findMatches(tree, rules)
        for (const fm of matches)
        {
            const replacement = fm.build()
            if (!replacement) continue   // realizability prune

            const inherited = fm.childNodes.flatMap(c => [...(nodeRuleNames.get(c) ?? [])])
            nodeRuleNames.set(replacement, new Set([fm.rule.name, ...inherited]))

            const newTree = replaceInTree(tree, fm.target, replacement)
            const key = hashTree(newTree)
            if (seen.has(key)) continue   // already reached via a different rewrite order
            seen.add(key)
            worklist.push(newTree)
        }
    }

    if (demand)
    {
        const filtered = results.filter(n => outputSatisfies(n, demand))
        return filtered
    }

    return results
}

function outputSatisfies(node: RtlNode, demand?: OutputLocation): boolean
{
    if (!demand) return true
    return outputHas(node.output, demand)
}

/** Cheapest-by-byte-count pick among an already-filtered variant set, with
 *  the winner's rule provenance recorded into `touchedRuleNames`. Shared by
 *  `lowerExpr` (demand-filtered via `tileExpr`) and `lowerStatementExpr`
 *  (custom-filtered — see there for why demand filtering alone isn't right
 *  for a discarded-value expression statement). */
function pickCheapest(variants: readonly RtlNode[]): RtlNode | undefined
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

export function lowerExpr(expr: EastExpression, rules: readonly Rule[], demand?: OutputLocation): RtlNode | undefined
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
export function lowerStatementExpr(expr: EastExpression, rules: readonly Rule[]): RtlNode | undefined
{
    const variants = tileExpr(expr, rules).filter(v => v.output.some(loc => loc !== "tos"))
    return pickCheapest(variants)
}
