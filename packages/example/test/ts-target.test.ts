/**
 * TS target integration test.
 *
 * Verifies that the GENERIC TypeScript projection from @ppl/target-js,
 * when COMPOSED over this project's schema (via compose.ts), produces
 * the correct desktop/server type declarations.
 */
import {test} from "node:test"
import * as assert from "node:assert/strict"

import {child} from "@ppl/core"
import {graph as g, tsTypes as result, tsDeclarations as output} from "../src/compose"

// ——————————————————————————————————————————————
// Root
// ——————————————————————————————————————————————

test("ts-target: TelemetryPacket is an interface", () =>
{
    const decl = result.get(g.root.id)!
    assert.ok(decl.decl!.includes("interface TelemetryPacket {"))
})

test("ts-target: TelemetryPacket has deviceId: number", () =>
{
    assert.ok(result.get(g.root.id)!.decl!.includes("deviceId: number;"))
})

test("ts-target: TelemetryPacket has timestamp: Timestamp", () =>
{
    assert.ok(result.get(g.root.id)!.decl!.includes("timestamp: Timestamp;"))
})

test("ts-target: TelemetryPacket has readings as SensorReading[]", () =>
{
    assert.ok(result.get(g.root.id)!.decl!.includes("readings: SensorReading[];"))
})

test("ts-target: TelemetryPacket has acoustic as number[]", () =>
{
    assert.ok(result.get(g.root.id)!.decl!.includes("acoustic: number[];"))
})

test("ts-target: TelemetryPacket has status: number", () =>
{
    assert.ok(result.get(g.root.id)!.decl!.includes("status: number;"))
})

// ——————————————————————————————————————————————
// Timestamp
// ——————————————————————————————————————————————

test("ts-target: Timestamp is an interface with secs and nanos", () =>
{
    const tsNode = child(g.root, {field: "timestamp"})!
    const decl = result.get(tsNode.id)!.decl!
    assert.ok(decl.includes("interface Timestamp {"))
    assert.ok(decl.includes("secs: number;"))
    assert.ok(decl.includes("nanos: number;"))
})

// ——————————————————————————————————————————————
// SensorKind — all-unit union → string literal union
// ——————————————————————————————————————————————

test("ts-target: SensorKind is a string literal union (all-unit)", () =>
{
    const readingsNode = child(g.root, {field: "readings"})!
    const readingNode = child(readingsNode, {element: true})!
    const sensorNode = child(readingNode, {field: "sensor"})!
    const decl = result.get(sensorNode.id)!.decl!

    assert.ok(decl.includes("type SensorKind = "))
    assert.ok(decl.includes('"temperature"'))
    assert.ok(decl.includes('"humidity"'))
    assert.ok(decl.includes('"pressure"'))
})

// ——————————————————————————————————————————————
// SensorReading
// ——————————————————————————————————————————————

test("ts-target: SensorReading is an interface", () =>
{
    const readingsNode = child(g.root, {field: "readings"})!
    const readingNode = child(readingsNode, {element: true})!
    const decl = result.get(readingNode.id)!.decl!
    assert.ok(decl.includes("interface SensorReading {"))
    assert.ok(decl.includes("sensor: SensorKind;"))
    assert.ok(decl.includes("value: number;"))
    assert.ok(decl.includes("unit: number;"))
})

// ——————————————————————————————————————————————
// Full output
// ——————————————————————————————————————————————

test("ts-target: emitTSDeclarations includes all named types", () =>
{
    assert.ok(output.includes("interface Timestamp"))
    assert.ok(output.includes("type SensorKind"))
    assert.ok(output.includes("interface SensorReading"))
    assert.ok(output.includes("interface TelemetryPacket"))
})
