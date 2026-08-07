/**
 * @ppl/codecs — Generic codec builders
 *
 * `buildCodec(root, direction, extraRules?)` walks a `@ppl/core` `TypeGraph`
 * node and generates a real, direction-specific `RtlProgram` for it — the
 * metaprogramming layer codec-extension.md always assumed would exist (§5:
 * "the metaprogramming layer that walks the semantic type graph and emits
 * `ir` fragments"). Dispatch is an ordered `CodecRule<Direction>[]` (a
 * pattern + a producer, `./rules.ts`), not a closed per-kind switch — a
 * caller's own rules are tried *first*, so a caller can preempt any default
 * for a specific type shape without touching this file at all (see
 * `test/rules.test.ts`'s custom-rule test, and the ISO-8601 override demo).
 *
 * Each default rule is authored as real `ir\`...\`` text against
 * `codecRules()` (codec-extension.ts), delegating to a child's own codec by
 * splicing its `Procedure` reference — resolved on demand, memoized, and
 * cycle-safe via `createCodecResolver` (`./rules.ts`), which itself rides on
 * `@ppl/machine`'s own `declareProc`/`defineProc`/`lowerProgram` machinery
 * rather than reimplementing "reserve an index before recursing" here.
 *
 * One real generic optimization lives here: a struct's union-typed field
 * with few enough variants to need only a couple of bits gets its tag
 * *hoisted* into one shared leading bitmap instead of paying for its own
 * standalone tag byte — see `structRule`.
 */

import type { RtlProgram, IrFragment, Procedure } from "@ppl/machine"
import { ir, lowerProgram } from "@ppl/machine"
import type { IntegerType, ListType, TypeNode } from "@ppl/core"
import { kindOf, SemanticTypeKinds } from "@ppl/core"
import { pInteger, pUnit, pList, pUnionFields, pStructFields, pStar } from "@ppl/core"
import type { Direction } from "./codec-extension"
import { intWireSize, codecRules } from "./codec-extension"
import type { CodecRule } from "./rules"
import { createCodecResolver, irSeq } from "./rules"

// ── Integers ─────────────────────────────────────────────────────────────

function intCodecBody(direction: Direction, width: number): IrFragment
{
    return direction === "encode"
        ? ir`load_val(0); write(0, ${width}); return;`
        : ir`read(0, ${width}); store_val(0); return;`
}

const integerRule: CodecRule<Direction> = {
    pattern: pInteger(-Infinity, Infinity),
    produce: (_m, node, direction) =>
        intCodecBody(direction, intWireSize(node.type as IntegerType)),
}

const unitRule: CodecRule<Direction> = {
    pattern: pUnit(),
    produce: () => ir`return;`,
}

// ── Lists — length-prefixed ──────────────────────────────────────────────

/** Byte width of a list's count prefix, sized to its declared capacity
 *  (defaulting to a 1-byte prefix, ≤255 elements, when uncapacitated). */
function countPrefixWidth(capacity: number | undefined): number
{
    const cap = capacity ?? 0xFF
    return cap <= 0xFF ? 1 : cap <= 0xFFFF ? 2 : 4
}

const listRule: CodecRule<Direction> = {
    pattern: pList(pStar()),
    produce: (_m, node, direction, resolve) =>
    {
        const lt = node.type as ListType
        const elem = resolve(node.edges[0]!.target, direction)
        const width = countPrefixWidth(lt.capacity)

        // Plain "while (left != 0) { delegate; left -= 1 }" — no special-
        // cased first element (that's delta-encoding's own concern, §8.6,
        // in delta-leb128.ts, not a general list-walk requirement).
        return direction === "encode"
            ? irSeq([
                `u32 left = 0;\nleft = count(0);\nwrite(0, ${width});\n` +
                `while (left != 0) { call_codec_next(`, elem, `, 0); left = left - 1; }\nreturn;`,
              ])
            : irSeq([
                `u32 left = 0;\nleft = read(0, ${width});\nopen_list(0);\n` +
                `while (left != 0) { call_codec_next(`, elem, `, 0); left = left - 1; }\nreturn;`,
              ])
    },
}

// ── Unions — standalone (no hoisting available to the caller) ──────────

/** Tag width for a standalone union — 1 byte, up to 256 variants. Struct
 *  fields that qualify for hoisting (`structRule`, below) never reach this
 *  rule at all; this is for a union reached any other way (the root type
 *  itself, or through a list element). */
const unionRule: CodecRule<Direction> = {
    pattern: pUnionFields(pStar()),
    produce: (_m, node, direction, resolve) =>
    {
        const variants = node.edges.map(e => resolve(e.target, direction))

        // Encode: TAG is computed twice (once to WRITE, once as the
        // switch's own discriminant) — redundant instructions, but the
        // union's value is unchanged in between, so both calls agree; this
        // costs nothing in wire bytes, only avoids threading the value
        // through a register just to keep it in `acc` across the WRITE.
        const parts: (string | Procedure)[] = [
            direction === "encode"
                ? "tag(0); write(0, 1);\nswitch (tag(0))\n{\n"
                : "switch (read(0, 1))\n{\n",
        ]
        variants.forEach((proc, k) => parts.push(`case ${k}: call_codec(`, proc, `, 0, ${k});\n`))
        parts.push("}\nreturn;")

        return irSeq(parts)
    },
}

// ── Structs — per-field delegation, with union-tag hoisting ─────────────

/** A struct field whose union tag was folded into the shared bitmap. */
interface HoistedField
{
    readonly fieldIndex: number
    readonly bitOffset: number
    readonly bits: number
    readonly mask: number
    /** One variant payload TypeNode per variant, in declaration order. */
    readonly variantNodes: readonly TypeNode[]
}

const HOIST_MAX_VARIANTS = 4 // needs ≤2 bits — the "basic" cutoff
const BITMAP_MAX_BITS = 32   // one register's worth (vm.ts's ALU is 32-bit)

const bitsFor = (variantCount: number): number =>
    variantCount <= 1 ? 0 : Math.ceil(Math.log2(variantCount))

function classifyHoistableFields(node: TypeNode): ReadonlyMap<number, HoistedField>
{
    const byField = new Map<number, HoistedField>()
    let bitOffset = 0

    node.edges.forEach((edge, fieldIndex) =>
    {
        if(kindOf(edge.target.type) !== SemanticTypeKinds.Union) return
        const variantCount = edge.target.edges.length
        if(variantCount > HOIST_MAX_VARIANTS) return
        const bits = bitsFor(variantCount)
        if(bitOffset + bits > BITMAP_MAX_BITS) return // safety cap — stop hoisting further fields

        byField.set(fieldIndex, {
            fieldIndex, bitOffset, bits,
            mask: bits === 0 ? 0 : (1 << bits) - 1,
            variantNodes: edge.target.edges.map(e => e.target),
        })
        bitOffset += bits
    })

    return byField
}

const structRule: CodecRule<Direction> = {
    pattern: pStructFields(pStar()),
    produce: (_m, node, direction, resolve) =>
    {
        const hoisted = classifyHoistableFields(node)
        const totalBits = [...hoisted.values()].reduce((sum, h) => sum + h.bits, 0)
        const bitmapBytes = Math.ceil(totalBits / 8)
        const O_FIELD = 1 // scratch handle slot for whichever field is being processed

        const parts: (string | Procedure)[] = []

        if(hoisted.size > 0)
        {
            if(direction === "encode")
            {
                // Pass 1: read every hoisted field's active-variant index
                // (the same computation TAG does, just folded into a shared
                // local instead of its own opcode) and pack it in. Has to
                // happen — and be written to the wire — *before* any
                // field's payload, since the payloads are written by nested
                // delegate calls in pass 2 and the stream is strictly
                // append-only.
                parts.push("u32 bitmap = 0;\n")
                for(const h of hoisted.values())
                    parts.push(`enter(${O_FIELD}, 0, ${h.fieldIndex});\nbitmap = bitmap | (tag(${O_FIELD}) << ${h.bitOffset});\n`)
                parts.push(`bitmap;\nwrite(0, ${bitmapBytes});\n`)
            }
            else
            {
                parts.push(`u32 bitmap = 0;\nbitmap = read(0, ${bitmapBytes});\n`)
            }
        }

        // Pass 2 (the only pass, for non-hoisted fields): per field, in
        // declaration order (§8.1).
        node.edges.forEach((edge, fieldIndex) =>
        {
            const hoist = hoisted.get(fieldIndex)
            if(!hoist)
            {
                parts.push(`call_codec(`, resolve(edge.target, direction), `, 0, ${fieldIndex});\n`)
                return
            }

            // Hoisted union field: get the tag from TAG again (encode —
            // cheap to recompute, avoids a second local just to remember it
            // from pass 1) or unpack it from the shared bitmap (decode),
            // then dispatch straight to the matching variant's payload
            // codec — no separate TAG opcode here, no standalone union
            // codec. The tag value only ever drives a `switch`/`BR_TABLE`;
            // every `call_codec`'s callee stays a real `Procedure`
            // reference resolved at generation time — hoisting only
            // changes *where the tag bits live* (shared bitmap vs.
            // standalone tag byte), not how dispatch works.
            const variantProcs = hoist.variantNodes.map(v => resolve(v, direction))

            if(direction === "encode")
            {
                parts.push(`enter(${O_FIELD}, 0, ${fieldIndex});\nswitch (tag(${O_FIELD}))\n{\n`)
                variantProcs.forEach((proc, k) => parts.push(`case ${k}: call_codec(`, proc, `, ${O_FIELD}, ${k});\n`))
                parts.push("}\n")
            }
            else
            {
                parts.push(`switch ((bitmap >> ${hoist.bitOffset}) & ${hoist.mask})\n{\n`)
                variantProcs.forEach((proc, k) =>
                    parts.push(`case ${k}: enter(${O_FIELD}, 0, ${fieldIndex}); call_codec(`, proc, `, ${O_FIELD}, ${k});\n`))
                parts.push("}\n")
            }
        })

        parts.push("return;")
        return irSeq(parts)
    },
}

// ── Entry point ──────────────────────────────────────────────────────────

const defaultCodecRules: readonly CodecRule<Direction>[] = [integerRule, unitRule, listRule, unionRule, structRule]

/**
 * Build a complete `RtlProgram` for `root`, in one direction. Returns the
 * program only — not a bound `Extension`, since an `Extension` (via
 * `createCodecExtension`, codec-extension.ts) is bound to one specific
 * root *value* and byte buffer, which only exist per encode/decode call,
 * not per type; build the program once with `buildCodec`, then call
 * `createCodecExtension(direction, {container, key, type: root}, buffer)`
 * fresh for every value encoded/decoded against it.
 *
 * `extraRules`, tried before the defaults, is the extension seam: a caller
 * can preempt any default for a specific type shape (a `List<Integer>`
 * that should use delta-LEB128, a `Timestamp`-shaped struct that should be
 * an ISO-8601 string, ...) without editing this file at all.
 */
export function buildCodec(root: TypeNode, direction: Direction, extraRules: readonly CodecRule<Direction>[] = []): RtlProgram
{
    const resolve = createCodecResolver([...extraRules, ...defaultCodecRules])
    return lowerProgram(resolve(root, direction), { rules: codecRules })
}
