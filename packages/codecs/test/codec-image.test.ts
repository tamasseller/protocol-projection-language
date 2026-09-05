/**
 * @ppl/codecs/test — Codec image container (engine/codec-image.ts,
 * docs/codec-image.md §7, ROADMAP.md item 10)
 *
 * Proves the whole item-10 pipeline end to end: build real encoder/decoder
 * programs via `buildCodec`, wrap them with a type tree into an image,
 * round-trip the image through bytes, then actually *run* the decoded
 * programs through the VM — same rigor `bytecode.test.ts`'s item-8 tests
 * applied to the program envelope alone.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { buildTypeGraph, i16, list, struct, u8, union, unit } from "@ppl/core"
import { validateProgram, run } from "mog-core"

import { buildCodec } from "../src/engine/resolver"
import { createCodecExtension } from "../src/engine/codec-extension"
import { binaryDecodeRules, binaryEncodeRules } from "../src/components/binary-rules"
import { decodeCodecImage, encodeCodecImage } from "../src/engine/codec-image"
import type { CodecImage } from "../src/engine/codec-image"

describe("codec image — container round trip", () =>
{
    test("type tree + encoder program + decoder program survive encode/decode and still run", () =>
    {
        const SensorKind = union({ temperature: unit, humidity: unit })
        const Reading = struct({ sensor: SensorKind, value: i16 })
        const Packet = struct({ readings: list(Reading, 4), status: u8 })

        const image: CodecImage = {
            typeTree: Packet,
            encoderProgram: buildCodec(Packet, binaryEncodeRules, undefined),
            decoderProgram: buildCodec(Packet, binaryDecodeRules, undefined),
        }

        const bytes = encodeCodecImage(image)
        const decoded = decodeCodecImage(bytes)

        const graph = buildTypeGraph(decoded.typeTree)
        const value = {
            readings: [{ sensor: { variant: "humidity", value: undefined }, value: -5 }],
            status: 200,
        }

        const buffer: number[] = []
        const encodeExt = createCodecExtension("encode", { container: { root: value }, key: "root", type: graph.root }, buffer)
        validateProgram(decoded.encoderProgram, encodeExt)
        assert.equal(run(decoded.encoderProgram, encodeExt).ok, true)

        const wrapper: { root: unknown } = { root: {} }
        const decodeExt = createCodecExtension("decode", { container: wrapper, key: "root", type: graph.root }, [...buffer])
        validateProgram(decoded.decoderProgram, decodeExt)
        assert.equal(run(decoded.decoderProgram, decodeExt).ok, true)

        assert.deepEqual(wrapper.root, value)
    })

    test("sections are read back-to-back with no framing between them", () =>
    {
        // Bodies/argCounts, not headers: a procedure's own header (the
        // codec extension's `o0` TypeNode) is a build/validate-time-only
        // handoff that never survives wire encoding at all (item 7/8's own
        // finding, docs/codec-image.md §5) — decoded procedures always
        // come back with `header: undefined`, by design, not a bug here.
        const image: CodecImage = {
            typeTree: u8,
            encoderProgram: buildCodec(u8, binaryEncodeRules, undefined),
            decoderProgram: buildCodec(u8, binaryDecodeRules, undefined),
        }
        const bytes = encodeCodecImage(image)
        const decoded = decodeCodecImage(bytes)
        const stripHeaders = (procs: readonly { argCount: number; body: unknown }[]) =>
            procs.map(({ argCount, body }) => ({ argCount, body }))

        assert.deepEqual(stripHeaders(decoded.encoderProgram.procedures), stripHeaders(image.encoderProgram.procedures))
        assert.deepEqual(stripHeaders(decoded.decoderProgram.procedures), stripHeaders(image.decoderProgram.procedures))
    })
})
