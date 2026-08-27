/**
 * @ppl/machine/test — vm.ts acc-clobbering enforcement (docs/design.md §16 item 2)
 *
 * `raise.ts` already poisons its own tracked `acc` after a write-back-
 * in-place combo (REG_REG/PEEK_PEEK, rtl.ts's `COMBO` table); `run()`
 * didn't — a hand-crafted program reading `acc` right after one of these
 * would silently get whatever `acc` held *before* the combo ran (write-back
 * combos never touch the real `acc` variable at all), computing a
 * bit-accurate-by-luck answer instead of being caught. Hand-built via
 * rtl.ts's own constructors (matching validate.test.ts's convention for
 * violation shapes a correct lowerer would never itself produce).
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { run } from "../src/vm"
import { bare, brTable, CONST, PUSH, opRegWriteback } from "../src/rtl"
import type { RtlProgram } from "../src/rtl"

describe("run — §16 item 2: acc-clobbering convention enforcement", () =>
{
    test("RETURN reading acc right after a write-back-in-place (REG_REG) combo throws", () =>
    {
        const program: RtlProgram = {
            procedures: [{ argCount: 0, body: [CONST(5), PUSH(), opRegWriteback("ADD", 0), bare("RETURN")] }],
        }
        assert.throws(() => run(program), /read of acc/)
    })

    test("a fresh producer between a write-back-in-place combo and its next read is fine", () =>
    {
        const program: RtlProgram = {
            procedures: [{ argCount: 0, body: [CONST(5), PUSH(), opRegWriteback("ADD", 0), CONST(1), bare("RETURN")] }],
        }
        const result = run(program)
        assert.equal(result.ok, true)
        assert.equal(result.acc, 1)
    })
})

describe("run — §8.7 acc liveness across control flow", () =>
{
    test("a BR_TABLE case reading acc with no producer of its own throws at runtime", () =>
    {
        const program: RtlProgram = {
            procedures: [{ argCount: 0, body: [brTable(1), bare("RETURN")] }],
        }
        assert.throws(() => run(program), /read of acc/)
    })

    test("a BR_TABLE case with its own fresh producer runs fine, unaffected by the dispatch poisoning acc", () =>
    {
        const program: RtlProgram = {
            procedures: [{ argCount: 0, body: [brTable(1), CONST(7), bare("RETURN")] }],
        }
        const result = run(program)
        assert.equal(result.ok, true)
        assert.equal(result.acc, 7)
    })

    test("code immediately after a whole LOOP reading acc with no producer of its own throws at runtime (the loop-exit shape a fused comparison's un-materialized boolean used to break)", () =>
    {
        const program: RtlProgram = {
            procedures: [{
                argCount: 0,
                body: [
                    bare("LOOP"),
                    CONST(0), bare("BLOCK_END"), // condition: always exits
                    CONST(5), bare("RETURN"),    // body (never actually taken)
                    bare("RETURN"),               // exit edge: reads acc with no producer of its own
                ],
            }],
        }
        assert.throws(() => run(program), /read of acc/)
    })

    test("code after a whole LOOP with its own fresh producer runs fine, unaffected by the exit-edge poisoning acc", () =>
    {
        const program: RtlProgram = {
            procedures: [{
                argCount: 0,
                body: [
                    bare("LOOP"),
                    CONST(0), bare("BLOCK_END"),
                    CONST(5), bare("RETURN"),
                    CONST(42), bare("RETURN"),
                ],
            }],
        }
        const result = run(program)
        assert.equal(result.ok, true)
        assert.equal(result.acc, 42)
    })
})
