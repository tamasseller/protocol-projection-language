/**
 * src/codecs/test — codec extension end to end (codec-extension.md §8.1)
 *
 * `{x: u32, y: u16, flag: u8}`, encoder and decoder, each delegating per
 * field to a small fixed-width number codec via `CALL_CODEC` — exactly
 * §8.1's worked example. Hand-built `RtlProgram<CodecExtInstr>`s (no `ir`/lowering
 * pipeline involved — see codec-extension.ts's file header and
 * extension.test.ts's "a call-shaped op actually invokes its callee" test
 * in mog-core for why: a codec procedure's target is a *reference* to
 * another procedure, which only lowers safely from *callee* position, not
 * as a builtin-call argument). Proves the full mechanism for real: RTL →
 * `validateProgram` (folds `CALL_CODEC` into the call graph) → `run`
 * (handle-frame push/pop + `callProc` threading across delegation).
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { struct, u8, u16, u32, buildTypeGraph } from "../../src/core/index"
import { bare, validateProgram, run } from "mog-core"
import { callCodecInstr, loadValInstr, readInstr, storeValInstr, writeInstr } from "../../src/codecs/engine/codec-ext-instr"
import type { CodecExtInstr } from "../../src/codecs/engine/codec-ext-instr"
import type { RtlProgram, RtlInstr } from "mog-core"

import { createCodecExtension } from "../../src/codecs/engine/codec-extension"
import type { Handle } from "../../src/codecs/engine/codec-extension"

const structType = struct({ x: u32, y: u16, flag: u8 })
const graph = buildTypeGraph(structType)

/** One leaf number codec's body — LOAD_VAL+WRITE for encode, READ+STORE_VAL
 *  for decode, `width` bytes, little-endian (codec-extension.md §8.1's
 *  "unfused core spelling" collapsed to the minimum: no ENTER needed since
 *  `o0` already *is* the primitive, per §3.2's value-access table). */
function numberCodecBody(direction: "encode" | "decode", width: number): RtlInstr<CodecExtInstr>[]
{
    return direction === "encode"
        ? [loadValInstr(0), writeInstr(0, width), bare("RETURN")]
        : [readInstr(0, width), storeValInstr(0), bare("RETURN")]
}

/** The entry procedure: delegate each field, in declaration order, to its
 *  number codec — codec-extension.md §8.1 verbatim (procedure indices
 *  1/2/3 for x/y/flag, assigned below in `program`). */
function structCodecBody(): RtlInstr<CodecExtInstr>[]
{
    return [
        callCodecInstr(1, 0, 0), // x    (field #0) -> codec_u32
        callCodecInstr(2, 0, 1), // y    (field #1) -> codec_u16
        callCodecInstr(3, 0, 2), // flag (field #2) -> codec_u8
        bare("RETURN"),
    ]
}

function program(direction: "encode" | "decode"): RtlProgram<CodecExtInstr>
{
    return {
        procedures: [
            { argCount: 0, body: structCodecBody() },
            { argCount: 0, body: numberCodecBody(direction, 4) }, // codec_u32
            { argCount: 0, body: numberCodecBody(direction, 2) }, // codec_u16
            { argCount: 0, body: numberCodecBody(direction, 1) }, // codec_u8
        ],
    }
}

describe("codec extension — struct-of-scalars encoder/decoder", () =>
{
    test("encodes to little-endian packed bytes, in field-declaration order", () =>
    {
        const value = { x: 0x11223344, y: 0x5566, flag: 0x77 }
        const root: Handle = { container: { root: value }, key: "root", type: graph.root }
        const buffer: number[] = []

        const prog = program("encode")
        const ext = createCodecExtension("encode", root, buffer)

        const stats = validateProgram(prog, ext)
        assert.equal(stats.totalDepth, 0) // no operand-stack use anywhere in this program

        const result = run(prog, ext)
        assert.equal(result.ok, true)

        assert.deepEqual(buffer, [
            0x44, 0x33, 0x22, 0x11, // x: u32 LE
            0x66, 0x55,             // y: u16 LE
            0x77,                   // flag: u8
        ])
    })

    test("decodes the same bytes back to the original object", () =>
    {
        const buffer = [0x44, 0x33, 0x22, 0x11, 0x66, 0x55, 0x77]
        const decoded: Record<string, unknown> = {}
        const root: Handle = { container: { root: decoded }, key: "root", type: graph.root }

        const prog = program("decode")
        const ext = createCodecExtension("decode", root, buffer)

        validateProgram(prog, ext)
        const result = run(prog, ext)
        assert.equal(result.ok, true)

        assert.deepEqual(decoded, { x: 0x11223344, y: 0x5566, flag: 0x77 })
    })
})
