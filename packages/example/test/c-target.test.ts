/**
 * C target integration test.
 *
 * Verifies that the GENERIC C projection from @ppl/target-cpp, when
 * COMPOSED over this project's schema (via compose.ts), produces the
 * correct bare-metal C header — no STL, fixed arrays, manual tagged
 * unions.
 */
import {test} from "node:test"
import * as assert from "node:assert/strict"

import {child} from "@ppl/core"
import {graph as g, cTypes as result, cHeader as header} from "../src/compose"

// ——————————————————————————————————————————————
// No STL
// ——————————————————————————————————————————————

test("c-target: no STL types appear in the output", () =>
{
    assert.ok(!header.includes("std::"))
    assert.ok(!header.includes("vector"))
    assert.ok(!header.includes("variant"))
    assert.ok(!header.includes("optional"))
    assert.ok(!header.includes("<vector>"))
    assert.ok(!header.includes("<variant>"))
    assert.ok(!header.includes("<optional>"))
})

test("c-target: includes only stdint.h", () =>
{
    assert.ok(header.includes("#include <stdint.h>"))
})

// ——————————————————————————————————————————————
// Root struct: TelemetryPacket
// ——————————————————————————————————————————————

test("c-target: TelemetryPacket is a typedef struct", () =>
{
    const decl = result.get(g.root.id)!
    assert.equal(decl.ref, "TelemetryPacket")
    assert.ok(decl.decl!.includes("typedef struct TelemetryPacket {"))
    assert.ok(decl.decl!.includes("} TelemetryPacket;"))
})

test("c-target: TelemetryPacket has deviceId as uint32_t", () =>
{
    assert.ok(result.get(g.root.id)!.decl!.includes("uint32_t deviceId;"))
})

test("c-target: TelemetryPacket has timestamp as named struct", () =>
{
    assert.ok(result.get(g.root.id)!.decl!.includes("Timestamp timestamp;"))
})

test("c-target: TelemetryPacket has readings as fixed array + count", () =>
{
    const decl = result.get(g.root.id)!.decl!
    assert.ok(decl.includes("SensorReading readings[16];"), "missing readings array")
    assert.ok(decl.includes("uint8_t readings_count;"), "missing readings count")
})

test("c-target: TelemetryPacket has status as uint16_t", () =>
{
    assert.ok(result.get(g.root.id)!.decl!.includes("uint16_t status;"))
})

// ——————————————————————————————————————————————
// Nested struct: Timestamp
// ——————————————————————————————————————————————

test("c-target: Timestamp is a typedef struct", () =>
{
    const tsNode = child(g.root, {field: "timestamp"})!
    const decl = result.get(tsNode.id)!
    assert.ok(decl.decl!.includes("typedef struct Timestamp {"))
})

test("c-target: Timestamp has uint32_t secs and nanos", () =>
{
    const tsNode = child(g.root, {field: "timestamp"})!
    const decl = result.get(tsNode.id)!.decl!
    assert.ok(decl.includes("uint32_t secs;"))
    assert.ok(decl.includes("uint32_t nanos;"))
})

// ——————————————————————————————————————————————
// SensorKind — all-unit union → just a tag
// ——————————————————————————————————————————————

test("c-target: SensorKind is a tagged union with no data union", () =>
{
    const readingsNode = child(g.root, {field: "readings"})!
    const readingNode = child(readingsNode, {element: true})!
    const sensorNode = child(readingNode, {field: "sensor"})!
    const decl = result.get(sensorNode.id)!

    assert.ok(decl.decl!.includes("typedef struct SensorKind {"))
    assert.ok(decl.decl!.includes("uint8_t tag;"))
    // All variants are unit → no `union {` block needed
    assert.ok(!decl.decl!.includes("union {"))
})

// ——————————————————————————————————————————————
// SensorReading
// ——————————————————————————————————————————————

test("c-target: SensorReading has sensor, value, unit fields", () =>
{
    const readingsNode = child(g.root, {field: "readings"})!
    const readingNode = child(readingsNode, {element: true})!
    const decl = result.get(readingNode.id)!.decl!
    assert.ok(decl.includes("SensorKind sensor;"))
    assert.ok(decl.includes("int16_t value;"))
    assert.ok(decl.includes("uint8_t unit;"))
})

// ——————————————————————————————————————————————
// Full header emission
// ——————————————————————————————————————————————

test("c-target: emitCHeader includes all named struct/union types", () =>
{
    // DeviceID is just an integer → inline uint32_t, no typedef struct.
    // Only check the types that actually produce declarations.
    assert.ok(header.includes("typedef struct Timestamp"))
    assert.ok(header.includes("typedef struct SensorKind"))
    assert.ok(header.includes("typedef struct SensorReading"))
    assert.ok(header.includes("typedef struct TelemetryPacket"))
})

test("c-target: header has forward declarations before definitions", () =>
{
    const fwdIdx = header.indexOf("typedef struct TelemetryPacket TelemetryPacket;")
    const defIdx = header.indexOf("typedef struct TelemetryPacket {")
    assert.ok(fwdIdx >= 0 && defIdx >= 0)
    assert.ok(fwdIdx < defIdx, "forward declaration must precede definition")
})
