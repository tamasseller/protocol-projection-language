/**
 * @ppl/target-js — The one generic TS-decl resolver
 *
 * A thin adapter over `@ppl/core/projection.ts`'s `createResolver`, the same
 * primitive `@ppl/codecs`'s `createCodecResolver` adapts. The artifact
 * differs (`TSTypeDecl` vs `Procedure`), so the `TsRule`/`tsRule()`/
 * `Accessor` surface lives here; the on-demand, memoized, cycle-safe
 * execution and the `claims`-based absorption guarantee do not.
 *
 * `TsRule` splits `refOf` from `produce` for cycle safety. A struct/union
 * ref is name-based and safe to mint before recursing, but an inline rule
 * may have to resolve its value type to compute its own ref — so `refOf` is
 * asked for and cached *before* `produce` runs, and `produce` is then free
 * to recurse into a cycle, since a cyclic reference only ever needs the ref,
 * never a formed `decl` for the type it is already inside.
 *
 * A rule whose own `refOf` recurses is safe as long as every real cycle
 * passes through a by-name struct/union, which holds for every recursive
 * type expressible here: a cycle needs a named thunk, and a bare
 * list/optional thunked onto itself has no inhabitants. Not defended
 * against beyond that.
 */

import type { SemanticType, TypeGraph, TypeNode, TypePattern, MatchOf, ResolverRule } from "@ppl/core"
import { createResolver } from "@ppl/core"

/**
 * How to construct/read a value of this `TypeNode`'s locally-projected
 * shape — what `TSTypeDecl.ref`/`.decl` alone don't provide. One variant per
 * `SemanticTypeKinds`, since a rule's pattern always resolves to exactly one
 * structural kind.
 *
 * Never recursive, unlike `refOf`/`produce`: a struct's `readField` says how
 * *this* struct exposes one named part, not how the field's own type is
 * represented (a separate `Accessor`, looked up separately). Hence no
 * `resolve` callback.
 *
 * `finishStruct`/`finishUnion`/`finishList` are decode-only: they convert the
 * uniform codegen-internal accumulator into this rule's host shape, at the
 * one point a decoded value crosses a procedure boundary. Encode never builds
 * a value of its own type — it only reads from an already-finished one.
 */
export type Accessor =
    | { readonly kind: "integer"
        /** Raw, already sign-extended-per-width wire bits -> this rule's
         *  own host representation (identity for `number`, `BigInt(x)`
         *  for a bigint rule). */
        readonly fromWire: (rawExpr: string, width: number, signed: boolean) => string
        /** This rule's own host representation -> a plain wire-bits
         *  number expression (identity for `number`, `Number(x)` for a
         *  bigint rule). */
        readonly toWire: (hostExpr: string) => string }
    | { readonly kind: "unit"
        readonly unitValue: () => string }
    | { readonly kind: "struct"
        readonly finishStruct: (plainObjExpr: string) => string
        readonly readField: (finishedValueExpr: string, field: string) => string
        /** Optional: how to create this struct's own in-progress decode
         *  accumulator, and how to write one field into it. Defaults to a
         *  bare object literal and direct property assignment if omitted
         *  — every existing rule relies on that default. A rule
         *  overriding one of these should almost always override the
         *  other too (they describe the same accumulator shape). Never
         *  itself recursive, same as the rest of `Accessor` (see this
         *  type's own header comment) — this is what lets a rule build
         *  its own *real* representation incrementally instead of only
         *  ever converting a disposable plain object at `finishStruct`. */
        readonly beginStruct?: () => string
        readonly setField?: (accExpr: string, field: string, valueExpr: string) => string }
    | { readonly kind: "union"
        /** `variant` is always a compile-time-known literal name (`ref`
         *  resolves against the image tree's own declared variant list,
         *  never a runtime-computed string) and `payloadExpr` is the
         *  already-finished payload expression, or `undefined` for a
         *  `unit` variant — never an opaque pre-assembled `{variant,
         *  value}` object a rule would have to destructure back apart. */
        readonly finishUnion: (variant: string, payloadExpr: string | undefined) => string
        readonly activeVariantName: (finishedValueExpr: string) => string
        readonly activeVariantPayload: (finishedValueExpr: string, variant: string) => string }
    | { readonly kind: "list"
        readonly finishList: (plainArrayExpr: string) => string
        readonly count: (finishedValueExpr: string) => string
        readonly elementAt: (finishedValueExpr: string, indexExpr: string) => string
        /** Bulk sequential transfer (`WRITE_SEQ`/`READ_SEQ`,
         *  ROADMAP.md item 11) — optional: only a list rule whose element
         *  is itself numeric ever receives one (the RTL only emits these
         *  ops for a `List<Integer>`-shaped node, `binary-rules.ts`'s
         *  `listOfIntegerEncodeRule`/`DecodeRule`), so a rule for any
         *  other element kind simply never needs to implement this.
         *  `codec-codegen.ts` delegates to it rather than hardcoding a
         *  runtime call — the trivial rule (`ts-emitter.ts`'s `listRule`)
         *  implements it the obvious way (forward to `writeSeq`/
         *  `readSeq`); a future direct-access mapping rule is free to
         *  implement it via a raw `subarray`/DMA-style copy instead,
         *  with no special-cased knowledge on codec-codegen's side either
         *  way. `writeSeq` reads the already-`finishList`-ed incoming
         *  value (encode only ever reads a finished value); `readSeq`
         *  fills the plain, pre-`finishList` growable accumulator
         *  (decode's own accumulator shape, uniform regardless of rule —
         *  see this type's own header comment) — so only `writeSeq` ever
         *  needs to account for a rule's own chosen finished shape. */
        readonly bulk?: {
            readonly writeSeq: (finishedValueExpr: string, iterExpr: string, widthExpr: string, countExpr: string) => string
            readonly readSeq: (accumulatorExpr: string, iterExpr: string, widthExpr: string, signedExpr: string, countExpr: string) => string
        }
        /** Optional: how to create this list's own in-progress decode
         *  accumulator, and how to append one element to it. Defaults to
         *  a bare array literal and `.push` if omitted — every existing
         *  rule relies on that default. Same rationale as `beginStruct`/
         *  `setField` above. */
        readonly beginList?: () => string
        readonly appendElement?: (accExpr: string, valueExpr: string) => string }

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
    /** How `codec-codegen.ts` constructs/reads a value of this node's own
     *  projected shape — see {@link Accessor}'s own doc comment. */
    readonly access: Accessor
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
    /** See {@link Accessor}'s own doc comment. No `resolve` callback,
     *  unlike `refOf`/`produce` — an accessor never needs a child's own
     *  accessor, only how *this* node's own value exposes its parts. */
    readonly access: (match: MatchOf<TypePattern>, node: TypeNode) => Accessor
    /** Optional: capabilities for other nodes this rule's own `pattern`
     *  structurally absorbed in the same match — a concrete sub-pattern
     *  deeper than a bare `pStar()` hole (e.g. `ts-alternative-rules.ts`'s
     *  `byteListAsUint8ArrayRule`, `pList(pInteger(0,255))`, witnesses
     *  both the list and its byte element in one `matchType` call).
     *  Keyed by that child's raw (possibly-thunk) `SemanticType` — the
     *  same identity `ResolveFn` uses. Only needed if something might
     *  ever independently `resolve()` the absorbed position (a different
     *  pairing of codec rules that makes it its own procedure boundary);
     *  leaving it unset when nothing does is fine — `createResolver`
     *  (`@ppl/core`) only complains if something actually tries. See
     *  `createTsResolver`'s own header for the guarantee this provides:
     *  an absorbed node is never independently re-matched against the
     *  full rule list from scratch. A full `TSTypeDecl`, not a bare
     *  `Accessor` — the absorbed node's own `ref`/`deps` matter too, if
     *  it's ever independently addressed (e.g. as a leaf `LOAD_VAL`/
     *  `STORE_VAL` target rather than a `finishList` return, its `ref` is
     *  what a caller declaring a variable of its type would need). */
    readonly claims?: (match: MatchOf<TypePattern>, node: TypeNode) => ReadonlyMap<SemanticType, TSTypeDecl>
}

/**
 * Build a `TsRule` with `refOf`/`produce`/`access`/`claims`'s `match`
 * narrowed to `MatchOf<P>` — exactly `codecRule`'s own factory, for
 * exactly the same reason (a rule list needs `pattern`/callbacks erased
 * back to the union at the point of storage; this is the one place that
 * erasure happens).
 */
export function tsRule<P extends TypePattern>(
    pattern: P,
    refOf: (match: MatchOf<P>, node: TypeNode, resolve: ResolveFn) => string,
    produce: (match: MatchOf<P>, node: TypeNode, resolve: ResolveFn) => { decl?: string; deps: readonly number[] },
    access: (match: MatchOf<P>, node: TypeNode) => Accessor,
    claims?: (match: MatchOf<P>, node: TypeNode) => ReadonlyMap<SemanticType, TSTypeDecl>,
): TsRule
{
    return { pattern, refOf, produce, access, claims } as TsRule
}

/**
 * Build an on-demand, memoized, cycle-safe `SemanticType -> TSTypeDecl`
 * resolver from an ordered rule list (first match wins — a caller's own
 * rules go first so they can preempt a default, exactly like
 * `createCodecResolver`). Returns a function that, given a root type (and
 * optionally further roots — see `projectTSTypes`), resolves it and
 * returns the *whole* accumulated `Map<TypeNode.id, TSTypeDecl>` — unlike
 * `createCodecResolver` (whose caller only ever wants the *root's* own
 * `Procedure`, since `lowerProgram` separately walks the call graph),
 * every reachable struct/union here needs its own top-level declaration
 * emitted, so the full map is the actual deliverable — `@ppl/core`'s
 * `createResolver` exposes exactly this via its own `cache`.
 *
 * `mintPlaceholder`/`fill` lift each `TsRule`'s own three-producer shape
 * (`refOf`/`produce`/`access`, plus optional `claims`) onto
 * `createResolver`'s reserve-then-fill contract: `access` is computed
 * first (never itself recursive — safe before anything might recurse
 * back to this same node), then `refOf` (may recurse, cached for anyone
 * that needs it before `produce` runs), then `produce`.
 *
 * `graph`, if given, is used instead of building a fresh one — required
 * whenever a caller (`codec-module.ts`) also needs to cross-reference
 * `TypeNode`s from some *other* already-built graph over the same root
 * (its own `resolveHandleTypes`-based procedure-boundary walk): for a
 * thunked/self-referential schema, two independently-built graphs over
 * the same root type are *not* interchangeable (`createResolver`'s own
 * doc comment) — sharing one is the only sound way to cross-reference.
 */
/** `TSTypeDecl`'s public fields are `readonly` for every consumer past
 *  construction — `codec-codegen.ts`/`emitTSDeclarations` should never
 *  mutate one. `fill` is the one place that's wrong for: it's building
 *  the record in place, exactly as the old hand-rolled resolver's own
 *  `decl: {ref: string; ...}` local did before being handed back as a
 *  `TSTypeDecl`. Same trick here — mutate through this local, mutable
 *  view of the very same object `mintPlaceholder` handed back as `C`. */
type MutableTSTypeDecl = { ref: string; decl?: string; deps: readonly number[]; access: Accessor }

export function createTsResolver(rules: readonly TsRule[], graph?: TypeGraph): (root: SemanticType, extraRoots?: readonly SemanticType[]) => Map<number, TSTypeDecl>
{
    const adapted: readonly ResolverRule<TSTypeDecl, void>[] = rules.map(rule => ({
        pattern: rule.pattern,
        fill: (placeholder, match, node, _ctx, resolveWithCtx) =>
        {
            const resolve: ResolveFn = childType => resolveWithCtx(childType, undefined)
            const mutable = placeholder as MutableTSTypeDecl
            mutable.access = rule.access(match, node)
            mutable.ref = rule.refOf(match, node, resolve)
            const { decl, deps } = rule.produce(match, node, resolve)
            mutable.decl = decl
            mutable.deps = deps
            return rule.claims ? { claims: rule.claims(match, node) } : undefined
        },
    }))

    const { resolve, cache } = createResolver<TSTypeDecl, void>(
        adapted,
        (): TSTypeDecl => ({ ref: "", deps: [], access: undefined as unknown as Accessor }),
        undefined,
        graph,
    )

    return (root: SemanticType, extraRoots: readonly SemanticType[] = []) =>
    {
        resolve(root, undefined)
        for(const extra of extraRoots) resolve(extra, undefined)

        // `cache` is keyed by `createResolver`'s default `keyOf`
        // (`String(node.id)`, never overridden here — target-js has no
        // per-call `Ctx`) — parsing back to a number is exact, an integer
        // id round-trips through `String`/`Number` losslessly.
        const result = new Map<number, TSTypeDecl>()
        for(const [key, decl] of cache) result.set(Number(key), decl)
        return result
    }
}

/**
 * Run a TS projection over `root` with `rules` (first match wins — a
 * caller's own rules go first to preempt a default). The thinnest possible
 * driver over `createTsResolver` above — mirrors where `buildCodec` sits
 * relative to `createCodecResolver` in `@ppl/codecs/src/engine/resolver.ts`:
 * generic over *any* `TsRule[]`, so it belongs next to the primitive it
 * drives, not inside a specific rule library like `../components/ts-emitter.ts`.
 *
 * `extraRoots`, if given, are also resolved (in addition to `root`) —
 * `codec-module.ts` uses this to guarantee every genuine CALL_CODEC/
 * procedure-boundary `TypeNode` (its own `resolveHandleTypes`-based walk,
 * across both directions) has its own `Accessor`, precisely, without a
 * blind "resolve literally everything reachable" sweep: a `TsRule`'s own
 * `produce`/`refOf` only calls `resolve()` on a child whose *declaration
 * text* it actually needs (the all-unit union collapse never resolves
 * its own unit-kind variants, since a bare string-literal union needs no
 * per-variant ref) — a strictly narrower set than every procedure
 * boundary codec-codegen.ts's own `accessorFor` might reach. `graph`, if
 * given, is passed straight through to `createTsResolver` — see its own
 * doc comment for why a caller cross-referencing another already-built
 * graph over the same root (exactly what `extraRoots` needs) must share
 * it rather than let this function build its own.
 */
export function projectTSTypes(root: SemanticType, rules: readonly TsRule[], extraRoots: readonly SemanticType[] = [], graph?: TypeGraph): Map<number, TSTypeDecl>
{
    return createTsResolver(rules, graph)(root, extraRoots)
}

/**
 * Emit a complete TypeScript declaration string from a projection result.
 * Generic over the result `Map` alone — it doesn't know or care which
 * rules produced it, so it lives here rather than in a components file.
 */
/** `export `-prefixes every top-level `interface`/`type`/`class`/
 *  `abstract class` statement a rule's own `decl` text contains — one
 *  rule (`unionAsClassHierarchyRule`) emits several such statements in
 *  one `decl` string (an abstract base plus one subclass per variant), so
 *  this is a per-line match rather than a once-per-decl prefix. Exported
 *  declarations matter for real: `structAsClassRule`/
 *  `unionAsClassHierarchyRule`'s own classes are real runtime values a
 *  caller (or `codec-module.ts`'s own generated `encode${name}`/
 *  `decode${name}`, in the same module) needs to actually construct
 *  instances of — an `interface`/`type` has no runtime existence to
 *  export at all, but prefixing it too is harmless (TS erases it either
 *  way) and keeps this one rule uniform across every decl shape. */
const EXPORTABLE_DECL = /^(interface|type|class|abstract class)\b/

export function emitTSDeclarations(result: Map<number, TSTypeDecl>): string
{
    const lines: string[] = []
    for (const [, decl] of result)
    {
        if (decl.decl)
        {
            lines.push(decl.decl.split("\n").map(line => line.replace(EXPORTABLE_DECL, "export $1")).join("\n"))
            lines.push("")
        }
    }
    return lines.join("\n")
}
