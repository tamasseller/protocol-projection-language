/**
 * @ppl/machine/test — `switch`, where a case label is a value
 *
 * `BR_TABLE` indexes by the discriminant (isa-core.md §4.5), so a run of
 * consecutive labels maps onto it directly and anything else does not.
 * `lowerSwitch` therefore groups the labels into runs and chains the
 * groups behind range tests — one dense group being the common case, and
 * the one that costs nothing extra.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { ir } from "../src/ir"
import { lowerProc } from "../src/lower"
import { validateProgram } from "../src/validate"
import { run } from "../src/vm"
import { format } from "../src/rtl"
import type { RtlProgram } from "../src/rtl"

function program(source: string): RtlProgram
{
    const prog: RtlProgram = { procedures: [lowerProc(ir`${source}`.body)] }
    validateProgram(prog)
    return prog
}

const opsOf = (source: string): string[] => program(source).procedures[0]!.body.map(format)

/** Run `switch(x) { <cases> default: return 99; }` with `x = disc`. */
function dispatch(cases: string, disc: number): number
{
    const result = run(program(`u32 x = ${disc}; switch(x) { ${cases} default: return 99; }`))
    assert.ok(result.ok, `x = ${disc}: expected a normal return, got trap ${result.trapCode}`)
    return result.acc >>> 0
}

const countOf = (ops: string[], op: string): number => ops.filter(o => o.startsWith(op)).length

describe("switch — a label is a value", () =>
{
    test("consecutive labels from zero index the table directly", () =>
    {
        const cases = "case 0: return 10; case 1: return 11; case 2: return 12;"
        assert.equal(dispatch(cases, 0), 10)
        assert.equal(dispatch(cases, 2), 12)
        assert.equal(dispatch(cases, 3), 99)

        // The shape every codec's variant dispatch produces: no slot for
        // the discriminant, no shift, one table.
        const ops = opsOf(`u32 x = 1; switch(x) { ${cases} default: return 99; }`)
        assert.ok(ops.includes("BR_TABLE 3"), ops.join(" | "))
        assert.equal(countOf(ops, "PUSH"), 1, ops.join(" | "))   // `x` itself
        assert.equal(countOf(ops, "SUB"), 0, ops.join(" | "))
    })

    test("consecutive labels from a non-zero base are shifted", () =>
    {
        const cases = "case 5: return 15; case 6: return 16; case 7: return 17;"
        assert.equal(dispatch(cases, 4), 99)
        assert.equal(dispatch(cases, 5), 15)
        assert.equal(dispatch(cases, 7), 17)
        assert.equal(dispatch(cases, 8), 99)

        assert.ok(opsOf(`u32 x = 5; switch(x) { ${cases} default: return 99; }`).includes("SUB #5"))
    })

    test("source order does not matter", () =>
    {
        const cases = "case 2: return 12; case 0: return 10; case 1: return 11;"
        assert.equal(dispatch(cases, 0), 10)
        assert.equal(dispatch(cases, 1), 11)
        assert.equal(dispatch(cases, 2), 12)
    })

    test("a single label", () =>
    {
        assert.equal(dispatch("case 7: return 70;", 7), 70)
        assert.equal(dispatch("case 7: return 70;", 8), 99)
    })

    test("with no default, an unmatched value leaves the switch", () =>
        assert.equal(run(program(
            "u32 x = 9; u32 r = 0; switch(x) { case 0: r = 1; case 9: r = 2; } return r;")).acc, 2))
})

describe("switch — grouping", () =>
{
    test("a small gap stays in one table, filled with empty cases", () =>
    {
        const cases = "case 0: return 10; case 3: return 13;"
        assert.equal(dispatch(cases, 0), 10)
        assert.equal(dispatch(cases, 1), 99)
        assert.equal(dispatch(cases, 3), 13)

        const ops = opsOf(`u32 x = 0; switch(x) { ${cases} default: return 99; }`)
        assert.equal(countOf(ops, "BR_TABLE"), 1, ops.join(" | "))
        assert.ok(ops.includes("BR_TABLE 4"), ops.join(" | "))
    })

    // The whole grouping rule: a gap costs one byte per missing label, a
    // chain link costs CHAIN_LINK_BYTES (lower.ts). These two probes sit on
    // either side of that line.
    test("a gap of 7 is cheaper to fill than to branch around", () =>
    {
        const ops = opsOf("u32 x = 0; switch(x) { case 0: return 1; case 8: return 2; default: return 99; }")
        assert.equal(countOf(ops, "BR_TABLE"), 1, ops.join(" | "))
    })

    test("a gap of 8 is not", () =>
    {
        const ops = opsOf("u32 x = 0; switch(x) { case 0: return 1; case 9: return 2; default: return 99; }")
        assert.equal(countOf(ops, "BR_TABLE"), 2, ops.join(" | "))
    })

    test("far-apart labels become a compare chain", () =>
    {
        const cases = "case 1: return 11; case 100: return 20; case 1000: return 30;"
        assert.equal(dispatch(cases, 1), 11)
        assert.equal(dispatch(cases, 100), 20)
        assert.equal(dispatch(cases, 1000), 30)
        assert.equal(dispatch(cases, 7), 99)
        assert.equal(dispatch(cases, 0), 99)

        // Three lone labels: a test each, and no table wider than one.
        const ops = opsOf(`u32 x = 1; switch(x) { ${cases} default: return 99; }`)
        assert.equal(countOf(ops, "NE"), 2, ops.join(" | "))
    })

    test("clusters chain, and each cluster is a table", () =>
    {
        const cases = "case 10: return 1; case 11: return 2; case 12: return 3; case 500: return 4; case 501: return 5;"
        assert.equal(dispatch(cases, 10), 1)
        assert.equal(dispatch(cases, 12), 3)
        assert.equal(dispatch(cases, 13), 99)
        assert.equal(dispatch(cases, 500), 4)
        assert.equal(dispatch(cases, 501), 5)
        assert.equal(dispatch(cases, 502), 99)

        const ops = opsOf(`u32 x = 10; switch(x) { ${cases} default: return 99; }`)
        assert.ok(ops.includes("BR_TABLE 3"), ops.join(" | "))
        assert.ok(ops.includes("BR_TABLE 2"), ops.join(" | "))
    })

    test("labels at the edges of the word do not build a table between them", () =>
    {
        const cases = "case 0: return 1; case 4294967295: return 2;"
        assert.equal(dispatch(cases, 0), 1)
        assert.equal(dispatch(cases, 4294967295), 2)
        assert.equal(dispatch(cases, 5), 99)
    })

    // A case body is a statement list, not a block (isa-core.md §10.3
    // excludes bare blocks), and it gets a scope of its own all the same.
    test("a case body runs its own statements and locals", () =>
        assert.equal(run(program(
            "u32 x = 100; switch(x) { case 0: return 1; case 100: u32 t = 6; return t * 7; default: return 99; }")).acc, 42))
})

describe("switch — rejected shapes", () =>
{
    test("a duplicate label", () =>
        assert.throws(() => program("u32 x = 0; switch(x) { case 1: return 1; case 1: return 2; }"),
            /Duplicate switch case label 1/))

    test("an empty case body, which would be a fallthrough in C", () =>
        assert.throws(() => program("u32 x = 0; switch(x) { case 0: case 1: return 1; }"),
            /Empty body for case 0/))

    test("a label that is not an integer literal", () =>
        assert.throws(() => program("u32 x = 0; u32 y = 1; switch(x) { case y: return 1; }"),
            /must be an integer literal/))

    test("two default clauses", () =>
        assert.throws(() => program("u32 x = 0; switch(x) { case 0: return 1; default: return 2; default: return 3; }"),
            /more than one default/))

    test("no cases at all", () =>
        assert.throws(() => program("u32 x = 0; switch(x) { default: return 2; }"),
            /at least one case/))
})
