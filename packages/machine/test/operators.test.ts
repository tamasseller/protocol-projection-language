/**
 * @ppl/machine/test — The operators that lower by being rewritten
 *
 * desugar.ts turns compound assignment, `++`/`--`, `!`, unary `+` and
 * `&&`/`||` into the operators the tiler already knows; a postfix step
 * whose value is read goes further, to lift.ts, because the value it
 * yields is the one from before the step. Each case runs the whole
 * pipeline and validates the result, so a rewrite that produced
 * ill-formed code fails here rather than downstream.
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

describe("compound assignment", () =>
{
    for(const [op, start, operand, expected] of [
        ["+=", 1, 2, 3], ["-=", 5, 2, 3], ["*=", 5, 3, 15],
        ["<<=", 5, 2, 20], [">>=", 20, 2, 5],
        ["&=", 6, 3, 2], ["|=", 6, 1, 7], ["^=", 6, 3, 5],
    ] as const)
    {
        test(`a ${op} b`, () => returns(`u32 a = ${start}; a ${op} ${operand}; return a;`, expected))
    }

    test("narrows into the target's own type", () =>
        returns("u8 x = 1; x += 300; return x;", 45))

    test("is an expression, with the stored value", () =>
        returns("u32 a = 1; u32 b = 0; b = (a += 2); return b * 10 + a;", 33))

    // `a = a + 1` is what the rewrite produces, and rules.ts has a
    // write-back combo for exactly that shape — so the desugared form costs
    // no more than the fused one would.
    test("reaches the register write-back combo", () =>
        assert.deepEqual(opsOf("u32 a = 1; a += 2; return a;").slice(2, 4),
            ["CONST #2", "ADD 0 → 0"]))
})

describe("++ and --", () =>
{
    test("as a statement", () =>
    {
        returns("u32 a = 1; a++; return a;", 2)
        returns("u32 a = 1; ++a; return a;", 2)
        returns("u32 a = 5; a--; return a;", 4)
        returns("u32 a = 5; --a; return a;", 4)
    })

    test("prefix yields the new value", () =>
        returns("u32 a = 1; u32 b = ++a; return b * 10 + a;", 22))

    test("postfix yields the value from before the step", () =>
    {
        returns("u32 a = 1; u32 b = a++; return b * 10 + a;", 12)
        returns("u32 a = 5; u32 b = a--; return b * 10 + a;", 54)
    })

    test("postfix twice in one expression", () =>
        returns("u32 a = 1; u32 b = a++ + a++; return b * 10 + a;", 33))

    test("postfix wraps in its own type", () =>
        returns("u8 c = 255; u32 b = c++; return b * 1000 + c;", 255000))

    test("postfix inside a call argument", () =>
        returns("u32 a = 2; return clz(a++) + a;", 33))

    test("postfix inside a ternary arm stays conditional", () =>
    {
        returns("u32 a = 1; u32 c = 1; u32 b = c ? a++ : 9; return b * 10 + a;", 12)
        returns("u32 a = 1; u32 c = 0; u32 b = c ? a++ : 9; return b * 10 + a;", 91)
    })

    test("postfix in a loop condition steps every pass", () =>
        returns("u32 i = 0; u32 s = 0; while(i++ < 3) { s += 1; } return s * 10 + i;", 34))

    test("in a for update", () =>
        returns("u32 s = 0; for(u32 i = 0; i < 4; i++) { s += i; } return s;", 6))

    test("the operand must be a variable", () =>
        assert.throws(() => program("return 5++;"), /Operand of \+\+ must be a variable/))
})

describe("! and unary +", () =>
{
    test("! is a comparison against zero", () =>
    {
        returns("u32 a = 0; return !a;", 1)
        returns("u32 a = 7; return !a;", 0)
        assert.ok(opsOf("u32 a = 0; return !a;").includes("EQ #0"))
    })

    test("!! normalizes to 0 or 1", () =>
    {
        returns("u32 a = 7; return !!a;", 1)
        returns("u32 a = 0; return !!a;", 0)
    })

    test("unary + is the identity", () =>
        returns("u32 a = 7; return +a;", 7))
})

describe("&& and ||", () =>
{
    test("yield 0 or 1", () =>
    {
        returns("u32 a = 2; u32 b = 3; return a && b;", 1)
        returns("u32 a = 2; u32 b = 0; return a && b;", 0)
        returns("u32 a = 0; u32 b = 0; return a || b;", 0)
        returns("u32 a = 0; u32 b = 3; return a || b;", 1)
    })

    // An assignment is the only side effect an expression here can have, so
    // it is also the only way to see whether the right-hand side ran.
    test("&& does not evaluate its right side when the left is false", () =>
    {
        returns("u32 a = 0; u32 b = 0; u32 r = a && (b = 1); return b;", 0)
        returns("u32 a = 1; u32 b = 0; u32 r = a && (b = 1); return b;", 1)
    })

    test("|| does not evaluate its right side when the left is true", () =>
    {
        returns("u32 a = 1; u32 b = 0; u32 r = a || (b = 1); return b;", 0)
        returns("u32 a = 0; u32 b = 0; u32 r = a || (b = 1); return b;", 1)
    })

    test("chain left to right", () =>
    {
        returns("u32 a = 1; u32 b = 1; u32 c = 0; return a && b && c;", 0)
        returns("u32 a = 1; u32 b = 1; u32 c = 3; return a && b && c;", 1)
        returns("u32 a = 0; u32 b = 0; u32 c = 3; return a || b || c;", 1)
    })

    test("as a branch test", () =>
    {
        returns("u32 a = 1; u32 b = 1; if(a && b) { return 5; } return 0;", 5)
        returns("u32 a = 1; u32 b = 0; if(a && b) { return 5; } return 0;", 0)
        returns("u32 i = 0; u32 z = 0; while(i < 3 || z) { i += 1; } return i;", 3)
    })

    test("across a call", () =>
    {
        const isZero = proc(["x"], ir`return !x;`)
        const entry = proc([], ir`u32 a = 0; return ${isZero}(a) && 7;`)
        const prog = lowerProgram(entry)
        validateProgram(prog)
        assert.equal(run(prog).acc, 1)
    })
})
