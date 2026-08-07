/**
 * @ppl/codecs/test — a rule that overrides representation, not just adds one
 *
 * Demonstrates the point raised in review directly: rule-based dispatch
 * isn't just "one more leaf kind" (an N+1th `SemanticTypeKinds` case) — a
 * rule can intercept a *specific struct shape* and emit something
 * structurally unrelated to what the default struct rule would, exactly
 * the way `target-cpp`'s optional-union rule (cpp-emitter.ts:164-168)
 * preempts the generic union rule for a specific shape.
 *
 * `iso8601Rule` matches the `Timestamp` shape already used in
 * `packages/example`'s own schema (`{secs, nanos}`) and, instead of the
 * default struct rule's per-field binary layout, emits a fixed-width
 * ASCII `"1970-01-01THH:MM:SSZ"` string. This is a demo, not a calendar
 * library: the date is a hardcoded placeholder and the time-of-day
 * breakdown (hours/minutes/seconds) only handles `secs` values that fit
 * within a single day — matching-and-embedding is the point being proven,
 * not calendrical correctness. `nanos` is ignored entirely. Decode is
 * intentionally unsupported (`trap`) — this is encode-only by choice, the
 * same way `buildJsonEncoder` is.
 *
 * This stays a test, not a new permanent library export — it's evidence
 * the mechanism supports overriding representation and embedding one
 * convention (ASCII text) inside another (an otherwise binary wire
 * format), not a claim that date formatting belongs in `@ppl/codecs`.
 */
import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { struct, u8, u32, buildTypeGraph } from "@ppl/core"
import { pStruct, pInteger } from "@ppl/core"
import { ir, declareProc, defineProc, validateProgram, run } from "@ppl/machine"

import { buildCodec } from "../src/builders"
import { createCodecExtension } from "../src/codec-extension"
import type { CodecRule } from "../src/rules"
import type { Direction } from "../src/codec-extension"
import { irSeq } from "../src/rules"

const emitLiteral = (s: string): string =>
    Array.from(s).map(ch => `${ch.codePointAt(0)}; write(0, 1);\n`).join("")

/** Matches exactly the `Timestamp` shape (`{secs, nanos}`, both integers) —
 *  `pStruct` (named-field matching) rather than `pStructFields`'s
 *  homogeneous-any-field-type matching, since this must target one
 *  specific struct shape, not every struct. */
const iso8601Rule: CodecRule<Direction> = {
    pattern: pStruct({ secs: pInteger(-Infinity, Infinity), nanos: pInteger(-Infinity, Infinity) }),
    produce: (_m, node, direction) =>
    {
        if(direction === "decode") return ir`trap(1);`

        const secsIndex = node.edges.findIndex(e => "field" in e.step && e.step.field === "secs")

        // Fixed 2-digit zero-padded decimal (0-59) — simpler than
        // json.ts's `emit_decimal` (no variable width, no leading-zero
        // suppression), still no DIV/MOD (ir-engine.md).
        const emit2 = declareProc(["value"])
        defineProc(emit2, ir`
            u32 tens = 0;
            u32 rem = value;
            while (rem >= 10) { rem = rem - 10; tens = tens + 1; }
            tens = tens + 48;
            tens;
            write(0, 1);
            rem = rem + 48;
            rem;
            write(0, 1);
            return;
        `)

        return irSeq([
            emitLiteral("1970-01-01T") +
            `enter(1, 0, ${secsIndex});\n` +
            "u32 total = 0;\n" +
            "total = load_val(1);\n" +
            "u32 h = 0;\n" +
            "while (total >= 3600) { total = total - 3600; h = h + 1; }\n" +
            "u32 m = 0;\n" +
            "while (total >= 60) { total = total - 60; m = m + 1; }\n",
            emit2, "(h);\n" + emitLiteral(":"),
            emit2, "(m);\n" + emitLiteral(":"),
            emit2, "(total);\n" + emitLiteral("Z") + "\nreturn;",
        ])
    },
}

describe("a custom rule can override representation entirely, not just add a leaf kind", () =>
{
    test("a Timestamp-shaped field inside an otherwise-binary struct comes out as an embedded ASCII string", () =>
    {
        const Timestamp = struct({ secs: u32, nanos: u32 })
        const Packet = struct({ id: u8, at: Timestamp })
        const graph = buildTypeGraph(Packet)

        // 12345s = 3h 25m 45s.
        const value = { id: 7, at: { secs: 12345, nanos: 0 } }
        const program = buildCodec(graph.root, "encode", [iso8601Rule])
        const buffer: number[] = []
        const ext = createCodecExtension("encode", { container: { root: value }, key: "root", type: graph.root }, buffer)

        validateProgram(program, ext)
        assert.equal(run(program, ext).ok, true)

        const text = Buffer.from(buffer.slice(1)).toString("ascii") // byte 0 is `id`
        assert.equal(buffer[0], 7)
        assert.equal(text, "1970-01-01T03:25:45Z")
        assert.equal(buffer.length, 1 + 20) // id + the fixed-width timestamp string, no length prefix needed

        // Without the override, the same field would be two little-endian
        // u32s (8 bytes) instead of a 20-byte ASCII string — the rule
        // genuinely changed the wire representation, not just added a
        // case.
        const defaultProgram = buildCodec(graph.root, "encode")
        const defaultBuffer: number[] = []
        const defaultExt = createCodecExtension("encode", { container: { root: value }, key: "root", type: graph.root }, defaultBuffer)
        validateProgram(defaultProgram, defaultExt)
        assert.equal(run(defaultProgram, defaultExt).ok, true)
        assert.equal(defaultBuffer.length, 1 + 8)
    })

    test("decode is intentionally unsupported — the override is encode-only, by choice", () =>
    {
        const Timestamp = struct({ secs: u32, nanos: u32 })
        const graph = buildTypeGraph(Timestamp)

        const program = buildCodec(graph.root, "decode", [iso8601Rule])
        const ext = createCodecExtension("decode", { container: { root: {} }, key: "root", type: graph.root }, [])

        validateProgram(program, ext)
        assert.equal(run(program, ext).ok, false)
    })
})
