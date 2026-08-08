/**
 * @ppl/codecs/test — stream-fork opcodes: HAS_NEXT, CLONE_RD, CLONE_WR, SEEK
 * (docs/codec-extension.md §3.1)
 *
 * DSL lowering + VM execution (mirrors dsl-rules.test.ts's style), the
 * checksum-with-fixup worked example (§8.4) end to end, capability/runtime
 * guards, and the static check (validateCodecHandles).
 */
import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { unit, buildTypeGraph } from "@ppl/core"
import { ir, proc, lowerProgram, validateProgram, run } from "@ppl/machine"
import type { RtlProgram } from "@ppl/machine"

import { createCodecExtension, codecRules } from "../src/engine/codec-extension"
import type { Handle } from "../src/engine/codec-extension"
import { validateCodecHandles } from "../src/engine/validate-handles"

const unitGraph = buildTypeGraph(unit)

/** Handle/root type is irrelevant to every test here — none of these ops
 *  touch an object handle at all. */
function encodeExt(buffer: number[])
{
    const root: Handle = { container: { root: {} }, key: "root", type: unitGraph.root }
    return createCodecExtension("encode", root, buffer)
}

function lower(entry: ReturnType<typeof proc>): RtlProgram
{
    return lowerProgram(entry, { rules: codecRules })
}

describe("stream forks — DSL lowering + execution", () =>
{
    test("has_next reflects whether i0 has bytes left (decoding, so i0 is read-only)", () =>
    {
        const entry = proc([], ir`
            u32 a = 0;
            u32 b = 0;
            a = has_next(0);
            u32 v = 0;
            v = read(0, 1);
            b = has_next(0);
            return a * 10 + b;
        `)
        const root: Handle = { container: { root: {} }, key: "root", type: unitGraph.root }
        const ext = createCodecExtension("decode", root, [42])
        const program = lower(entry)
        validateProgram(program, ext)
        const result = run(program, ext)
        assert.equal(result.ok, true)
        assert.equal(result.acc, 10) // a=1 (one byte available), b=0 (consumed it)
    })

    test("clone_rd forks a readable iterator off i0, independent of i0's own (write) capability", () =>
    {
        const entry = proc([], ir`
            clone_rd(0, 1);
            write(0, 1, 7);
            write(0, 1, 8);
            u32 v = 0;
            v = read(1, 1);
            return v;
        `)
        const buffer: number[] = []
        const ext = encodeExt(buffer)
        const program = lower(entry)
        validateProgram(program, ext)
        const result = run(program, ext)
        assert.equal(result.ok, true)
        assert.equal(result.acc, 7) // reader forked at pos 0, before either write
        assert.deepEqual(buffer, [7, 8])
    })

    test("clone_wr forks a writer that may only overwrite, never append", () =>
    {
        const entry = proc([], ir`
            clone_wr(0, 1);
            write(0, 1, 1);
            write(0, 1, 2);
            write(1, 1, 99);
            return;
        `)
        const buffer: number[] = []
        const ext = encodeExt(buffer)
        const program = lower(entry)
        validateProgram(program, ext)
        assert.equal(run(program, ext).ok, true)
        assert.deepEqual(buffer, [99, 2]) // fork parked at pos 0, patches byte 0
    })

    test("seek moves an iterator by a literal delta, including a negative one", () =>
    {
        const entry = proc([], ir`
            write(0, 1, 10);
            write(0, 1, 20);
            write(0, 1, 30);
            clone_rd(0, 1);
            seek(1, -2);
            u32 v = 0;
            v = read(1, 1);
            return v;
        `)
        const buffer: number[] = []
        const ext = encodeExt(buffer)
        const program = lower(entry)
        validateProgram(program, ext)
        const result = run(program, ext)
        assert.equal(result.ok, true)
        assert.equal(result.acc, 20) // reader forked at pos 3 (after 3 writes), seek(-2) -> pos 1
    })
})

describe("stream forks — checksum with fixup (codec-extension.md §8.4)", () =>
{
    test("reader fork sums the packet while a parked writer fork patches the checksum byte", () =>
    {
        const entry = proc([], ir`
            clone_rd(0, 1);
            clone_wr(0, 2);
            write(0, 1, 0);
            write(0, 1, 10);
            write(0, 1, 20);
            write(0, 1, 30);
            u32 sum = 0;
            while (has_next(1) != 0) { sum = sum + read(1, 1); }
            write(2, 1, sum);
            return;
        `)
        const buffer: number[] = []
        const ext = encodeExt(buffer)
        const program = lower(entry)
        validateProgram(program, ext)
        assert.equal(run(program, ext).ok, true)
        // checksum byte (patched) + the three payload bytes.
        assert.deepEqual(buffer, [60, 10, 20, 30])
    })
})

describe("stream forks — runtime capability guards", () =>
{
    test("READ on a write-only iterator (i0, encoding) throws", () =>
    {
        const entry = proc([], ir`u32 v = 0; v = read(0, 1); return v;`)
        const ext = encodeExt([])
        const program = lower(entry)
        validateProgram(program, ext)
        assert.throws(() => run(program, ext), /READ on write-only iterator/)
    })

    test("WRITE on a read-only fork throws", () =>
    {
        const entry = proc([], ir`clone_rd(0, 1); write(1, 1, 5); return;`)
        const ext = encodeExt([])
        const program = lower(entry)
        validateProgram(program, ext)
        assert.throws(() => run(program, ext), /WRITE on read-only iterator/)
    })

    test("a CLONE_WR fork can't append past the buffer's current end", () =>
    {
        const entry = proc([], ir`clone_wr(0, 1); write(1, 1, 5); return;`)
        const ext = encodeExt([]) // buffer starts empty — pos 0 IS the end
        const program = lower(entry)
        validateProgram(program, ext)
        assert.throws(() => run(program, ext), /can't append/)
    })

    test("SEEK before the stream's start throws", () =>
    {
        const entry = proc([], ir`clone_rd(0, 1); seek(1, -1); return;`)
        const ext = encodeExt([])
        const program = lower(entry)
        validateProgram(program, ext)
        assert.throws(() => run(program, ext), /before the stream's start/)
    })
})

describe("static checks — validateCodecHandles", () =>
{
    test("a well-formed fork program passes validateCodecHandles", () =>
    {
        const entry = proc([], ir`
            clone_rd(0, 1);
            clone_wr(0, 2);
            write(0, 1, 0);
            while (has_next(1) != 0) { u32 v = 0; v = read(1, 1); }
            write(2, 1, 1);
            return;
        `)
        const program = lower(entry)
        assert.doesNotThrow(() => validateCodecHandles(program))
    })

    test("rejects READ on an iterator id never cloned in this procedure", () =>
    {
        const entry = proc([], ir`u32 v = 0; v = read(1, 1); return v;`)
        const program = lower(entry)
        assert.throws(() => validateCodecHandles(program), /stream iterator 1 was never cloned/)
    })

    test("rejects WRITE on a fork established via CLONE_RD (read-only)", () =>
    {
        const entry = proc([], ir`clone_rd(0, 1); write(1, 1, 5); return;`)
        const program = lower(entry)
        assert.throws(() => validateCodecHandles(program), /iterator 1 is read-only, not write/)
    })
})
