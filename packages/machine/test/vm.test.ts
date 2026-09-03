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

import { run, evalBinary, evalUnary, UnspecifiedShiftAmount } from "../src/vm"
import { bare, brTable, call, CONST, PUSH, opStack, opRegWriteback } from "../src/rtl"
import type { RtlProgram } from "../src/rtl"

describe("run — §16 item 2: acc-clobbering convention enforcement", () =>
{
    test("RETURN reading acc right after a write-back-in-place (REG_REG) combo throws", () =>
    {
        const program: RtlProgram = {
            procedures: [{ argCount: 0, body: [CONST(5), PUSH(), opRegWriteback("ADD", 0), PUSH(), CONST(0), bare("RETURN")] }],
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
            procedures: [{ argCount: 0, body: [brTable(1), PUSH(), CONST(0), bare("RETURN")] }],
        }
        assert.throws(() => run(program), /read of acc/)
    })

    test("a BR_TABLE case with its own fresh producer runs fine, unaffected by the dispatch poisoning acc", () =>
    {
        // The dispatch reads acc, so the procedure has to take an argument
        // for one to be live there at all (isa-core.md §4.6).
        const program: RtlProgram = {
            procedures: [{ argCount: 1, body: [brTable(1), CONST(7), bare("RETURN")] }],
        }
        const result = run(program, undefined, [0])
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
                    PUSH(), CONST(0), bare("RETURN"),  // exit edge: reads acc with no producer of its own
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

describe("evalBinary — §4.1 unspecified shift amounts", () =>
{
    // The VM is an oracle, so the one thing it must not do here is pick a
    // value and let a differential harness treat it as the answer. §4.1
    // defines a shift for 0..31 only; jit-armv6m's bare register-form
    // shift uses Rm[7:0] and a host `<<` masks to five bits, and neither
    // is more correct than the other.
    for(const op of ["SHL", "SHR", "ASR"] as const)
    {
        test(`${op} by 31 is defined`, () =>
        {
            assert.doesNotThrow(() => evalBinary(0xdeadbeef, 31, op))
        })

        test(`${op} by 32 throws rather than mask to a shift by 0`, () =>
        {
            assert.throws(() => evalBinary(0xdeadbeef, 32, op), UnspecifiedShiftAmount)
        })

        test(`${op} by 2784 throws — low five bits zero, low eight are not`, () =>
        {
            // The finding-5 repro: masked to five bits this is the
            // identity, and on ARMv6-M it is a shift by 224.
            assert.throws(() => evalBinary(0xdeadbeef, 2784, op), UnspecifiedShiftAmount)
        })
    }

    test("a negative amount arrives as a large unsigned one and throws too", () =>
    {
        assert.throws(() => evalBinary(1, -1, "SHL"), UnspecifiedShiftAmount)
    })

    test("it is not a Trap — run() propagates it instead of reporting a trap code", () =>
    {
        const program: RtlProgram = {
            procedures: [{ argCount: 0, body: [CONST(40), PUSH(), CONST(1), opStack("SHL", "POP_ACC"), bare("RETURN")] }],
        }
        assert.throws(() => run(program), UnspecifiedShiftAmount)
    })
})

describe("evalUnary — §4.3 extend ops", () =>
{
    // Every result is a u32: a narrow variable holds an already-extended
    // word, which is what lets a read of one cost nothing (§4.3).
    const cases: [string, number, number][] = [
        ["SXTB", 0x7f, 0x7f],
        ["SXTB", 0x80, 0xffffff80],
        ["SXTB", 0xdeadbeef, 0xffffffef],
        ["SXTH", 0x7fff, 0x7fff],
        ["SXTH", 0x8000, 0xffff8000],
        ["SXTH", 0xdeadbeef, 0xffffbeef],
        ["UXTB", 0x80, 0x80],
        ["UXTB", 0xdeadbeef, 0xef],
        ["UXTH", 0x8000, 0x8000],
        ["UXTH", 0xdeadbeef, 0xbeef],
    ]

    for(const [op, input, expected] of cases)
    {
        test(`${op}(0x${input.toString(16)}) === 0x${expected.toString(16)}`, () =>
        {
            assert.equal(evalUnary(input, op as "SXTB"), expected)
        })
    }

    test("the signed pair round-trips a value the unsigned pair truncates", () =>
    {
        // -1 narrowed and widened again is -1; the same bits read unsigned
        // are the type's maximum. Both are u32 words here.
        assert.equal(evalUnary(0xffffffff, "SXTB"), 0xffffffff)
        assert.equal(evalUnary(0xffffffff, "UXTB"), 0xff)
    })

    test("extending an already-narrow word is the identity", () =>
    {
        for(const op of ["SXTB", "SXTH", "UXTB", "UXTH"] as const)
            assert.equal(evalUnary(evalUnary(0xdeadbeef, op), op), evalUnary(0xdeadbeef, op))
    })
})

describe("run — a void entry procedure's result", () =>
{
    test("accLive says the result is not one, rather than the VM inventing a value", () =>
    {
        // Nothing establishes acc, so `acc` here is whatever this
        // interpreter happened to hold — jit-armv6m returns whatever was in
        // r0. `accLive` is what tells the two apart (isa-core.md §8.7).
        const result = run({ procedures: [{ argCount: 0, body: [bare("RETURN")] }] })
        assert.equal(result.ok, true)
        assert.equal(result.accLive, false)
    })

    test("a value-returning entry reports accLive", () =>
    {
        const result = run({ procedures: [{ argCount: 0, body: [CONST(9), bare("RETURN")] }] })
        assert.equal(result.accLive, true)
        assert.equal(result.acc, 9)
    })

    test("a caller sees the callee's own liveness, not a blanket true", () =>
    {
        const result = run({
            procedures: [
                { argCount: 0, body: [call(1), bare("RETURN")] },
                { argCount: 0, body: [bare("RETURN")] },
            ],
        })
        assert.equal(result.ok, true)
        assert.equal(result.accLive, false)
    })
})
