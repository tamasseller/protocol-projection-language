/**
 * @ppl/core/machine — Expression tiling orchestrator (worklist-based)
 *
 * Bottom-up rewrite search following the design in
 * docs/implementation-planning.md. Maintains a worklist of partially-tiled
 * EAST trees; each iteration pops one, finds all rule matches at any node,
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
import type { EastExpression, RtlNode, EastBinary, EastUnary, EastAssign, EastCall } from "./east"
import {
    isRtlNode,
} from "./east"
import type { RtlInstr, BinaryOpcode, OutputLocation, RtlProc } from "./rtl"
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
    build: () => RtlNode | undefined
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
                    build: () => r.build(m as any),
                })
            }
        }
    }
    return found
}
 
export function tileExpr(expr: EastExpression, rules: readonly Rule[], demand?: OutputLocation): RtlNode[]
{
    const results: RtlNode[] = []
    const worklist: EastExpression[] = [expr]

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

            const newTree = replaceInTree(tree, fm.target, replacement)
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
    return node.output.includes(demand)
}

export function lowerExpr(expr: EastExpression, rules: readonly Rule[], demand?: OutputLocation): RtlNode | undefined
{
    const variants = tileExpr(expr, rules, demand)
    if (variants.length === 0) return undefined

    return variants.reduce((best, v) =>
    {
        const vc = fragmentBytes(v), bc = fragmentBytes(best)
        if (vc < bc) return v
        if (vc > bc) return best
        if (v.fragment.length < best.fragment.length) return v
        if (v.fragment.length > best.fragment.length) return best
        return v.maxStack < best.maxStack ? v : best
    })
}
