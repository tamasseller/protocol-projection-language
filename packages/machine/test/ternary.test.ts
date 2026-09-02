/**
 * @ppl/machine/test — The conditional operator
 *
 * A ternary is the only expression that lowers to a CFG split. One that is
 * the whole expression rides acc across the merge (isa-core.md §8.7,
 * `conditionalToAcc`); one nested inside a larger expression writes a TOS
 * slot reserved before the dispatch. Every case here therefore validates the
 * lowered body as well as running it: a slot reserved inside a case, or an
 * arm leaving acc dead where the merge reads it, produces bytecode the
 * validator rejects rather than a wrong answer.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { ir, proc } from "../src/ir"
import { lowerProc, lowerProgram } from "../src/lower"
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

function opsOf(source: string): string[]
{
    return program(source).procedures[0]!.body.map(format)
}

function returns(source: string, expected: number): void
{
    const result = run(program(source))
    assert.ok(result.ok, `${source}: expected a normal return, got trap ${result.trapCode}`)
    assert.equal(result.acc, expected >>> 0, `${source} → ${result.acc}`)
}

describe("ternary — values", () =>
{
    test("selects the consequent when the test holds", () =>
        returns("u32 a = 7; u32 b = 9; return a < b ? a : b;", 7))

    test("selects the alternate when it does not", () =>
        returns("u32 a = 9; u32 b = 7; return a < b ? a : b;", 7))

    test("a non-comparison test is the ISA's truthy test", () =>
    {
        returns("u32 a = 5; return a ? 1 : 2;", 1)
        returns("u32 a = 0; return a ? 1 : 2;", 2)
    })

    test("arms are full expressions", () =>
        returns("u32 a = 7; return a > 3 ? a * 2 : a + 100;", 14))

    test("two in one expression get a slot each", () =>
        returns("u32 a = 1; u32 b = 0; return (a ? 10 : 20) + (b ? 1 : 2);", 12))

    test("nested in an arm", () =>
        returns("u32 a = 0; return a ? 1 : (a == 0 ? 42 : 7);", 42))

    test("nested in the test", () =>
        returns("u32 a = 3; return (a > 2 ? 0 : 1) ? 10 : 20;", 20))

    // The child positions a ternary can hide in are `ast.ts`'s fan-out, so
    // each one is worth a probe: nothing else here would notice a position
    // that stopped being visited.
    test("under a unary operator", () =>
        returns("u32 a = 1; return -(a ? 1 : 2);", -1))

    test("inside a cast", () =>
        returns("u32 a = 1; u8 y = u8(a ? 300 : 1); return y;", 44))

    test("on the right of an assignment", () =>
        returns("u32 a = 1; u32 x = 0; x = a ? 11 : 22; return x;", 11))

    test("as a call argument", () =>
    {
        const half = proc(["x"], ir`return x >> 1;`)
        const entry = proc([], ir`u32 a = 9; return ${half}(a > 5 ? 100 : 3);`)
        const prog = lowerProgram(entry)
        validateProgram(prog)
        assert.equal(run(prog).acc, 50)
    })
})

describe("ternary — only one arm runs", () =>
{
    // `trap` is the only side effect an expression can have here, so it is
    // also the only way to observe that the untaken arm was never entered.
    test("the untaken arm is not evaluated", () =>
    {
        returns("u32 a = 1; return a ? 5 : trap(7);", 5)

        const result = run(program("u32 a = 0; return a ? 5 : trap(7);"))
        assert.equal(result.ok, false)
        assert.equal(result.trapCode, 7)
    })

    test("an arm nested in an arm stays conditional", () =>
        returns("u32 a = 1; return a ? 5 : (a ? trap(7) : trap(8));", 5))
})

describe("ternary — where the value rides", () =>
{
    // Every edge into a dispatch merge is a case body that establishes
    // acc, so it survives (isa-core.md §8.7). No slot is involved at all.
    test("a whole-expression ternary rides acc, with no slot", () =>
    {
        const ops = opsOf("u32 a = 7; return a > 3 ? 1 : 2;")

        assert.ok(ops.includes("BR_TABLE 1"), ops.join(" | "))
        assert.equal(ops.filter(o => o.startsWith("STORE")).length, 0, ops.join(" | "))
        assert.equal(ops.filter(o => o === "PUSH").length, 1, ops.join(" | ")) // `a`'s own declaration
    })

    test("an initializer rides acc too, and is pushed once at the end", () =>
    {
        const ops = opsOf("u32 a = 7; u32 b = a > 3 ? 11 : 22; return b;")
        const dispatch = ops.indexOf("BR_TABLE 1")

        assert.ok(dispatch > 0, ops.join(" | "))
        assert.equal(ops[ops.length - 3], "PUSH", ops.join(" | ")) // b's slot, after the merge
        assert.equal(ops.filter(o => o.startsWith("STORE")).length, 0, ops.join(" | "))
    })

    // Nested in a larger expression, acc cannot survive to the consumer —
    // something else runs in between — so this one still takes a slot,
    // reserved before the dispatch and stored at the end of every case (a
    // slot pushed *inside* a case would be dropped by its own BLOCK_END).
    test("a ternary inside a larger expression still takes a slot", () =>
    {
        const ops = opsOf("u32 a = 7; return (a > 3 ? 1 : 2) + a;")
        const dispatch = ops.indexOf("BR_TABLE 1")

        assert.ok(dispatch > 0, ops.join(" | "))
        assert.equal(ops[dispatch - 1], "PUSH", ops.join(" | "))

        const stores = ops.filter(o => o.startsWith("STORE"))
        assert.deepEqual(stores, ["STORE 1", "STORE 1"], ops.join(" | "))
    })

    test("either way the value survives the merge", () =>
    {
        returns("u32 a = 7; u32 b = a > 3 ? 11 : 22; return b + 1;", 12)
        returns("u32 a = 7; return (a > 3 ? 11 : 22) + 1;", 12)
    })
})

describe("ternary — inside control flow", () =>
{
    // The condition sub-block's own BLOCK_END drops the slot again, so the
    // body's locals must be numbered as if it were never there — `t` below
    // is what notices when they are not.
    test("in a while condition, re-evaluated every pass", () =>
        returns("u32 n = 0; u32 i = 0; while(i < (n ? 3 : 5)) { u32 t = 1; i = i + t; } return i;", 5))

    test("in a for update, above the body's own locals", () =>
    {
        // The update runs at the end of the body block, where the body's
        // locals are still pushed — its slot has to be numbered above them
        // or it aliases one. `t` is register 2, so the slot must not be.
        const source = "u32 s = 0; u32 i = 0; for(i = 0; i < 4; i = i + (i > 1 ? 2 : 1)) { u32 t = i + 1; s = s + t; } return s;"
        const ops = opsOf(source)

        assert.ok(ops.includes("STORE 3"), ops.join(" | "))
        assert.ok(!ops.includes("STORE 2"), ops.join(" | "))

        returns(source, 6)
    })

    test("in an if test, ahead of either branch's own scope", () =>
        returns("u32 a = 2; u32 r = 0; if(a > 1 ? 1 : 0) { u32 t = 9; r = t; } else { r = 1; } return r;", 9))

    // A `switch` dispatches on the discriminant as a case *index*
    // (isa-core.md §7.1), so the labels here are positions, not values.
    test("as a switch discriminant", () =>
    {
        const src = "switch(a ? 1 : 0) { case 0: return 5; case 1: return 40; default: return 0; }"
        returns(`u32 a = 1; ${src}`, 40)
        returns(`u32 a = 0; ${src}`, 5)
    })

    // `trap` is a terminator, so that arm *is* its case's close — a STORE
    // and BLOCK_END after it would be read as the next case's content.
    test("a trap arm closes its own case", () =>
    {
        const result = run(program("u32 a = 5; return a > 1 ? trap(3) : 9;"))
        assert.equal(result.ok, false)
        assert.equal(result.trapCode, 3)

        returns("u32 a = 0; return a > 1 ? trap(3) : 9;", 9)
    })
})

describe("ternary — type", () =>
{
    // C's usual arithmetic conversions over the two arms, which is what
    // types the slot and so decides the opcodes downstream of it.
    test("two signed arms make the result signed", () =>
    {
        const source = "i32 a = 0 - 8; return (a < 0 ? a : 0 - a) >> 1;"
        assert.ok(opsOf(source).includes("ASR #1"), opsOf(source).join(" | "))
        returns(source, 0xfffffffc)
    })

    test("one u32 arm makes it unsigned", () =>
    {
        const source = "i32 a = 0 - 8; u32 b = 4; return (a < 0 ? a : b) >> 1;"
        assert.ok(opsOf(source).includes("SHR #1"), opsOf(source).join(" | "))
        returns(source, 0x7ffffffc)
    })

    test("narrowing into the target applies to the value the branch produced", () =>
    {
        const source = "u8 x = 3; u8 y = x > 2 ? 300 : 1; return y;"
        assert.ok(opsOf(source).includes("UXTB"), opsOf(source).join(" | "))
        returns(source, 44)
    })
})
