/**
 * src/target-js/test — Compiled codec codegen against alternative
 * representations (`components/ts-alternative-rules.ts`)
 *
 * `codec-codegen.runtime.test.ts` proves the default representation
 * round-trips correctly; this file proves the actual point of the
 * accessor-driven rework — that swapping in an alternative `TsRule`
 * (structAsClassRule/unionAsClassHierarchyRule/byteListAsUint8ArrayRule/
 * bigIntEscalationRules) changes what the *compiled codec* actually
 * produces to match, not just what the declared TS type claims. Before
 * this rework, using any of these with the compiled path was a documented
 * lie (`ts-alternative-rules.ts`'s own doc comments on the class rules) —
 * the decoder always built a plain object/array/number regardless of
 * which rule was in play.
 */
import { describe, test } from "node:test"
import * as assert from "node:assert/strict"

import type { SemanticType } from "../../src/core/index"
import { struct, union, list, u8, integer, named, pList, pStar, pStructFields, child } from "../../src/core/index"
import { buildCodec, binaryEncodeRules, binaryDecodeRules, deltaLeb128EncodeRule, deltaLeb128DecodeRule } from "../../src/codecs/index"

import type { TsRule } from "../../src/target-js/engine/resolver"
import { tsRule } from "../../src/target-js/engine/resolver"
import { tsTypeRules } from "../../src/target-js/components/ts-emitter"
import {
    structAsClassRule, unionAsClassHierarchyRule, byteListAsUint8ArrayRule, bigIntEscalationRules,
    capacityOneListAsOptionalRule, int16ListAsInt16ArrayRule,
} from "../../src/target-js/components/ts-alternative-rules"
import { generateCodecModule } from "../../src/target-js/engine/codec-module"
import { loadGenerated } from "./load-generated"

function loadCompiled(rootType: SemanticType, name: string, rules: readonly TsRule[]): { encode: (v: any) => Uint8Array; decode: (b: Uint8Array) => any; mod: any }
{
    // No real RtlProgram distinction between rule sets — the wire format
    // is entirely a function of the codec rules (unaffected by which
    // TsRule projects the *local* representation), so the same
    // buildCodec-produced programs `codec-codegen.runtime.test.ts` uses
    // work here too.
    const encodeProgram = buildCodec(rootType, binaryEncodeRules, undefined)
    const decodeProgram = buildCodec(rootType, binaryDecodeRules, undefined)
    const source = generateCodecModule({ name, rootType, encodeProgram, decodeProgram, rules })
    const mod = loadGenerated(source)
    return { encode: mod[`encode${name}`], decode: mod[`decode${name}`], mod }
}

describe("codec-codegen — alternative representations actually round-trip through the compiled path", () =>
{
    test("structAsClassRule: decode produces a real class instance, encode reads a real one back", () =>
    {
        const T = named("Point", struct({ x: u8, y: u8 }))
        const { encode, decode, mod } = loadCompiled(T, "Point", [structAsClassRule, ...tsTypeRules])

        const decoded = decode(encode(new mod.Point(3, 250)))
        assert.ok(decoded instanceof mod.Point, "decoded value isn't an instance of the generated class")
        assert.equal(decoded.x, 3)
        assert.equal(decoded.y, 250)

        // Round-trip through a second, independently-constructed instance
        // — encode must read a real instance's own fields, not assume a
        // plain object.
        const roundTripped = decode(encode(new mod.Point(7, 8)))
        assert.equal(roundTripped.x, 7)
        assert.equal(roundTripped.y, 8)
    })

    test("unionAsClassHierarchyRule: decode produces a real subclass instance, instanceof narrows", () =>
    {
        const T = named("Result", union({ ok: u8, err: integer(-100, 100) }))
        const { encode, decode, mod } = loadCompiled(T, "Result", [unionAsClassHierarchyRule, ...tsTypeRules])

        // Construct directly through the generated subclasses — a plain
        // `{variant, value}` object was never this rule's own input
        // contract to begin with (that's exactly the "lie" this rework
        // fixes: the class hierarchy is the *real* shape now).
        const errInstance = new mod.Result_Err(-42)
        assert.ok(errInstance instanceof mod.Result, "subclass instance isn't instanceof its own abstract base")

        const decoded = decode(encode(errInstance))
        assert.ok(decoded instanceof mod.Result_Err, "decoded value isn't a Result_Err instance")
        assert.equal(decoded.value, -42)

        const okInstance = new mod.Result_Ok(7)
        const decodedOk = decode(encode(okInstance))
        assert.ok(decodedOk instanceof mod.Result_Ok, "decoded value isn't a Result_Ok instance")
        assert.equal(decodedOk.value, 7)
    })

    test("byteListAsUint8ArrayRule: decode produces a real Uint8Array", () =>
    {
        const T = named("Bytes", list(u8, 8))
        const { encode, decode } = loadCompiled(T, "Bytes", [byteListAsUint8ArrayRule, ...tsTypeRules])

        const decoded = decode(encode(Uint8Array.from([1, 2, 3, 255])))
        assert.ok(decoded instanceof Uint8Array, "decoded value isn't a real Uint8Array")
        assert.deepEqual(Array.from(decoded), [1, 2, 3, 255])
    })

    test("bigIntEscalationRules: an out-of-safe-range integer decodes to a real bigint", () =>
    {
        // Just past Number.MAX_SAFE_INTEGER — safeIntegerRule's own
        // envelope (pInteger(MIN_SAFE_INTEGER, MAX_SAFE_INTEGER)) no
        // longer fully contains this range, so it falls through to
        // wideIntegerRule. A small value keeps this within what the
        // wire-level read/write byte loop (plain JS number bitwise ops,
        // 32-bit) can actually move correctly — this test is about
        // wideIntegerRule's own fromWire/toWire conversion actually being
        // wired in, not about the separate, pre-existing question of
        // exact 64-bit wire correctness for a value that needs every bit.
        const T = named("Wide", struct({ n: integer(0, Number.MAX_SAFE_INTEGER + 1) }))
        const { encode, decode } = loadCompiled(T, "Wide", [...bigIntEscalationRules, ...tsTypeRules])

        const decoded = decode(encode({ n: 123456789n }))
        assert.equal(typeof decoded.n, "bigint", "decoded value isn't a real bigint")
        assert.equal(decoded.n, 123456789n)
    })

    test("capacityOneListAsOptionalRule: WRITE_SEQ/READ_SEQ bulk transfer through the T|null special case", () =>
    {
        // binaryEncodeRules/DecodeRules list listOfIntegerEncodeRule/
        // DecodeRule (pList(pInteger(...)), no capacity constraint) ahead
        // of the generic per-element list rule, so this capacity-1
        // integer list still gets WRITE_SEQ/READ_SEQ, not call_codec_next
        // — exactly the pairing that needs `bulk.writeSeq`'s own T|null
        // special-casing (see ts-alternative-rules.ts's own comment on it).
        const T = named("MaybeByte", list(integer(0, 255), 1))
        const { encode, decode } = loadCompiled(T, "MaybeByte", [capacityOneListAsOptionalRule, ...tsTypeRules])

        assert.equal(decode(encode(42)), 42)
        assert.equal(decode(encode(null)), null)
    })

    test("a list-kind rule with no bulk() throws a clear error when WRITE_SEQ/READ_SEQ is actually needed", () =>
    {
        const noBulkListRule: TsRule = tsRule(pList(pStar()),
            (match, _node, resolve) => `${resolve(match.elementType).ref}[]`,
            () => ({ deps: [] }),
            () => ({
                kind: "list",
                finishList: x => x,
                count: v => `${v}.length`,
                elementAt: (v, i) => `${v}[${i}]`,
                // no bulk — the point of this test.
            }))

        const T = named("Samples", list(integer(0, 255), 4))
        assert.throws(
            () => loadCompiled(T, "Samples", [noBulkListRule, ...tsTypeRules]),
            /no bulk sequential-transfer support/,
        )
    })

    test("beginStruct/setField: decode can build its own real representation incrementally, with no separate finishStruct conversion", () =>
    {
        // Something the plain-accumulator default can't express: `finishStruct`
        // here is the identity — decode's own accumulator *is* the rule's real
        // representation the whole time, built up field by field via a real
        // (mutating) instance rather than a disposable plain object only
        // converted to the real shape at the very end.
        const mutablePointRule: TsRule = tsRule(pStructFields(pStar()),
            () => "MutablePoint",
            (match, _node, resolve) =>
            {
                const fieldLines = match.fieldMatches.map(f => `  ${f.name}: ${resolve(f.type).ref} = undefined as any;`)
                return { decl: `class MutablePoint {\n${fieldLines.join("\n")}\n}`, deps: [] }
            },
            () => ({
                kind: "struct",
                finishStruct: x => x,
                readField: (v, f) => `${v}.${f}`,
                beginStruct: () => "new MutablePoint()",
                setField: (acc, f, v) => `${acc}.${f} = ${v}`,
            }))

        const T = named("Point", struct({ x: u8, y: u8 }))
        const { encode, decode, mod } = loadCompiled(T, "Point", [mutablePointRule, ...tsTypeRules])

        const decoded = decode(encode({ x: 3, y: 250 }))
        assert.ok(decoded instanceof mod.MutablePoint, "decoded value isn't an instance of the rule's own class")
        assert.equal(decoded.x, 3)
        assert.equal(decoded.y, 250)
    })

    test("beginList/appendElement: decode can validate each element as it arrives, not just after the fact", () =>
    {
        // A plain accumulator can't express "reject this element right now" —
        // with the default `.push()`, a bad element is only ever visible
        // after the whole list finished decoding. `appendElement` lets a rule
        // own that check at the exact point of construction. Element type is
        // a struct (not an integer) so the *codec*-rule side picks the
        // generic per-element list rule (binary-rules.ts's own
        // `listEncodeRule`/`listDecodeRule`), which drives ENTER_NEXT/
        // CALL_CODEC_NEXT — never WRITE_SEQ/READ_SEQ's own bulk path (only
        // ever selected for a plain `List<Integer>`, see this file's own
        // capacityOneListAsOptionalRule test above), which would bypass
        // `appendElement` entirely.
        const noDuplicatesListRule: TsRule = tsRule(pList(pStar()),
            (match, _node, resolve) => `${resolve(match.elementType).ref}[]`,
            (_match, node) => ({ deps: [child(node, { element: true })!.id] }),
            () => ({
                kind: "list",
                finishList: x => x,
                count: v => `${v}.length`,
                elementAt: (v, i) => `${v}[${i}]`,
                appendElement: (acc, v) =>
                    `(${acc}.some((x: any) => JSON.stringify(x) === JSON.stringify(${v})) ? (() => { throw new Error("duplicate element") })() : ${acc}.push(${v}))`,
            }))

        const T = named("Bag", list(struct({ v: integer(0, 255) }), 4))
        const { encode, decode } = loadCompiled(T, "Bag", [noDuplicatesListRule, ...tsTypeRules])

        assert.deepEqual(decode(encode([{ v: 1 }, { v: 2 }, { v: 3 }])), [{ v: 1 }, { v: 2 }, { v: 3 }])
        assert.throws(() => decode(encode([{ v: 1 }, { v: 1 }])), /duplicate element/)
    })

    test("int16ListAsInt16ArrayRule: bulk WRITE_SEQ/READ_SEQ path is genuinely zero-copy on decode", () =>
    {
        // A bare top-level `List<Integer>` puts its 1-byte count prefix
        // right before the sample data, landing it at an *odd* byte
        // offset — misaligned for Int16Array (see the next test). One
        // leading u8 field shifts the count prefix to offset 1 and the
        // samples to offset 2, so the zero-copy path actually succeeds
        // here — this is the schema-layout concern int16ListAsInt16ArrayRule's
        // own doc comment describes, not an accident of this test.
        const T = named("Padded", struct({ pad: integer(0, 255), samples: list(integer(-32768, 32767), 4) }))
        const { encode, decode } = loadCompiled(T, "Padded", [int16ListAsInt16ArrayRule, ...tsTypeRules])

        const bytes = encode({ pad: 7, samples: Int16Array.from([1000, -1000, 32767, -32768]) })
        const decoded = decode(bytes)
        assert.ok(decoded.samples instanceof Int16Array, "decoded value isn't a real Int16Array")
        assert.deepEqual(Array.from(decoded.samples), [1000, -1000, 32767, -32768])
        assert.equal(decoded.samples.buffer, bytes.buffer, "decoded Int16Array doesn't alias the input bytes' own buffer — it was copied, not zero-copy")
    })

    test("int16ListAsInt16ArrayRule: a misaligned wire position throws rather than silently misbehaving", () =>
    {
        // No padding this time — the 1-byte count prefix lands the sample
        // data at offset 1, which Int16Array's own constructor rejects.
        const T = named("Samples", list(integer(-32768, 32767), 4))
        const { encode, decode } = loadCompiled(T, "Samples", [int16ListAsInt16ArrayRule, ...tsTypeRules])

        const bytes = encode(Int16Array.from([1000, -1000, 32767, -32768]))
        assert.throws(() => decode(bytes), /start offset|BYTES_PER_ELEMENT|multiple/)
    })

    test("int16ListAsInt16ArrayRule: falls back to per-element access when the codec pairing can't use bulk transfer", () =>
    {
        // delta-leb128.ts's own SLEB128 delta coder must read every
        // element to compute the next delta, so it never emits
        // WRITE_SEQ/READ_SEQ either — the natural real-world codec
        // pairing that can't use bulk transfer at all. Its own RTL body
        // invokes a plain CALL to its synthesized leb128_encode/decode
        // helper (a GENERIC-ABI procedure, no header) — now a real,
        // compiled call (raise.ts's own BR_TABLE-arm acc-liveness fix,
        // plus codec-codegen.ts's GENERIC-ABI generateProcedure branch),
        // so this exercises both that feature and this rule's own
        // fallback path together, in place of the hand-rolled substitute
        // rule pair this test used before CALL support existed.
        const T = named("Samples", list(integer(-32768, 32767), 8))
        const encodeProgram = buildCodec(T, [deltaLeb128EncodeRule], undefined)
        const decodeProgram = buildCodec(T, [deltaLeb128DecodeRule], undefined)
        const source = generateCodecModule({ name: "Samples", rootType: T, encodeProgram, decodeProgram, rules: [int16ListAsInt16ArrayRule, ...tsTypeRules] })
        const mod = loadGenerated(source)

        // RUNTIME_IMPORTS always lists writeSeqRaw/readSeqView regardless
        // of use (codec-module.ts's own fixed import list) — check for an
        // actual call, not just the harmless unused import line.
        assert.ok(!source.includes("writeSeqRaw(ctx") && !source.includes("readSeqView(ctx"), "this pairing should never reach the bulk path at all")

        const values = [1000, -1000, 32767, -32768, 0, 1, -1, 500]
        const bytes = mod.encodeSamples(Int16Array.from(values))
        const decoded = mod.decodeSamples(bytes)
        assert.ok(decoded instanceof Int16Array, "decoded value isn't a real Int16Array")
        assert.deepEqual(Array.from(decoded), values)
    })
})
