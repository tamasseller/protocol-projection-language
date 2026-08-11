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

import type { TsRule } from "../engine/resolver"
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
    () => ({ deps: [] }))

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
    () => ({ deps: [] }))

const wideIntegerRule: TsRule = tsRule(pInteger(-Infinity, Infinity),
    () => "bigint",
    () => ({ deps: [] }))

export const bigIntEscalationRules: readonly TsRule[] = [safeIntegerRule, wideIntegerRule]

// ── List<byte> → Uint8Array, instead of number[] ────────────────────────

/** For a field meant as raw bytes (matches the shape
 *  `binary-rules.ts`'s `listOfIntegerEncodeRule`/`WRITE_SEQ` special-cases
 *  on the wire side) rather than a small numeric array — `Uint8Array` is
 *  typed and zero-copy-friendly; it doesn't serialize through
 *  `JSON.stringify` on its own, unlike `number[]`. */
export const byteListAsUint8ArrayRule: TsRule = tsRule(pList(pInteger(0, 255)),
    () => "Uint8Array",
    () => ({ deps: [] }))

// ── List<T> capacity ≤1 → optional field ─────────────────────────────────

/** A list capped at one element is isomorphic to an optional value.
 *  Opt-in, not a default: capacity is a wire/storage bound, not a
 *  declaration of "this is optional" — collapsing it by default would
 *  surprise a caller expecting array methods (`.length`, `.map()`) on
 *  every `List<T>` regardless of capacity. */
export const capacityOneListAsOptionalRule: TsRule = tsRule(pList(pStar(), 1),
    (match, _node, resolve) => `${resolve(match.elementType).ref} | null`,
    (_match, node) => ({ deps: [child(node, { element: true })!.id] }))

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
    (_match, node) => ({ deps: [child(node, { variant: "value" })!.id] }))

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

        const className = (variantName: string) => `${name}_${variantName[0].toUpperCase()}${variantName.slice(1)}`
        const subclasses = variants.map(v => `class ${className(v.name)} extends ${name} {\n  constructor(readonly value: ${v.ref}) { super(); }\n}`)

        return { decl: `abstract class ${name} {}\n${subclasses.join("\n")}`, deps }
    })

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
    })
