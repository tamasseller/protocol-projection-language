/**
 * TS type projection tests.
 */
import {test} from "node:test"
import * as assert from "node:assert/strict"

import {TelemetryPacket} from "../src/schema"
import {buildTypeGraph, child} from "@ppl/core"
import {extractTraits} from "@ppl/core"
import {projectTSTypes, emitTSDeclarations} from "../src/ts-adapter/ts-types"

const g = buildTypeGraph(TelemetryPacket)
const traits = extractTraits(g)
const result = projectTSTypes(g, traits)
const output = emitTSDeclarations(result)

// ——————————————————————————————————————————————
// Root
// ——————————————————————————————————————————————

test("ts-types: TelemetryPacket is an interface", () =>
{
    const decl = result.get(g.root.id)!
    assert.ok(decl.decl!.includes("interface TelemetryPacket {"))
})

test("ts-types: TelemetryPacket has deviceId: number", () =>
{
    assert.ok(result.get(g.root.id)!.decl!.includes("deviceId: number;"))
})

test("ts-types: TelemetryPacket has timestamp: Timestamp", () =>
{
    assert.ok(result.get(g.root.id)!.decl!.includes("timestamp: Timestamp;"))
})

test("ts-types: TelemetryPacket has readings as SensorReading[]", () =>
{
    assert.ok(result.get(g.root.id)!.decl!.includes("readings: SensorReading[];"))
})

test("ts-types: TelemetryPacket has status: number", () =>
{
    assert.ok(result.get(g.root.id)!.decl!.includes("status: number;"))
})

// ——————————————————————————————————————————————
// Timestamp
// ——————————————————————————————————————————————

test("ts-types: Timestamp is an interface with secs and nanos", () =>
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

test("ts-types: SensorKind is a string literal union (all-unit)", () =>
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

test("ts-types: SensorReading is an interface", () =>
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

test("ts-types: emitTSDeclarations includes all named types", () =>
{
    assert.ok(output.includes("interface Timestamp"))
    assert.ok(output.includes("type SensorKind"))
    assert.ok(output.includes("interface SensorReading"))
    assert.ok(output.includes("interface TelemetryPacket"))
})
