/**
 * @ppl/target-js/test — Compiled codec codegen against alternative
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

import type { SemanticType } from "@ppl/core"
import { struct, union, list, u8, integer, named } from "@ppl/core"
import { buildCodec, binaryEncodeRules, binaryDecodeRules } from "@ppl/codecs"

import type { TsRule } from "../src/engine/resolver"
import { tsTypeRules } from "../src/components/ts-emitter"
import {
    structAsClassRule, unionAsClassHierarchyRule, byteListAsUint8ArrayRule, bigIntEscalationRules,
} from "../src/components/ts-alternative-rules"
import { generateCodecModule } from "../src/engine/codec-module"
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
})
