/**
 * @ppl/codecs/test — json.ts: encoder-only pretty-printed JSON
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { struct, union, unit, list, i16, u8, buildTypeGraph } from "@ppl/core"
import { validateProgram, run } from "@ppl/machine"

import { buildJsonEncoder } from "../src/json"
import { createCodecExtension } from "../src/codec-extension"

function toJsonText(rootType: Parameters<typeof buildTypeGraph>[0], value: unknown): string
{
    const graph = buildTypeGraph(rootType)
    const program = buildJsonEncoder(graph.root)
    const buffer: number[] = []
    const ext = createCodecExtension("encode", { container: { root: value }, key: "root", type: graph.root }, buffer)
    validateProgram(program, ext)
    assert.equal(run(program, ext).ok, true)
    return Buffer.from(buffer).toString("ascii")
}

describe("buildJsonEncoder", () =>
{
    test("plain non-negative integer", () =>
    {
        assert.equal(toJsonText(u8, 0), "0")
        assert.equal(toJsonText(u8, 42), "42")
        assert.equal(toJsonText(u8, 255), "255")
    })

    test("signed integer: negative, zero, and positive", () =>
    {
        assert.equal(toJsonText(i16, -12345), "-12345")
        assert.equal(toJsonText(i16, 0), "0")
        assert.equal(toJsonText(i16, 32767), "32767")
    })

    test("pretty-printed nested struct", () =>
    {
        const t = struct({ x: u8, y: struct({ a: u8, b: u8 }) })
        const text = toJsonText(t, { x: 1, y: { a: 2, b: 3 } })
        assert.equal(text, [
            "{",
            '  "x": 1,',
            '  "y": {',
            '    "a": 2,',
            '    "b": 3',
            "  }",
            "}",
        ].join("\n"))
    })

    test("list of integers, pretty-printed, including empty", () =>
    {
        const t = list(u8)
        assert.equal(toJsonText(t, [1, 2, 3]), ["[", "  1,", "  2,", "  3", "]"].join("\n"))
        assert.equal(toJsonText(t, []), "[\n]")
    })

    test("all-unit union prints as just its variant name", () =>
    {
        const t = union({ on: unit, off: unit })
        assert.equal(toJsonText(t, { variant: "on", value: undefined }), '"on"')
        assert.equal(toJsonText(t, { variant: "off", value: undefined }), '"off"')
    })

    test("union with real payloads prints as a single-key object", () =>
    {
        const t = union({ a: unit, b: u8 })
        assert.equal(toJsonText(t, { variant: "a", value: undefined }), '{"a": null}')
        assert.equal(toJsonText(t, { variant: "b", value: 7 }), '{"b": 7}')
    })

    test("a realistic composite: struct containing a list of structs containing an all-unit union", () =>
    {
        const sensorKind = union({ temperature: unit, humidity: unit })
        const reading = struct({ kind: sensorKind, value: i16 })
        const packet = struct({ deviceId: u8, readings: list(reading) })

        const text = toJsonText(packet, {
            deviceId: 7,
            readings: [
                { kind: { variant: "temperature", value: undefined }, value: -5 },
                { kind: { variant: "humidity", value: undefined }, value: 60 },
            ],
        })

        assert.equal(text, [
            "{",
            '  "deviceId": 7,',
            '  "readings": [',
            "    {",
            '      "kind": "temperature",',
            '      "value": -5',
            "    },",
            "    {",
            '      "kind": "humidity",',
            '      "value": 60',
            "    }",
            "  ]",
            "}",
        ].join("\n"))
    })
})
