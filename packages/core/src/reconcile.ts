/**
 * @ppl/core — Reconciliation (docs/codec-image.md §2/§3, ROADMAP.md item 11)
 *
 * Target- *and* codec-independent: this computes a mapping some codegen
 * consumes, but knows nothing about wire bytes, RTL, or any target
 * language — the same relationship `raise.ts` has to a target's own
 * emitter, just one layer further removed. Originally built in
 * `@ppl/codecs` (where the problem motivating it, codec-image.md, lives)
 * but moved here once it was clear nothing in either function below
 * touches anything beyond `@ppl/core`'s own `TypeNode`/`defaultValueOf` —
 * unlike `@ppl/codecs`'s own `engine/resolver.ts` (`createCodecResolver`),
 * which genuinely can't move (it depends on `mog-core`'s `Procedure`/
 * `declareProc`/`lowerProgram`, and `@ppl/core` stays `mog-core`-free
 * on purpose), reconciling two semantic type trees by name is exactly the
 * kind of pure, structural, metamodel-level operation `@ppl/core` already
 * hosts elsewhere (`matchType`, `defaultValueOf`). `@ppl/codecs/engine/
 * codec-extension.ts` re-exports `Direction` from here for its own
 * existing consumers — it isn't redefined there.
 *
 * Two functions, deliberately kept separate (docs/codec-image.md §2.4
 * spells out why): `reconcile` is the direction-agnostic lock-step walk of
 * the image tree and the local tree (§2); `resolve` turns one edge of that
 * walk's result into what a codegen should actually do, which — unlike the
 * tree shape itself — does depend on direction (§3's four relaxation
 * rules).
 *
 * "Image tree" and "local tree" are both ordinary `TypeNode` graphs here —
 * the image side is whatever `buildTypeGraph` produces from a decoded
 * `@ppl/codecs`-side `codec-image.ts`/`type-tree-wire.ts` type tree, the
 * local side is the consumer's own, independently-built graph. Nothing in
 * this file reads a value, a wire byte, or an opcode; it only walks the
 * two type shapes.
 *
 * Names live on the *edge*, never on the node — deliberately mirroring
 * `type-graph.ts`'s own `TypeEdge {step, target}` split (a `TypeNode` has
 * no name of its own; only the edge that reaches it does), for the exact
 * reason that document does it: the same `TypeNode` can be reached by
 * more than one edge (shared/deduped types, and — here specifically — a
 * genuine cycle closing back onto an ancestor still being processed).
 * `Correspondence` is memoized on the (imageNode, localNode) pair (`pair`
 * below), so a cyclic or shared position returns the exact same object a
 * caller already has elsewhere — invaluable for a codegen that wants to
 * monomorphize one generated procedure per distinct pair (`@ppl/codecs`'s
 * own `createCodecResolver`/`declareProc`-cache pattern). An earlier draft
 * of this file instead put `.name`/`.parent` directly on `Correspondence`,
 * which silently broke exactly this sharing: a cyclic back-edge returned
 * the *ancestor's* name/parent instead of the edge's own. Keeping the node
 * itself purely structural (outcome + both `TypeNode`s + children/element)
 * avoids the bug entirely, rather than working around it.
 */

import type { TypeNode } from "./type-graph"
import { SemanticTypeKinds, defaultValueOf } from "./metamodel"
import type { UnionType } from "./metamodel"

/** Which of the two ends of a codec a piece of generated/interpreted code
 *  is playing — encoding a local value onto the wire, or decoding wire
 *  bytes into one. A whole-program property in `@ppl/codecs` (passed in
 *  once, read by `computeChild`'s union branch and `i0`'s own initial
 *  stream capability — see `codec-extension.ts`'s own doc comment) and, at
 *  a smaller grain here, `resolve`'s own per-edge parameter (§3's four
 *  relaxation rules are direction-crossed by construction). */
export type Direction = "encode" | "decode"

export type ReconciliationOutcome = "matched" | "image-only" | "local-only"

/**
 * One node of the reconciliation walk. Exactly one of `imageNode`/
 * `localNode` is absent when `outcome` isn't `"matched"` — never both
 * absent (a `Correspondence` always exists *because* at least one side
 * has this node). Purely structural — no name, no parent; see this file's
 * header for why.
 */
export interface Correspondence
{
    readonly outcome: ReconciliationOutcome
    readonly imageNode?: TypeNode
    readonly localNode?: TypeNode
    /** Struct fields *or* union variants (never both — which one applies
     *  is determined by this node's own kind, whichever side has it),
     *  keyed by name. The *union* of names present on either side: image
     *  declaration order first (matching the wire's own `ref` addressing,
     *  §2.1), then any local-only names appended in local declaration
     *  order. Every name that exists on at least one side gets an entry,
     *  regardless of whether a codegen for a *specific* direction will
     *  actually need it — §2.4's table: a decode-side union switch only
     *  ever needs `"matched"`/`"image-only"` variants, an encode-side one
     *  only ever needs `"matched"`/`"local-only"` — filtering by outcome
     *  for the direction at hand is the caller's job, not `reconcile`'s. */
    readonly children?: readonly CorrespondenceEdge[]
    /** A list's one, unnamed element edge (§2.1: a list needs no name to
     *  match by at all) — present iff this node's kind is List. Always
     *  `"matched"` once its own kind check has passed: a `ListType`
     *  always has exactly one element edge on both sides, so there is no
     *  image-only/local-only *element* — only what's inside it can
     *  diverge. */
    readonly element?: Correspondence
}

export interface CorrespondenceEdge
{
    readonly name: string
    readonly correspondence: Correspondence
}

function fieldNamesOf(node: TypeNode | undefined): readonly string[]
{
    if(!node) return []
    return node.edges.filter(e => "field" in e.step).map(e => (e.step as { field: string }).field)
}

function variantNamesOf(node: TypeNode | undefined): readonly string[]
{
    if(!node) return []
    return node.edges.filter(e => "variant" in e.step).map(e => (e.step as { variant: string }).variant)
}

function fieldEdge(node: TypeNode | undefined, name: string): TypeNode | undefined
{
    return node?.edges.find(e => "field" in e.step && e.step.field === name)?.target
}

function variantEdge(node: TypeNode | undefined, name: string): TypeNode | undefined
{
    return node?.edges.find(e => "variant" in e.step && e.step.variant === name)?.target
}

function elementEdge(node: TypeNode | undefined): TypeNode | undefined
{
    return node?.edges.find(e => "element" in e.step)?.target
}

function unionOfNames(imageNames: readonly string[], localNames: readonly string[]): readonly string[]
{
    const extras = localNames.filter(n => !imageNames.includes(n))
    return [...imageNames, ...extras]
}

function outcomeOf(imageNode: TypeNode | undefined, localNode: TypeNode | undefined): ReconciliationOutcome
{
    return imageNode && localNode ? "matched" : imageNode ? "image-only" : "local-only"
}

/**
 * Reconcile `imageRoot` against `localRoot` (§2's lock-step walk).
 *
 * Memoized on the exact (imageNode, localNode) pair — mint the identity,
 * cache it, *then* recurse (mirroring `type-graph.ts`'s own `build()`
 * exactly: `byObject.set(key, node)` before `edgesOf`), so a self- or
 * mutually-recursive type on either side re-derives the same pair and
 * hits the cache instead of looping forever. Correct to share the cached
 * object across unrelated positions too — see this file's header — since a
 * `Correspondence` carries nothing position-dependent.
 *
 * Throws on a §2.2 kind mismatch — the one case reconciliation rejects
 * outright rather than resolving via §3.
 */
export function reconcile(imageRoot: TypeNode, localRoot: TypeNode): Correspondence
{
    const cache = new Map<string, Correspondence>()

    function pair(imageNode: TypeNode | undefined, localNode: TypeNode | undefined): Correspondence
    {
        const key = `${imageNode?.id ?? "-"}|${localNode?.id ?? "-"}`
        const cached = cache.get(key)
        if(cached) return cached

        if(imageNode && localNode && imageNode.type.kind !== localNode.type.kind)
        {
            throw new Error(
                `reconcile: kind mismatch — image is "${imageNode.type.kind}", local is "${localNode.type.kind}" ` +
                `(docs/codec-image.md §2.2: kind-changing evolution is out of scope)`)
        }

        const outcome = outcomeOf(imageNode, localNode)
        const kind = (imageNode ?? localNode)!.type.kind
        const c: Correspondence = { outcome, imageNode, localNode }
        cache.set(key, c) // reserved — before recursing, so a cycle hits this entry

        if(kind === SemanticTypeKinds.Struct)
        {
            const names = unionOfNames(fieldNamesOf(imageNode), fieldNamesOf(localNode))
            const children = names.map(n => ({ name: n, correspondence: pair(fieldEdge(imageNode, n), fieldEdge(localNode, n)) }))
            ;(c as { children?: readonly CorrespondenceEdge[] }).children = children
        }
        else if(kind === SemanticTypeKinds.Union)
        {
            const names = unionOfNames(variantNamesOf(imageNode), variantNamesOf(localNode))
            const children = names.map(n => ({ name: n, correspondence: pair(variantEdge(imageNode, n), variantEdge(localNode, n)) }))
            ;(c as { children?: readonly CorrespondenceEdge[] }).children = children
        }
        else if(kind === SemanticTypeKinds.List)
        {
            const element = pair(elementEdge(imageNode), elementEdge(localNode))
            ;(c as { element?: Correspondence }).element = element
        }
        // Unit/Integer: leaves, nothing to recurse into.

        return c
    }

    return pair(imageRoot, localRoot)
}

export type Resolution =
    | { readonly action: "bridge" }
    | { readonly action: "drop" }
    | { readonly action: "default"; readonly value: unknown }
    | { readonly action: "trap"; readonly reason: string }
    /** §2.4's table: a combination §3 never needed a rule for, because the
     *  union's own selection mechanism (the local value's active variant
     *  on encode; the wire tag on decode) already rules it out
     *  structurally — not a gap, a codegen literally never needs to emit
     *  anything for this edge under this direction. */
    | { readonly action: "unreachable" }

/**
 * Apply §3's relaxation rules to one edge of `parent`'s children, for one
 * direction. `reconcile`'s own tree is direction-agnostic (§2.4) — this is
 * the separate, direction-aware interpretation step, called once per
 * direction a codegen is generating for, and once per edge it needs a
 * decision for (never recursively — see below).
 *
 * `parent` must itself be `"matched"` — the precondition that makes
 * `parent.imageNode`/`parent.localNode` (both needed to read `parent`'s
 * own kind, and, for a variant, its *local* declared default variant)
 * safe to dereference unconditionally. This isn't a limitation: once an
 * edge resolves to anything other than `"bridge"`, that resolution
 * (`drop`/`default`/`trap`/`unreachable`) already fully describes what to
 * do with *that entire edge*, including whatever is nested inside it —
 * dropping a struct field write is unconditionally safe regardless of
 * what the field's own type contains (§3.2), so a caller never needs to
 * recurse into a non-matched edge's own children at all. Every real call
 * site is therefore "resolve one child of an edge I already bridged into."
 */
export function resolve(parent: Correspondence, edge: CorrespondenceEdge, direction: Direction): Resolution
{
    const c = edge.correspondence
    if(c.outcome === "matched") return { action: "bridge" }

    if(parent.outcome !== "matched")
        throw new Error("resolve: parent must be a matched correspondence — see this function's own doc comment")

    const parentKind = parent.imageNode!.type.kind

    if(parentKind === SemanticTypeKinds.Union)
    {
        if(c.outcome === "image-only")
        {
            // §3.2 — decode: an unrecognized tag arrived. On encode this
            // variant can never be the value being encoded at all (§2.4).
            if(direction === "encode") return { action: "unreachable" }
            const localUnion = parent.localNode!.type as UnionType
            if(localUnion.defaultVariant === undefined)
            {
                return {
                    action: "trap",
                    reason: `variant "${edge.name}" isn't recognized locally and the local union declares no default variant`,
                }
            }
            return { action: "default", value: defaultValueOf(parent.localNode!.type) }
        }

        // local-only. §3.4 — encode: the local value genuinely is this
        // variant; no wire representation exists for it. On decode this
        // variant can never be selected by an incoming tag at all (§2.4).
        if(direction === "decode") return { action: "unreachable" }
        return {
            action: "trap",
            reason: `variant "${edge.name}" has no counterpart in the image type — no wire representation exists for it`,
        }
    }

    // A struct field (parentKind === Struct; a List's "element" edge is
    // always "matched" and already returned above).
    if(c.outcome === "image-only")
    {
        // §3.2 (decode): dropping a struct field's write is unconditionally
        // safe. §3.3 (encode): substitute the field's own declared default,
        // read from the image — the only place a value for a field the
        // local model doesn't have at all could come from.
        return direction === "decode" ? { action: "drop" } : { action: "default", value: defaultValueOf(c.imageNode!.type) }
    }

    // local-only. §3.1 (decode): the decoder itself instantiates this
    // field's container; seed it from the local declared default. §3.4
    // (encode, additive): drop — unconditionally safe, the mirror of §3.2.
    return direction === "decode" ? { action: "default", value: defaultValueOf(c.localNode!.type) } : { action: "drop" }
}
