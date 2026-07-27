/**
 * schema.ts — Shared semantic type definitions.
 *
 * This is the SINGLE SOURCE OF TRUTH for the three-way split.
 * Every adapter (embedded C, TS desktop, wire format) projects
 * from these same definitions. Change the schema here and all
 * adapters regenerate consistently.
 *
 * The example models a realistic embedded telemetry packet:
 * sensor readings from an environmental monitoring device.
 */
import {integer, struct, union, unit, list, named} from "@ppl/core"

// ——————————————————————————————————————————————
// Leaf types
// ——————————————————————————————————————————————

/** 32-bit unsigned device identifier. */
export const DeviceID = named("DeviceID", integer(0, 0xFFFFFFFF))

/** Unix-style timestamp with nanosecond precision. */
export const Timestamp = named("Timestamp", struct({
    secs:  integer(0, 0xFFFFFFFF),
    nanos: integer(0, 999_999_999),
}))

/** Sensor kind discriminator — purely symbolic, no payload. */
export const SensorKind = named("SensorKind", union({
    temperature: unit,
    humidity:    unit,
    pressure:    unit,
}))

/** A single sensor reading: what kind, the raw value, and a unit code. */
export const SensorReading = named("SensorReading", struct({
    sensor: SensorKind,
    value:  integer(-32768, 32767),   // i16 — raw sensor ADC / scaled value
    unit:   integer(0, 255),          // u8  — unit-of-measure enum code
}))

/** Unit-of-measure codes (temperature scale, pressure units, etc.). */
export const UnitCode = named("UnitCode", integer(0, 255))

// ——————————————————————————————————————————————
// Top-level packet
// ——————————————————————————————————————————————

/**
 * Telemetry packet sent from an environmental monitor to a gateway.
 *
 * Contains device identity, a timestamp, up to 16 sensor readings,
 * and a 16-bit status bitfield for alarms / flags.
 */
export const TelemetryPacket = named("TelemetryPacket", struct({
    deviceId:  DeviceID,
    timestamp: Timestamp,
    readings:  list(SensorReading, 16),
    status:    integer(0, 0xFFFF),     // u16 bitfield
}))
