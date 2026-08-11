/**
 * @ppl/codecs/test — resolveProcedureTypes (engine/procedure-types.ts)
 *
 * Cross-checks against the ground truth every one of these programs
 * already carries: `header` (stamped by createCodecResolver from the very
 * TypeNode each procedure was built from). The real point is the last
 * describe block — proving resolveProcedureTypes recovers the exact same
 * answer even after `header` is gone entirely, round-tripped through
 * bytecode.ts's wire encoding.
 */
import { test, describe } from "node:test"
import * as assert from "node:assert/strict"

import { buildCodec } from "../src/engine/resolver"
import { binaryEncodeRules } from "../src/components/binary-rules"
import { createCodecExtension } from "../src/engine/codec-extension"
import { resolveProcedureTypes } from "../src/engine/procedure-types"
import { struct, union, list, integer, u8, named, optional, buildTypeGraph } from "@ppl/core"
import type { SemanticType, ConcreteSemanticType, TypeNode } from "@ppl/core"
import { encodeProgram, decodeProgram } from "@ppl/machine"
import type { RtlProgram } from "@ppl/machine"

/** A trivial extension good for nothing but its own `.codec` (wire
 *  encode/decode of EXT instructions) — encodeProgram/decodeProgram never
 *  touch `.exec`/`.effects`, so a throwaway root/buffer is fine. */
const wireExtension = createCodecExtension("encode", { container: {}, key: "x", type: buildTypeGraph(u8).root }, [])

/** Ground truth: the TypeNode `createCodecResolver` actually built this
 *  procedure from — from a *different* `buildTypeGraph` call than
 *  `resolveProcedureTypes` makes internally, so comparing by reference
 *  would never match even when both are correct; compare structurally
 *  instead (kind, and field/variant names for the two kinds that have
 *  them). */
const headerType = (program: RtlProgram, index: number): ConcreteSemanticType =>
    (program.procedures[index]!.header as TypeNode).type

function assertSameShape(a: ConcreteSemanticType, b: ConcreteSemanticType, label: string): void
{
    assert.equal(a.kind, b.kind, `${label}: kind mismatch`)
    if(a.kind === "struct" && b.kind === "struct")
        assert.deepEqual([...a.fields.keys()], [...b.fields.keys()], `${label}: field names mismatch`)
    if(a.kind === "union" && b.kind === "union")
        assert.deepEqual([...a.variants.keys()], [...b.variants.keys()], `${label}: variant names mismatch`)
}

function assertMatchesHeaders(program: RtlProgram, resolved: ReadonlyMap<number, TypeNode>): void
{
    program.procedures.forEach((_proc, i) =>
    {
        assertSameShape(resolved.get(i)!.type, headerType(program, i), `procedure ${i}`)
    })
}

describe("resolveProcedureTypes — cross-checked against header (ground truth)", () =>
{
    test("flat struct of shared-type integer fields", () =>
    {
        const T = named("Point", struct({ x: u8, y: u8 }))
        const program = buildCodec(T, binaryEncodeRules, undefined)
        assert.ok(program.procedures.length >= 2, "expects at least the struct + one shared integer procedure")
        assertMatchesHeaders(program, resolveProcedureTypes(program, T))
    })

    test("nested struct — multi-hop CALL_CODEC", () =>
    {
        const Inner = named("Inner", struct({ a: u8 }))
        const Outer = named("Outer", struct({ inner: Inner, b: u8 }))
        const program = buildCodec(Outer, binaryEncodeRules, undefined)
        assertMatchesHeaders(program, resolveProcedureTypes(program, Outer))
    })

    test("standalone union — TAG + CALL_CODEC per variant", () =>
    {
        const T = named("Result", union({ ok: u8, err: integer(0, 1) }))
        const program = buildCodec(T, binaryEncodeRules, undefined)
        assertMatchesHeaders(program, resolveProcedureTypes(program, T))
    })

    test("struct with a hoisted-tag union field", () =>
    {
        // Small enough (2 variants) to qualify for structEncodeRule's own
        // bitmap hoisting (HOIST_MAX_VARIANTS=128) — exercises ENTER
        // (into the union field) feeding a later CALL_CODEC's own src.
        const T = named("Reading", struct({ kind: union({ a: u8, b: u8 }), value: u8 }))
        const program = buildCodec(T, binaryEncodeRules, undefined)
        assertMatchesHeaders(program, resolveProcedureTypes(program, T))
    })

    test("optional(T) — the same 2-variant union shape, one more level of nesting", () =>
    {
        const T = named("Sample", struct({ maybe: optional(u8) }))
        const program = buildCodec(T, binaryEncodeRules, undefined)
        assertMatchesHeaders(program, resolveProcedureTypes(program, T))
    })

    test("list of structs — ENTER_NEXT/CALL_CODEC_NEXT", () =>
    {
        const Item = named("Item", struct({ v: u8 }))
        const T = named("Batch", struct({ items: list(Item, 8) }))
        const program = buildCodec(T, binaryEncodeRules, undefined)
        assertMatchesHeaders(program, resolveProcedureTypes(program, T))
    })

    test("self-referential struct — cycle-safe, no infinite loop", () =>
    {
        const Tree: SemanticType = named("Tree", (): SemanticType => union({
            leaf: u8,
            node: struct({ left: Tree, right: Tree }),
        }))

        const program = buildCodec(Tree, binaryEncodeRules, undefined)
        const resolved = resolveProcedureTypes(program, Tree)
        assert.equal(resolved.size, program.procedures.length)
        assertMatchesHeaders(program, resolved)
    })
})

describe("resolveProcedureTypes — robust to a program with no header at all", () =>
{
    test("bytecode round-trip strips header; resolveProcedureTypes still recovers the same types", () =>
    {
        const Inner = named("Inner", struct({ a: u8 }))
        const Outer = named("Outer", struct({ inner: Inner, list: list(u8, 4), b: u8 }))
        const program = buildCodec(Outer, binaryEncodeRules, undefined)

        const decoded = decodeProgram(encodeProgram(program, wireExtension), 0, wireExtension).program
        assert.ok(decoded.procedures.every(p => p.header === undefined), "sanity: header really is gone after the round-trip")

        const before = resolveProcedureTypes(program, Outer)
        const after = resolveProcedureTypes(decoded, Outer)

        assert.equal(after.size, before.size)
        for(const [i, node] of before)
            assert.equal(after.get(i)!.type.kind, node.type.kind, `procedure ${i}: kind mismatch after header-less resolution`)
    })
})
