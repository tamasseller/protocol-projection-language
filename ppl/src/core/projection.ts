/**
 * Layer 1: the on-demand, memoized, cycle-safe resolver every projection
 * runs on — `codecs`'s `createCodecResolver` and `target-js`'s
 * `createTsResolver` are both thin adapters over it.
 *
 * A rule covers every position its pattern matches, EXCEPT at `pStar`
 * holes (iburg-style nonterminal leaves): there coverage stops and
 * independent matching (re-dispatch to root) happens. Coverage is derived
 * automatically from the (TypeNode, Pattern, Match) witness — no manual
 * claim extraction by the rule author.
 *
 * Pure compile-time host machinery. No IR impact.
 */
import {TypeGraph, TypeNode, Step, child, buildTypeGraph} from "./type-graph"
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
import type {SemanticType} from "./metamodel"
import {kindOf} from "./metamodel"

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

/**
 * The resolver's own model: resolution is *lazy*, starting from a root and
 * recursing into children only as a rule's own `fill()` asks for them via
 * `resolve()` — the model both `Procedure` (codecs) and
 * `TSTypeDecl`+`Accessor` (target-js) actually need, since a struct's own
 * decl text has to inline a field's `ref` *while being built*, and a
 * self-referential type needs reserve-before-recurse cycle safety.
 *
 * `deriveCoverage` (above) is what lets a rule structurally absorb more
 * than one `TypeNode` in a single match — a concrete sub-pattern deeper
 * than a `pStar()` hole, e.g. `pList(pInteger(...))` witnessing both the
 * list and its element in one `matchType` call — under a guarantee an
 * absorbed position is never independently re-matched against the full
 * rule list from scratch.
 */

/**
 * One resolver rule: a structural filter (`pattern`) and `fill`, which
 * populates an already-reserved `placeholder` (mutated in place — cycle
 * safety depends on this) and may recurse into children via `resolve`.
 *
 * Contract: `fill` must populate any field of `placeholder` a cyclic
 * re-entry could read BEFORE calling `resolve` on anything that might
 * recurse back to this same node (mint identity/cheap-to-compute fields
 * first, recurse after — mirrors the discipline `declareProc`/
 * `defineProc` already enforce for `Procedure`, and `TSTypeDecl.access`'s
 * own non-recursive-by-construction ordering for target-js).
 *
 * `fill` may optionally return `claims`: capabilities for other nodes
 * this same match's own pattern structurally absorbed (per
 * `deriveCoverage`), keyed by that child's raw (possibly-thunk)
 * `SemanticType` — the same identity convention `resolve`'s own `resolve
 * (childType, ctx)` callback uses. Absorbed nodes with no claims entry are
 * fine as long as nothing ever independently `resolve()`s them; if
 * something does, that's a loud, immediate error (see `createResolver`),
 * not a silent re-match against the full rule list.
 *
 * Ordering invariant this relies on: an absorbing rule's own top node must
 * always be reached via normal navigation from `root` before anything
 * could independently `resolve()` one of its absorbed children. True of
 * every rule in this codebase today (an absorbing list is always
 * reachable via some enclosing struct field's own declaration) — not
 * itself checked or enforced by this primitive.
 */
export interface ResolverRule<C, Ctx = void>
{
    readonly pattern: TypePattern
    readonly fill: (
        placeholder: C,
        match: MatchOf<TypePattern>,
        node: TypeNode,
        ctx: Ctx,
        resolve: (childType: SemanticType, ctx: Ctx) => C,
    ) => { readonly claims?: ReadonlyMap<SemanticType, C> } | void
}

/**
 * Build a `ResolverRule<C, Ctx>` with `fill`'s `match` narrowed to
 * `MatchOf<P>` — same erasure trade as `rule()`/`codecRule()`/`tsRule()`:
 * a rule list needs `pattern`/`fill` erased back to the union at the
 * point of storage; this factory is the one place that happens.
 */
export function resolverRule<P extends TypePattern, C, Ctx = void>(
    pattern: P,
    fill: (
        placeholder: C,
        match: MatchOf<P>,
        node: TypeNode,
        ctx: Ctx,
        resolve: (childType: SemanticType, ctx: Ctx) => C,
    ) => { readonly claims?: ReadonlyMap<SemanticType, C> } | void,
): ResolverRule<C, Ctx>
{
    return { pattern, fill } as ResolverRule<C, Ctx>
}

/**
 * Build an on-demand, memoized, cycle-safe `SemanticType -> C` resolver
 * from an ordered rule list (first match wins). `mintPlaceholder` reserves
 * a node's own identity before `fill` runs (and possibly recurses) —
 * `declareProc([], node)` for codecs' `Procedure`, `{ref:"", deps:[],
 * access: undefined as any}` for target-js' `TSTypeDecl`. `keyOf` controls
 * memoization the same way `createCodecResolver`'s own `keyOf` does — node
 * id alone by default, or `(node, ctx)` together for a resolver whose
 * `Ctx` genuinely varies per call (e.g. a JSON-style nesting depth).
 *
 * The `TypeGraph` is built once, lazily, from whichever type `resolve` is
 * first called with (always the root in practice).
 *
 * A claimed/absorbed child (see `ResolverRule.fill`'s own doc comment) is
 * understood to exist at the *same* `ctx` as the parent match that
 * claimed it — there's no other sensible default, since the claiming
 * rule never itself calls `resolve()` (with a chosen `ctx`) for that
 * position at all.
 *
 * Returns both `resolve` itself and read-only access to everything
 * resolved so far (`cache`, keyed exactly as `keyOf` produces) — a caller
 * that only ever wants one root's own capability (`createCodecResolver`,
 * below) uses `resolve` alone; one that needs every reachable node's own
 * capability (`createTsResolver`, target-js/engine/resolver.ts — every
 * reachable struct/union needs its own top-level declaration emitted, not
 * just the root's) reads `cache` after resolving whatever roots it needs.
 */
export function createResolver<C, Ctx = void>(
    rules: readonly ResolverRule<C, Ctx>[],
    mintPlaceholder: (node: TypeNode, ctx: Ctx) => C,
    keyOf: (node: TypeNode, ctx: Ctx) => string = node => String(node.id),
    existingGraph?: TypeGraph,
): { readonly resolve: (root: SemanticType, ctx: Ctx) => C; readonly cache: ReadonlyMap<string, C> }
{
    // `existingGraph`: for a caller that already needs its own
    // `TypeGraph` for a *different* reason (target-js's `codec-module.ts`
    // — see its own comment on why) and must resolve against the exact
    // same `TypeNode` objects that graph produced, not a second,
    // independently-built graph. Building a fresh one from the same root
    // type is *not* interchangeable for a thunked/self-referential
    // schema: dereferencing a thunk re-invokes it, producing a fresh,
    // structurally-equivalent but non-identical nested object every call
    // (`src/core/type-graph.ts`'s own header comment) — a second
    // independently-built graph's nodes (and their `.source`s) simply
    // aren't the same objects as the first graph's, for anything reached
    // through such a thunk more than once.
    let graph: TypeGraph | undefined = existingGraph
    const cache = new Map<string, C>()
    const coveredIds = new Set<string>()

    function resolve(type: SemanticType, ctx: Ctx): C
    {
        graph ??= buildTypeGraph(type)
        const g = graph
        const node = g.nodeOf(type)
        if(!node)
            throw new Error("resolver: resolve() called with a type not reachable from the root it was first called with")

        const key = keyOf(node, ctx)
        const cached = cache.get(key)
        if(cached !== undefined) return cached

        // Lazy check: only fires if something actually tries to
        // independently resolve a position an enclosing rule's own match
        // already absorbed without claiming it — see ResolverRule.fill.
        if(coveredIds.has(key))
            throw new Error(`resolver: node ${key} was absorbed into an enclosing rule's own multi-node match, but that rule's fill() supplied no claims() entry for it — either add one, or ensure nothing resolves this position independently`)

        let found: { rule: ResolverRule<C, Ctx>; match: TypeMatch } | undefined
        for(const rule of rules)
        {
            const m = matchType(node.type, rule.pattern)
            if(m !== undefined) { found = { rule, match: m }; break }
        }
        if(!found) throw new Error(`resolver: no rule matches type kind "${kindOf(node.type)}"`)

        const placeholder = mintPlaceholder(node, ctx)
        cache.set(key, placeholder) // reserved — before fill() recurses

        const result = found.rule.fill(placeholder, found.match, node, ctx, resolve)

        const covered = new Set<number>()
        deriveCoverage(node, found.rule.pattern, found.match, g, covered)
        for(const id of covered) coveredIds.add(keyOf(g.nodes.get(id)!, ctx))

        if(result?.claims)
        {
            for(const [childType, value] of result.claims)
            {
                const childNode = g.nodeOf(childType)
                if(!childNode) throw new Error("resolver: claims() entry references a type not reachable from the root")
                cache.set(keyOf(childNode, ctx), value)
            }
        }

        return placeholder
    }

    return { resolve, cache }
}

export {TypeGraph, TypeNode, Step, child}
