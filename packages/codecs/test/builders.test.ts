/**
 * @ppl/codecs/test — builders.ts: the generic codec-generation library
 *
 * Unit-level coverage per `TypeNode` kind, plus the two things that make
 * this a *library* rather than a one-off: memoizing shared `TypeNode`s to
 * one codec, and the struct-level union-tag hoisting optimization.
 * `packages/example`'s rewritten integration test is the "does this hold
 * up against a real, independently-authored schema" proof; this file is
 * the focused, per-feature one.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import type { SemanticType } from "@ppl/core"
import { struct, union, unit, u8, u16, i8, i16, i32, list, pUnit, buildTypeGraph } from "@ppl/core"
import { ir, validateProgram, run } from "@ppl/machine"

import { buildCodec } from "../src/builders"
import { createCodecExtension } from "../src/codec-extension"
import type { CodecRule } from "../src/rules"
import type { Direction } from "../src/codec-extension"

function roundTrip(rootType: Parameters<typeof buildTypeGraph>[0], value: unknown, extraRules: readonly CodecRule<Direction>[] = [])
{
    const graph = buildTypeGraph(rootType)

    const encodeProgram = buildCodec(graph.root, "encode", extraRules)
    const buffer: number[] = []
    const encodeExt = createCodecExtension("encode", { container: { root: value }, key: "root", type: graph.root }, buffer)
    validateProgram(encodeProgram, encodeExt)
    assert.equal(run(encodeProgram, encodeExt).ok, true)

    const decodeProgram = buildCodec(graph.root, "decode", extraRules)
    // Pre-seed the root slot with an empty object: essential for a
    // struct-rooted decode (fields mutate an existing object in place,
    // never get "instantiated" the way a list/union does) and harmless
    // for every other root kind (STORE_VAL/OPEN_LIST/the union branch all
    // replace it outright regardless of what was there).
    const wrapper: Record<string, unknown> = { root: {} }
    const decodeExt = createCodecExtension("decode", { container: wrapper, key: "root", type: graph.root }, [...buffer])
    validateProgram(decodeProgram, decodeExt)
    assert.equal(run(decodeProgram, decodeExt).ok, true)

    return { buffer, decoded: wrapper.root }
}

describe("buildCodec — integers, lists, standalone unions", () =>
{
    test("integer round-trips at its natural width", () =>
    {
        const { buffer, decoded } = roundTrip(u16, 0x1234)
        assert.deepEqual(buffer, [0x34, 0x12])
        assert.equal(decoded, 0x1234)
    })

    test("signed integers decode back to a real negative JS number, not their raw unsigned bit pattern", () =>
    {
        // Each width's sign bit sits at a different position (bit 7, 15,
        // 31) — exercise all three so a width-independent regression
        // (e.g. hardcoding one shift amount) would show up.
        assert.equal(roundTrip(i8, -1).decoded, -1)
        assert.equal(roundTrip(i16, -1).decoded, -1)
        assert.equal(roundTrip(i32, -1).decoded, -1)
        assert.equal(roundTrip(i16, -12345).decoded, -12345)
        assert.equal(roundTrip(i32, -2147483648).decoded, -2147483648) // i32's own min
        assert.equal(roundTrip(i16, 32767).decoded, 32767) // positive values unaffected
    })

    test("length-prefixed list round-trips, including empty", () =>
    {
        const listType = list(u8)
        assert.deepEqual(roundTrip(listType, [1, 2, 3]).buffer, [3, 1, 2, 3])
        assert.deepEqual(roundTrip(listType, []).decoded, [])
    })

    test("standalone union (reached as the root type) round-trips both variants", () =>
    {
        const unionType = union({ a: unit, b: u8 })
        assert.deepEqual(roundTrip(unionType, { variant: "a", value: undefined }).buffer, [0])
        const { buffer, decoded } = roundTrip(unionType, { variant: "b", value: 9 })
        assert.deepEqual(buffer, [1, 9])
        assert.deepEqual(decoded, { variant: "b", value: 9 })
    })

    test("a struct field that is itself a struct decodes correctly (nested object gets instantiated, not written through `undefined`)", () =>
    {
        const t = struct({ id: u8, at: struct({ secs: u16, nanos: u8 }) })
        const { decoded } = roundTrip(t, { id: 1, at: { secs: 1000, nanos: 5 } })
        assert.deepEqual(decoded, { id: 1, at: { secs: 1000, nanos: 5 } })
    })

    test("a list of structs decodes correctly (each element gets instantiated before its own fields are written)", () =>
    {
        const t = list(struct({ a: u8, b: u8 }))
        const { decoded } = roundTrip(t, [{ a: 1, b: 2 }, { a: 3, b: 4 }])
        assert.deepEqual(decoded, [{ a: 1, b: 2 }, { a: 3, b: 4 }])
    })
})

describe("buildCodec — structs: field order, sharing, and union-tag hoisting", () =>
{
    test("fields encode in declaration order", () =>
    {
        const t = struct({ x: u8, y: u16 })
        assert.deepEqual(roundTrip(t, { x: 1, y: 2 }).buffer, [1, 2, 0])
    })

    test("two fields of the same shared TypeNode resolve to one codec, not two", () =>
    {
        const t = struct({ a: u8, b: u8 }) // `u8` is the same exported singleton object
        const graph = buildTypeGraph(t)
        const program = buildCodec(graph.root, "encode")
        assert.equal(program.procedures.length, 2) // struct + one shared u8 codec
    })

    test("a ≤4-variant union field is hoisted into a shared leading bitmap, not its own tag byte", () =>
    {
        const flag = union({ on: unit, off: unit }) // 2 variants -> 1 bit
        const t = struct({ flag, value: u8 })

        // "on" is variant #0 -> bitmap bit = 0; "off" is #1 -> bit = 1.
        // No standalone tag byte for `flag` at all: bitmap byte, then
        // straight to `value`'s own byte — 2 bytes total, not 3.
        assert.deepEqual(roundTrip(t, { flag: { variant: "on", value: undefined }, value: 7 }).buffer, [0, 7])
        const { buffer, decoded } = roundTrip(t, { flag: { variant: "off", value: undefined }, value: 7 })
        assert.deepEqual(buffer, [1, 7])
        assert.deepEqual(decoded, { flag: { variant: "off", value: undefined }, value: 7 })
    })

    test("a >4-variant union field falls back to a standalone (non-hoisted) union codec", () =>
    {
        const big = union({ a: unit, b: unit, c: unit, d: unit, e: unit }) // 5 variants
        const t = struct({ big, tail: u8 })

        // Falls back to a full tag byte for `big`, same as a bare union root.
        const { buffer, decoded } = roundTrip(t, { big: { variant: "c", value: undefined }, tail: 5 })
        assert.deepEqual(buffer, [2, 5])
        assert.deepEqual(decoded, { big: { variant: "c", value: undefined }, tail: 5 })
    })

    test("multiple hoistable fields pack into the same bitmap byte", () =>
    {
        const flag = union({ on: unit, off: unit })
        const t = struct({ a: flag, b: flag, c: u8 })

        // a -> bit 0, b -> bit 1; "off"=1 for both -> bitmap = 0b11 = 3.
        const { buffer, decoded } = roundTrip(t, {
            a: { variant: "off", value: undefined },
            b: { variant: "off", value: undefined },
            c: 42,
        })
        assert.deepEqual(buffer, [0b11, 42])
        assert.deepEqual(decoded, {
            a: { variant: "off", value: undefined },
            b: { variant: "off", value: undefined },
            c: 42,
        })
    })
})

describe("buildCodec — extensibility and recursive types", () =>
{
    test("a caller-supplied rule wins over the matching default for the same type shape", () =>
    {
        // The default `unit` rule (builders.ts) writes nothing at all — a
        // custom rule can still preempt it and write an explicit marker
        // byte instead, purely by being listed first; no change to
        // builders.ts itself.
        const markerUnitRule: CodecRule<Direction> = {
            pattern: pUnit(),
            produce: (_m, _node, direction) =>
                direction === "encode" ? ir`255; write(0, 1); return;` : ir`read(0, 1); return;`,
        }

        const { buffer } = roundTrip(unit, undefined, [markerUnitRule])
        assert.deepEqual(buffer, [255])
    })

    test("a self-referential struct/union type resolves without hanging, and the validator correctly rejects the resulting recursive call graph", () =>
    {
        // `node`'s own "next" field is a union whose "some" variant is a
        // thunk deref'ing back to `node` itself — buildTypeGraph's cycle-
        // breaking (type-graph.ts:72-74) makes this a genuinely cyclic
        // TypeNode graph, not just a deeply-nested finite tree. The two-
        // phase `Procedure` construction (declareProc/defineProc, ir.ts) is
        // what lets `resolve()` even *reach* this without infinite
        // recursion during generation (see rules.test.ts's driver-level
        // version of the same thing) — but isa-core.md §8.2 forbids a
        // recursive call graph outright (bounded-stack-depth guarantee),
        // and `validateProgram` enforces that regardless of how the
        // program was authored. A codec for a genuinely recursive type was
        // never expressible under this ISA — hand-built or DSL-authored —
        // so the correct, provable claim is "construction survives the
        // cycle and the validator catches it with a clear error," not
        // "it round-trips."
        let node!: SemanticType
        const chainType: SemanticType = struct({ depth: u8, next: union({ some: () => node, none: unit }) })
        node = chainType

        const graph = buildTypeGraph(chainType)
        const program = buildCodec(graph.root, "encode") // must not hang or stack-overflow
        const ext = createCodecExtension("encode", { container: { root: undefined }, key: "root", type: graph.root }, [])
        assert.throws(
            () => validateProgram(program, ext),
            /cycle/,
        )
    })
})
