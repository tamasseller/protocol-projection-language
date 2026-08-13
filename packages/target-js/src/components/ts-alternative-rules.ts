/**
 * @ppl/target-js — Opt-in alternative TS representations
 *
 * `components/ts-emitter.ts`'s `tsTypeRules` is one idiomatic mapping among
 * several the metamodel supports — not the only correct one. Each rule
 * below is a standalone, independently-composable alternative for one
 * specific type shape, in the same spirit as `@ppl/codecs`'s
 * `delta-leb128.ts` (an opt-in alternative for `List<Integer>`, not a
 * default): prepend the ones you want ahead of `tsTypeRules`
 * (`[...selectedAlternatives, ...tsTypeRules]`) to preempt the default for
 * just that shape. None of these are wired into `tsTypeRules` itself.
 *
 * Two matcher facts every rule below leans on (`@ppl/core/matcher.ts`):
 * `pInteger(min, max)`/`pList(_, capacityMax)` match by CONTAINMENT — the
 * pattern is an envelope the type's actual range/capacity must fit
 * *inside* — so a narrower envelope tried first can carve out a subset of
 * what a wider envelope (the default rule, or another alternative here)
 * would otherwise catch. `pUnion({...})` (unlike `pUnionFields`) matches by
 * *exact* variant name set, which is what makes `optionalUnionRule` below
 * safe to compose ahead of `unionAsClassHierarchyRule`/the default
 * `unionFieldsRule`: it only ever claims the one shape `optional()`
 * (`@ppl/core/metamodel.ts`) constructs, never a generic union.
 */
import type { TypeNode } from "@ppl/core"
import { child, nameOf as declaredNameOf } from "@ppl/core"
import { pInteger, pUnit, pStar, pList, pUnion, pStructFields, pUnionFields } from "@ppl/core"

import type { TsRule, TSTypeDecl } from "../engine/resolver"
import { tsRule } from "../engine/resolver"

/** Same name-resolution fallback `ts-emitter.ts`'s rules use — repeated
 *  here rather than imported, since it's a one-liner and importing it
 *  would make this file depend on the very component library it's meant
 *  to stand apart from as an alternative. */
function nameOf(node: TypeNode): string
{
    return declaredNameOf(node.source as any) ?? `T${node.id}`
}

// ── Unit → undefined, instead of null ───────────────────────────────────

/** An absent-key idiom (`{...(hasX && {x: v})}`-style construction, or a
 *  field a consumer expects to check with `"x" in obj"`) reads more
 *  naturally as `undefined` than `null`. Trade-off vs. the default: this
 *  doesn't round-trip through `JSON.stringify` (an `undefined`-valued key
 *  is dropped, not serialized), unlike `null`. */
export const unitAsUndefinedRule: TsRule = tsRule(pUnit(),
    () => "undefined",
    () => ({ deps: [] }),
    () => ({ kind: "unit", unitValue: () => "undefined" }))

// ── Integer → bigint past Number's safe range ───────────────────────────

/** A pair, not two independent rules — `wideIntegerRule`'s envelope
 *  (`-Infinity, Infinity`) alone would shadow the default `integerRule`
 *  for every integer, safe-range ones included. Compose both together,
 *  ahead of `tsTypeRules`: `[...bigIntEscalationRules, ...tsTypeRules]`.
 *  `safeIntegerRule`'s narrower envelope claims anything that actually
 *  fits `Number`'s safe range first; only what doesn't falls through to
 *  `wideIntegerRule`. */
const safeIntegerRule: TsRule = tsRule(pInteger(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    () => "number",
    () => ({ deps: [] }),
    () => ({ kind: "integer", fromWire: x => x, toWire: x => x }))

// `BigInt(x)`/`Number(x)` — the wire-level bit width/sign-extension a
// caller's `fromWire`/`toWire` receives is always already correct (image-
// tree-driven, computed by codec-codegen before calling in), so this rule
// only ever needs the last-mile host-representation conversion, never any
// wire mechanics of its own.
const wideIntegerRule: TsRule = tsRule(pInteger(-Infinity, Infinity),
    () => "bigint",
    () => ({ deps: [] }),
    () => ({
        kind: "integer",
        // Sign-extension (mandatory wire correctness, same reasoning as
        // the default integerRule) happens first, on the plain-number
        // raw read, then the last-mile bigint conversion.
        fromWire: (raw, width, signed) => `BigInt(${signed ? `signExtend(${width * 8}, ${raw})` : raw})`,
        toWire: x => `Number(${x}) >>> 0`,
    }))

export const bigIntEscalationRules: readonly TsRule[] = [safeIntegerRule, wideIntegerRule]

// ── List<byte> → Uint8Array, instead of number[] ────────────────────────

/** For a field meant as raw bytes (matches the shape
 *  `binary-rules.ts`'s `listOfIntegerEncodeRule`/`WRITE_SEQ` special-cases
 *  on the wire side) rather than a small numeric array — `Uint8Array` is
 *  typed and zero-copy-friendly; it doesn't serialize through
 *  `JSON.stringify` on its own, unlike `number[]`. */
export const byteListAsUint8ArrayRule: TsRule = tsRule(pList(pInteger(0, 255)),
    () => "Uint8Array",
    () => ({ deps: [] }),
    () => ({
        kind: "list",
        // codec-codegen's own decode accumulator is always a plain,
        // growable `number[]` regardless of the rule in play (see
        // resolver.ts's own `Accessor` doc comment) — `finishList` is the
        // one, one-time conversion point to this rule's chosen final
        // representation.
        finishList: x => `Uint8Array.from(${x})`,
        count: v => `${v}.length`,
        elementAt: (v, i) => `${v}[${i}]`,
        // The trivial forwarding implementation — a `Uint8Array` already
        // satisfies `writeSeq`'s indexed-read contract just like a plain
        // `number[]` does, so no representation-specific work is needed
        // here (a `subarray`-based fast path is a natural, easy, but not
        // required follow-up once this mechanism exists).
        bulk: {
            writeSeq: (v, iter, width, count) => `writeSeq(ctx, ${iter}, ${v}, ${width}, ${count})`,
            readSeq: (v, iter, width, signed, count) => `readSeq(ctx, ${iter}, ${v}, ${width}, ${signed}, ${count})`,
        },
    }),
    // `pList(pInteger(0, 255))` witnesses both the list and its byte
    // element in one `matchType` call (a concrete sub-pattern, not a
    // `pStar()` hole) — this rule's own match structurally absorbs the
    // element node, so it must supply that node's own Accessor too (see
    // `TsRule.claims`'s own doc comment): nothing in *this* rule/codec
    // pairing ever independently resolves it (bulk transfer never goes
    // through the element's own accessor), but a different pairing of
    // codec rules could make the element its own procedure boundary —
    // without this, that would silently re-match against the full rule
    // list from scratch instead of getting this exact byte semantics.
    (match) => new Map([[match.elementType, {
        ref: "number",
        deps: [],
        access: {
            kind: "integer",
            fromWire: (raw, width, signed) => signed ? `signExtend(${width * 8}, ${raw})` : raw,
            toWire: x => `(${x}) >>> 0`,
        },
    } as TSTypeDecl]]))

// ── List<T> capacity ≤1 → optional field ─────────────────────────────────

/** A list capped at one element is isomorphic to an optional value.
 *  Opt-in, not a default: capacity is a wire/storage bound, not a
 *  declaration of "this is optional" — collapsing it by default would
 *  surprise a caller expecting array methods (`.length`, `.map()`) on
 *  every `List<T>` regardless of capacity. */
export const capacityOneListAsOptionalRule: TsRule = tsRule(pList(pStar(), 1),
    (match, _node, resolve) => `${resolve(match.elementType).ref} | null`,
    (_match, node) => ({ deps: [child(node, { element: true })!.id] }),
    () => ({
        kind: "list",
        // The decode accumulator is still a plain 0-or-1-element array
        // (capacity 1 is enforced by the schema, not by this rule) —
        // `finishList` collapses it to this rule's own `T | null`.
        finishList: x => `${x}.length > 0 ? ${x}[0] : null`,
        count: v => `(${v} === null ? 0 : 1)`,
        // Never called with an index other than 0 — a capacity-1 list has
        // no other element to ask for. `v`'s own static type is `T |
        // null`; `!` narrows it to `T` (this is only ever reached when
        // count() reported 1, i.e. v is genuinely non-null).
        elementAt: v => `${v}!`,
        bulk: {
            // Only `writeSeq` needs to special-case this rule's own
            // `T | null` finished shape — encode is the one direction
            // that ever reads an already-`finishList`-ed value. `count`
            // (via the `TAG`/`COUNT`-equivalent op the RTL already
            // issued before this) is what actually decided 0 vs. 1;
            // this only has to build an array of matching length.
            writeSeq: (v, iter, width, count) => `writeSeq(ctx, ${iter}, ${v} === null ? [] : [${v}], ${width}, ${count})`,
            // `readSeq`'s own accumulator is always the plain, pre-
            // `finishList` growable array — identical regardless of
            // this rule's own chosen finished shape, so no special
            // casing at all.
            readSeq: (v, iter, width, signed, count) => `readSeq(ctx, ${iter}, ${v}, ${width}, ${signed}, ${count})`,
        },
    }))

// ── optional(T) → T | null ───────────────────────────────────────────────

/** The TS counterpart to `target-cpp/cpp-emitter.ts`'s own
 *  `std::optional<T>` rule — both match the exact shape
 *  `@ppl/core/metamodel.ts`'s `optional()` constructs
 *  (`union({value: T, empty: unit}, "empty")`), so a schema authored with
 *  `optional(T)` gets a matching idiomatic representation on both targets
 *  for free, with no per-target opt-in beyond this rule. Must be listed
 *  ahead of `unionAsClassHierarchyRule`/the default `unionFieldsRule`:
 *  `pUnion`'s exact-name match only ever claims this one shape, but a
 *  wider union rule tried first would still claim it via its own
 *  structural (name-agnostic) pattern. */
export const optionalUnionRule: TsRule = tsRule(pUnion({ value: pStar(), empty: pUnit() }),
    (match, _node, resolve) => `${resolve(match.variantMatches.value.type).ref} | null`,
    (_match, node) => ({ deps: [child(node, { variant: "value" })!.id] }),
    () => ({
        kind: "union",
        finishUnion: (variant, payloadExpr) => variant === "value" ? payloadExpr! : "null",
        activeVariantName: v => `(${v} === null ? "empty" : "value")`,
        // `v`'s own static type is `T | null` — codegen-time knowledge of
        // which branch this is (from the compile-time `variant` string,
        // never a runtime check TS could narrow through) doesn't narrow
        // `v` itself, so a plain `!` is needed to read it as `T`.
        activeVariantPayload: (v, variant) => variant === "value" ? `${v}!` : "undefined as any",
    }))

// ── General union → class hierarchy, instead of a discriminated union ───

/** An abstract base class plus one subclass per variant, instead of the
 *  default's `{tag: "..."; value: T}` discriminated union. Trade-off vs.
 *  the default: enables `instanceof` narrowing and per-variant methods,
 *  but the codec's own decoder builds plain `{variant, value}` objects
 *  (`codec-extension.ts`'s `UnionValue`), never actual class instances —
 *  using this rule's output to type a decoded value is a lie unless the
 *  consumer also constructs real instances from the decoded data itself. */
export const unionAsClassHierarchyRule: TsRule = tsRule(pUnionFields(pStar()),
    (_match, node) => nameOf(node),
    (match, node, resolve) =>
    {
        const name = nameOf(node)
        const variants = match.variantMatches.map(v => ({ name: v.name, ref: resolve(v.type).ref }))
        const deps = match.variantMatches.map(v => child(node, { variant: v.name })!.id)

        const className = classNameOf(name)
        const subclasses = variants.map(v => `class ${className(v.name)} extends ${name} {\n  constructor(readonly value: ${v.ref}) { super(); }\n}`)

        return { decl: `abstract class ${name} {}\n${subclasses.join("\n")}`, deps }
    },
    (match, node) =>
    {
        const name = nameOf(node)
        const className = classNameOf(name)
        const variantNames = match.variantMatches.map(v => v.name)
        return {
            kind: "union",
            finishUnion: (variant, payloadExpr) => `new ${className(variant)}(${payloadExpr ?? "undefined"})`,
            // `instanceof`, checked variant-by-variant — the accessor's
            // own real "tag": unlike the default discriminated-union
            // rule, there's no separate `.tag` field to read at all. The
            // chain's own fallback is the *last* variant's name, literal
            // — every real instance matches exactly one `instanceof`
            // check, so "none of the others" already means "the last
            // one," not a genuine unmatched case to guard against.
            activeVariantName: v =>
            {
                const lastName = variantNames[variantNames.length - 1]!
                return variantNames.slice(0, -1).reduceRight(
                    (fallback, n) => `${v} instanceof ${className(n)} ? ${JSON.stringify(n)} : (${fallback})`,
                    JSON.stringify(lastName),
                )
            },
            activeVariantPayload: (v, variant) => `(${v} as ${className(variant)}).value`,
        }
    })

/** Shared between `unionAsClassHierarchyRule`'s `produce`/`access` — one
 *  subclass name per variant, derived from the union's own declared name. */
function classNameOf(unionName: string): (variantName: string) => string
{
    return variantName => `${unionName}_${variantName[0]!.toUpperCase()}${variantName.slice(1)}`
}

// ── Struct → class, instead of an interface ──────────────────────────────

/** A class with a constructor assigning every field, instead of the
 *  default's `interface`. Same caveat as `unionAsClassHierarchyRule`: the
 *  decoder builds a plain object, never a `new StructName(...)` instance —
 *  this rule's output only matches reality if the consumer constructs real
 *  instances from decoded data themselves. */
export const structAsClassRule: TsRule = tsRule(pStructFields(pStar()),
    (_match, node) => nameOf(node),
    (match, node, resolve) =>
    {
        const name = nameOf(node)
        const params = match.fieldMatches.map(f => `readonly ${f.name}: ${resolve(f.type).ref}`)
        const deps = match.fieldMatches.map(f => child(node, { field: f.name })!.id)
        return { decl: `class ${name} {\n  constructor(${params.join(", ")}) {}\n}`, deps }
    },
    (match, node) =>
    {
        const name = nameOf(node)
        const fieldNames = match.fieldMatches.map(f => f.name)
        return {
            kind: "struct",
            // `plainObjExpr` is codec-codegen's own plain accumulator
            // (`{field: v, ...}`) — this rule's own constructor takes
            // fields positionally, in declaration order, so pull them
            // off it by name rather than needing codec-codegen to know
            // this rule's own parameter order.
            finishStruct: obj => `new ${name}(${fieldNames.map(f => `${obj}.${f}`).join(", ")})`,
            // A class's own fields are still plain `readonly` properties
            // — reading one is identical to the default interface rule.
            readField: (v, f) => `${v}.${f}`,
        }
    })
