/**
 * @ppl/target-js/test — Compiled codec codegen (components/codec-codegen.ts)
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
import { run } from "@ppl/machine"
import { buildCodec, binaryEncodeRules, binaryDecodeRules, createCodecExtension } from "@ppl/codecs"

import { generateCodecModule } from "../src/components/codec-codegen"
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

function loadCompiled(rootType: SemanticType, name: string): { encode: (v: unknown) => number[]; decode: (b: number[]) => unknown }
{
    const encodeProgram = buildCodec(rootType, binaryEncodeRules, undefined)
    const decodeProgram = buildCodec(rootType, binaryDecodeRules, undefined)
    const source = generateCodecModule({ name, rootType, encodeProgram, decodeProgram })
    const mod = loadGenerated(source)
    return { encode: mod[`encode${name}`], decode: mod[`decode${name}`] }
}

function assertMatchesInterpreted(rootType: SemanticType, name: string, value: unknown): void
{
    const { encode, decode } = loadCompiled(rootType, name)

    const expectedBytes = interpretedEncode(rootType, value)
    const actualBytes = encode(value)
    assert.deepEqual(actualBytes, expectedBytes, "compiled encode disagrees with the interpreted path")

    const expectedDecoded = interpretedDecode(rootType, expectedBytes)
    const actualDecoded = decode(expectedBytes)
    assert.deepEqual(actualDecoded, expectedDecoded, "compiled decode disagrees with the interpreted path")

    assert.deepEqual(decode(encode(value)), value, "compiled round trip (encode then decode) doesn't recover the original value")
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
        assertMatchesInterpreted(T, "Sample", { maybe: { variant: "empty", value: undefined } })
    })

    test("unit — a truly empty procedure body (raise.ts's own acc-seed fix)", () =>
    {
        const T = named("Flag", union({ on: unit, off: unit }))
        assertMatchesInterpreted(T, "Flag", { variant: "on", value: undefined })
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
