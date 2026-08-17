/**
 * Compiled JS codec integration test.
 *
 * `codec.test.ts` exercises the INTERPRETED path (`run()` +
 * `createCodecExtension`, an `RtlProgram` walked at every call). This file
 * exercises the other one: `jsCodecModule` (`compose.ts`) is the literal
 * compiled TypeScript source `@ppl/target-js`'s `generateCodecModule`
 * produces for this exact schema — real `encode_procN`/`decode_procN`
 * functions, not a program interpreted at runtime. Writing it to a real
 * file and `require()`-ing it back (mirroring `@ppl/target-js`'s own
 * `test/load-generated.ts`) is the only way to actually run it — a
 * generated function only exists once its source has been compiled, same
 * as `codec-module.ts`'s own doc comment says.
 *
 * `npm run generate` writes this same `jsCodecModule` string to the
 * committed, human-readable `generated/telemetry-packet.codec.ts` — this
 * file writes its own throwaway copy to a gitignored scratch directory
 * purely so `require()` has a real path, independent of whether `generate`
 * was ever run.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import {test} from "node:test"
import * as assert from "node:assert/strict"

import {jsCodecModule, encodedSample} from "../src/compose"

const SCRATCH_DIR = path.join(__dirname, ".codegen-scratch")
fs.mkdirSync(SCRATCH_DIR, {recursive: true})
const scratchFile = path.join(SCRATCH_DIR, "telemetry-packet.codec.ts")
fs.writeFileSync(scratchFile, jsCodecModule)
const compiled: {
    encodeTelemetryPacket: (v: unknown) => Uint8Array
    decodeTelemetryPacket: (b: Uint8Array) => unknown
} = require(scratchFile)

// The compiled path's default TS projection (`tsTypeRules`'s
// `unionFieldsRule`) represents this schema's all-unit `SensorKind` union
// as a bare string ("temperature") — the interpreted path's sample data
// uses `codec-extension.ts`'s own Handle-based `{variant, value}` shape
// instead (see `compose.ts`'s own `sampleTelemetryPacket`). Same wire
// bytes either way — only the *local* JS representation differs — so
// this is the compiled-path-shaped equivalent of that same sample.
const compiledSample = {
    deviceId: 42,
    timestamp: {secs: 1_700_000_000, nanos: 123_456_789},
    readings: [
        {sensor: "temperature", value: 235, unit: 1},
        {sensor: "humidity", value: 55, unit: 2},
    ],
    acoustic: [1000, -1000, 32767],
    status: 0,
}

test("js-codegen: the compiled module exports a real encode/decode pair", () =>
{
    assert.equal(typeof compiled.encodeTelemetryPacket, "function")
    assert.equal(typeof compiled.decodeTelemetryPacket, "function")
})

test("js-codegen: compiled encode agrees byte-for-byte with the interpreted path", () =>
{
    const bytes = compiled.encodeTelemetryPacket(compiledSample)
    assert.deepEqual(Array.from(bytes), encodedSample)
})

test("js-codegen: compiled decode round-trips its own (bare-string-union) representation", () =>
{
    const bytes = compiled.encodeTelemetryPacket(compiledSample)
    assert.deepEqual(compiled.decodeTelemetryPacket(bytes), compiledSample)
})

test("js-codegen: round-trips through the compiled path alone, every SensorKind variant", () =>
{
    for(const kind of ["temperature", "humidity", "pressure"])
    {
        const packet = {
            deviceId: 1,
            timestamp: {secs: 0, nanos: 0},
            readings: [{sensor: kind, value: -1, unit: 0}],
            acoustic: [-32768, 0, 32767],
            status: 0xFFFF,
        }
        assert.deepEqual(compiled.decodeTelemetryPacket(compiled.encodeTelemetryPacket(packet)), packet)
    }
})

test("js-codegen: the generated source contains real per-procedure functions, not a program to interpret", () =>
{
    assert.ok(jsCodecModule.includes("function encode_proc0("))
    assert.ok(jsCodecModule.includes("function decode_proc0("))
    assert.ok(jsCodecModule.includes("interface TelemetryPacket {"))
    assert.ok(!jsCodecModule.includes("RtlProgram"))
})
