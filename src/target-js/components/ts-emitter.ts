/**
 * target-js — The default TypeScript type-projection component library
 *
 * Layer 2 (mirrors `src/codecs/components/binary-rules.ts`'s own
 * framing): a concrete, opinionated `TsRule[]` built entirely on
 * `../engine/resolver.ts`'s generic resolution primitive
 * (`createTsResolver`/`projectTSTypes`), which knows nothing about this
 * library. `tsTypeRules` has no special standing with `projectTSTypes` — a
 * caller passes it (or doesn't) exactly like any other `TsRule[]`, and can
 * prepend their own rules ahead of it (`[...myOverrides, ...tsTypeRules]`)
 * to preempt specific shapes, same contract `binary-rules.ts` establishes
 * for its own consumers.
 *
 * Idiomatic mapping, no consumer say in it yet:
 *  - `number` for all integers (JS has no fixed-width integers)
 *  - `null` for unit types
 *  - `interface` / `type` for structs and unions
 *  - `T[]` for lists
 */
import type { TypeNode } from "../../core/index"
import { child, nameOf as declaredNameOf, isUnit } from "../../core/index"
import { pInteger, pUnit, pStar, pStructFields, pUnionFields, pList } from "../../core/index"

import type { TsRule } from "../engine/resolver"
import { tsRule } from "../engine/resolver"

// ——————————————————————————————————————————————
// Helpers
// ——————————————————————————————————————————————

/** Resolve a type's TS name: its first-class declared name if present
 *  (`core`'s `named()`, read off `node.source` — the pre-deref
 *  object `named()` was actually called on), else `T<id>`. */
function nameOf(node: TypeNode): string
{
    return declaredNameOf(node.source as any) ?? `T${node.id}`
}

// ——————————————————————————————————————————————
// Rules
// ——————————————————————————————————————————————

// 1. Integer → number (leaf, no decl)
const integerRule: TsRule = tsRule(pInteger(-Infinity, Infinity),
    () => "number",
    () => ({ deps: [] }),
    () => ({
        kind: "integer",
        // A raw wire read is always unsigned bits (codec-runtime.ts's own
        // `read`) — sign-extension back to the real host value is
        // mandatory wire correctness, not a representation choice, so it
        // happens here unconditionally rather than being left for
        // codec-codegen.ts to assume.
        fromWire: (raw, width, signed) => signed ? `signExtend(${width * 8}, ${raw})` : raw,
        // The mirror on the way out — `>>> 0` reinterprets a (possibly
        // negative) host number as the unsigned bit pattern `write`
        // expects, exactly like the old loadVal helper did.
        toWire: x => `(${x}) >>> 0`,
    }))

// 2. Unit → null (leaf, no decl)
const unitRule: TsRule = tsRule(pUnit(),
    () => "null",
    () => ({ deps: [] }),
    () => ({ kind: "unit", unitValue: () => "null" }))

// 3. List → T[] (inline, no decl of its own)
const listRule: TsRule = tsRule(pList(pStar()),
    (match, _node, resolve) => `${resolve(match.elementType).ref}[]`,
    (_match, node) => ({ deps: [child(node, { element: true })!.id] }),
    () => ({
        kind: "list",
        finishList: x => x,
        count: v => `${v}.length`,
        elementAt: (v, i) => `${v}[${i}]`,
        // The trivial, always-correct implementation: forward straight
        // to the runtime's own generic per-element helpers — this rule
        // has no representation-specific reason to do anything else (a
        // plain `number[]` already satisfies both helpers' own indexed-
        // read/write contract). codec-codegen.ts never calls this unless
        // the RTL itself emitted WRITE_SEQ/READ_SEQ, which only ever
        // happens for a numeric-element list in the first place.
        bulk: {
            writeSeq: (v, iter, width, count) => `writeSeq(ctx, ${iter}, ${v}, ${width}, ${count})`,
            readSeq: (v, iter, width, signed, count) => `readSeq(ctx, ${iter}, ${v}, ${width}, ${signed}, ${count})`,
        },
    }))

// 4. Struct → interface
const structFieldsRule: TsRule = tsRule(pStructFields(pStar()),
    (_match, node) => nameOf(node),
    (match, node, resolve) =>
    {
        const name = nameOf(node)
        const fieldLines = match.fieldMatches.map(f => `  readonly ${f.name}: ${resolve(f.type).ref};`)
        const deps = match.fieldMatches.map(f => child(node, { field: f.name })!.id)
        return { decl: `interface ${name} {\n${fieldLines.join("\n")}\n}`, deps }
    },
    () => ({
        kind: "struct",
        finishStruct: x => x,
        readField: (v, f) => `${v}.${f}`,
    }))

// 5. Union → discriminated union (all-unit variants collapse to a plain
//    string-literal union — no tag field needed when there's no payload).
const unionFieldsRule: TsRule = tsRule(pUnionFields(pStar()),
    (_match, node) => nameOf(node),
    (match, node, resolve) =>
    {
        const name = nameOf(node)
        const allUnit = node.edges.every(e => isUnit(e.target.type))

        if(allUnit)
        {
            const literals = match.variantMatches.map(v => `"${v.name}"`).join(" | ")
            return { decl: `type ${name} = ${literals};`, deps: [] }
        }

        // `variant`, not `tag` — the field name this shape has everywhere
        // else (`codec-extension.ts`'s `UnionValue`, every hand-authored
        // fixture). codec-codegen reaches it only through `access` below,
        // so the declared type and the runtime shape agree only as long as
        // this name matches that convention.
        const members = match.variantMatches.map(v => `  | { variant: "${v.name}"; value: ${resolve(v.type).ref} }`)
        const deps = match.variantMatches.map(v => child(node, { variant: v.name })!.id)
        return { decl: `type ${name} =\n${members.join("\n")};`, deps }
    },
    (_match, node) =>
    {
        // `allUnit` mirrors `produce`'s own check exactly — the accessor
        // has to agree with whichever shape `produce` actually declared.
        const allUnit = node.edges.every(e => isUnit(e.target.type))
        const name = nameOf(node)
        return {
            kind: "union",
            finishUnion: allUnit
                ? (variant) => JSON.stringify(variant)
                : (variant, payloadExpr) => `{ variant: ${JSON.stringify(variant)}, value: ${payloadExpr ?? "undefined"} }`,
            activeVariantName: allUnit ? v => v : v => `${v}.variant`,
            // A runtime `tagOf(...)`-driven `switch` (codec-codegen.ts's
            // own encode-side dispatch) gives TS no way to narrow `v`'s
            // own type the way an `if (v.variant === "x")` check would —
            // an explicit `Extract<>` on the union's own declared name
            // (available without `resolve`, unlike the payload's own
            // ref) recovers exactly the one variant's own shape, so
            // `.value` reads at its real, specific type rather than the
            // union of every variant's own payload type.
            activeVariantPayload: allUnit
                ? () => "undefined as any" // a unit payload carries no real value regardless of which unit rule is active (null vs undefined) — the callee's own body never reads its parameter at all
                : (v, variant) => `(${v} as Extract<${name}, { variant: ${JSON.stringify(variant)} }>).value`,
        }
    })

/** The default TS projection — one array among possibly several, not
 *  privileged by `createTsResolver`/`projectTSTypes` in any way. Pass it
 *  explicitly: `projectTSTypes(root, tsTypeRules)`, or
 *  `projectTSTypes(root, [...myOverrides, ...tsTypeRules])` to preempt
 *  specific shapes. */
export const tsTypeRules: readonly TsRule[] = [integerRule, unitRule, listRule, structFieldsRule, unionFieldsRule]
