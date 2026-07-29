/**
 * Runtime tests for the wire-format projection (wire-format.ts).
 *
 * Validates the generic wire-shape descriptors in isolation. The example
 * package exercises the full composition; these tests guard the
 * package's own contract.
 */
import {test} from "node:test"
import * as assert from "node:assert/strict"

import {integer, list, struct, union, unit} from "@ppl/core"
import {buildTypeGraph} from "@ppl/core"
import {
    projectWireFormat,
    wireFormatRules,
    intWireSize,
    wireSize,
    WireFixed,
    WireCounted,
    WireTagged,
    WireStructFields,
} from "../src/wire-format"

////////////////////////////////////////////////////////////////////////////////////////////////
// intWireSize — byte width from integer range
////////////////////////////////////////////////////////////////////////////////////////////////

test("wire-format: intWireSize picks smallest power-of-2 byte count", () => {
    assert.equal(intWireSize(integer(0, 255)), 1)
    assert.equal(intWireSize(integer(0, 256)), 2)
    assert.equal(intWireSize(integer(0, 65535)), 2)
    assert.equal(intWireSize(integer(0, 65536)), 4)
    assert.equal(intWireSize(integer(0, 4294967295)), 4)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Integer → WireFixed
////////////////////////////////////////////////////////////////////////////////////////////////

test("wire-format: integer projects to fixed size", () => {
    const g = buildTypeGraph(integer(0, 65535))
    const r = projectWireFormat(g)
    const s = r.get(0)! as WireFixed
    assert.equal(s.kind, "fixed")
    assert.equal(s.size, 2)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Unit → 0 bytes
////////////////////////////////////////////////////////////////////////////////////////////////

test("wire-format: unit projects to 0 bytes", () => {
    const g = buildTypeGraph(unit)
    const r = projectWireFormat(g)
    const s = r.get(0)! as WireFixed
    assert.equal(s.kind, "fixed")
    assert.equal(s.size, 0)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Struct → packed fields
////////////////////////////////////////////////////////////////////////////////////////////////

test("wire-format: struct projects to ordered packed fields", () => {
    const g = buildTypeGraph(struct({a: integer(0, 255), b: integer(0, 65535)}))
    const r = projectWireFormat(g)
    const s = r.get(0)! as WireStructFields
    assert.equal(s.kind, "struct")
    assert.equal(s.fields.length, 2)
    assert.equal(s.fields[0].name, "a")
    assert.equal((s.fields[0].shape as WireFixed).size, 1)
    assert.equal(s.fields[1].name, "b")
    assert.equal((s.fields[1].shape as WireFixed).size, 2)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// List → counted with 1-byte prefix
////////////////////////////////////////////////////////////////////////////////////////////////

test("wire-format: list projects to counted with max count", () => {
    const g = buildTypeGraph(list(integer(0, 255), 32))
    const r = projectWireFormat(g)
    // The root is a list — but lists are inlined by enclosing structs.
    // Project via a struct to exercise the counted shape.
    const g2 = buildTypeGraph(struct({items: list(integer(0, 255), 32)}))
    const r2 = projectWireFormat(g2)
    const s = r2.get(0)! as WireStructFields
    const f = s.fields[0]
    assert.equal(f.name, "items")
    assert.equal(f.shape.kind, "counted")
    assert.equal((f.shape as WireCounted).maxCount, 32)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Union → tagged
////////////////////////////////////////////////////////////////////////////////////////////////

test("wire-format: all-unit union projects to tagged with 0-byte variants", () => {
    const g = buildTypeGraph(union({a: unit, b: unit}))
    const r = projectWireFormat(g)
    const s = r.get(0)! as WireTagged
    assert.equal(s.kind, "tagged")
    assert.equal(Object.keys(s.variants).length, 2)
    for (const v of Object.values(s.variants))
    {
        assert.equal((v as WireFixed).kind, "fixed")
        assert.equal((v as WireFixed).size, 0)
    }
})

////////////////////////////////////////////////////////////////////////////////////////////////
// wireSize helper
////////////////////////////////////////////////////////////////////////////////////////////////

test("wire-format: wireSize sums struct field sizes", () => {
    const g = buildTypeGraph(struct({a: integer(0, 255), b: integer(0, 65535)}))
    const r = projectWireFormat(g)
    assert.equal(wireSize(r.get(0)!), 3) // 1 + 2
})
