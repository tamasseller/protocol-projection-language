/**
 * Layer 1: Ruleset runner with automatic coverage (default-absorb).
 *
 * A rule covers every position its pattern matches, EXCEPT at `pStar`
 * holes (iburg-style nonterminal leaves): there coverage stops and
 * independent matching (re-dispatch to root) happens. Coverage is derived
 * automatically from the (TypeNode, Pattern, Match) witness — no manual
 * claim extraction by the rule author.
 *
 * Pre-order traversal (parents before children) ensures a parent rule
 * runs before the iteration reaches its children, so covered descendants
 * are already marked when visited.
 *
 * Pure compile-time host machinery. No IR impact.
 */
import {TypeGraph, TypeNode, Step, child} from "./type-graph"
import {TraitRegistry} from "./traits"
import {
    TypePattern,
    TypeMatch,
    MatchOf,
    matchType,
    isStarPattern,
    isAnyOfPattern,
    isListPattern,
    isStructPattern,
    isStructFieldsPattern,
    isUnionPattern,
    isUnionFieldsPattern,
    AnyOfMatch,
    StructFieldsMatch,
    StructMatch,
    UnionMatch,
    UnionFieldsMatch,
    ListMatch,
} from "./matcher"

export interface Rule<C>
{
    readonly pattern: TypePattern
    readonly produce: (match: MatchOf<TypePattern>, nodeId: number, graph: TypeGraph, traits: TraitRegistry) => C
}

/**
 * Build a `Rule<C>` with `produce`'s `match` narrowed to `MatchOf<P>` for
 * this rule's own concrete pattern `P` — `IntegerMatch` for a `pInteger(...)`
 * rule, `ListMatch` for a `pList(...)` rule, etc. — instead of the widened
 * `MatchOf<TypePattern>` (effectively `TypeMatch`) a plain `{pattern,
 * produce}` object literal against the `Rule<C>` interface gets stuck with.
 *
 * `matchType`/`MatchOf` already narrow correctly given a concrete pattern
 * (matcher.ts's pattern constructors deliberately return their own literal
 * interface for exactly this); `Rule<C>` itself can't express that inline
 * because a ruleset is a *list* of rules with different `P`s, which needs
 * `pattern`/`produce` erased back to the union at the point of storage —
 * TypeScript has no way to type "a list where each element internally
 * pairs its own P with its own correctly-typed handler." That erasure is
 * unavoidable somewhere; this factory is where it happens — once, here,
 * the same way `matchInteger`/`matchList`/etc. each end in one `as
 * MatchOf<P>` (trusted because the surrounding control flow already
 * proved the pattern/type pairing) — rather than every rule body paying
 * for it separately via an unchecked cast back through `graph.nodes.get
 * (nodeId)!.type`.
 */
export function rule<P extends TypePattern, C>(
    pattern: P,
    produce: (match: MatchOf<P>, nodeId: number, graph: TypeGraph, traits: TraitRegistry) => C,
): Rule<C>
{
    return { pattern, produce } as Rule<C>
}

/**
 * Run a ruleset against the type graph.
 *
 * For each TypeNode (in id order, pre-order): if already covered by an
 * earlier rule's coverage set, skip. Otherwise try rules in priority
 * order; first match wins; call produce() to assign a capability; then
 * derive the coverage set (all positions the witness touches, except
 * under pStar holes) so descendants are skipped.
 *
 * The produce callback receives a TraitRegistry, which it may read
 * (for pre-seeded traits like names) and write (for cross-projection
 * facets like accessors).
 *
 * @returns Map<nodeId, C> — covered-but-not-directly-matched nodes are
 *   absent (they inherit the absorbing rule's capability conceptually;
 *   direct queries return undefined, same as unmatched nodes for now).
 */
export function runRuleset<C>(
    graph: TypeGraph,
    rules: ReadonlyArray<Rule<C>>,
    traits: TraitRegistry,
): Map<number, C>
{
    const result = new Map<number, C>()
    const covered = new Set<number>()

    for(const node of graph.nodes.values())
    {
        if(covered.has(node.id)) continue

        for(const rule of rules)
        {
            const m = matchType(node.type, rule.pattern)
            if(m !== undefined)
            {
                result.set(node.id, rule.produce(m, node.id, graph, traits))
                deriveCoverage(node, rule.pattern, m, graph, covered)
                break
            }
        }
    }

    return result
}

/**
 * Walk (TypeNode, Pattern, Match) in lockstep. Cover THIS node for
 * non-leaf patterns (except Star and AnyOf, which don't claim the node
 * they sit at), then descend into children — stopping at Star holes.
 *
 * Coverage rule:
 * - Star: boundary. Do NOT cover, do NOT descend. (Re-dispatch happens
 *   via normal iteration, which will reach this node uncovered.)
 * - AnyOf: don't cover the AnyOf position itself (it's a dispatcher, not
 *   a structural node); follow the winning branch into its witness.
 * - Struct/Union/List/StructFields: cover THIS node, descend into each
 *   child via the witness's structural correlation.
 * - Unit/Integer: leaves. No children; nothing to cover below.
 */
function deriveCoverage(
    node: TypeNode,
    pattern: TypePattern,
    match: TypeMatch,
    graph: TypeGraph,
    covered: Set<number>,
): void
{
    // Hole: stop. Don't cover, don't descend.
    if(isStarPattern(pattern)) return

    // AnyOf: dispatcher; follow the winning branch, don't cover here.
    if(isAnyOfPattern(pattern))
    {
        const am = match as AnyOfMatch
        const alts = pattern.alternatives()
        deriveCoverage(node, alts[am.branch] as TypePattern, am.match, graph, covered)
        return
    }

    // Structural non-leaf patterns: cover THIS node, then descend.
    if(isStructFieldsPattern(pattern))
    {
        covered.add(node.id)
        const sm = match as StructFieldsMatch
        for(const f of sm.fieldMatches)
        {
            const childNode = child(node, {field: f.name})
            if(childNode) deriveCoverage(childNode, pattern.elementPattern, f.match, graph, covered)
        }
        return
    }

    if(isStructPattern(pattern))
    {
        covered.add(node.id)
        const sm = match as StructMatch
        for(const [name, subPattern] of Object.entries(pattern.fieldPatterns))
        {
            const childNode = child(node, {field: name})
            if(childNode) deriveCoverage(childNode, subPattern as TypePattern, sm.fieldMatches[name].match, graph, covered)
        }
        return
    }

    if(isUnionFieldsPattern(pattern))
    {
        covered.add(node.id)
        const um = match as UnionFieldsMatch
        for(const v of um.variantMatches)
        {
            const childNode = child(node, {variant: v.name})
            if(childNode) deriveCoverage(childNode, pattern.elementPattern, v.match, graph, covered)
        }
        return
    }

    if(isUnionPattern(pattern))
    {
        covered.add(node.id)
        const um = match as UnionMatch
        for(const [name, subPattern] of Object.entries(pattern.variantPatterns))
        {
            const childNode = child(node, {variant: name})
            if(childNode) deriveCoverage(childNode, subPattern as TypePattern, um.variantMatches[name].match, graph, covered)
        }
        return
    }

    if(isListPattern(pattern))
    {
        covered.add(node.id)
        const lm = match as ListMatch
        const childNode = child(node, {element: true})
        if(childNode) deriveCoverage(childNode, pattern.elementPattern, lm.elementMatch, graph, covered)
        return
    }

    // Unit, Integer: leaves. They ARE covered positions (absorbed by the
    // enclosing rule) — only pStar is a hole. No children to descend into.
    covered.add(node.id)
}

export {TypeGraph, TypeNode, Step, child}
