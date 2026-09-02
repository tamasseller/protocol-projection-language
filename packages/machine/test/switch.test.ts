/**
 * @ppl/machine/test — `switch`, where a case label is a value
 *
 * `BR_TABLE` indexes by the discriminant (isa-core.md §4.5), so a run of
 * consecutive labels maps onto it directly and anything else does not.
 * `lowerSwitch` therefore groups the labels into runs and puts each group
 * in the previous one's default case — no range test needed, since
 * `case[N]` already means "none of these".
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

    // The whole grouping rule: a gap costs one copy of the default block
    // per missing label, a second table costs CHAIN_LINK_BYTES (lower.ts).
    // With no `default:` clause a gap filler is a lone BLOCK_END, so these
    // two probes sit on either side of that line.
    test("a gap of 6 is cheaper to fill than to start a second table", () =>
    {
        const ops = opsOf("u32 x = 0; switch(x) { case 0: return 1; case 7: return 2; } return 0;")
        assert.equal(countOf(ops, "BR_TABLE"), 1, ops.join(" | "))
    })

    test("a gap of 7 is not", () =>
    {
        const ops = opsOf("u32 x = 0; switch(x) { case 0: return 1; case 8: return 2; } return 0;")
        assert.equal(countOf(ops, "BR_TABLE"), 2, ops.join(" | "))
    })

    // A gap runs the `default:` clause, and `BR_TABLE`'s index is exact
    // below N — so a gap gets its own copy of it, and a substantial one
    // makes filling never worth it.
    test("a real default clause makes gaps expensive", () =>
    {
        const wide = opsOf("u32 x = 0; switch(x) { case 0: return 1; case 4: return 2; default: return 99; }")
        assert.equal(countOf(wide, "BR_TABLE"), 2, wide.join(" | "))

        const narrow = opsOf("u32 x = 0; switch(x) { case 0: return 1; case 2: return 2; default: return 99; }")
        assert.equal(countOf(narrow, "BR_TABLE"), 1, narrow.join(" | "))
    })

    test("far-apart labels become a compare chain", () =>
    {
        const cases = "case 1: return 11; case 100: return 20; case 1000: return 30;"
        assert.equal(dispatch(cases, 1), 11)
        assert.equal(dispatch(cases, 100), 20)
        assert.equal(dispatch(cases, 1000), 30)
        assert.equal(dispatch(cases, 7), 99)
        assert.equal(dispatch(cases, 0), 99)

        // Three lone labels: a one-case dispatch each, nested through
        // each other's default case, and no table wider than one.
        const ops = opsOf(`u32 x = 1; switch(x) { ${cases} default: return 99; }`)
        assert.deepEqual(ops.filter(o => o.startsWith("BR_TABLE")), ["BR_TABLE 1", "BR_TABLE 1", "BR_TABLE 1"], ops.join(" | "))
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

    // `FALLTHROUGH` continues into the case physically next in the table
    // (isa-core.md §4.5), so a shared body has to belong to the next label.
    test("an empty case whose neighbour is not the next label", () =>
    {
        assert.throws(() => program("u32 x = 0; switch(x) { case 0: case 5: return 1; default: return 9; }"),
            /Empty body for case 0: it can only share the body of case 1/)
        assert.throws(() => program("u32 x = 0; switch(x) { case 0: return 1; case 5: default: return 9; }"),
            /Empty body for case 5: it can only share the body of case 6/)
    })

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

// C's `case 0: case 1: X` — one body, several labels. The empty label's
// case is a lone `FALLTHROUGH`, which continues into the next case's body
// instead of leaving the construct (isa-core.md §4.5).
describe("switch — a shared case body", () =>
{
    const shared = "case 0: case 1: return 10; case 2: return 20;"

    test("every sharing label reaches the body", () =>
    {
        assert.equal(dispatch(shared, 0), 10)
        assert.equal(dispatch(shared, 1), 10)
        assert.equal(dispatch(shared, 2), 20)
        assert.equal(dispatch(shared, 7), 99)
    })

    test("the empty case is exactly one FALLTHROUGH", () =>
    {
        const ops = opsOf(`u32 x = 1; switch(x) { ${shared} default: return 99; }`)
        const dispatch = ops.indexOf("BR_TABLE 3")

        assert.ok(dispatch > 0, ops.join(" | "))
        assert.equal(ops[dispatch + 1], "FALLTHROUGH", ops.join(" | "))
        assert.equal(ops.filter(o => o === "FALLTHROUGH").length, 1, ops.join(" | "))
    })

    test("three labels can share one body", () =>
    {
        const three = "case 0: case 1: case 2: return 5;"
        for(const x of [0, 1, 2]) assert.equal(dispatch(three, x), 5)
        assert.equal(dispatch(three, 3), 99)
    })

    test("sharing works inside a compare chain too", () =>
    {
        const chained = "case 0: return 1; case 40: case 41: return 7;"
        assert.equal(dispatch(chained, 0), 1)
        assert.equal(dispatch(chained, 40), 7)
        assert.equal(dispatch(chained, 41), 7)
        assert.equal(dispatch(chained, 42), 99)
    })

    // A gap goes to the default, so a shared body must never be reachable
    // through one — the labels either side of a gap are in different runs.
    test("a gap next to a shared body still reaches the default", () =>
    {
        const withGap = "case 0: case 1: return 10; case 3: return 30;"
        assert.equal(dispatch(withGap, 1), 10)
        assert.equal(dispatch(withGap, 2), 99)
        assert.equal(dispatch(withGap, 3), 30)
    })
})
