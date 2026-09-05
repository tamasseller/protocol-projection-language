/**
 * Differential test: `codec-codegen.ts`'s `binaryOpToJs`/`unaryOpToJs`
 * (inline JS text — production-safe, since generated code must not
 * depend on `mog-core`'s `vm.ts`, an interpreter "designed as an
 * oracle for testing", not a runtime dependency) against `mog-core`'s
 * own `evalBinary`/`evalUnary` (the oracle — fine to import here, this is
 * a test file, never embedded in generated output). Same shape as
 * `raise.ts`'s own test suite's differential check against these exact
 * functions, per `vm.ts`'s own doc comment on why they're exported.
 *
 * Run via: npm test
 */
import {test} from "node:test"
import * as assert from "node:assert/strict"

import type {BinaryOpcode, UnaryOpcode} from "mog-core"
import {evalBinary, evalUnary, SHIFT_OPS} from "mog-core"
import {binaryOpToJs, unaryOpToJs} from "../src/engine/codec-codegen"
import {revBits} from "../src/runtime/codec-runtime"
import {buildCodec, binaryEncodeRules, binaryDecodeRules} from "@ppl/codecs"
import {generateCodecModule} from "../src/engine/codec-module"
import {tsTypeRules} from "../src/components/ts-emitter"
import {named, list, integer} from "@ppl/core"

const BINARY_OPS: readonly BinaryOpcode[] = [
    "ADD", "SUB", "RSUB", "MUL", "AND", "OR", "XOR", "SHL", "SHR", "ASR",
    "EQ", "NE", "LT_S", "LE_S", "GT_S", "GE_S", "LT_U", "LE_U", "GT_U", "GE_U",
]
const UNARY_OPS: readonly UnaryOpcode[] = ["NEG", "NOT", "CLZ", "REVBITS"]

// Representative matrix: zero/one/small values, the full-uint32 pattern
// (0xFFFFFFFF), and the signed/unsigned boundary pair (0x7FFFFFFF /
// 0x80000000) — enough to distinguish a signed comparison/wrap bug from
// an unsigned one.
//
// The values >= 32 still appear, and are still used as shift *amounts* —
// but only as the left operand there. isa-core.md §4.1 leaves a shift by
// 32 or more unspecified, so `evalBinary` refuses to produce a value for
// one (`UnspecifiedShiftAmount`) and there is nothing for this projection
// to match: `binaryOpToJs` renders a `<<`, JS masks it to five bits, and
// that is one legal answer among several rather than the answer. Skipped
// rather than deleted from VALUES, so the *left* operand still sweeps the
// whole matrix against every shift amount that is specified.
const VALUES: readonly number[] = [0, 1, 2, 5, 31, 32, 33, 0x7FFFFFFF, 0x80000000, 0xFFFFFFFF, 100, 1000]

function evalRendered(rendered: string, args: Record<string, number>): number
{
    const names = Object.keys(args)
    // eslint-disable-next-line no-new-func
    const fn = new Function(...names, `return (${rendered});`)
    return fn(...names.map(n => args[n]))
}

for(const op of BINARY_OPS)
{
    test(`binaryOpToJs("${op}") matches evalBinary across the value matrix`, () =>
    {
        for(const L of VALUES)
        {
            for(const R of VALUES)
            {
                // See the VALUES comment: unspecified, so not this
                // projection's to agree on.
                if(SHIFT_OPS.has(op) && (R >>> 0) > 31) continue

                const rendered = binaryOpToJs(op, "L", "R")
                const actual = evalRendered(rendered, {L, R})
                const expected = evalBinary(L, R, op)
                assert.equal(actual, expected, `${op}(${L}, ${R}): rendered "${rendered}" gave ${actual}, evalBinary gave ${expected}`)
            }
        }
    })
}

for(const op of UNARY_OPS)
{
    test(`unaryOpToJs("${op}") matches evalUnary across the value matrix`, () =>
    {
        for(const V of VALUES)
        {
            const rendered = unaryOpToJs(op, "V")
            const actual = op === "REVBITS"
                ? new Function("V", "revBits", `return (${rendered});`)(V, revBits)
                : evalRendered(rendered, {V})
            const expected = evalUnary(V, op)
            assert.equal(actual, expected, `${op}(${V}): rendered "${rendered}" gave ${actual}, evalUnary gave ${expected}`)
        }
    })
}

test("revBits matches evalUnary's REVBITS directly", () =>
{
    for(const V of VALUES)
    {
        assert.equal(revBits(V), evalUnary(V, "REVBITS"))
    }
})

test("compiled codec output never references evalBinary/evalUnary (the test oracle)", () =>
{
    const T = named("Samples", list(integer(0, 255), 4))
    const encodeProgram = buildCodec(T, binaryEncodeRules, undefined)
    const decodeProgram = buildCodec(T, binaryDecodeRules, undefined)
    const source = generateCodecModule({name: "Samples", rootType: T, encodeProgram, decodeProgram, rules: tsTypeRules})

    assert.ok(!source.includes("evalBinary"), "generated source must not call evalBinary")
    assert.ok(!source.includes("evalUnary"), "generated source must not call evalUnary")
    assert.ok(!source.includes("mog-core"), "generated source must not import mog-core at all")
})
