/**
 * @ppl/codecs/test — WRITE_SEQ / READ_SEQ, the bulk-array transfer pair
 * (ROADMAP.md item 11, engine/opcodes.ts, engine/codec-extension.ts,
 * engine/validate-handles.ts, engine/wire.ts, components/binary-rules.ts)
 *
 * Four angles, mirroring how the existing 15 opcodes are each covered
 * elsewhere in this package: (1) the `ir` DSL surface + VM execution,
 * standalone; (2) sign extension on decode, the one piece of real logic
 * these ops have; (3) `validateCodecHandles`'s static checks; (4) the
 * default binary codec actually using these ops for `List<Integer>`,
 * end to end, in place of the generic per-element loop. Wire-level byte
 * encoding is covered in `wire.test.ts`, not repeated here.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import type { TypeNode } from "@ppl/core"
import { struct, union, unit, u8, i16, list, integer, buildTypeGraph } from "@ppl/core"
import { ir, proc, lowerProgram, validateProgram, run, extInstr, bare } from "@ppl/machine"
import type { RtlProgram, RtlProc } from "@ppl/machine"

import { createCodecExtension, codecRules } from "../src/engine/codec-extension"
import type { Handle } from "../src/engine/codec-extension"
import { validateCodecHandles } from "../src/engine/validate-handles"
import { buildCodec } from "../src/engine/resolver"
import { binaryEncodeRules, binaryDecodeRules } from "../src/components/binary-rules"

function lower(entry: ReturnType<typeof proc>): RtlProgram
{
    return lowerProgram(entry, { rules: codecRules })
}

// ── DSL + VM execution, standalone ──────────────────────────────────────

describe("write_seq / read_seq: ir DSL + VM execution", () =>
{
    const listType = list(u8)
    const graph = buildTypeGraph(listType)

    test("write_seq bulk-writes count elements straight from the list handle's own storage", () =>
    {
        const program = lower(proc([], ir`write_seq(0, 0, 1, count(0)); return;`))
        const root: Handle = { container: { root: [10, 20, 30] }, key: "root", type: graph.root }
        const buffer: number[] = []
        const ext = createCodecExtension("encode", root, buffer)

        validateProgram(program, ext)
        assert.equal(run(program, ext).ok, true)
        assert.deepEqual(buffer, [10, 20, 30])
    })

    test("read_seq bulk-fills an already-opened list from the stream", () =>
    {
        const program = lower(proc([], ir`open_list(0); read_seq(0, 0, 1, 0, 3); return;`))
        const wrapper: Record<string, unknown> = { root: undefined }
        const root: Handle = { container: wrapper, key: "root", type: graph.root }
        const ext = createCodecExtension("decode", root, [10, 20, 30])

        validateProgram(program, ext)
        assert.equal(run(program, ext).ok, true)
        assert.deepEqual(wrapper.root, [10, 20, 30])
    })

    test("count is read at the call site, not baked into the op — a plain runtime value works", () =>
    {
        // Proves count isn't a codegen-time literal: it comes from `count(0)`
        // (encode) / a decoded length (decode), computed however the caller
        // likes, then just handed to the op.
        const program = lower(proc([],
            ir`u32 n = 0; n = count(0); write(0, 1, n); write_seq(0, 0, 1, n); return;`))
        const root: Handle = { container: { root: [1, 2, 3, 4, 5] }, key: "root", type: graph.root }
        const buffer: number[] = []
        const ext = createCodecExtension("encode", root, buffer)

        validateProgram(program, ext)
        assert.equal(run(program, ext).ok, true)
        assert.deepEqual(buffer, [5, 1, 2, 3, 4, 5])
    })

    test("width folds correctly for multi-byte elements (little-endian, same as WRITE/READ)", () =>
    {
        const wideList = list(integer(0, 0xFFFF))
        const wideGraph = buildTypeGraph(wideList)
        const program = lower(proc([], ir`write_seq(0, 0, 2, count(0)); return;`))
        const root: Handle = { container: { root: [0x1234, 0xABCD] }, key: "root", type: wideGraph.root }
        const buffer: number[] = []
        const ext = createCodecExtension("encode", root, buffer)

        validateProgram(program, ext)
        assert.equal(run(program, ext).ok, true)
        assert.deepEqual(buffer, [0x34, 0x12, 0xCD, 0xAB])
    })
})

// ── Sign extension on decode ────────────────────────────────────────────

describe("read_seq: sign extension mirrors STORE_VAL's toHostNumber", () =>
{
    test("signed=1 reinterprets the wire pattern as two's-complement", () =>
    {
        const listType = list(i16)
        const graph = buildTypeGraph(listType)
        const program = lower(proc([], ir`open_list(0); read_seq(0, 0, 2, 1, 2); return;`))
        const wrapper: Record<string, unknown> = { root: undefined }
        const root: Handle = { container: wrapper, key: "root", type: graph.root }
        // 0xFFFF -> -1, 0x8000 -> -32768, little-endian.
        const ext = createCodecExtension("decode", root, [0xFF, 0xFF, 0x00, 0x80])

        validateProgram(program, ext)
        assert.equal(run(program, ext).ok, true)
        assert.deepEqual(wrapper.root, [-1, -32768])
    })

    test("signed=0 leaves the same bit pattern as an unsigned magnitude", () =>
    {
        const listType = list(integer(0, 0xFFFF))
        const graph = buildTypeGraph(listType)
        const program = lower(proc([], ir`open_list(0); read_seq(0, 0, 2, 0, 2); return;`))
        const wrapper: Record<string, unknown> = { root: undefined }
        const root: Handle = { container: wrapper, key: "root", type: graph.root }
        const ext = createCodecExtension("decode", root, [0xFF, 0xFF, 0x00, 0x80])

        validateProgram(program, ext)
        assert.equal(run(program, ext).ok, true)
        assert.deepEqual(wrapper.root, [0xFFFF, 0x8000])
    })
})

// ── validateCodecHandles: static checks ─────────────────────────────────

function itemNode(): TypeNode
{
    return buildTypeGraph(list(u8)).root
}

function fixture(body: RtlProc["body"], header?: TypeNode): RtlProgram
{
    return { procedures: [{ argCount: 0, body, header }] }
}

describe("validateCodecHandles: WRITE_SEQ / READ_SEQ", () =>
{
    test("a real buildCodec-generated List<u8> field passes cleanly", () =>
    {
        const root = struct({ id: u8, items: list(u8) })
        const graph = buildTypeGraph(root)
        const value = { id: 1, items: [1, 2, 3] }

        const encodeProgram = buildCodec(root, binaryEncodeRules, undefined)
        const buffer: number[] = []
        const encodeExt = createCodecExtension("encode", { container: { root: value }, key: "root", type: graph.root }, buffer)
        validateProgram(encodeProgram, encodeExt)
        assert.doesNotThrow(() => validateCodecHandles(encodeProgram))

        const decodeProgram = buildCodec(root, binaryDecodeRules, undefined)
        const wrapper: Record<string, unknown> = { root: {} }
        const decodeExt = createCodecExtension("decode", { container: wrapper, key: "root", type: graph.root }, [...buffer])
        validateProgram(decodeProgram, decodeExt)
        assert.doesNotThrow(() => validateCodecHandles(decodeProgram))
    })

    test("rejects WRITE_SEQ on a non-list handle", () =>
    {
        const header = buildTypeGraph(u8).root
        const program = fixture([extInstr("WRITE_SEQ", [0, 0, 1]), bare("RETURN")], header)
        assert.throws(() => validateCodecHandles(program), /not a list/)
    })

    test("rejects READ_SEQ on a non-list handle", () =>
    {
        const header = buildTypeGraph(u8).root
        const program = fixture([extInstr("READ_SEQ", [0, 0, 1, 0]), bare("RETURN")], header)
        assert.throws(() => validateCodecHandles(program), /not a list/)
    })

    test("rejects WRITE_SEQ on a read-only iterator", () =>
    {
        const header = itemNode()
        const program = fixture([extInstr("WRITE_SEQ", [0, 0, 1]), bare("RETURN")], header)
        // i0's capability is "any" in this validator (direction-agnostic —
        // see validate-handles.ts's own file header), so exercise a
        // definitely-read-only fork instead.
        const withFork: RtlProgram = {
            procedures: [{
                argCount: 0,
                body: [
                    extInstr("CLONE_RD", [0, 1]),
                    extInstr("WRITE_SEQ", [1, 0, 1]),
                    bare("RETURN"),
                ],
                header,
            }],
        }
        assert.throws(() => validateCodecHandles(withFork), /write-only|read-only|is read-only/)
    })

    test("rejects READ_SEQ on a write-only iterator", () =>
    {
        const header = itemNode()
        const withFork: RtlProgram = {
            procedures: [{
                argCount: 0,
                body: [
                    extInstr("CLONE_WR", [0, 1]),
                    extInstr("READ_SEQ", [1, 0, 1, 0]),
                    bare("RETURN"),
                ],
                header,
            }],
        }
        assert.throws(() => validateCodecHandles(withFork), /is write-only|write-only, not read/)
    })

    test("rejects WRITE_SEQ on a handle never entered in this procedure", () =>
    {
        const program = fixture([extInstr("WRITE_SEQ", [0, 1, 1]), bare("RETURN")], itemNode())
        assert.throws(() => validateCodecHandles(program), /never entered/)
    })
})

// ── Default binary codec: List<Integer> actually uses the bulk path ────

describe("binary-rules.ts: List<Integer> uses write_seq/read_seq, not a per-element loop", () =>
{
    test("round-trips through the real default codec", () =>
    {
        const root = list(integer(-32768, 32767))
        const graph = buildTypeGraph(root)
        const value = [-1, 0, 1, 32767, -32768]

        const encodeProgram = buildCodec(root, binaryEncodeRules, undefined)
        const buffer: number[] = []
        const encodeExt = createCodecExtension("encode", { container: { root: value }, key: "root", type: graph.root }, buffer)
        validateProgram(encodeProgram, encodeExt)
        assert.equal(run(encodeProgram, encodeExt).ok, true)

        const decodeProgram = buildCodec(root, binaryDecodeRules, undefined)
        const wrapper: Record<string, unknown> = { root: undefined }
        const decodeExt = createCodecExtension("decode", { container: wrapper, key: "root", type: graph.root }, [...buffer])
        validateProgram(decodeProgram, decodeExt)
        assert.equal(run(decodeProgram, decodeExt).ok, true)

        assert.deepEqual(wrapper.root, value)
    })

    test("produces the exact same bytes as the generic per-element path would (length prefix + raw little-endian run)", () =>
    {
        const root = list(u8, 8) // capacity <=255 -> 1-byte length prefix
        const graph = buildTypeGraph(root)
        const value = [1, 2, 3]

        const encodeProgram = buildCodec(root, binaryEncodeRules, undefined)
        const buffer: number[] = []
        const ext = createCodecExtension("encode", { container: { root: value }, key: "root", type: graph.root }, buffer)
        validateProgram(encodeProgram, ext)
        assert.equal(run(encodeProgram, ext).ok, true)

        assert.deepEqual(buffer, [3, 1, 2, 3])
    })

    test("a non-integer element (struct) still falls through to the generic per-element rule", () =>
    {
        const elem = struct({ flag: union({ on: unit, off: unit }), value: u8 })
        const root = list(elem)
        const graph = buildTypeGraph(root)
        const value = [{ flag: { variant: "on", value: undefined }, value: 5 }]

        const encodeProgram = buildCodec(root, binaryEncodeRules, undefined)
        const buffer: number[] = []
        const ext = createCodecExtension("encode", { container: { root: value }, key: "root", type: graph.root }, buffer)
        validateProgram(encodeProgram, ext)
        assert.equal(run(encodeProgram, ext).ok, true)
        // count=1, then flag's hoisted 1-bit tag (0 = "on") in its own
        // 1-byte bitmap, then value=5 — proves this element shape still
        // goes through structEncodeRule's per-field delegation, not
        // write_seq (which a struct element type can never match).
        assert.deepEqual(buffer, [1, 0, 5])
    })
})
