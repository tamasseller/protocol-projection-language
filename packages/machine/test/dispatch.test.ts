/**
 * @ppl/machine/test — `BR_TABLE` and `FALLTHROUGH`, at the ISA level
 * (isa-core.md §4.5, §8.7)
 *
 * ternary.test.ts and switch.test.ts cover what the lowerer does with
 * these; this file covers what they *mean*, against hand-written RTL the
 * lowerer would never emit. Two rules carry the weight:
 *
 *   - `BR_TABLE N` opens `N + 1` blocks and is total: `acc >= N` runs
 *     `case[N]` rather than skipping the construct, so every edge into the
 *     merge is a case body and a value can cross it.
 *   - acc survives only if every case that *reaches* the merge leaves it
 *     live; a case ending in a terminator reaches nothing.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { bare, brTable, trap, CONST, PUSH, LOAD, STORE, opImm, opRegWriteback } from "../src/rtl"
import type { RtlInstr, RtlProgram } from "../src/rtl"
import { validateProgram } from "../src/validate"
import { encodeInstr, encodeProgram, decodeProgram } from "../src/bytecode"
import { run } from "../src/vm"

function program(body: RtlInstr[], argCount = 1): RtlProgram
{
    const prog: RtlProgram = { procedures: [{ argCount, body }] }
    validateProgram(prog)
    return prog
}

/** Validate, round-trip through the wire codec, then run. */
function exec(body: RtlInstr[], arg: number): number
{
    const prog = program(body)
    const decoded = decodeProgram(encodeProgram(prog)).program
    assert.deepEqual(decoded.procedures[0]!.body, prog.procedures[0]!.body, "wire round trip")

    const result = run(prog, undefined, [arg])
    assert.ok(result.ok, `arg ${arg}: expected a normal return, got trap ${result.trapCode}`)
    return result.acc >>> 0
}

/** `arg > 3 ? 11 : 22`, with the value riding acc and no slot anywhere. */
const carried: RtlInstr[] = [
    LOAD(0), opImm("GT_U", 3), brTable(1),
        CONST(22), bare("BLOCK_END"),
        CONST(11), bare("BLOCK_END"),
    bare("RETURN"),
]

describe("BR_TABLE 1 — a truthy two-way split", () =>
{
    test("acc zero takes case[0], anything else takes case[1]", () =>
    {
        assert.equal(exec(carried, 1), 22) // 1 > 3 is false -> acc 0
        assert.equal(exec(carried, 9), 11)
    })

    // At N = 1 the index is a truthy test, not a range: everything at or
    // above 1 is the same outcome, and it has a body of its own.
    test("a dispatch value far outside 0..1 is still just case[1]", () =>
    {
        const body: RtlInstr[] = [
            LOAD(0), brTable(1),
                CONST(5), bare("BLOCK_END"),
                CONST(6), bare("BLOCK_END"),
            bare("RETURN"),
        ]
        assert.equal(exec(body, 0), 5)
        assert.equal(exec(body, 1), 6)
        assert.equal(exec(body, 0x9000), 6)
        assert.equal(exec(body, 0xffffffff), 6)
    })

    test("a wider table sends everything at or above N to case[N]", () =>
    {
        const body: RtlInstr[] = [
            LOAD(0), brTable(3),
                CONST(10), bare("BLOCK_END"),
                CONST(11), bare("BLOCK_END"),
                CONST(12), bare("BLOCK_END"),
                CONST(99), bare("BLOCK_END"),
            bare("RETURN"),
        ]
        assert.equal(exec(body, 0), 10)
        assert.equal(exec(body, 2), 12)
        assert.equal(exec(body, 3), 99)
        assert.equal(exec(body, 0xffffffff), 99)
    })

    // One always-taken block is a scoped block, not a branch, so `N = 0`
    // has no encoding at all — and the validator says so before a decoder
    // ever has to.
    test("N = 0 is rejected, and has no encoding either", () =>
    {
        assert.throws(() => program([
            LOAD(0), brTable(0), bare("BLOCK_END"), CONST(0), bare("RETURN"),
        ]), /at least one indexed case/)

        assert.throws(() => encodeInstr(brTable(0)), /not encodable/)
    })
})

describe("BR_TABLE — acc across the merge", () =>
{
    test("the value each case leaves in acc is readable after the construct", () =>
        assert.equal(exec([...carried.slice(0, -1), opImm("ADD", 1), bare("RETURN")], 9), 12))

    test("one case leaving acc dead makes the merge dead", () =>
        assert.throws(() => program([
            LOAD(0), opImm("GT_U", 3), brTable(1),
                CONST(11), bare("BLOCK_END"),
                CONST(1), PUSH(), opRegWriteback("ADD", 1), bare("BLOCK_END"),
            PUSH(), CONST(0), bare("RETURN"),
        ]), /read of acc/))

    // A case that traps reaches no merge at all, so it constrains nothing.
    test("a terminating case does not constrain the merge", () =>
    {
        const body: RtlInstr[] = [
            LOAD(0), opImm("EQ", 0), brTable(1),
                CONST(22), bare("BLOCK_END"),
                trap(3),
            bare("RETURN"),
        ]
        assert.equal(exec(body, 7), 22) // 7 == 0 is false -> acc 0 -> case[0]

        const trapped = run(program(body), undefined, [0])
        assert.ok(!trapped.ok)
        assert.equal(trapped.trapCode, 3)
    })

    test("every case terminating leaves the merge dead", () =>
        assert.throws(() => program([
            LOAD(0), opImm("EQ", 0), brTable(1),
                trap(3),
                trap(4),
            PUSH(), CONST(0), bare("RETURN"),
        ]), /read of acc/))

    // Entry is unchanged: a case is a split successor, so it still starts
    // with acc dead however the dispatch was reached.
    test("a case still starts with acc dead", () =>
        assert.throws(() => program([
            LOAD(0), opImm("EQ", 0), brTable(1),
                STORE(0), bare("BLOCK_END"),
                CONST(1), bare("BLOCK_END"),
            bare("RETURN"),
        ]), /read of acc/))
})

describe("FALLTHROUGH — continuing into the next case", () =>
{
    /** `switch` with a shared body: case 0 is a lone FALLTHROUGH. */
    const shared: RtlInstr[] = [
        CONST(0), PUSH(),
        LOAD(0), brTable(3),
            bare("FALLTHROUGH"),
            CONST(10), STORE(1), bare("BLOCK_END"),
            CONST(20), STORE(1), bare("BLOCK_END"),
            bare("BLOCK_END"),
        LOAD(1), bare("RETURN"),
    ]

    test("the sharing label reaches the next case's body", () =>
    {
        assert.equal(exec(shared, 0), 10)
        assert.equal(exec(shared, 1), 10)
        assert.equal(exec(shared, 2), 20)
        assert.equal(exec(shared, 9), 0) // out of range: the default case
    })

    test("a case may do work before running on", () =>
    {
        const body: RtlInstr[] = [
            CONST(0), PUSH(),
            LOAD(0), brTable(1),
                CONST(5), STORE(1), bare("FALLTHROUGH"),
                LOAD(1), opImm("ADD", 1), STORE(1), bare("BLOCK_END"),
            LOAD(1), bare("RETURN"),
        ]
        assert.equal(exec(body, 0), 6) // case[0] stores 5, then case[1] adds 1
        assert.equal(exec(body, 1), 1)
    })

    test("closing the default case has nothing to continue into", () =>
        assert.throws(() => program([
            LOAD(0), brTable(1),
                CONST(1), bare("BLOCK_END"),
                CONST(2), bare("FALLTHROUGH"),
            CONST(0), bare("RETURN"),
        ]), /no next case to continue into/))

    test("it cannot close a LOOP sub-block", () =>
    {
        assert.throws(() => program([
            bare("LOOP"), CONST(0), bare("FALLTHROUGH"), CONST(1), bare("BLOCK_END"),
            CONST(0), bare("RETURN"),
        ]), /condition sub-block must close with BLOCK_END, not FALLTHROUGH/)

        assert.throws(() => program([
            bare("LOOP"), CONST(0), bare("BLOCK_END"), CONST(1), bare("FALLTHROUGH"),
            CONST(0), bare("RETURN"),
        ]), /body sub-block must close with BLOCK_END, not FALLTHROUGH/)
    })

    test("it cannot close the procedure body", () =>
        assert.throws(() => program([CONST(0), bare("FALLTHROUGH")]),
            /FALLTHROUGH with no open block/))
})
