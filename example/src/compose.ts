/**
 * compose.ts — The composition layer.
 *
 * It takes the SHARED semantic schema (this project's only real asset)
 * and COMPOSES the generic projection packages over it to produce
 * independent artifacts:
 *
 *   ┌─────────────┐      buildCodec        ┌──────────────┐
 *   │  schema.ts  │ ─────────────────────▶ │  encode/     │
 *   │ (semantic)  │                         │  decode      │
 *   │             │      tsTypeRules       ├──────────────┤
 *   │             │ ─────────────────────▶ │  TS decls    │
 *   └─────────────┘                         └──────────────┘
 *
 * The example owns NOTHING generic here — no rulesets, no emitters;
 * every projection above comes from `ppl` as an ordinary dependency.
 * It only:
 *   1. Defines the domain schema (schema.ts).
 *   2. Builds the shared type graph once.
 *   3. Applies each package's projection to that single graph.
 *
 * Change the schema → every artifact regenerates consistently.
 * Swap a package → only that artifact changes. This is composition.
 */
import {buildTypeGraph, TypeGraph, buildCodec, buildJsonEncoder, createCodecExtension,
    binaryEncodeRules, binaryDecodeRules, Handle, CodecExtInstr,
    projectTSTypes, emitTSDeclarations, tsTypeRules, TSTypeDecl, generateCodecModule} from "ppl"
import {validateProgram, run, RtlProgram} from "mog-core"

import {TelemetryPacket} from "./schema"

// ——————————————————————————————————————————————
// Shared foundation (built once, reused by every projection)
// ——————————————————————————————————————————————

/** The finitized type graph for TelemetryPacket. */
export const graph: TypeGraph = buildTypeGraph(TelemetryPacket)

// ——————————————————————————————————————————————
// Composed artifacts
// ——————————————————————————————————————————————

/**
 * Real binary codecs generated from the schema — one program per
 * direction (docs/codec-extension.md §2.3: direction is a property of
 * the whole program, so an encoder and a decoder are two programs, never
 * one bidirectional call graph), sharing nothing but `TelemetryPacket`
 * itself (which of `binaryEncodeRules`/`binaryDecodeRules` runs is what
 * actually picks the direction now — see binary-rules.ts).
 */
export const encodeProgram: RtlProgram<CodecExtInstr> = buildCodec(TelemetryPacket, binaryEncodeRules, undefined)
export const decodeProgram: RtlProgram<CodecExtInstr> = buildCodec(TelemetryPacket, binaryDecodeRules, undefined)

function runCodec(program: RtlProgram<CodecExtInstr>, ext: ReturnType<typeof createCodecExtension>): void
{
    validateProgram(program, ext)
    const result = run(program, ext)
    if(!result.ok) throw new Error(`codec run failed — trap code ${result.trapCode}`)
}

export function encodeTelemetryPacket(value: unknown): number[]
{
    const buffer: number[] = []
    const root: Handle = {container: {root: value}, key: "root", type: graph.root}
    runCodec(encodeProgram, createCodecExtension("encode", root, buffer))
    return buffer
}

export function decodeTelemetryPacket(buffer: readonly number[]): unknown
{
    const wrapper: Record<string, unknown> = {root: {}} // pre-seed — the root type is a struct
    const root: Handle = {container: wrapper, key: "root", type: graph.root}
    runCodec(decodeProgram, createCodecExtension("decode", root, [...buffer]))
    return wrapper.root
}

/** A representative packet, round-tripped through the generated codecs —
 *  the same schema exercising nested struct (`timestamp`), a capacity-16
 *  list of structs (`readings`), and a 3-variant all-unit union
 *  (`SensorKind`) at once, none of it authored with this integration in
 *  mind (schema.ts predates the codec extension entirely). */
export const sampleTelemetryPacket = {
    deviceId: 42,
    timestamp: {secs: 1_700_000_000, nanos: 123_456_789},
    readings: [
        {sensor: {variant: "temperature", value: undefined}, value: 235, unit: 1},
        {sensor: {variant: "humidity", value: undefined}, value: 55, unit: 2},
    ],
    acoustic: [1000, -1000, 32767],
    status: 0,
}

export const encodedSample: number[] = encodeTelemetryPacket(sampleTelemetryPacket)
export const decodedSample: unknown = decodeTelemetryPacket(encodedSample)

/** Pretty-printed JSON of the same schema, from the same `graph.root` —
 *  encoder-only (json.ts's own file header), demonstrating the codec
 *  model isn't binary-only any more than it's bidirectional-only. */
export const jsonProgram: RtlProgram<CodecExtInstr> = buildJsonEncoder(TelemetryPacket)

export function toJson(value: unknown): string
{
    const buffer: number[] = []
    const root: Handle = {container: {root: value}, key: "root", type: graph.root}
    runCodec(jsonProgram, createCodecExtension("encode", root, buffer))
    return Buffer.from(buffer).toString("ascii")
}

export const jsonSample: string = toJson(sampleTelemetryPacket)

/** TypeScript declarations (desktop/server) projected from the schema. */
export const tsTypes: Map<number, TSTypeDecl> = projectTSTypes(TelemetryPacket, tsTypeRules)
export const tsDeclarations: string = emitTSDeclarations(tsTypes)

/**
 * The literal compiled TypeScript source for this schema's encode/decode
 * pair — real `encode_proc0`/`decode_proc0` functions
 * (`generateCodecModule`), not the interpreted `RtlProgram` + `run()` path
 * `encodeTelemetryPacket`/`decodeTelemetryPacket` above use. Reuses the
 * same `encodeProgram`/`decodeProgram` this file already built — nothing
 * about compilation rebuilds them. `src/generate.ts` (`npm run generate`)
 * writes this — and `tsDeclarations` — to real files under
 * `generated/`, so the actual generated code can be opened and read
 * directly, not just asserted against in tests.
 */
export const jsCodecModule: string = generateCodecModule({
    name: "TelemetryPacket",
    rootType: TelemetryPacket,
    encodeProgram,
    decodeProgram,
})
