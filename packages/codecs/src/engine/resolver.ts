/**
 * @ppl/codecs — The one generic codec resolver
 *
 * Layer 1 (docs/ARCHITECTURE.md's "Mappings" section) — a dispatch engine,
 * not a codec, even though it currently has no consumer outside this
 * package. Every codec family `@ppl/codecs` has (the binary family,
 * `../components/binary-rules.ts`; the JSON family,
 * `../components/json.ts`) is "walk a `SemanticType`, dispatch by pattern,
 * resolve children on demand, memoize, survive cycles." That's one
 * primitive, not two independently hand-rolled ones — `createCodecResolver`
 * is it, and both families are built directly on top of it, differing only
 * in which rule list and which context type (a JSON depth, or nothing at
 * all) they close over.
 *
 * `TypePattern`/`matchType` (`@ppl/core/matcher.ts`) — the pure structural
 * matching vocabulary already used by `target-cpp`/`target-js`'s own
 * `Rule<C>`/`runRuleset` (`@ppl/core/projection.ts`, itself labeled "Layer
 * 1: Ruleset runner") — is reused as-is here. `runRuleset` itself is not:
 * it fills `Map<nodeId, C>` in one eager top-down pass via
 * absorption/coverage, with no way to hand a not-yet-finished child a
 * reserved slot number before a sibling embeds it into its own instruction
 * stream. Codec generation needs on-demand, indexed, self-reference-safe
 * resolution instead — a different execution model, not a superset
 * `runRuleset` can be stretched to cover — so this file provides its own
 * small driver rather than routing through `runRuleset`. It lives here,
 * next to its only current consumer, rather than promoted into
 * `@ppl/core` alongside `runRuleset`, because there's exactly one consumer
 * to generalize for so far; if a second one shows up (e.g. a target
 * needing the same on-demand/cycle-safe resolution for a recursive type),
 * that's the point to actually merge the two into one shared Layer-1
 * primitive, not before.
 *
 * A rule's `produce` sees only its own match witness and a `resolve`
 * callback — no `TypeNode`, no graph. `resolve` takes a raw `SemanticType`
 * (a struct/union/list field's `.type`, straight off the match witness —
 * see matcher.ts's `FieldWitness`/`StructFieldsMatch`/etc.) and returns its
 * `Procedure`, keyed on that type's own object identity. Internally this
 * still rides on `@ppl/core`'s `TypeGraph` (built once, from whichever
 * type `resolve` is first called with — the root) so cycle-breaking and
 * thunk-unwrapping are exactly `buildTypeGraph`'s already-proven behavior,
 * not a second, independently-written copy of that logic; `TypeGraph.nodeOf`
 * is the bridge from "resolve was handed a SemanticType" back to "the
 * TypeNode identity Procedures are actually cached against."
 *
 * A rule set that mixes conventions (e.g. an ASCII-text override sitting
 * inside an otherwise-binary rule list) is not a special case this driver
 * needs to know about: `CodecRule.produce` never inspects what family it's
 * emitting, so nothing here enforces — or even notices — that distinction.
 */

import type { TypePattern, TypeMatch, TypeGraph, TypeNode, MatchOf } from "@ppl/core"
import type { SemanticType } from "@ppl/core"
import { matchType, kindOf, buildTypeGraph } from "@ppl/core"
import type { IrFragment, Procedure } from "@ppl/machine"
import { declareProc, defineProc } from "@ppl/machine"

/**
 * One codec rule: a structural filter (`pattern`) and a producer
 * (`produce`) that builds the matching type's `ir\`...\`` fragment —
 * "codecs are standalone metaprograms, including the pattern their match
 * comes from," not a closed per-kind switch. `resolve` is threaded in as a
 * plain extra argument (mirroring `cpp-emitter.ts`'s own `refOf` helper,
 * called directly by its rules rather than smuggled into the match's
 * witness) — it recursively resolves a *child* `SemanticType` to its own
 * `Procedure`, under the same or a different `ctx`.
 *
 * `match: TypeMatch` here is deliberately the widened union — see
 * {@link codecRule} for why, and for how to get a rule whose `produce`
 * sees its own concrete `MatchOf<P>` instead.
 */
export interface CodecRule<Ctx>
{
    readonly pattern: TypePattern
    readonly produce: (
        match: TypeMatch,
        ctx: Ctx,
        resolve: (childType: SemanticType, ctx: Ctx) => Procedure,
    ) => IrFragment
}

/**
 * Build a `CodecRule<Ctx>` with `produce`'s `match` narrowed to
 * `MatchOf<P>` — exactly `@ppl/core/projection.ts`'s `rule()` factory,
 * mirrored here because `CodecRule` is its own interface (a `resolve`
 * callback in its `produce` signature, not `Rule`'s `nodeId` + `TypeGraph`
 * + `TraitRegistry`), not something `rule()` itself can build. Same
 * erasure trade as there: storing rules with different `P`s in one
 * `CodecRule<Ctx>[]` needs `pattern`/`produce` erased back to the union
 * *somewhere*; this factory is the one place that happens, instead of
 * every rule body re-deriving type info via a cast.
 */
export function codecRule<P extends TypePattern, Ctx>(
    pattern: P,
    produce: (
        match: MatchOf<P>,
        ctx: Ctx,
        resolve: (childType: SemanticType, ctx: Ctx) => Procedure,
    ) => IrFragment,
): CodecRule<Ctx>
{
    return { pattern, produce } as CodecRule<Ctx>
}

/**
 * Build an on-demand, memoized, cycle-safe `SemanticType → Procedure`
 * resolver from an ordered rule list (first match wins — a caller's own
 * rules go first so they can preempt a default). `keyOf` controls
 * memoization: the default (the type's `TypeNode.id` alone) is right for a
 * resolver whose only context is a fixed value closed over by the caller
 * (binary-rules.ts, whose `Ctx` is `void` — direction is which rule *list*
 * you pass in, not a per-call value); a resolver whose `Ctx` actually
 * varies per call (json.ts's nesting depth) supplies its own, keying on
 * `(node, ctx)` together.
 *
 * The `TypeGraph` backing this is built once, lazily, from whichever type
 * `resolve` is first called with — that call is always the root in
 * practice (every subsequent call is for a child reached from an
 * already-resolved node's own match witness, hence already part of the
 * same graph). Cycle safety mirrors `lowerProgram`'s own
 * (`@ppl/machine/lower.ts:141-173`): mint the `Procedure`'s identity via
 * `declareProc` and cache it *before* recursing into `produce`, so a self-
 * or mutually-recursive type resolves to the reserved identity instead of
 * looping forever.
 */
export function createCodecResolver<Ctx>(
    rules: readonly CodecRule<Ctx>[],
    keyOf: (node: TypeNode, ctx: Ctx) => string = node => String(node.id),
): (root: SemanticType, ctx: Ctx) => Procedure
{
    let graph: TypeGraph | undefined
    const cache = new Map<string, Procedure>()

    function resolve(type: SemanticType, ctx: Ctx): Procedure
    {
        graph ??= buildTypeGraph(type)
        const node = graph.nodeOf(type)
        if(!node)
            throw new Error("codec resolver: resolve() called with a type not reachable from the root it was first called with")

        const key = keyOf(node, ctx)
        const cached = cache.get(key)
        if(cached) return cached

        const handle = declareProc([]) // mint identity now — reserved, before recursing
        cache.set(key, handle)

        const rule = rules.find(r => matchType(node.type, r.pattern) !== undefined)
        if(!rule) throw new Error(`no codec rule matches type kind "${kindOf(node.type)}"`)

        const match = matchType(node.type, rule.pattern)!
        defineProc(handle, rule.produce(match, ctx, resolve))
        return handle
    }

    return resolve
}
