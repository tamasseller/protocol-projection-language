/**
 * @ppl/codecs — The default binary codec component library
 *
 * Layer 2 (docs/ARCHITECTURE.md's "Mappings" section): a concrete, opinionated
 * pair of `CodecRule<void>[]` — length-prefixed lists, a leading-tag byte for
 * a standalone union, per-field struct delegation with union-tag hoisting —
 * built entirely on `engine/builders.ts`'s generic driver and
 * `engine/resolver.ts`'s generic resolution primitive, neither of which know
 * this library exists. Neither list has any special standing with
 * `buildCodec`: a caller passes `binaryEncodeRules`/`binaryDecodeRules` (or
 * doesn't) exactly like any other `CodecRule<void>[]` — see
 * `components/delta-leb128.ts` and `components/json.ts` for the other
 * libraries this one composes alongside.
 *
 * Two lists, not one list plus a threaded `direction` value: a resolver run
 * is already committed to one direction for its *entire* walk (`buildCodec`
 * takes one fixed rule list per call), so a single rule branching on
 * `direction === "encode"` internally was pure ceremony — every `produce`
 * body below is a flat, non-branching description of exactly what its own
 * direction does. `unitRule` is the one rule genuinely shared by both lists
 * (`return;` either way), so it's just one object referenced from both.
 *
 * One real generic optimization lives here: a struct's union-typed field
 * with few enough variants to need only a couple of bits gets its tag
 * *hoisted* into one shared leading bitmap instead of paying for its own
 * standalone tag byte — see `structEncodeRule`/`structDecodeRule`.
 */

import type { IrFragment } from "@ppl/machine"
import { ir } from "@ppl/machine"
import type { SemanticType, UnionType, IntegerPattern, UnitPattern, StructFieldsMatch } from "@ppl/core"
import { concreteKindOf, derefType, SemanticTypeKinds } from "@ppl/core"
import { pInteger, pUnit, pList, pUnionFields, pStructFields, pStar } from "@ppl/core"
import { intWireSize } from "../engine/codec-extension"
import type { CodecRule } from "../engine/resolver"
import { codecRule } from "../engine/resolver"

// ── Integers ─────────────────────────────────────────────────────────────

// `Ctx` (void here) has nothing to infer it from on rules whose produce
// doesn't take it at all — explicit type arguments instead.
const integerEncodeRule = codecRule<IntegerPattern, void>(pInteger(-Infinity, Infinity), (match) =>
    ir`load_val(0); write(0, ${intWireSize(match)}); return;`)

const integerDecodeRule = codecRule<IntegerPattern, void>(pInteger(-Infinity, Infinity), (match) =>
    ir`read(0, ${intWireSize(match)}); store_val(0); return;`)

// ── Unit — genuinely direction-agnostic, shared by both lists ───────────

const unitRule = codecRule<UnitPattern, void>(pUnit(), () => ir`return;`)

// ── Lists — length-prefixed ──────────────────────────────────────────────

/** Byte width of a list's count prefix, sized to its declared capacity
 *  (defaulting to a 1-byte prefix, ≤255 elements, when uncapacitated). */
function countPrefixWidth(capacity: number | undefined): number
{
    const cap = capacity ?? 0xFF
    return cap <= 0xFF ? 1 : cap <= 0xFFFF ? 2 : 4
}

const listEncodeRule = codecRule(pList(pStar()), (match, _ctx: void, resolve) =>
{
    const elem = resolve(match.elementType, undefined)
    const width = countPrefixWidth(match.capacity)

    return ir`
        u32 left = 0;
        left = count(0);
        write(0, ${width});
        while (left != 0) { call_codec_next(${elem}, 0); left = left - 1; }
        return;
    `
})

const listDecodeRule = codecRule(pList(pStar()), (match, _ctx: void, resolve) =>
{
    const elem = resolve(match.elementType, undefined)
    const width = countPrefixWidth(match.capacity)

    return ir`
        u32 left = 0;
        left = read(0, ${width});
        open_list(0);
        while (left != 0) { call_codec_next(${elem}, 0); left = left - 1; }
        return;
    `
})

// ── Unions — standalone (no hoisting available to the caller) ──────────

/** Tag width for a standalone union — 1 byte, up to 256 variants. Struct
 *  fields that qualify for hoisting (`structEncodeRule`/`structDecodeRule`,
 *  below) never reach this rule at all; this is for a union reached any
 *  other way (the root type itself, or through a list element). */
const unionEncodeRule = codecRule(pUnionFields(pStar()), (match, _ctx: void, resolve) =>
{
    const cases = match.variantMatches.map((v, k) =>
        ir`case ${k}: call_codec(${resolve(v.type, undefined)}, 0, ${k});`)

    return ir`tag(0); write(0, 1); switch (tag(0)) { ${cases} } return;`
})

const unionDecodeRule = codecRule(pUnionFields(pStar()), (match, _ctx: void, resolve) =>
{
    const cases = match.variantMatches.map((v, k) =>
        ir`case ${k}: call_codec(${resolve(v.type, undefined)}, 0, ${k});`)

    return ir`switch (read(0, 1)) { ${cases} } return;`
})

// ── Structs — per-field delegation, with union-tag hoisting ─────────────

/** A struct field whose union tag was folded into the shared bitmap. */
interface HoistedField
{
    readonly fieldIndex: number
    readonly bitOffset: number
    readonly bits: number
    readonly mask: number
    /** One variant payload's raw SemanticType per variant, in declaration
     *  order — resolvable by identity, no TypeNode needed. */
    readonly variantTypes: readonly SemanticType[]
}

const HOIST_MAX_VARIANTS = 4 // needs ≤2 bits — the "basic" cutoff
const BITMAP_MAX_BITS = 32   // one register's worth (vm.ts's ALU is 32-bit)

const bitsFor = (variantCount: number): number =>
    variantCount <= 1 ? 0 : Math.ceil(Math.log2(variantCount))

function classifyHoistableFields(fieldMatches: StructFieldsMatch["fieldMatches"]): ReadonlyMap<number, HoistedField>
{
    const byField = new Map<number, HoistedField>()
    let bitOffset = 0

    fieldMatches.forEach((f, fieldIndex) =>
    {
        // `f.type` may still be a reference thunk — concreteKindOf/derefType
        // follow it through (kindOf alone would just report "reference").
        if(concreteKindOf(f.type) !== SemanticTypeKinds.Union) return
        const unionType = derefType(f.type) as UnionType
        const variantCount = unionType.variants.size
        if(variantCount > HOIST_MAX_VARIANTS) return
        const bits = bitsFor(variantCount)
        if(bitOffset + bits > BITMAP_MAX_BITS) return // safety cap — stop hoisting further fields

        byField.set(fieldIndex, {
            fieldIndex, bitOffset, bits,
            mask: bits === 0 ? 0 : (1 << bits) - 1,
            variantTypes: [...unionType.variants.values()],
        })
        bitOffset += bits
    })

    return byField
}

const structEncodeRule = codecRule(pStructFields(pStar()), (match, _ctx: void, resolve) =>
{
    const hoisted = classifyHoistableFields(match.fieldMatches)
    const totalBits = [...hoisted.values()].reduce((sum, h) => sum + h.bits, 0)
    const bitmapBytes = Math.ceil(totalBits / 8)
    const O_FIELD = 1 // scratch handle slot for whichever field is being processed

    const stmts: IrFragment[] = []

    if(hoisted.size > 0)
    {
        // Read every hoisted field's active-variant index (the same
        // computation TAG does, just folded into a shared local instead of
        // its own opcode) and pack it in. Has to happen — and be written to
        // the wire — *before* any field's payload, since the payloads are
        // written by nested delegate calls below and the stream is
        // strictly append-only.
        stmts.push(ir`u32 bitmap = 0;`)
        for(const h of hoisted.values())
            stmts.push(ir`
                enter(${O_FIELD}, 0, ${h.fieldIndex});
                bitmap = bitmap | (tag(${O_FIELD}) << ${h.bitOffset});
            `)
        stmts.push(ir`bitmap; write(0, ${bitmapBytes});`)
    }

    // Per field, in declaration order (§8.1).
    match.fieldMatches.forEach((f, fieldIndex) =>
    {
        const hoist = hoisted.get(fieldIndex)
        if(!hoist)
        {
            stmts.push(ir`call_codec(${resolve(f.type, undefined)}, 0, ${fieldIndex});`)
            return
        }

        // Hoisted union field: get the tag from TAG (cheap to recompute,
        // avoids a second local just to remember it from the bitmap pass
        // above), then dispatch straight to the matching variant's payload
        // codec — no separate TAG opcode here, no standalone union codec.
        const cases = hoist.variantTypes.map((v, k) => ir`case ${k}: call_codec(${resolve(v, undefined)}, ${O_FIELD}, ${k});`)
        stmts.push(ir`enter(${O_FIELD}, 0, ${fieldIndex}); switch (tag(${O_FIELD})) { ${cases} }`)
    })

    stmts.push(ir`return;`)
    return ir`${stmts}`
})

const structDecodeRule = codecRule(pStructFields(pStar()), (match, _ctx: void, resolve) =>
{
    const hoisted = classifyHoistableFields(match.fieldMatches)
    const totalBits = [...hoisted.values()].reduce((sum, h) => sum + h.bits, 0)
    const bitmapBytes = Math.ceil(totalBits / 8)
    const O_FIELD = 1

    const stmts: IrFragment[] = []

    if(hoisted.size > 0)
        stmts.push(ir`u32 bitmap = 0; bitmap = read(0, ${bitmapBytes});`)

    match.fieldMatches.forEach((f, fieldIndex) =>
    {
        const hoist = hoisted.get(fieldIndex)
        if(!hoist)
        {
            stmts.push(ir`call_codec(${resolve(f.type, undefined)}, 0, ${fieldIndex});`)
            return
        }

        // `enter` (struct → field) is direction-agnostic — it only produces
        // a plain, not-yet-variant-selected handle; the union's own variant
        // gets set by `call_codec`'s `ref`, inside each case, not by this.
        // One `enter` ahead of the switch covers every case, so only the
        // discriminant expression (unpacked from the bitmap here, vs. a
        // fresh TAG read on the encode side) depends on direction.
        const cases = hoist.variantTypes.map((v, k) => ir`case ${k}: call_codec(${resolve(v, undefined)}, ${O_FIELD}, ${k});`)
        const discriminant = `(bitmap >> ${hoist.bitOffset}) & ${hoist.mask}`
        stmts.push(ir`enter(${O_FIELD}, 0, ${fieldIndex}); switch (${discriminant}) { ${cases} }`)
    })

    stmts.push(ir`return;`)
    return ir`${stmts}`
})

/** The default binary wire-format library — one pair of `CodecRule<void>[]`
 *  among possibly several, not privileged `buildCodec` applies on a
 *  caller's behalf. Pass the one matching your direction explicitly:
 *  `buildCodec(root, binaryEncodeRules, undefined)`, or
 *  `[...myOverrides, ...binaryEncodeRules]` to preempt specific shapes
 *  (see `components/delta-leb128.ts`). */
export const binaryEncodeRules: readonly CodecRule<void>[] =
    [integerEncodeRule, unitRule, listEncodeRule, unionEncodeRule, structEncodeRule]

export const binaryDecodeRules: readonly CodecRule<void>[] =
    [integerDecodeRule, unitRule, listDecodeRule, unionDecodeRule, structDecodeRule]
