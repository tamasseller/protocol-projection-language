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
import { resolveProcedureTypes, correspondenceChild, correspondenceElement, resolveHandleCorrespondences } from "../src/engine/procedure-types"
import type { CodecExtInstr } from "../src/engine/codec-ext-instr"
import { struct, union, list, integer, u8, named, optional, buildTypeGraph, reconcile } from "@ppl/core"
import type { SemanticType, ConcreteSemanticType, TypeNode, Correspondence } from "@ppl/core"
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

/** Walks every procedure boundary reachable from `root`, memoized by
 *  procedure index — the same shape a real target codegen (e.g.
 *  `codec-module.ts`'s own `procedureBoundaryTypes`) drives over
 *  `resolveHandleTypes`, here over `resolveHandleCorrespondences` instead. */
function allBoundaryCorrespondences(program: RtlProgram<CodecExtInstr>, root: Correspondence): Map<number, Correspondence>
{
    const byIndex = new Map<number, Correspondence>()
    function visit(procIndex: number, c: Correspondence): void
    {
        if(byIndex.has(procIndex)) return
        byIndex.set(procIndex, c)
        resolveHandleCorrespondences(program.procedures[procIndex]!.body, c, visit)
    }
    visit(0, root)
    return byIndex
}

describe("resolveHandleCorrespondences / correspondenceChild / correspondenceElement — bridging navigation", () =>
{
    test("matched struct: every field's own CALL_CODEC threads a fully-matched child correspondence", () =>
    {
        const Image = named("Point", struct({ x: u8, y: u8 }))
        const Local = named("Point", struct({ x: u8, y: u8 }))
        const program = buildCodec(Image, binaryEncodeRules, undefined)
        const root = reconcile(buildTypeGraph(Image).root, buildTypeGraph(Local).root)

        const calls: Correspondence[] = []
        const slots = resolveHandleCorrespondences(program.procedures[0]!.body, root, (_i, c) => calls.push(c))

        assert.equal(slots.get(0), root)
        assert.ok(calls.length >= 2, "expects one CALL_CODEC per shared-integer field")
        for(const c of calls)
        {
            assert.equal(c.outcome, "matched")
            assert.ok(c.imageNode && c.localNode)
        }
    })

    test("image-only field: still reached (the bytecode still reads it), correspondence says image-only", () =>
    {
        const Image = named("Widget", struct({ a: u8, extra: u8 }))
        const Local = named("Widget", struct({ a: u8 }))
        const program = buildCodec(Image, binaryEncodeRules, undefined)
        const root = reconcile(buildTypeGraph(Image).root, buildTypeGraph(Local).root)

        const outcomes: string[] = []
        resolveHandleCorrespondences(program.procedures[0]!.body, root, (_i, c) => outcomes.push(c.outcome))

        assert.deepEqual(outcomes.sort(), ["image-only", "matched"])
    })

    test("nested struct: multi-hop CALL_CODEC carries correspondence across the procedure boundary", () =>
    {
        const InnerImage = named("Inner", struct({ a: u8, extra: u8 }))
        const InnerLocal = named("Inner", struct({ a: u8 }))
        const OuterImage = named("Outer", struct({ inner: InnerImage, b: u8 }))
        const OuterLocal = named("Outer", struct({ inner: InnerLocal, b: u8 }))

        const program = buildCodec(OuterImage, binaryEncodeRules, undefined)
        const root = reconcile(buildTypeGraph(OuterImage).root, buildTypeGraph(OuterLocal).root)
        const byIndex = allBoundaryCorrespondences(program, root)

        assert.equal(byIndex.get(0), root)
        const inner = [...byIndex.values()].find(c => c !== root && c.imageNode?.type.kind === "struct")
        assert.ok(inner, "expected Inner's own procedure boundary to be reached")
        assert.equal(inner!.outcome, "matched")
        assert.equal(correspondenceChild(inner!, "extra").correspondence.outcome, "image-only")
    })

    test("list of structs: ENTER_NEXT/CALL_CODEC_NEXT navigate the element correspondence", () =>
    {
        const ItemImage = named("Item", struct({ v: u8, extra: u8 }))
        const ItemLocal = named("Item", struct({ v: u8 }))
        const TImage = named("Batch", struct({ items: list(ItemImage, 4) }))
        const TLocal = named("Batch", struct({ items: list(ItemLocal, 4) }))

        const program = buildCodec(TImage, binaryEncodeRules, undefined)
        const root = reconcile(buildTypeGraph(TImage).root, buildTypeGraph(TLocal).root)
        const byIndex = allBoundaryCorrespondences(program, root)

        const item = [...byIndex.values()].find(c => c !== root && c.imageNode?.type.kind === "struct")
        assert.ok(item, "expected Item's own procedure boundary to be reached")
        assert.equal(correspondenceChild(item!, "extra").correspondence.outcome, "image-only")
    })

    test("correspondenceChild/correspondenceElement throw clearly when there's nothing to navigate to", () =>
    {
        const T = named("Point", struct({ x: u8 }))
        const c = reconcile(buildTypeGraph(T).root, buildTypeGraph(T).root)
        assert.throws(() => correspondenceChild(c, "nope"), /no edge named/)
        assert.throws(() => correspondenceElement(c), /no element Correspondence/)
    })
})
