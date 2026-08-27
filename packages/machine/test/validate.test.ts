/**
 * @ppl/machine/test — Whole-program validator (isa-core.md §8)
 *
 * Two kinds of coverage: the real pipeline (`ir`/`proc`/`lowerProgram`)
 * for the happy path and the tight stack-depth computation, and hand-
 * built `RtlProgram`s (mirroring bytecode.test.ts's own convention) for
 * each individual §8.1–§8.5 violation, since a correct lowerer should
 * never actually produce most of these shapes.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { ir, proc } from "../src/ir"
import { lowerProgram } from "../src/lower"
import { validateProgram } from "../src/validate"
import { bare, call, brTable, trap, PUSH, POP, CONST, LOAD, STORE, opStack, opImm, opRegWriteback } from "../src/rtl"
import type { RtlProgram, RtlProc } from "../src/rtl"

describe("validateProgram — happy path (real pipeline)", () =>
{
    test("a single trivial procedure validates, with the correct local peak", () =>
    {
        const entry = proc([], ir`return 42;`)
        const stats = validateProgram(lowerProgram(entry))
        assert.equal(stats.procedures.length, 1)
        assert.equal(stats.procedures[0]!.localPeak, 0) // CONST -> acc; never pushes
    })

    test("a call chain validates, and totalDepth accounts for the callee", () =>
    {
        const inc = proc(["x"], ir`return x + 1;`)
        const entry = proc([], ir`
            u32 y = ${inc}(5);
            return y;
        `)
        const stats = validateProgram(lowerProgram(entry))
        assert.equal(stats.procedures.length, 2)
        assert.ok(stats.totalDepth >= 1) // at least the pushed argument
    })
})

describe("validateProgram — §8.3 stack-depth bound is the tight one, not the naive sum", () =>
{
    // callee: argCount=2 — the calling convention's last-arg-in-acc rule
    // (rtl.ts's `call` doc comment) means only `stackArgsOf(2) = 1` value is
    // ever popped off the stack for this callee, regardless of its own
    // body. It pushes 3 more here, netting a local peak of 2 + 3 = 5.
    const callee: RtlProc = {
        argCount: 2,
        body: [PUSH(), PUSH(), PUSH(), POP(), POP(), POP(), bare("RETURN")],
    }

    // caller: argCount=0; first reaches a deep, call-unrelated peak of 10,
    // fully unwinds, *then* pushes exactly 1 (stackArgsOf(2)) argument and
    // calls callee. Naive ("sum of per-procedure maxima along the call
    // chain") would report 10 (caller's own peak) + 5 (callee's peak) = 15.
    // The actual worst case is 10: the call site's own depth (1, minus
    // callee's stackArgsOf(2) = 1, is 0) plus callee's peak (5) is only 5 —
    // dominated by the caller's unrelated peak of 10, which the call never
    // coincides with.
    const caller: RtlProc = {
        argCount: 0,
        body: [
            ...Array.from({ length: 10 }, () => PUSH()),
            ...Array.from({ length: 10 }, () => POP()),
            PUSH(),
            call(1),
            bare("RETURN"),
        ],
    }

    const program: RtlProgram = { procedures: [caller, callee] }

    test("per-procedure local peaks are reported individually", () =>
    {
        const stats = validateProgram(program)
        assert.equal(stats.procedures[0]!.localPeak, 10)
        assert.equal(stats.procedures[1]!.localPeak, 5)
    })

    test("totalDepth is the tight call-site-based figure (10), not the naive sum (15)", () =>
    {
        const stats = validateProgram(program)
        assert.equal(stats.totalDepth, 10)
    })

    test("moving the call to the deep point instead makes the call the dominant path", () =>
    {
        // Same two procedures, but the call now happens *at* the deep
        // point (tos=10) instead of after unwinding — so this time the
        // call-site contribution (10 - 1 + 5 = 14) dominates.
        const callerCallingDeep: RtlProc = {
            argCount: 0,
            body: [
                ...Array.from({ length: 9 }, () => PUSH()),
                PUSH(), // tos now 10
                call(1), // consumes stackArgsOf(2) = 1; tos back to 9
                ...Array.from({ length: 9 }, () => POP()),
                bare("RETURN"),
            ],
        }
        const stats = validateProgram({ procedures: [callerCallingDeep, callee] })
        assert.equal(stats.totalDepth, 10 - 1 + 5)
    })

    test("maxCallDepth is independent of totalDepth: 1 nested call here, same as always", () =>
    {
        const stats = validateProgram(program)
        assert.equal(stats.maxCallDepth, 1)
        assert.equal(stats.totalDepth, 10) // unchanged from above — the two figures don't move together
    })

    test("a long, shallow call chain has a small totalDepth but a large maxCallDepth", () =>
    {
        // Five procedures, each a trivial pass-through calling the next —
        // the mirror image of caller/callee above: negligible register
        // pressure (nothing ever pushed) but five simultaneously active
        // frames on the one path through them all.
        const chain: RtlProc[] = Array.from({ length: 5 }, (_, i) => ({
            argCount: 0,
            body: i < 4 ? [call(i + 1), bare("RETURN")] : [bare("RETURN")],
        }))
        const stats = validateProgram({ procedures: chain })
        assert.equal(stats.maxCallDepth, 4)
        assert.equal(stats.totalDepth, 0)
    })
})

describe("validateProgram — §8.1 TOS balance", () =>
{
    test("POP below the procedure's own entry depth is rejected", () =>
    {
        const program: RtlProgram = { procedures: [{ argCount: 0, body: [POP(), bare("RETURN")] }] }
        assert.throws(() => validateProgram(program), /underflow/)
    })

    test("a stack-combo op reading below entry depth is rejected", () =>
    {
        const program: RtlProgram = {
            procedures: [{ argCount: 0, body: [opStack("ADD", "PEEK_PEEK"), bare("RETURN")] }],
        }
        assert.throws(() => validateProgram(program), /below this block's entry depth/)
    })

    test("a balanced push/pop pair around a call is fine", () =>
    {
        const callee: RtlProc = { argCount: 0, body: [bare("RETURN")] }
        const caller: RtlProc = { argCount: 0, body: [CONST(1), PUSH(), POP(), bare("RETURN")] }
        assert.doesNotThrow(() => validateProgram({ procedures: [caller, callee] }))
    })
})

describe("validateProgram — §8.2 call-graph acyclicity", () =>
{
    test("direct self-recursion is rejected", () =>
    {
        const program: RtlProgram = { procedures: [{ argCount: 0, body: [call(0), bare("RETURN")] }] }
        assert.throws(() => validateProgram(program), /cycle/)
    })

    test("mutual recursion between two procedures is rejected", () =>
    {
        const program: RtlProgram = {
            procedures: [
                { argCount: 0, body: [call(1), bare("RETURN")] },
                { argCount: 0, body: [call(0), bare("RETURN")] },
            ],
        }
        assert.throws(() => validateProgram(program), /cycle/)
    })
})

describe("validateProgram — §8.4 dead-code rejection", () =>
{
    test("an instruction after the procedure's terminator is rejected", () =>
    {
        const program: RtlProgram = {
            procedures: [{ argCount: 0, body: [bare("RETURN"), CONST(1)] }],
        }
        assert.throws(() => validateProgram(program), /unreachable/)
    })
})

describe("validateProgram — §8.5 header/block well-formedness", () =>
{
    test("CALL to a nonexistent procedure index is rejected", () =>
    {
        const program: RtlProgram = { procedures: [{ argCount: 0, body: [call(5), bare("RETURN")] }] }
        assert.throws(() => validateProgram(program), /no such procedure/)
    })

    test("CALL with fewer pushed values than the callee's stack-arg count is rejected", () =>
    {
        // argCount=3 → stackArgsOf(3) = 2 (the last argument comes from acc,
        // not the stack); pushing only 1 is one short.
        const callee: RtlProc = { argCount: 3, body: [bare("RETURN")] }
        const caller: RtlProc = { argCount: 0, body: [PUSH(), call(1), bare("RETURN")] }
        assert.throws(() => validateProgram({ procedures: [caller, callee] }), /needs 2/)
    })

    test("a BLOCK_END with no open block is rejected", () =>
    {
        const program: RtlProgram = { procedures: [{ argCount: 0, body: [bare("BLOCK_END")] }] }
        assert.throws(() => validateProgram(program), /no open block/)
    })

    test("a LOOP whose condition sub-block closes with a terminator instead of BLOCK_END is rejected", () =>
    {
        const program: RtlProgram = {
            procedures: [{ argCount: 0, body: [bare("LOOP"), bare("RETURN")] }],
        }
        assert.throws(() => validateProgram(program), /condition sub-block must close with BLOCK_END/)
    })

    test("a LOOP body closed by a terminator (never taking the back-edge) is accepted", () =>
    {
        // isa-core.md §7.2: a legitimate, non-cyclic use of LOOP purely to
        // host a pre-test. The condition's own exit path (acc=0) falls
        // through past the *whole* construct, so there must be something
        // reachable there too — not just inside the body. §8.7: that exit
        // edge starts acc-dead, so the reachable code needs its own producer.
        const program: RtlProgram = {
            procedures: [{
                argCount: 0,
                body: [
                    bare("LOOP"),
                    CONST(0), bare("BLOCK_END"),  // condition sub-block
                    CONST(5), bare("RETURN"),     // body sub-block, closed by a terminator
                    CONST(9), bare("RETURN"),     // reached via the condition's own exit path — fresh producer (§8.7)
                ],
            }],
        }
        assert.doesNotThrow(() => validateProgram(program))
    })

    test("a BR_TABLE case correctly falls through to code after the whole construct", () =>
    {
        const program: RtlProgram = {
            procedures: [{
                argCount: 0,
                body: [brTable(1), CONST(1), bare("BLOCK_END"), CONST(2), bare("RETURN")],
            }],
        }
        const stats = validateProgram(program)
        assert.equal(stats.procedures[0]!.localPeak, 0)
    })

    test("a procedure falling off the end without RETURN/TRAP is rejected", () =>
    {
        const program: RtlProgram = { procedures: [{ argCount: 0, body: [CONST(1)] }] }
        assert.throws(() => validateProgram(program))
    })

    test("an empty program is rejected", () =>
    {
        assert.throws(() => validateProgram({ procedures: [] }), /empty program/)
    })

    test("TRAP is a valid terminator on its own", () =>
    {
        const program: RtlProgram = { procedures: [{ argCount: 0, body: [trap(0)] }] }
        assert.doesNotThrow(() => validateProgram(program))
    })
})

describe("validateProgram — §16 item 2: acc-clobbering convention enforcement", () =>
{
    test("RETURN reading acc right after a write-back-in-place (REG_REG) combo is rejected", () =>
    {
        const program: RtlProgram = {
            procedures: [{ argCount: 0, body: [CONST(5), PUSH(), opRegWriteback("ADD", 0), bare("RETURN")] }],
        }
        assert.throws(() => validateProgram(program), /read of acc/)
    })

    test("a stack-combo op (PEEK_PEEK) reading acc right after a REG_REG combo is rejected", () =>
    {
        const program: RtlProgram = {
            procedures: [{ argCount: 0, body: [CONST(5), PUSH(), opRegWriteback("ADD", 0), opStack("ADD", "PEEK_PEEK"), bare("RETURN")] }],
        }
        assert.throws(() => validateProgram(program), /read of acc/)
    })

    test("a fresh producer between a write-back-in-place combo and its next read is accepted", () =>
    {
        const program: RtlProgram = {
            procedures: [{ argCount: 0, body: [CONST(5), PUSH(), opRegWriteback("ADD", 0), CONST(1), bare("RETURN")] }],
        }
        assert.doesNotThrow(() => validateProgram(program))
    })

    test("BR_TABLE reading acc right after a REG_REG combo is rejected", () =>
    {
        const program: RtlProgram = {
            procedures: [{
                argCount: 0,
                body: [CONST(5), PUSH(), opRegWriteback("ADD", 0), brTable(2), CONST(1), bare("RETURN"), CONST(2), bare("RETURN")],
            }],
        }
        assert.throws(() => validateProgram(program), /read of acc/)
    })

    test("a case that clobbers acc merges safely with a sibling that doesn't, since the whole construct is treated as poisoned afterward", () =>
    {
        const program: RtlProgram = {
            procedures: [{
                argCount: 0,
                body: [
                    CONST(5), PUSH(),
                    brTable(2),
                    CONST(2), opRegWriteback("ADD", 0), bare("BLOCK_END"), // case 0: fresh producer (§8.7: case starts acc-dead), then poisons it again
                    CONST(1), bare("BLOCK_END"),                            // case 1: leaves acc live
                    CONST(9), bare("RETURN"),                                // merge point: never reads the pre-merge acc, so this is fine either way
                ],
            }],
        }
        assert.doesNotThrow(() => validateProgram(program))
    })
})

describe("validateProgram — §8.7 acc liveness across control flow", () =>
{
    test("a BR_TABLE case reading acc immediately, with no producer of its own, is rejected (used to inherit the pre-dispatch value before §8.7)", () =>
    {
        const program: RtlProgram = {
            procedures: [{ argCount: 0, body: [brTable(1), bare("RETURN")] }],
        }
        assert.throws(() => validateProgram(program), /read of acc/)
    })

    test("a LOOP body reading acc immediately after the condition closes, with no producer of its own, is rejected", () =>
    {
        const program: RtlProgram = {
            procedures: [{
                argCount: 0,
                body: [
                    bare("LOOP"),
                    CONST(1), bare("BLOCK_END"), // condition sub-block: establishes and reads acc fine
                    bare("RETURN"),               // body: reads acc with no producer of its own
                ],
            }],
        }
        assert.throws(() => validateProgram(program), /read of acc/)
    })

    test("code immediately after a whole LOOP reading acc, with no producer of its own, is rejected (the loop-exit shape a fused comparison's un-materialized boolean used to break)", () =>
    {
        const program: RtlProgram = {
            procedures: [{
                argCount: 1,
                body: [
                    bare("LOOP"),
                    LOAD(0), opImm("LT_U", 5), bare("BLOCK_END"),           // condition: r0 < 5
                    LOAD(0), opImm("ADD", 1), STORE(0), bare("BLOCK_END"), // body: r0 = r0 + 1
                    bare("RETURN"),                                         // exit edge: reads acc (the LT_U result) with no producer of its own
                ],
            }],
        }
        assert.throws(() => validateProgram(program), /read of acc/)
    })

    test("a BR_TABLE where every sibling case re-establishes acc before the merge is still accepted", () =>
    {
        const program: RtlProgram = {
            procedures: [{
                argCount: 0,
                body: [
                    brTable(2),
                    CONST(1), bare("BLOCK_END"), // case 0: fresh producer
                    CONST(2), bare("BLOCK_END"), // case 1: fresh producer
                    bare("RETURN"),               // merge point: safe, since every case re-established acc
                ],
            }],
        }
        assert.doesNotThrow(() => validateProgram(program))
    })

    test("a LOOP whose exit code never reads acc at all is still accepted", () =>
    {
        const program: RtlProgram = {
            procedures: [{
                argCount: 0,
                body: [
                    bare("LOOP"),
                    CONST(0), bare("BLOCK_END"), // condition: acc=0, exits every time
                    CONST(5), bare("RETURN"),    // body (statically present, never actually taken)
                    trap(0),                      // exit edge: TRAP never reads acc, so the exit's own liveness never matters
                ],
            }],
        }
        assert.doesNotThrow(() => validateProgram(program))
    })
})
