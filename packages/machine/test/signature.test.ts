/**
 * @ppl/machine/test — procedure signatures
 *
 * An `ir` fragment is a statement sequence, not a function definition, so a
 * signature has nowhere to live in the source text; it lives on `proc`
 * instead. Return arity is deduced from the body's own `return`s where it
 * isn't declared — the C++14 `auto` rule — because isa-core.md §8.7 makes
 * "returns nothing" a real distinction and every existing procedure predates
 * any way to say so.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { ir, proc } from "../src/ir"
import { lowerProc, lowerProgram } from "../src/lower"
import { validateProgram } from "../src/validate"
import { run } from "../src/vm"
import { format } from "../src/rtl"
import type { RtlInstr } from "../src/rtl"

const opsOf = (p: ReturnType<typeof lowerProgram>, i: number): string[] => p.procedures[i]!.body.map(instr => format(instr as RtlInstr))

function runs(entry: ReturnType<typeof proc>, expected: number): void
{
    const program = lowerProgram(entry)
    validateProgram(program)
    const result = run(program)
    assert.ok(result.ok)
    assert.equal(result.acc, expected >>> 0)
}

describe("return arity — deduced", () =>
{
    test("every return bare makes the procedure void, and its RETURN needs no producer", () =>
    {
        const program = lowerProgram(proc([], ir`u32 q = 1; return;`))
        assert.deepEqual(opsOf(program, 0), ["CONST #1", "PUSH", "RETURN"])
    })

    test("a valued return keeps the producer a real value", () =>
        assert.deepEqual(opsOf(lowerProgram(proc([], ir`return 7;`)), 0), ["CONST #7", "RETURN"]))

    test("doing both is rejected at the definition", () =>
        assert.throws(
            () => lowerProc(ir`u32 x = 0; if (x) { return; } return 9;`.body),
            /returns a value on some paths and none on others/))
})

describe("return arity — declared", () =>
{
    test("`void` makes it void whatever the body would have deduced", () =>
    {
        const program = lowerProgram(proc([], ir`u32 q = 1; return;`, { returns: "void" }))
        assert.deepEqual(opsOf(program, 0), ["CONST #1", "PUSH", "RETURN"])
    })

    test("returning a value from one is rejected", () =>
        assert.throws(
            () => lowerProgram(proc([], ir`return 3;`, { returns: "void" })),
            /returns none/))

    test("a declared type narrows at the return, the way C narrows in the callee", () =>
        runs(proc([], ir`return ${proc([], ir`return 300;`, { returns: "u8" })}();`), 44))
})

describe("a call to a void procedure", () =>
{
    const voidProc = (): ReturnType<typeof proc> => proc([], ir`u32 q = 1; return;`, { returns: "void" })

    test("is fine as a statement", () => runs(proc([], ir`${voidProc()}(); return 5;`), 5))

    test("is rejected as a value", () =>
        assert.throws(() => lowerProgram(proc([], ir`return ${voidProc()}();`)), /used as a value/))

    test("is rejected nested inside one too", () =>
        assert.throws(() => lowerProgram(proc([], ir`return 1 + ${voidProc()}();`)), /used as a value/))
})

describe("argument types", () =>
{
    test("a typed parameter narrows every argument to it", () =>
        runs(proc([], ir`return ${proc(["u8 n"], ir`return n;`)}(300);`), 44))

    test("an untyped parameter is still a plain word", () =>
        runs(proc([], ir`return ${proc(["n"], ir`return n;`)}(300);`), 300))

    test("the declared type is also the name's type inside the body", () =>
        // `n + 0` is u8 arithmetic promoted to int, so the value survives —
        // what matters is that the narrowing happened once, on entry.
        runs(proc([], ir`return ${proc(["u8 n"], ir`return n + 0;`)}(511);`), 255))
})

describe("a body that runs off its end", () =>
{
    test("closes itself when the procedure returns nothing — C's implicit `return;`", () =>
    {
        const program = lowerProgram(proc([], ir`u32 q = 1;`))
        assert.deepEqual(opsOf(program, 0), ["CONST #1", "PUSH", "RETURN"])
        validateProgram(program)
    })

    test("is rejected when the procedure owes a value", () =>
        assert.throws(
            () => lowerProgram(proc([], ir`u32 x = 0; if (x) { return 1; }`)),
            /runs off the end without one/))

    test("a body that only traps needs nothing added", () =>
        assert.deepEqual(opsOf(lowerProgram(proc([], ir`trap(3);`)), 0), ["TRAP 3"]))
})
