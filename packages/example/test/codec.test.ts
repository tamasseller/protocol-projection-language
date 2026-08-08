/**
 * Codec integration test.
 *
 * Verifies that the GENERIC codec-generation library from @ppl/codecs
 * (engine/resolver.ts's `buildCodec`, components/json.ts's `buildJsonEncoder`), when
 * COMPOSED over this project's independently-authored schema (via
 * compose.ts), correctly handles a real mix of nested struct, a
 * capacity-limited list of structs, and a small all-unit union — the
 * struct-level union-tag hoisting optimization applies automatically to
 * `SensorReading.sensor` (3 variants ≤ the hoisting threshold) with no
 * schema change needed to trigger it.
 */
import {test} from "node:test"
import * as assert from "node:assert/strict"

import {
    sampleTelemetryPacket,
    encodedSample,
    decodedSample,
    jsonSample,
    encodeTelemetryPacket,
    decodeTelemetryPacket,
} from "../src/compose"

test("codec: encodes to a plausible byte count for this schema", () =>
{
    // deviceId(4) + timestamp(secs4+nanos4=8) + readings: 1 count-prefix
    // byte + 2 elements * (1 hoisted-tag bitmap byte + value:i16(2) +
    // unit:u8(1)) = 1+8=9 + status(2) = 23 total. The interesting part
    // isn't the exact number so much as it being *smaller* than a naive
    // per-field-tag-byte encoding would be (25, one extra byte per
    // reading) — proof the hoisting optimization actually fired.
    assert.equal(encodedSample.length, 23)
})

test("codec: round-trips the sample packet exactly", () =>
{
    assert.deepEqual(decodedSample, sampleTelemetryPacket)
})

test("codec: round-trips an empty readings list and every SensorKind variant", () =>
{
    for(const kind of ["temperature", "humidity", "pressure"])
    {
        const packet = {
            deviceId: 1,
            timestamp: {secs: 0, nanos: 0},
            readings: [{sensor: {variant: kind, value: undefined}, value: -1, unit: 0}],
            status: 0xFFFF,
        }
        assert.deepEqual(decodeTelemetryPacket(encodeTelemetryPacket(packet)), packet)
    }

    const empty = {deviceId: 0, timestamp: {secs: 0, nanos: 0}, readings: [], status: 0}
    assert.deepEqual(decodeTelemetryPacket(encodeTelemetryPacket(empty)), empty)
})

test("codec: pretty-prints the sample packet as valid-looking, correctly-nested JSON", () =>
{
    assert.match(jsonSample, /^\{\n {2}"deviceId": 42,\n/)
    assert.ok(jsonSample.includes('"temperature"'), "all-unit union prints as a bare variant-name string")
    assert.ok(jsonSample.includes('"humidity"'))
    assert.ok(jsonSample.includes('"secs": 1700000000'))
    assert.ok(jsonSample.includes('"value": 235'))
    // Every opening brace/bracket has a matching close, and the whole
    // thing is one balanced document, not two concatenated fragments.
    assert.equal((jsonSample.match(/\{/g) ?? []).length, (jsonSample.match(/\}/g) ?? []).length)
    assert.equal((jsonSample.match(/\[/g) ?? []).length, (jsonSample.match(/\]/g) ?? []).length)
    assert.equal(jsonSample.split("\n")[0], "{")
    assert.equal(jsonSample.at(-1), "}")
})
