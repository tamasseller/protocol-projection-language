/**
 * @ppl/codecs/test — delta-leb128.ts (codec-extension.md §8.6)
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { list, struct, u8, u32, buildTypeGraph } from "@ppl/core"
import { validateProgram, run } from "mog-core"

import { buildDeltaLeb128ListCodec, deltaLeb128EncodeRule, deltaLeb128DecodeRule } from "../src/components/delta-leb128"
import { buildCodec } from "../src/engine/resolver"
import { createCodecExtension } from "../src/engine/codec-extension"
import { binaryEncodeRules, binaryDecodeRules } from "../src/components/binary-rules"

const rootType = list(u32)
const graph = buildTypeGraph(rootType) // TypeNode only needed for the runtime Handle below

function encode(values: number[]): number[]
{
    const buffer: number[] = []
    const program = buildDeltaLeb128ListCodec(rootType, "encode")
    const ext = createCodecExtension("encode", { container: { root: values }, key: "root", type: graph.root }, buffer)
    validateProgram(program, ext)
    assert.equal(run(program, ext).ok, true)
    return buffer
}

function decode(buffer: number[]): unknown
{
    const wrapper: Record<string, unknown> = {}
    const program = buildDeltaLeb128ListCodec(rootType, "decode")
    const ext = createCodecExtension("decode", { container: wrapper, key: "root", type: graph.root }, buffer)
    validateProgram(program, ext)
    assert.equal(run(program, ext).ok, true)
    return wrapper.root
}

describe("delta-leb128 — List<u32>", () =>
{
    test("empty list is just the count byte", () =>
    {
        assert.deepEqual(encode([]), [0])
        assert.deepEqual(decode([0]), [])
    })

    test("first element as-is, rest as small non-negative deltas: mostly 1-byte LEB128 despite large absolute values", () =>
    {
        const values = [1_000_000, 1_000_001, 1_000_003, 1_000_008]
        const buffer = encode(values)
        // count(1) + first-value-LEB128(3 bytes for 1_000_000) + three
        // 1-byte deltas (+1, +2, +5) — far smaller than 4 fixed-width u32s.
        assert.equal(buffer.length, 1 + 3 + 1 + 1 + 1)
        assert.deepEqual(decode(buffer), values)
    })

    test("round-trips correctly with a negative delta, and the zigzag step keeps it cheap — a small " +
        "negative delta costs the same 1 byte a same-magnitude positive one would, not the up-to-5 " +
        "bytes an unsigned encoding's two's-complement wraparound would otherwise waste on it", () =>
    {
        const values = [5, 5, 4, 100]
        const buffer = encode(values)
        // count(1) + zigzag(5)=10 (1) + zigzag(0)=0 (1) + zigzag(-1)=1 (1) + zigzag(96)=192 (2, >127).
        assert.equal(buffer.length, 1 + 1 + 1 + 1 + 2)
        assert.deepEqual(decode(buffer), values)
    })

    test("rejects a non-List<Integer> type", () =>
    {
        assert.throws(() => buildDeltaLeb128ListCodec(u32, "encode"), /expected a list type/)
    })

    test("composes as a rules entry — fires for a List<Integer> field nested inside a struct, not just a standalone root", () =>
    {
        // The whole point of making this a CodecRule instead of a one-off
        // top-level function: a caller can now opt a *specific field* into
        // delta-LEB128 without the binary rules' own defaults ever knowing
        // about it, and without needing to extract that field's type by
        // hand.
        const t = struct({ id: u8, samples: list(u32) })
        const structGraph = buildTypeGraph(t)

        function run_(direction: "encode" | "decode", value: unknown, buffer: number[])
        {
            const rules = direction === "encode"
                ? [deltaLeb128EncodeRule, ...binaryEncodeRules]
                : [deltaLeb128DecodeRule, ...binaryDecodeRules]
            const program = buildCodec(t, rules, undefined)
            const container = direction === "encode" ? { root: value } : { root: {} }
            const ext = createCodecExtension(direction, { container, key: "root", type: structGraph.root }, buffer)
            validateProgram(program, ext)
            assert.equal(run(program, ext).ok, true)
            return container.root
        }

        const value = { id: 7, samples: [1_000_000, 1_000_001, 1_000_003] }
        const buffer: number[] = []
        run_("encode", value, buffer)
        // id (1 byte) + count(1) + first-value-LEB128(3 bytes) + two 1-byte deltas.
        assert.equal(buffer.length, 1 + 1 + 3 + 1 + 1)

        assert.deepEqual(run_("decode", undefined, [...buffer]), value)
    })
})
