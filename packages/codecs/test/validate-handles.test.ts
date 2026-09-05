/**
 * @ppl/codecs/test — validate-handles.ts (codec-extension.md §7.1)
 *
 * Two kinds of coverage: (1) real `buildCodec` output — including a
 * hoisted union field, so `ENTER` onto a non-`o0` handle actually appears
 * in the body — passes `validateCodecHandles` cleanly; (2) hand-built
 * `RtlProgram<CodecExtInstr>` fixtures for each violation §7.1 is supposed to catch.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import type { TypeNode } from "@ppl/core"
import { struct, union, unit, u8, u32, list, buildTypeGraph } from "@ppl/core"
import type { RtlProgram, RtlProc } from "mog-core"
import { bare, validateProgram } from "mog-core"
import { callCodecInstr, enterInstr, enterNextInstr, loadValInstr, tagInstr } from "../src/engine/codec-ext-instr"
import type { CodecExtInstr } from "../src/engine/codec-ext-instr"

import { validateCodecHandles } from "../src/engine/validate-handles"
import { buildCodec } from "../src/engine/resolver"
import { createCodecExtension } from "../src/engine/codec-extension"
import { binaryEncodeRules, binaryDecodeRules } from "../src/components/binary-rules"

// ── Real buildCodec output — should validate cleanly ────────────────────

describe("validateCodecHandles — real buildCodec output", () =>
{
    test("a struct with a hoisted union field and a nested list passes", () =>
    {
        const root = struct({
            id: u8,
            tag: union({ a: unit, b: unit, c: unit }), // hoistable — real ENTER onto a non-o0 handle
            items: list(u32),
        })
        const graph = buildTypeGraph(root)

        const value = { id: 7, tag: { variant: "b", value: undefined }, items: [1, 2, 3] }

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
})

// ── Hand-built fixtures — precise, hand-computed expectations ───────────

/** `Item { tag: union{a,b: unit}, payload: struct{v: u32} }` — small enough
 *  that every TypeNode below is nameable by hand. */
function itemTypeNodes()
{
    const graph = buildTypeGraph(struct({
        tag: union({ a: unit, b: unit }),
        payload: struct({ v: u32 }),
    }))
    const item = graph.root                              // fields: [0]=tag, [1]=payload
    const tagUnion = item.edges[0]!.target                // variants: [0]=a, [1]=b
    const variantA = tagUnion.edges[0]!.target
    const payload = item.edges[1]!.target                 // fields: [0]=v
    const v = payload.edges[0]!.target
    return { item, tagUnion, variantA, payload, v }
}

function proc(argCount: number, body: RtlProc<CodecExtInstr>["body"], header?: TypeNode): RtlProc<CodecExtInstr>
{
    return { argCount, body, header }
}

describe("validateCodecHandles — hand-built fixtures", () =>
{
    test("well-formed program with real nesting and delegation passes", () =>
    {
        const { item, tagUnion, variantA, payload } = itemTypeNodes()

        // proc 0: item's own codec — enters both its fields, delegates the
        // active union variant (proc 1) and the payload struct (proc 2).
        const itemProc = proc(0, [
            enterInstr(1, 0, 0),        // handle1 = tag (union)
            enterInstr(2, 1, 0),        // handle2 = tag's variant 'a' (unit)
            callCodecInstr(1, 1, 0),   // delegate variant 'a' to proc 1
            callCodecInstr(2, 0, 1),   // delegate 'payload' (from o0 directly) to proc 2
            bare("RETURN"),
        ], item)

        // proc 1: variant 'a's own codec (unit — nothing to do).
        const variantAProc = proc(0, [bare("RETURN")], variantA)

        // proc 2: payload's own codec — enters its one field and reads it.
        const payloadProc = proc(0, [
            enterInstr(1, 0, 0),   // handle1 = v (integer)
            loadValInstr(1),
            bare("RETURN"),
        ], payload)

        const program: RtlProgram<CodecExtInstr> = { procedures: [itemProc, variantAProc, payloadProc] }

        assert.doesNotThrow(() => validateCodecHandles(program))
    })

    test("rejects an out-of-range struct field ref", () =>
    {
        const { item } = itemTypeNodes()
        const program: RtlProgram<CodecExtInstr> = {
            procedures: [proc(0, [enterInstr(1, 0, 5), bare("RETURN")], item)],
        }
        assert.throws(() => validateCodecHandles(program), /ref 5 out of range/)
    })

    test("rejects CALL_CODEC targeting a GENERIC procedure (no declared object type)", () =>
    {
        const { item, payload } = itemTypeNodes()
        void payload
        const program: RtlProgram<CodecExtInstr> = {
            procedures: [
                proc(0, [callCodecInstr(1, 0, 1), bare("RETURN")], item),
                proc(0, [bare("RETURN")]), // no header — GENERIC
            ],
        }
        assert.throws(() => validateCodecHandles(program), /GENERIC.*can't be a delegation target/)
    })

    test("rejects CALL_CODEC delegating to a codec built for the wrong type", () =>
    {
        const { item, tagUnion } = itemTypeNodes()
        const program: RtlProgram<CodecExtInstr> = {
            procedures: [
                // field 1 is 'payload', but the callee below declares 'tagUnion' as its type.
                proc(0, [callCodecInstr(1, 0, 1), bare("RETURN")], item),
                proc(0, [bare("RETURN")], tagUnion),
            ],
        }
        assert.throws(() => validateCodecHandles(program), /doesn't match the delegated-to child's actual type/)
    })

    test("rejects TAG on a non-union handle", () =>
    {
        const { item } = itemTypeNodes()
        const program: RtlProgram<CodecExtInstr> = {
            procedures: [proc(0, [
                enterInstr(1, 0, 1),  // handle1 = payload (a struct)
                tagInstr(1),
                bare("RETURN"),
            ], item)],
        }
        assert.throws(() => validateCodecHandles(program), /not a union/)
    })

    test("rejects ENTER_NEXT on a non-list handle", () =>
    {
        const { item } = itemTypeNodes()
        const program: RtlProgram<CodecExtInstr> = {
            procedures: [proc(0, [enterNextInstr(1, 0), bare("RETURN")], item)],
        }
        assert.throws(() => validateCodecHandles(program), /list only/)
    })

    test("rejects a handle used before it's entered", () =>
    {
        const { item } = itemTypeNodes()
        const program: RtlProgram<CodecExtInstr> = {
            procedures: [proc(0, [loadValInstr(1), bare("RETURN")], item)],
        }
        assert.throws(() => validateCodecHandles(program), /never entered/)
    })

    test("a GENERIC procedure (no header) touching any handle at all is rejected — o0 doesn't exist for it", () =>
    {
        const program: RtlProgram<CodecExtInstr> = {
            procedures: [proc(0, [loadValInstr(0), bare("RETURN")])], // no header
        }
        assert.throws(() => validateCodecHandles(program), /never entered/)
    })
})
