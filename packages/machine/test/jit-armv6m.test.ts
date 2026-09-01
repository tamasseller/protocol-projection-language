// The jit-armv6m target's own wrapper around the generic codec: the
// whole-program stats it needs up front, and the frame binding a program to
// the validator that produced it (jit-armv6m/docs/design.md §1.1).
import { describe, test } from "node:test"
import assert from "node:assert/strict"

import {
    encodeJitEnvelope, decodeJitEnvelope, encodeJitProgram, decodeJitProgram,
    programFrameHash, PROGRAM_FRAME_BYTES, PROGRAM_CONTRACT_VERSION,
} from "../src/jit-armv6m"
import { encodeProgram, encodeLeb128 } from "../src/bytecode"
import { bare, call, opImm, LOAD, CONST } from "../src/rtl"
import type { RtlProgram } from "../src/rtl"
import { validateProgram } from "../src/validate"
import { run } from "../src/vm"

describe("jit-armv6m wire envelope (design.md §1.1)", () =>
{
    // proc 0 (entry, maxCallDepth 1): CONST 5; CALL 1; RETURN.
    // proc 1 (argCount 1, leaf): LOAD 0; ADD #10; RETURN.
    function twoProcProgram(): RtlProgram
    {
        return {
            procedures: [
                { argCount: 0, body: [CONST(5), call(1), bare("RETURN")] },
                { argCount: 1, body: [LOAD(0), opImm("ADD", 10), bare("RETURN")] },
            ],
        }
    }

    test("prepends validateProgram's own maxCallDepth/totalDepth to an ordinary encodeProgram blob", () =>
    {
        const program = twoProcProgram()
        const stats = validateProgram(program)
        const envelope = encodeJitEnvelope(program)
        const plainBytes = encodeProgram(program)

        assert.deepEqual([...envelope], [...encodeLeb128(stats.maxCallDepth), ...encodeLeb128(stats.totalDepth), ...plainBytes])
    })

    test("round-trips exactly, stats included", () =>
    {
        const program = twoProcProgram()
        const stats = validateProgram(program)
        const decoded = decodeJitProgram(encodeJitProgram(program))

        assert.equal(decoded.maxCallDepth, stats.maxCallDepth)
        assert.equal(decoded.totalDepth, stats.totalDepth)
        assert.deepEqual(decoded.program, program)
        assert.equal(decoded.next, encodeJitProgram(program).length)
    })

    test("the round-tripped program still validates and runs correctly", () =>
    {
        const { program: decoded } = decodeJitProgram(encodeJitProgram(twoProcProgram()))
        validateProgram(decoded)
        const result = run(decoded)
        assert.equal(result.ok, true)
        assert.equal(result.acc, 15) // 5 + 10, via a real CALL across the wire
    })
})

describe("jit-armv6m program frame (design.md §1.1)", () =>
{
    function oneProcProgram(): RtlProgram
    {
        return { procedures: [{ argCount: 0, body: [CONST(7), bare("RETURN")] }] }
    }

    test("the frame is the envelope plus exactly two trailing bytes", () =>
    {
        const program = oneProcProgram()
        const envelope = encodeJitEnvelope(program)
        const framed = encodeJitProgram(program)

        assert.equal(framed.length, envelope.length + PROGRAM_FRAME_BYTES)
        assert.deepEqual([...framed.subarray(0, envelope.length)], [...envelope])

        const stored = framed[envelope.length] | (framed[envelope.length + 1] << 8)
        assert.equal(stored, programFrameHash(envelope))
    })

    test("a flipped payload byte does not verify", () =>
    {
        const framed = encodeJitProgram(oneProcProgram())
        framed[framed.length - PROGRAM_FRAME_BYTES - 1] ^= 0x01

        assert.throws(() => decodeJitProgram(framed), /program frame mismatch/)
    })

    test("a length that is off by one either way does not verify", () =>
    {
        const framed = encodeJitProgram(oneProcProgram())

        assert.throws(() => decodeJitProgram(framed.subarray(0, framed.length - 1)), /program frame/)
        assert.throws(() => decodeJitProgram(Uint8Array.from([...framed, 0])), /program frame mismatch/)
    })

    test("a buffer nobody filled in does not verify", () =>
    {
        assert.throws(() => decodeJitProgram(new Uint8Array(8)), /program frame mismatch/)
        assert.throws(() => decodeJitProgram(new Uint8Array(8).fill(0xff)), /program frame mismatch/)
        assert.throws(() => decodeJitProgram(new Uint8Array(PROGRAM_FRAME_BYTES)), /cannot hold a frame/)
    })

    test("a frame built against another contract version does not verify", () =>
    {
        // What a producer one version behind would have written: the seed is
        // the only thing that differs, so the payload is byte-identical.
        const envelope = encodeJitEnvelope(oneProcProgram())
        let h = ((0x811c9dc5 ^ (PROGRAM_CONTRACT_VERSION + 1)) >>> 0)
        for(const b of envelope) h = Math.imul(h ^ b, 0x01000193) >>> 0
        const stale = ((h >>> 16) ^ (h & 0xffff)) & 0xffff

        const framed = Uint8Array.from([...envelope, stale & 0xff, (stale >>> 8) & 0xff])
        assert.throws(() => decodeJitProgram(framed), /program frame mismatch/)
    })

    test("the hash matches what the C++ side computes for the same bytes", () =>
    {
        // jit-armv6m/test/host/test_executor.cpp asserts this same number. A
        // divergence would otherwise show up only as every program being
        // refused, in whichever suite happens to run first.
        // 0x80 rather than a core opcode, so a byte with its high bit set goes
        // through the mixer: nothing else here would catch one side widening
        // it as signed.
        const vector = Uint8Array.from([0x00, 0x00, 0x01, 0x00, 0x80, 102])
        assert.equal(programFrameHash(vector), 0xdc7d)
    })

    test("the unframed envelope still round-trips on its own", () =>
    {
        // The fuzz corpus is raw mutation fodder and stays unframed.
        const program = oneProcProgram()
        const decoded = decodeJitEnvelope(encodeJitEnvelope(program))

        assert.deepEqual(decoded.program, program)
        assert.equal(decoded.next, encodeJitEnvelope(program).length)
    })
})
