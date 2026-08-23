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
import { bare, CONST, PUSH, opRegWriteback } from "../src/rtl"
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
