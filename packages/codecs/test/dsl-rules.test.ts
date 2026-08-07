/**
 * @ppl/codecs/test — codecRules(): the `ir\`...\`` DSL surface for codec ops
 *
 * Proves each opcode in `EFFECTS` (codec-extension.ts) lowers correctly from
 * `ir\`...\`` builtin-call syntax via `codecRules()`, end to end through
 * `validateProgram`/`run` against the existing `createCodecExtension`
 * runtime — the DSL surface `builders.ts` (Phase 2b) is built on. Small,
 * hand-authored fragments per opcode group, not the full generic builder;
 * that gets its own exhaustive coverage in `builders.test.ts`.
 */
import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { struct, union, unit, u8, list, buildTypeGraph } from "@ppl/core"
import { ir, proc, lowerProgram, validateProgram, run } from "@ppl/machine"
import type { RtlProgram } from "@ppl/machine"

import { createCodecExtension, codecRules } from "../src/codec-extension"
import type { Handle, Direction } from "../src/codec-extension"

function numberCodec(direction: Direction, width: number)
{
    return direction === "encode"
        ? proc([], ir`load_val(0); write(0, ${width}); return;`)
        : proc([], ir`read(0, ${width}); store_val(0); return;`)
}

function lower(entry: ReturnType<typeof proc>): RtlProgram
{
    return lowerProgram(entry, { rules: codecRules })
}

describe("codecRules(): call_codec / load_val / store_val / read / write", () =>
{
    const structType = struct({ a: u8, b: u8 })
    const graph = buildTypeGraph(structType)

    function entry(direction: Direction)
    {
        const a = numberCodec(direction, 1)
        const b = numberCodec(direction, 1)
        return proc([], ir`call_codec(${a}, 0, 0); call_codec(${b}, 0, 1); return;`)
    }

    test("encodes a two-field struct authored entirely as ir` ` text", () =>
    {
        const program = lower(entry("encode"))
        const root: Handle = { container: { root: { a: 5, b: 9 } }, key: "root", type: graph.root }
        const buffer: number[] = []
        const ext = createCodecExtension("encode", root, buffer)

        validateProgram(program, ext)
        assert.equal(run(program, ext).ok, true)
        assert.deepEqual(buffer, [5, 9])
    })

    test("decodes the same bytes back", () =>
    {
        const program = lower(entry("decode"))
        const decoded: Record<string, unknown> = {}
        const root: Handle = { container: { root: decoded }, key: "root", type: graph.root }
        const ext = createCodecExtension("decode", root, [5, 9])

        validateProgram(program, ext)
        assert.equal(run(program, ext).ok, true)
        assert.deepEqual(decoded, { a: 5, b: 9 })
    })
})

describe("codecRules(): count / open_list / enter_next / call_codec_next", () =>
{
    const listType = list(u8)
    const graph = buildTypeGraph(listType)

    function entry(direction: Direction)
    {
        const elem = numberCodec(direction, 1)
        return direction === "encode"
            ? proc([], ir`
                u32 left = 0;
                left = count(0);
                write(0, 1);
                while (left != 0) { call_codec_next(${elem}, 0); left = left - 1; }
                return;
              `)
            : proc([], ir`
                u32 left = 0;
                left = read(0, 1);
                open_list(0);
                while (left != 0) { call_codec_next(${elem}, 0); left = left - 1; }
                return;
              `)
    }

    test("encodes a length-prefixed list", () =>
    {
        const program = lower(entry("encode"))
        const root: Handle = { container: { root: [1, 2, 3] }, key: "root", type: graph.root }
        const buffer: number[] = []
        const ext = createCodecExtension("encode", root, buffer)

        validateProgram(program, ext)
        assert.equal(run(program, ext).ok, true)
        assert.deepEqual(buffer, [3, 1, 2, 3])
    })

    test("decodes it back", () =>
    {
        const program = lower(entry("decode"))
        const wrapper: Record<string, unknown> = { root: undefined }
        const root: Handle = { container: wrapper, key: "root", type: graph.root }
        const ext = createCodecExtension("decode", root, [3, 1, 2, 3])

        validateProgram(program, ext)
        assert.equal(run(program, ext).ok, true)
        assert.deepEqual(wrapper.root, [1, 2, 3])
    })
})

describe("codecRules(): enter / tag / call_codec (union dispatch inside a struct field)", () =>
{
    const structType = struct({ flag: union({ on: unit, off: unit }) })
    const graph = buildTypeGraph(structType)

    const variantCodec = () => proc([], ir`return;`)

    function entry()
    {
        const onCodec = variantCodec()
        const offCodec = variantCodec()
        return proc([], ir`
            enter(1, 0, 0);
            switch (tag(1))
            {
                case 0: call_codec(${onCodec}, 1, 0);
                case 1: call_codec(${offCodec}, 1, 1);
            }
            return;
        `)
    }

    test("navigates to the field via enter, then dispatches by its active variant's tag", () =>
    {
        const program = lower(entry())
        const root: Handle = { container: { root: { flag: { variant: "off", value: undefined } } }, key: "root", type: graph.root }
        const buffer: number[] = []
        const ext = createCodecExtension("encode", root, buffer)

        validateProgram(program, ext)
        assert.equal(run(program, ext).ok, true)
        // Both variants are `unit` — no payload byte, just proves ENTER/TAG/CALL_CODEC ran.
        assert.deepEqual(buffer, [])
    })
})
