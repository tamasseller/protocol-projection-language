/**
 * Wire format integration test.
 *
 * Verifies that the GENERIC wire-format projection from @ppl/codecs,
 * when COMPOSED over this project's schema (via compose.ts), produces
 * the correct binary layout descriptors.
 */
import {test} from "node:test"
import * as assert from "node:assert/strict"

import {child} from "@ppl/core"
import {
    WireShape,
    WireFixed,
    WireCounted,
    WireTagged,
    WireStructFields,
} from "@ppl/codecs"
import {graph as g, wireShapes as result} from "../src/compose"

// Helper: assert shape kind
function assertKind(s: WireShape, kind: string): asserts s is any
{
    assert.equal(s.kind, kind)
}

// ——————————————————————————————————————————————
// Root struct: TelemetryPacket
// ——————————————————————————————————————————————

test("wire: TelemetryPacket is a struct shape", () =>
{
    const s = result.get(g.root.id)!
    assertKind(s, "struct")
})

test("wire: TelemetryPacket has 4 fields in order", () =>
{
    const s = result.get(g.root.id)! as WireStructFields
    assert.equal(s.fields.length, 4)
    assert.equal(s.fields[0].name, "deviceId")
    assert.equal(s.fields[1].name, "timestamp")
    assert.equal(s.fields[2].name, "readings")
    assert.equal(s.fields[3].name, "status")
})

test("wire: deviceId is fixed 4 bytes (uint32)", () =>
{
    const s = result.get(g.root.id)! as WireStructFields
    const f = s.fields[0]
    assertKind(f.shape, "fixed")
    assert.equal((f.shape as WireFixed).size, 4)
})

test("wire: readings is a counted list", () =>
{
    const s = result.get(g.root.id)! as WireStructFields
    const f = s.fields[2]
    assertKind(f.shape, "counted")
    assert.equal((f.shape as WireCounted).maxCount, 16)
})

test("wire: status is fixed 2 bytes (uint16)", () =>
{
    const s = result.get(g.root.id)! as WireStructFields
    const f = s.fields[3]
    assertKind(f.shape, "fixed")
    assert.equal((f.shape as WireFixed).size, 2)
})

// ——————————————————————————————————————————————
// Timestamp nested struct
// ——————————————————————————————————————————————

test("wire: Timestamp has its own struct entry with secs + nanos (4B each)", () =>
{
    // Timestamp is matched independently (pStar re-dispatch) —
    // its shape is in its own result entry.
    const tsNode = child(g.root, {field: "timestamp"})!
    const s = result.get(tsNode.id)! as WireStructFields
    assertKind(s, "struct")
    assert.equal(s.fields.length, 2)
    assert.equal(s.fields[0].name, "secs")
    assert.equal((s.fields[0].shape as WireFixed).size, 4)
    assert.equal(s.fields[1].name, "nanos")
    assert.equal((s.fields[1].shape as WireFixed).size, 4)
})

// ——————————————————————————————————————————————
// SensorKind — all-unit union → tagged, variants all 0 bytes
// ——————————————————————————————————————————————

test("wire: SensorKind is a tagged union with 3 variants", () =>
{
    const readingsNode = child(g.root, {field: "readings"})!
    const readingNode = child(readingsNode, {element: true})!
    const sensorNode = child(readingNode, {field: "sensor"})!
    const s = result.get(sensorNode.id)! as WireTagged

    assert.equal(Object.keys(s.variants).length, 3)
    assert.ok("temperature" in s.variants)
    assert.ok("humidity" in s.variants)
    assert.ok("pressure" in s.variants)
})

test("wire: SensorKind variants are all 0-byte fixed (unit)", () =>
{
    const readingsNode = child(g.root, {field: "readings"})!
    const readingNode = child(readingsNode, {element: true})!
    const sensorNode = child(readingNode, {field: "sensor"})!
    const s = result.get(sensorNode.id)! as WireTagged

    for (const [, v] of Object.entries(s.variants))
    {
        assertKind(v, "fixed")
        assert.equal((v as WireFixed).size, 0)
    }
})

// ——————————————————————————————————————————————
// SensorReading
// ——————————————————————————————————————————————

test("wire: SensorReading has 3 fields with correct names", () =>
{
    const readingsNode = child(g.root, {field: "readings"})!
    const readingNode = child(readingsNode, {element: true})!
    const s = result.get(readingNode.id)! as WireStructFields

    assert.equal(s.fields.length, 3)
    assert.equal(s.fields[0].name, "sensor")
    assert.equal(s.fields[1].name, "value")
    assert.equal(s.fields[2].name, "unit")

    // Primitives are inlined: value (i16 = 2B), unit (u8 = 1B)
    assert.equal((s.fields[1].shape as WireFixed).size, 2)
    assert.equal((s.fields[2].shape as WireFixed).size, 1)

    // sensor is a union — re-dispatched by pStar, real shape in its own entry
    const sensorNode = child(readingNode, {field: "sensor"})!
    const sensorShape = result.get(sensorNode.id)!
    assertKind(sensorShape, "tagged")
})
