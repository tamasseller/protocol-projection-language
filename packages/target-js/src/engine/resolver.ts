/**
 * @ppl/target-js — The one generic TS-decl resolver
 *
 * Mirrors `@ppl/codecs/src/engine/resolver.ts` exactly, for the same
 * reason: "walk a `SemanticType`, dispatch by pattern, resolve children
 * on demand, memoize, survive cycles" is one primitive, not something
 * each consumer re-derives. This isn't merged with `@ppl/codecs`'s copy —
 * that one produces a `Procedure` (a `@ppl/machine` concept, minted via
 * `declareProc`/`defineProc`); this one produces a `TSTypeDecl` (a plain
 * `{ref, decl?, deps}` record) — different enough artifacts, and
 * `@ppl/target-js` has no reason to depend on `@ppl/codecs`, that
 * duplicating the *shape* here (not the code) is the right call, exactly
 * as `resolver.ts`'s own header reasons about when to actually merge two
 * copies of a Layer-1 primitive ("if a second consumer shows up... that's
 * the point to merge, not before" — a second consumer *has* shown up,
 * this file, but merging still isn't free: it would mean inventing a
 * shared artifact abstraction neither `Procedure` nor `TSTypeDecl`
 * naturally is, for two current call sites. Revisit if a third shows up).
 *
 * Why not `@ppl/core`'s `runRuleset` (projection.ts) directly, then — same
 * question already answered for codecs' own copy, and the answer is the
 * same here: `runRuleset` fills its output `Map` in ONE eager top-down
 * pass, `produce(match, nodeId, graph)` with no callback to recurse into a
 * child and get *its* result — and pre-order visitation means a child's
 * entry doesn't exist yet even if `produce` tried to look it up by hand.
 * A struct's `interface` text needs a field's `ref` inlined *while being
 * built*, on demand, not read out of an already-filled table; a
 * self-referential type additionally needs reserve-before-recurse cycle
 * safety `runRuleset` has no mechanism for, since nothing in it ever
 * recurses. `TypePattern`/`matchType` (the structural matching
 * vocabulary) are reused as-is; only `Rule<C>`/`runRuleset` (the execution
 * model) are skipped in favor of the on-demand driver below.
 *
 * The one real difference from `Procedure`'s own cycle-safety: a
 * `Procedure`'s identity (its `.name`, usable in `${proc}` interpolation)
 * is *always* a synthetic, rule-independent id — `declareProc` mints it
 * before any rule even runs. A TS type's `ref` is not always so simple: a
 * struct/union's ref is name-based (rule-independent, safe to mint before
 * recursing), but an inline rule (e.g. a future "optional as `T | null`"
 * one) needs to *compute* its own ref by resolving its value type first.
 * So `TsRule` splits `refOf` (may recurse, but is asked for and cached
 * *before* `produce` runs) from `produce` (the rest — decl text, deps;
 * always free to recurse, including into a cycle, since by the time it
 * runs, `refOf`'s result is already cached for anyone that needs it).
 * This keeps a genuinely recursive type (a struct/union field reaching
 * back to its own type) safe: the cyclic reference only ever needs the
 * ref (already known), never a fully-formed `decl` for the type it's
 * already inside. A rule whose *own* `refOf` needs to recurse (the
 * optional case) is safe too, as long as any real cycle passes through
 * at least one by-name struct/union first — true for every recursive type
 * expressible in this metamodel, since a cycle can only be created via a
 * named thunk reference (`const T = (): any => ...`), and nobody
 * meaningfully thunks a bare list/optional back onto itself (that type
 * would have no inhabitants at all). Not specifically defended against,
 * same bar the pre-existing code already held itself to.
 */

import type { SemanticType, TypeGraph, TypeNode, TypePattern, MatchOf } from "@ppl/core"
import { matchType, buildTypeGraph, kindOf } from "@ppl/core"

/** The capability every TS rule produces — parallels `codecRule`'s own
 *  `Procedure`, but a plain data record instead of a machine artifact. */
export interface TSTypeDecl
{
    /** How to reference this type in a field/parameter position. */
    readonly ref: string
    /** This type's own top-level declaration text, if it needs one
     *  (a struct/union does; a leaf or an inline-mapped shape doesn't). */
    readonly decl?: string
    /** Node ids this declaration references, for emission ordering. */
    readonly deps: readonly number[]
}

/** Resolves a child's own raw (possibly-thunk) `SemanticType` — straight
 *  off a match witness (`StructFieldsMatch.fieldMatches[i].type`,
 *  `ListMatch.elementType`, etc.) — to its `TSTypeDecl`, keyed by that
 *  type's own object identity. Never `node.edges[i].target.type`: that's
 *  always pre-dereferenced (`TypeNode.type`'s own invariant), which would
 *  silently miss the cache for anything reached through a thunk (a
 *  recursive type's own self-reference, most importantly). */
export type ResolveFn = (childType: SemanticType) => TSTypeDecl

/**
 * One TS rule: a structural filter (`pattern`) and two producers —
 * `refOf` (§ this file's header: cheap for a leaf or a by-name struct/
 * union, may recurse for an inline shape) and `produce` (everything else,
 * always free to recurse). `resolve` is threaded in as a plain extra
 * argument to both, mirroring `codecRule`'s own `resolve` parameter — not
 * smuggled into the match witness.
 *
 * `match: TypeMatch` is deliberately the widened union here (same trade
 * `codecRule`/`rule` both make) — see {@link tsRule} for a version whose
 * callbacks see the narrowed `MatchOf<P>` instead.
 */
export interface TsRule
{
    readonly pattern: TypePattern
    readonly refOf: (match: MatchOf<TypePattern>, node: TypeNode, resolve: ResolveFn) => string
    readonly produce: (
        match: MatchOf<TypePattern>, node: TypeNode, resolve: ResolveFn,
    ) => { decl?: string; deps: readonly number[] }
}

/**
 * Build a `TsRule` with `refOf`/`produce`'s `match` narrowed to
 * `MatchOf<P>` — exactly `codecRule`'s own factory, for exactly the same
 * reason (a rule list needs `pattern`/callbacks erased back to the union
 * at the point of storage; this is the one place that erasure happens).
 */
export function tsRule<P extends TypePattern>(
    pattern: P,
    refOf: (match: MatchOf<P>, node: TypeNode, resolve: ResolveFn) => string,
    produce: (match: MatchOf<P>, node: TypeNode, resolve: ResolveFn) => { decl?: string; deps: readonly number[] },
): TsRule
{
    return { pattern, refOf, produce } as TsRule
}

/**
 * Build an on-demand, memoized, cycle-safe `SemanticType -> TSTypeDecl`
 * resolver from an ordered rule list (first match wins — a caller's own
 * rules go first so they can preempt a default, exactly like
 * `createCodecResolver`). Returns a function that, given a root type,
 * resolves it (and every type transitively reachable from it) and
 * returns the *whole* accumulated `Map<TypeNode.id, TSTypeDecl>` — unlike
 * `createCodecResolver` (whose caller only ever wants the *root's* own
 * `Procedure`, since `lowerProgram` separately walks the call graph),
 * every reachable struct/union here needs its own top-level declaration
 * emitted, so the full map is the actual deliverable.
 *
 * Cycle safety: mint `{ref: "", deps: []}`, cache it, call `refOf`
 * (mutating `.ref` in place), *then* call `produce` (mutating `.decl`/
 * `.deps` in place) — mirrors `createCodecResolver`'s own
 * `declareProc`-before-recursing discipline, adapted to a plain mutable
 * record instead of a `Procedure` handle.
 */
export function createTsResolver(rules: readonly TsRule[]): (root: SemanticType) => Map<number, TSTypeDecl>
{
    return (root: SemanticType) =>
    {
        const graph: TypeGraph = buildTypeGraph(root)
        const cache = new Map<number, TSTypeDecl>()

        function resolve(type: SemanticType): TSTypeDecl
        {
            const node = graph.nodeOf(type)
            if(!node)
                throw new Error("ts resolver: resolve() called with a type not reachable from the root it was first called with")

            const cached = cache.get(node.id)
            if(cached) return cached

            const rule = rules.find(r => matchType(node.type, r.pattern) !== undefined)
            if(!rule) throw new Error(`no ts rule matches type kind "${kindOf(node.type)}"`)
            const match = matchType(node.type, rule.pattern)!

            const decl: { ref: string; decl?: string; deps: readonly number[] } = { ref: "", deps: [] }
            cache.set(node.id, decl) // reserved — before refOf/produce recurse

            decl.ref = rule.refOf(match, node, resolve)
            const { decl: text, deps } = rule.produce(match, node, resolve)
            decl.decl = text
            decl.deps = deps

            return decl
        }

        resolve(root)
        return cache
    }
}

/**
 * Run a TS projection over `root` with `rules` (first match wins — a
 * caller's own rules go first to preempt a default). The thinnest possible
 * driver over `createTsResolver` above — mirrors where `buildCodec` sits
 * relative to `createCodecResolver` in `@ppl/codecs/src/engine/resolver.ts`:
 * generic over *any* `TsRule[]`, so it belongs next to the primitive it
 * drives, not inside a specific rule library like `../components/ts-emitter.ts`.
 */
export function projectTSTypes(root: SemanticType, rules: readonly TsRule[]): Map<number, TSTypeDecl>
{
    return createTsResolver(rules)(root)
}

/**
 * Emit a complete TypeScript declaration string from a projection result.
 * Generic over the result `Map` alone — it doesn't know or care which
 * rules produced it, so it lives here rather than in a components file.
 */
export function emitTSDeclarations(result: Map<number, TSTypeDecl>): string
{
    const lines: string[] = []
    for (const [, decl] of result)
    {
        if (decl.decl)
        {
            lines.push(decl.decl)
            lines.push("")
        }
    }
    return lines.join("\n")
}
