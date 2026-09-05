/**
 * @ppl/target-js/test — Compiled codec codegen (engine/codec-codegen.ts +
 * engine/codec-module.ts's generateCodecModule entry point)
 *
 * A differential check, not a shape check: for every fixture, build the
 * real interpreted path (`run()` + `createCodecExtension`, @ppl/codecs'
 * own proven ground truth) and the compiled path (`generateCodecModule`,
 * written to a real file and `require()`'d — see load-generated.ts for
 * why), and assert they agree exactly — same encoded bytes, same decoded
 * value, and a same-process round trip through the compiled path alone.
 */
import { describe, test } from "node:test"
import * as assert from "node:assert/strict"

import type { SemanticType } from "@ppl/core"
import { struct, union, unit, list, u8, integer, named, optional, buildTypeGraph, kindOf, SemanticTypeKinds } from "@ppl/core"
import { run } from "mog-core"
import { buildCodec, binaryEncodeRules, binaryDecodeRules, createCodecExtension } from "@ppl/codecs"

import { generateCodecModule } from "../src/engine/codec-module"
import { loadGenerated } from "./load-generated"

function interpretedEncode(rootType: SemanticType, value: unknown): number[]
{
    const program = buildCodec(rootType, binaryEncodeRules, undefined)
    const graph = buildTypeGraph(rootType)
    const buffer: number[] = []
    const ext = createCodecExtension("encode", { container: { root: value }, key: "root", type: graph.root }, buffer)
    const result = run(program, ext)
    assert.equal(result.ok, true, `interpreted encode trapped (code ${result.trapCode})`)
    return buffer
}

function interpretedDecode(rootType: SemanticType, bytes: readonly number[]): unknown
{
    const program = buildCodec(rootType, binaryDecodeRules, undefined)
    const graph = buildTypeGraph(rootType)
    // A struct root's own container is never auto-instantiated by
    // computeChild (that only happens for a struct reached as someone
    // else's *child* — codec-extension.ts's ensureDecodedStructExists) —
    // the caller has to seed it, same as validate-handles.test.ts's own
    // `{ root: {} }` fixtures. Compiled decode does this itself
    // (generateCodecModule's `ensureStruct(root)` call).
    const isStructRoot = kindOf(graph.root.type) === SemanticTypeKinds.Struct
    const wrapper: Record<string, unknown> = { root: isStructRoot ? {} : undefined }
    const ext = createCodecExtension("decode", { container: wrapper, key: "root", type: graph.root }, [...bytes])
    const result = run(program, ext)
    assert.equal(result.ok, true, `interpreted decode trapped (code ${result.trapCode})`)
    return wrapper.root
}

function loadCompiled(rootType: SemanticType, name: string): { encode: (v: unknown) => Uint8Array; decode: (b: Uint8Array) => unknown }
{
    const encodeProgram = buildCodec(rootType, binaryEncodeRules, undefined)
    const decodeProgram = buildCodec(rootType, binaryDecodeRules, undefined)
    const source = generateCodecModule({ name, rootType, encodeProgram, decodeProgram })
    const mod = loadGenerated(source)
    return { encode: mod[`encode${name}`], decode: mod[`decode${name}`] }
}

/**
 * `compiledValue` defaults to `value` — every fixture but one shares the
 * exact same shape across both paths, since `tsTypeRules`'s own default
 * union representation (`{variant, value}`) now matches
 * `codec-extension.ts`'s own internal `UnionValue` convention exactly
 * (the tag-vs-variant mismatch this rework fixed). The one exception is
 * an *all-unit* union: `tsTypeRules` collapses it to a bare string-literal
 * type (a deliberate, pre-existing ergonomic choice, `ts-emitter.ts`'s own
 * doc comment) — a real, public shape difference from the interpreter's
 * own `{variant, value: undefined}`, not a bug, so that one fixture below
 * passes both shapes explicitly instead.
 */
function assertMatchesInterpreted(rootType: SemanticType, name: string, value: unknown, compiledValue: unknown = value): void
{
    const { encode, decode } = loadCompiled(rootType, name)

    const expectedBytes = interpretedEncode(rootType, value)
    const actualBytes = encode(compiledValue)
    // The public boundary is Uint8Array (codec-runtime.ts's own doc
    // comment on Ctx.buffer explains why) — compare contents, not
    // TypedArray-vs-plain-Array identity.
    assert.deepEqual(Array.from(actualBytes), expectedBytes, "compiled encode disagrees with the interpreted path")

    // Compared against `compiledValue`, not the interpreted path's own
    // `expectedDecoded` — the two paths' decoded *shapes* can genuinely
    // differ (this function's own doc comment), so the right ground truth
    // for "did the compiled path decode these bytes correctly" is "does
    // it recover the same, compiled-shaped value encoding started from,"
    // exactly what the trailing round-trip assertion below already
    // checks — this assertion is that same fact, checked one call sooner
    // (straight off the interpreter's own bytes, not the compiled path's
    // own encode output) so an encode-side bug can't mask a decode-side
    // one by producing self-consistently-wrong bytes.
    const actualDecoded = decode(new Uint8Array(expectedBytes))
    assert.deepEqual(actualDecoded, compiledValue, "compiled decode disagrees with the interpreted path")

    assert.deepEqual(decode(encode(compiledValue)), compiledValue, "compiled round trip (encode then decode) doesn't recover the original value")
}

describe("codec-codegen — compiled encode/decode agree with the interpreted path", () =>
{
    test("flat struct of shared-type integer fields", () =>
    {
        const T = named("Point", struct({ x: u8, y: u8 }))
        assertMatchesInterpreted(T, "Point", { x: 3, y: 250 })
    })

    test("nested struct — multi-hop CALL_CODEC", () =>
    {
        const Inner = named("Inner", struct({ a: u8 }))
        const T = named("Outer", struct({ inner: Inner, b: u8 }))
        assertMatchesInterpreted(T, "Outer", { inner: { a: 9 }, b: 200 })
    })

    test("standalone union — TAG + CALL_CODEC per variant", () =>
    {
        const T = named("Result", union({ ok: u8, err: integer(-100, 100) }))
        assertMatchesInterpreted(T, "Result", { variant: "err", value: -42 })
        assertMatchesInterpreted(T, "Result", { variant: "ok", value: 7 })
    })

    test("struct with a hoisted-tag union field", () =>
    {
        const T = named("Reading", struct({ kind: union({ a: u8, b: u8 }), value: u8 }))
        assertMatchesInterpreted(T, "Reading", { kind: { variant: "b", value: 5 }, value: 200 })
    })

    test("optional(T) — the same 2-variant union shape, one level of nesting", () =>
    {
        const T = named("Sample", struct({ maybe: optional(integer(-10, 10)) }))
        assertMatchesInterpreted(T, "Sample", { maybe: { variant: "value", value: -3 } })
        // A unit-kind payload's own value is `null` under tsTypeRules's
        // own declared convention ("null for unit types") — a real,
        // public shape difference from the interpreter's own internal
        // `undefined` (codec-extension.ts's UnionValue never writes a
        // unit variant's `.value` at all, so it just stays whatever it
        // was initialized to).
        assertMatchesInterpreted(
            T, "Sample",
            { maybe: { variant: "empty", value: undefined } },
            { maybe: { variant: "empty", value: null } },
        )
    })

    test("unit — a truly empty procedure body (raise.ts's own acc-seed fix)", () =>
    {
        const T = named("Flag", union({ on: unit, off: unit }))
        // All-unit union: tsTypeRules collapses the declared type to a
        // bare string-literal union (ts-emitter.ts's own doc comment) —
        // a real, public shape difference from the interpreter's own
        // `{variant, value}`, so the compiled path's own input/output is
        // just the variant name directly.
        assertMatchesInterpreted(T, "Flag", { variant: "on", value: undefined }, "on")
    })

    test("list of structs — ENTER_NEXT/CALL_CODEC_NEXT", () =>
    {
        const Item = named("Item", struct({ v: u8 }))
        const T = named("Batch", struct({ items: list(Item, 8) }))
        assertMatchesInterpreted(T, "Batch", { items: [{ v: 1 }, { v: 2 }, { v: 3 }] })
    })

    test("list of integers — WRITE_SEQ/READ_SEQ bulk transfer", () =>
    {
        const T = named("Samples", list(integer(-32768, 32767), 8))
        assertMatchesInterpreted(T, "Samples", [-1, 0, 1, 32767, -32768])
    })

    test("self-referential struct/union — cycle-safe generation, mutually-recursive generated functions", () =>
    {
        const Tree: SemanticType = named("Tree", (): SemanticType => union({
            leaf: u8,
            node: struct({ left: Tree, right: Tree }),
        }))
        const value = { variant: "node", value: { left: { variant: "leaf", value: 1 }, right: { variant: "leaf", value: 2 } } }
        assertMatchesInterpreted(Tree, "Tree", value)
    })
})
