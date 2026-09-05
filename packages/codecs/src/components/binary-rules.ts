/**
 * @ppl/codecs — The default binary codec component library
 *
 * Layer 2 (docs/ARCHITECTURE.md's "Mappings" section): a concrete, opinionated
 * pair of `CodecRule<void>[]` — length-prefixed lists, a leading-tag byte for
 * a standalone union, per-field struct delegation with union-tag hoisting —
 * built entirely on `engine/resolver.ts`'s generic resolution primitive
 * (`createCodecResolver`) and its `buildCodec` driver, neither of which know
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
 * (nothing to encode/decode either way), so it's just one object referenced
 * from both.
 *
 * One real generic optimization lives here: a struct's union-typed field
 * cheap enough to tag in fewer bits than a standalone tag byte would cost
 * gets its tag *hoisted* into one shared leading bitmap instead of paying
 * for its own standalone tag byte — see `structEncodeRule`/
 * `structDecodeRule`, and `HOIST_MAX_VARIANTS` for the break-even point.
 */

import type { IrFragment, Procedure } from "mog-core"
import { ir } from "mog-core"
import type { SemanticType, UnionType, IntegerPattern, UnitPattern, StructFieldsMatch, TypeNode } from "@ppl/core"
import { SemanticTypeKinds } from "@ppl/core"
import { pInteger, pUnit, pList, pUnionFields, pStructFields, pStar } from "@ppl/core"
import { intWireSize } from "../engine/codec-extension"
import type { CodecRule } from "../engine/resolver"
import { codecRule } from "../engine/resolver"

// ── Integers ─────────────────────────────────────────────────────────────

// `Ctx` (void here) has nothing to infer it from on rules whose produce
// doesn't take it at all — explicit type arguments instead.
const integerEncodeRule = codecRule(pInteger(-Infinity, Infinity), (match, _ctx: void) =>
    ir`write(0, ${intWireSize(match)}, load_val(0));`)

const integerDecodeRule = codecRule(pInteger(-Infinity, Infinity), (match, _ctx: void) =>
    ir`store_val(0, read(0, ${intWireSize(match)}));`)

// ── Unit — genuinely direction-agnostic, shared by both lists ───────────

const unitRule = codecRule(pUnit(), (_match, _ctx: void) => ir``)

// ── Lists — length-prefixed ──────────────────────────────────────────────

/** Byte width of a list's count prefix, sized to its declared capacity
 *  (defaulting to a 1-byte prefix, ≤255 elements, when uncapacitated). */
function countPrefixWidth(capacity: number | undefined): number
{
    const cap = capacity ?? 0xFF
    return cap <= 0xFF ? 1 : cap <= 0xFFFF ? 2 : 4
}

const listEncodeRule = codecRule(pList(pStar()), (match, _ctx: void, resolve) =>
ir`
    u32 left = 0;
    left = count(0);
    write(0, ${countPrefixWidth(match.capacity)}, left);
    while (left != 0)
    {
        call_codec_next(${resolve(match.elementType, undefined)}, 0); left = left - 1;
    }
`)

const listDecodeRule = codecRule(pList(pStar()), (match, _ctx: void, resolve) =>
ir`
    u32 left = 0;
    left = read(0, ${countPrefixWidth(match.capacity)});
    open_list(0);
    while (left != 0)
    {
        call_codec_next(${resolve(match.elementType, undefined)}, 0); left = left - 1;
    }
`)

// ── List<Integer> — the same length-prefixed layout, but the element run
// itself goes through one WRITE_SEQ/READ_SEQ bulk transfer (ROADMAP.md
// item 11) instead of `listEncodeRule`/`listDecodeRule`'s per-element
// `call_codec_next` loop — no nested procedure call per element, and a
// single recognizable op a target codegen's `raise.ts` pass can later
// specialize into a raw-buffer/DMA copy. Placed ahead of the generic list
// rules below (first-match-wins) so it preempts them for this one element
// shape; a non-integer element (a struct, a nested list) still falls
// through to the generic per-element loop. ─────────────────────────────

const listOfIntegerEncodeRule = codecRule(pList(pInteger(-Infinity, Infinity)), (match, _ctx: void) =>
ir`
    u32 left = 0;
    left = count(0);
    write(0, ${countPrefixWidth(match.capacity)}, left);
    write_seq(0, 0, ${intWireSize(match.elementMatch)}, left);
`)

const listOfIntegerDecodeRule = codecRule(pList(pInteger(-Infinity, Infinity)), (match, _ctx: void) =>
ir`
    u32 left = 0;
    left = read(0, ${countPrefixWidth(match.capacity)});
    open_list(0);
    read_seq(0, 0, ${intWireSize(match.elementMatch)}, ${match.elementMatch.min < 0 ? 1 : 0}, left);
`)

/** Byte width of a standalone union's tag, sized to its actual variant
 *  count (mirrors `countPrefixWidth` above — same reasoning, a discrete
 *  count instead of an optional capacity). A tag is a variant *index*
 *  (0..variantCount-1), so it's `variantCount` itself, not `variantCount -
 *  1`, that has to fit the width: exactly 256 variants' worst-case index
 *  (255) still fits one byte. The `> 2**32` branch is unreachable in
 *  practice (no real schema gets anywhere near four billion variants) but
 *  costs nothing to state — better a loud build-time throw than silently
 *  handing `WRITE`/`READ` a width no tag could ever need past. Struct
 *  fields that qualify for hoisting (`structEncodeRule`/`structDecodeRule`,
 *  below) never reach this rule at all; this is for a union reached any
 *  other way (the root type itself, or through a list element). */
function unionTagWidth(variantCount: number): number
{
    if(variantCount > 2 ** 32)
        throw new Error(`binary-rules: union has ${variantCount} variants — no tag width can address that many`)
    return variantCount <= 0x100 ? 1 : variantCount <= 0x10000 ? 2 : 4
}

const unionEncodeRule = codecRule(pUnionFields(pStar()), (match, _ctx: void, resolve) =>
{
    const width = unionTagWidth(match.variantMatches.length)
    const cases: IrFragment[] = match.variantMatches.map((v, k) =>
        ir`case ${k}: call_codec(${resolve(v.type, undefined)}, 0, ${k}); break;`)

    return ir`
        write(0, ${width}, tag(0));
        switch (tag(0)) { ${cases} }
    `
})

const unionDecodeRule = codecRule(pUnionFields(pStar()), (match, _ctx: void, resolve) =>
{
    const width = unionTagWidth(match.variantMatches.length)
    const cases: IrFragment[] = match.variantMatches.map((v, k) =>
        ir`case ${k}: call_codec(${resolve(v.type, undefined)}, 0, ${k}); break;`)

    return ir`
        switch (read(0, ${width})) { ${cases} }
    `
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

// A standalone union always costs exactly 1 byte (8 bits) for its tag
// (`unionTagWidth` below, ≤256 variants), so hoisting a field only ever
// pays for itself when its own tag costs *less* than that — 128 variants
// (7 bits) is the actual break-even point, not an arbitrary round number.
const HOIST_MAX_VARIANTS = 128
const BITMAP_MAX_BITS = 32   // one register's worth (vm.ts's ALU is 32-bit)

const bitsFor = (variantCount: number): number =>
    variantCount <= 1 ? 0 : Math.ceil(Math.log2(variantCount))

/**
 * `f.type` may still be a reference thunk — for a self-referential schema
 * (a recursive union-typed field), dereferencing it directly (the old
 * `concreteKindOf`/`derefType` approach) re-invokes the thunk fresh,
 * producing brand-new variant-payload objects that were never registered
 * in the `TypeGraph`'s cycle-breaking identity map (`@ppl/core/type-
 * graph.ts`'s `byObject`) — a later `resolve(v, ...)` on one of those then
 * fails with "not reachable". `resolve(f.type, ctx)` goes through the
 * *same* graph the rest of this rule already trusts: its `Procedure`'s
 * `header` (resolver.ts) is the exact `TypeNode` — already deref'd once,
 * already identity-safe — that `f.type` maps to. Calling `resolve` here
 * merely to peek at `.header`, without ever splicing the returned
 * `Procedure` into any `ir` text, adds nothing to the final program:
 * reachability is driven by which procedures actually get interpolated,
 * not by how many times `resolve` was called.
 */
function classifyHoistableFields(
    fieldMatches: StructFieldsMatch["fieldMatches"],
    resolve: (childType: SemanticType, ctx: void) => Procedure,
): ReadonlyMap<number, HoistedField>
{
    const byField = new Map<number, HoistedField>()
    let bitOffset = 0

    fieldMatches.forEach((f, fieldIndex) =>
    {
        const fieldType = (resolve(f.type, undefined).header as TypeNode).type
        if(fieldType.kind !== SemanticTypeKinds.Union) return
        const unionType = fieldType as UnionType
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
    const hoisted = classifyHoistableFields(match.fieldMatches, resolve)
    const totalBits = [...hoisted.values()].reduce((sum, h) => sum + h.bits, 0)
    const bitmapBytes = Math.ceil(totalBits / 8)
    const O_FIELD = 1 // scratch handle slot for whichever field is being processed

    return ir`
        ${hoisted.size === 0 
            ? ir`` 
            : ir`
            u32 bitmap = 0;
            ${[...hoisted.values()].map(h => ir`
                enter(${O_FIELD}, 0, ${h.fieldIndex});
                bitmap = bitmap | (tag(${O_FIELD}) << ${h.bitOffset});
            `)}
            write(0, ${bitmapBytes}, bitmap);
            `
        }
        ${match.fieldMatches.map((f, fieldIndex) =>
        {
            const hoist = hoisted.get(fieldIndex)
            if(!hoist)
                return ir`call_codec(${resolve(f.type, undefined)}, 0, ${fieldIndex});`

            const cases = hoist.variantTypes.map((v, k) => ir`case ${k}: call_codec(${resolve(v, undefined)}, ${O_FIELD}, ${k}); break;`)
            return ir`enter(${O_FIELD}, 0, ${fieldIndex}); switch (tag(${O_FIELD})) { ${cases} }`
        })}
    `
})

const structDecodeRule = codecRule(pStructFields(pStar()), (match, _ctx: void, resolve) =>
{
    // ── Meta: pure JS bookkeeping, no DSL text yet ──────────────────────
    const hoisted = classifyHoistableFields(match.fieldMatches, resolve)
    const totalBits = [...hoisted.values()].reduce((sum, h) => sum + h.bits, 0)
    const bitmapBytes = Math.ceil(totalBits / 8)
    const O_FIELD = 1

    // ── DSL: the whole body, assembled in one place ─────────────────────
    return ir`
        ${hoisted.size === 0 
            ? ir`` 
            : ir`u32 bitmap = 0; bitmap = read(0, ${bitmapBytes});`
        }

        ${match.fieldMatches.map((f, fieldIndex) =>
        {
            const hoist = hoisted.get(fieldIndex)

            return hoist 
                ? (ir`
                    enter(${O_FIELD}, 0, ${fieldIndex}); 
                    switch (${`(bitmap >> ${hoist.bitOffset}) & ${hoist.mask}`}) 
                    { 
                        ${hoist.variantTypes.map((v, k) => ir`case ${k}: call_codec(${resolve(v, undefined)}, ${O_FIELD}, ${k}); break;`)} 
                    }
                `)
                : ir`call_codec(${resolve(f.type, undefined)}, 0, ${fieldIndex});`
        })}
    `
})

/** The default binary wire-format library — one pair of `CodecRule<void>[]`
 *  among possibly several, not privileged `buildCodec` applies on a
 *  caller's behalf. Pass the one matching your direction explicitly:
 *  `buildCodec(root, binaryEncodeRules, undefined)`, or
 *  `[...myOverrides, ...binaryEncodeRules]` to preempt specific shapes
 *  (see `components/delta-leb128.ts`). */
export const binaryEncodeRules: readonly CodecRule<void>[] =
    [integerEncodeRule, unitRule, listOfIntegerEncodeRule, listEncodeRule, unionEncodeRule, structEncodeRule]

export const binaryDecodeRules: readonly CodecRule<void>[] =
    [integerDecodeRule, unitRule, listOfIntegerDecodeRule, listDecodeRule, unionDecodeRule, structDecodeRule]
