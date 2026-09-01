/**
 * @ppl/machine/test — Declarations, scopes, call arity and literals
 *
 * A register index comes from how far TOS has grown (isa-core.md §8.6), so
 * a name and a slot have to stay in step: every declaration pushes, and
 * every push has to be a name nothing else already answers to. These are
 * the cases where that used to drift silently.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { ir, proc } from "../src/ir"
import { lowerProc, lowerProgram } from "../src/lower"
import { validateProgram } from "../src/validate"
import { run } from "../src/vm"
import type { RtlProgram } from "../src/rtl"

function program(source: string): RtlProgram
{
    const prog: RtlProgram = { procedures: [lowerProc(ir`${source}`.body)] }
    validateProgram(prog)
    return prog
}

function returns(source: string, expected: number): void
{
    const result = run(program(source))
    assert.ok(result.ok, `${source}: expected a normal return, got trap ${result.trapCode}`)
    assert.equal(result.acc, expected >>> 0, `${source} → ${result.acc}`)
}

describe("declarations", () =>
{
    test("a second declaration of the same name in one scope is rejected", () =>
        assert.throws(() => program("u32 a = 1; u32 a = 2; return a;"),
            /Redeclaration of 'a' in the same scope/))

    // A nested scope has a map of its own, and its block reclaims the slot
    // at `BLOCK_END` — so shadowing there is fine, and the outer name is
    // untouched afterwards.
    test("a nested scope may shadow", () =>
        returns("u32 a = 1; if(a) { u32 a = 2; } return a;", 1))

    test("a local may not shadow a procedure argument", () =>
    {
        const callee = proc(["x"], ir`u32 x = 5; return x;`)
        assert.throws(() => lowerProgram(proc([], ir`return ${callee}(9);`)),
            /Redeclaration of 'x' in the same scope/)
    })

    test("a declaration with no initializer reserves a zeroed slot", () =>
    {
        returns("u32 a; return a;", 0)
        returns("u32 a; a = 7; return a;", 7)
    })

    test("an uninitialized declaration still numbers what follows it", () =>
        returns("u32 a; u32 b = 5; a = 2; return a + b;", 7))
})

describe("for-init scope", () =>
{
    // C scopes a `for` init's declarations to the loop, but their registers
    // live until the enclosing block ends — nothing pops them at the
    // back-edge. So the name goes out of view while the slot does not.
    test("the name is gone after the loop", () =>
        assert.throws(() => program("u32 s = 0; for(u32 i = 0; i < 2; i = i + 1) { s += 1; } return i;"),
            /Failed to lower/))

    test("and may be declared again", () =>
        returns("u32 s = 0; for(u32 i = 0; i < 2; i = i + 1) { s += 1; } u32 i = 5; return i * 10 + s;", 52))

    test("two loops may each declare it", () =>
        returns("u32 s = 0; for(u32 i = 0; i < 2; i = i + 1) { s += 1; } for(u32 i = 0; i < 3; i = i + 1) { s += 10; } return s;", 32))

    test("a later declaration numbers above the loop's own slot", () =>
        returns("u32 s = 0; for(u32 i = 0; i < 3; i = i + 1) { s += i; } u32 z = 4; return s * 10 + z;", 34))

    test("an omitted test loops forever, as C's for(;;) does", () =>
        returns("u32 s = 9; for(u32 i = 0; ; i = i + 1) { if(i > 2) { return i; } } return s;", 3))
})

describe("call arity", () =>
{
    const two = () => proc(["a", "b"], ir`return a - b;`)

    test("a matching call", () =>
    {
        const prog = lowerProgram(proc([], ir`return ${two()}(9, 2);`))
        validateProgram(prog)
        assert.equal(run(prog).acc, 7)
    })

    test("too many arguments", () =>
        assert.throws(() => lowerProgram(proc([], ir`return ${two()}(1, 2, 3);`)),
            /passes 3 argument\(s\), but it takes 2/))

    test("too few arguments", () =>
        assert.throws(() => lowerProgram(proc([], ir`return ${two()}(1);`)),
            /passes 1 argument\(s\), but it takes 2/))

    test("arguments to a procedure that takes none", () =>
        assert.throws(() => lowerProgram(proc([], ir`return ${proc([], ir`return 7;`)}(1);`)),
            /passes 1 argument\(s\), but it takes 0/))
})

describe("integer literals", () =>
{
    test("decimal, hex and binary", () =>
    {
        returns("return 42;", 42)
        returns("return 0xff;", 255)
        returns("return 0b1011;", 11)
        returns("return 0B11 + 0X10;", 19)
        returns("return 4294967295;", 0xffffffff)
    })

    // C would read this as octal. Rejecting the spelling keeps the DSL a
    // subset of C rather than a dialect that disagrees about a value.
    test("a leading zero is rejected rather than read as octal", () =>
    {
        returns("return 0;", 0)
        assert.throws(() => program("return 010;"), /leading zeros are not allowed/)
    })
})
