/**
 * @ppl/codecs/test — codec extension: list + union opcodes (Phase A)
 *
 * Hand-built `RtlProgram<CodecExtInstr>`s, same style as struct-encoder.test.ts, isolating
 * the new opcodes (`COUNT`/`OPEN_LIST`/`ENTER_NEXT`/`CALL_CODEC_NEXT` for
 * lists, `TAG`/`CALL_CODEC`'s union branch for unions) from
 * `buildCodec`'s (engine/resolver.ts) generic codec-generation logic — a
 * bug here is an opcode bug, not a builder bug.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { list, u8, union, unit, buildTypeGraph } from "@ppl/core"
import { bare, brTable, CONST, STORE, LOAD, PUSH, opImm, validateProgram, run } from "@ppl/machine"
import { callCodecInstr, callCodecNextInstr, countInstr, loadValInstr, openListInstr, readInstr, storeValInstr, tagInstr, writeInstr } from "../src/engine/codec-ext-instr"
import type { CodecExtInstr } from "../src/engine/codec-ext-instr"
import type { RtlProgram, RtlInstr } from "@ppl/machine"

import { createCodecExtension } from "../src/engine/codec-extension"
import type { Handle } from "../src/engine/codec-extension"

const u8CodecBody = (direction: "encode" | "decode"): RtlInstr<CodecExtInstr>[] =>
    direction === "encode"
        ? [loadValInstr(0), writeInstr(0, 1), bare("RETURN")]
        : [readInstr(0, 1), storeValInstr(0), bare("RETURN")]

describe("codec extension — list of u8 (COUNT/OPEN_LIST/ENTER_NEXT/CALL_CODEC_NEXT)", () =>
{
    const listType = list(u8)
    const graph = buildTypeGraph(listType)

    // r0 = loop counter. Plain "while (r0 != 0) { ...; r0 -= 1 }" — no
    // special-cased first element (that's delta-encoding's own concern,
    // §8.6, not a general list-walk requirement).
    function listCodecBody(direction: "encode" | "decode"): RtlInstr<CodecExtInstr>[]
    {
        // countInstr/readInstr leave their result in acc, never in a
        // register directly — PUSH is what actually establishes register 0
        // as a real, TOS-covered local (isa-core.md's "register only
        // becomes live once TOS grows past it" convention); a bare STORE(0)
        // with tos still 0 would target a register no PUSH ever created.
        const prelude: RtlInstr<CodecExtInstr>[] = direction === "encode"
            ? [countInstr(0), PUSH(), writeInstr(0, 1)]
            : [readInstr(0, 1), PUSH(), openListInstr(0)]

        return [
            ...prelude,
            bare("LOOP_PRE"),
            callCodecNextInstr(1, 0),
            LOAD(0), opImm("SUB", 1), STORE(0),
            bare("BLOCK_END"),
            LOAD(0), opImm("NE", 0), bare("BLOCK_END"),
            CONST(0), bare("RETURN"),
        ]
    }

    function program(direction: "encode" | "decode"): RtlProgram<CodecExtInstr>
    {
        return { procedures: [{ argCount: 0, body: listCodecBody(direction) }, { argCount: 0, body: u8CodecBody(direction) }] }
    }

    test("encodes a count-prefixed byte list", () =>
    {
        const root: Handle = { container: { root: [10, 20, 30] }, key: "root", type: graph.root }
        const buffer: number[] = []
        const prog = program("encode")
        const ext = createCodecExtension("encode", root, buffer)

        validateProgram(prog, ext)
        assert.equal(run(prog, ext).ok, true)
        assert.deepEqual(buffer, [3, 10, 20, 30])
    })

    test("decodes it back, including the empty-list case", () =>
    {
        // `OPEN_LIST` replaces `container[key]` wholesale (it's instantiating
        // the list, not mutating an existing one in place, unlike a struct's
        // fields) — so the result has to be read back through `wrapper`
        // *after* running, not through a pre-created placeholder reference.
        const wrapper: Record<string, unknown> = {}
        const root: Handle = { container: wrapper, key: "root", type: graph.root }
        const prog = program("decode")
        const ext = createCodecExtension("decode", root, [3, 10, 20, 30])

        validateProgram(prog, ext)
        assert.equal(run(prog, ext).ok, true)
        assert.deepEqual(wrapper.root, [10, 20, 30])

        const emptyWrapper: Record<string, unknown> = {}
        const emptyRoot: Handle = { container: emptyWrapper, key: "root", type: graph.root }
        const emptyExt = createCodecExtension("decode", emptyRoot, [0])
        assert.equal(run(prog, emptyExt).ok, true)
        assert.deepEqual(emptyWrapper.root, [])
    })
})

describe("codec extension — union (TAG + CALL_CODEC's fused ENTER/instantiate)", () =>
{
    // union { a: unit, b: u8 } — "a" carries no payload at all (an EXT
    // opcode never even touches its handle's value), "b" is a real byte.
    const unionType = union({ a: unit, b: u8 })
    const graph = buildTypeGraph(unionType)

    // Nothing to read or write — but not a bare RETURN: a zero-argument
    // procedure begins with acc not live (isa-core.md §4.6), so the
    // trivial procedure is CONST + RETURN.
    const unitCodecBody = (): RtlInstr<CodecExtInstr>[] => [CONST(0), bare("RETURN")]

    // TAG; BR_TABLE 2; case a -> CALL_CODEC unitCodec; case b -> CALL_CODEC
    // u8Codec; shared RETURN — codec-extension.md §8.2's exact shape (N=2),
    // plus the tag-byte WRITE §8.2 itself never shows (it only illustrates
    // TAG/BR_TABLE/CALL_CODEC's mechanics) but any real encoder needs, to
    // give the decoder side's READ something to read. WRITE doesn't touch
    // acc (mirrors the ISA's own `WRITE`: "stream[i].write(acc,w)", a pure
    // write), so BR_TABLE right after still sees TAG's own result.
    function unionCodecBody(direction: "encode" | "decode"): RtlInstr<CodecExtInstr>[]
    {
        const tagOrRead: RtlInstr<CodecExtInstr>[] = direction === "encode"
            ? [tagInstr(0), writeInstr(0, 1)]
            : [readInstr(0, 1)]
        return [
            ...tagOrRead,
            brTable(2),
            callCodecInstr(1, 0, 0), bare("BLOCK_END"), // case 0: "a"
            callCodecInstr(2, 0, 1), bare("BLOCK_END"), // case 1: "b"
            bare("BLOCK_END"),                          // case 2: no such variant
            // isa-core.md §8.7: acc survives a merge only when every case
            // reaching it leaves it live, and the empty default case
            // doesn't. So the shared RETURN needs a producer of its own; it
            // cannot return whichever case's CALL_CODEC result happened to
            // run.
            CONST(0), bare("RETURN"),
        ]
    }

    function program(direction: "encode" | "decode"): RtlProgram<CodecExtInstr>
    {
        return {
            procedures: [
                { argCount: 0, body: unionCodecBody(direction) },
                { argCount: 0, body: unitCodecBody() },
                { argCount: 0, body: u8CodecBody(direction) },
            ],
        }
    }

    test("encodes the active variant's tag and payload", () =>
    {
        const root: Handle = { container: { root: { variant: "b", value: 42 } }, key: "root", type: graph.root }
        const buffer: number[] = []
        const prog = program("encode")
        const ext = createCodecExtension("encode", root, buffer)

        validateProgram(prog, ext)
        assert.equal(run(prog, ext).ok, true)
        assert.deepEqual(buffer, [1, 42])
    })

    test("encoding a mismatched-tag value throws (defensive check, not silent corruption)", () =>
    {
        // Value claims "a" is active, but its own encoded tag byte would
        // have to be read from *somewhere* — this simulates an authoring
        // bug (dispatch picked the wrong case) rather than a real TAG
        // mismatch, since encode's own TAG always reads the value's own
        // variant correctly. Exercise computeChild's cross-check directly
        // via a union codec instructed to enter variant #1 unconditionally.
        const root: Handle = { container: { root: { variant: "a", value: undefined } }, key: "root", type: graph.root }
        const buffer: number[] = []
        const badProgram: RtlProgram<CodecExtInstr> = {
            procedures: [
                { argCount: 0, body: [callCodecInstr(1, 0, 1), bare("RETURN")] }, // forces variant #1 ("b")
                { argCount: 0, body: u8CodecBody("encode") },
            ],
        }
        const ext = createCodecExtension("encode", root, buffer)
        assert.throws(() => run(badProgram, ext), /doesn't match the active variant/)
    })

    test("decodes tag + payload back to the tagged union value", () =>
    {
        // Same reasoning as the list case: entering a union instantiates a
        // brand-new `{variant, value}` at `container[key]` (§2.3's decoder
        // row for ENTER on a union) rather than mutating an existing object
        // in place, so read the result back through `wrapper`, not a stale
        // placeholder reference.
        const wrapper: Record<string, unknown> = {}
        const root: Handle = { container: wrapper, key: "root", type: graph.root }
        const prog = program("decode")
        const ext = createCodecExtension("decode", root, [1, 42])

        validateProgram(prog, ext)
        assert.equal(run(prog, ext).ok, true)
        assert.deepEqual(wrapper.root, { variant: "b", value: 42 })
    })

    test("decodes a unit variant with no payload bytes consumed", () =>
    {
        const wrapper: Record<string, unknown> = {}
        const root: Handle = { container: wrapper, key: "root", type: graph.root }
        const prog = program("decode")
        const ext = createCodecExtension("decode", root, [0])

        assert.equal(run(prog, ext).ok, true)
        assert.deepEqual(wrapper.root, { variant: "a", value: undefined })
    })
})
