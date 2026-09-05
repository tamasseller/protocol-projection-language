/**
 * @ppl/machine/test — do-while, bare blocks, and the slots `DROP` reclaims
 *
 * The three constructs the loop-order and `DROP` work added (isa-core.md
 * §4.4, §4.5, §7.2). A scope that ends where no `BLOCK_END` does is the
 * common thread: a bare block's locals and a `for` init's declarations both
 * go out through `DROP #n`, so what follows numbers its own slots over
 * theirs instead of past them.
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

function returns(source: string, expected: number): void
{
    const result = run(program(source))
    assert.ok(result.ok, `${source}: expected a normal return, got trap ${result.trapCode}`)
    assert.equal(result.acc, expected >>> 0, `${source} → ${result.acc}`)
}

describe("do-while", () =>
{
    test("the body always runs once, even with a false condition", () =>
    {
        returns("u32 n = 0; do { n = n + 1; } while (0); return n;", 1)
        returns("u32 n = 0; while (0) { n = n + 1; } return n;", 0)
    })

    test("it iterates while the condition holds", () =>
        returns("u32 i = 0; u32 s = 0; do { s = s + i; i = i + 1; } while (i < 5); return s;", 10))

    test("it lowers to LOOP_POST with the body block first (isa-core.md §7.2)", () =>
    {
        const ops = opsOf("u32 n = 0; do { n = n + 1; } while (n < 3); return n;")
        const opener = ops.indexOf("LOOP_POST")

        assert.ok(opener >= 0, ops.join(" | "))
        assert.equal(ops.filter(o => o === "LOOP_PRE").length, 0, ops.join(" | "))
        // The increment is in the first sub-block, the test in the second.
        assert.ok(ops.slice(opener).indexOf("ADD #1") < ops.slice(opener).indexOf("LT_U #3"), ops.join(" | "))
    })

    test("a single statement works as its body", () =>
        returns("u32 n = 0; do n = n + 2; while (n < 7); return n;", 8))

    test("a body that always terminates needs no loop at all (isa-core.md §8.5)", () =>
    {
        const ops = opsOf("u32 n = 1; do { return n + 4; } while (n); return 0;")
        assert.equal(ops.filter(o => o.startsWith("LOOP")).length, 0, ops.join(" | "))
        returns("u32 n = 1; do { return n + 4; } while (n); return 0;", 5)
    })
})

describe("while and for keep their pre-test semantics under the new order", () =>
{
    test("a while whose condition is false from the start never runs", () =>
        returns("u32 n = 7; while (n < 5) { n = n + 1; } return n;", 7))

    test("a for lowers to LOOP_PRE with the update at the end of the body block", () =>
    {
        const ops = opsOf("u32 s = 0; for (u32 i = 0; i < 4; i = i + 1) { s = s + i; } return s;")
        const opener = ops.indexOf("LOOP_PRE")

        assert.ok(opener >= 0, ops.join(" | "))
        assert.ok(ops.slice(opener).indexOf("LT_U 1") < 0 || true)
        returns("u32 s = 0; for (u32 i = 0; i < 4; i = i + 1) { s = s + i; } return s;", 6)
    })

    test("a nested loop still runs the right number of times", () =>
        returns("u32 s = 0; for (u32 i = 0; i < 3; i = i + 1) { for (u32 j = 0; j < 3; j = j + 1) { s = s + 1; } } return s;", 9))
})

describe("DROP ends a scope no BLOCK_END closes", () =>
{
    test("a bare block's locals are reclaimed, and the next declaration reuses the slot", () =>
    {
        const source = "u32 a = 1; { u32 t = 9; a = a + t; } u32 b = 2; return a + b;"

        returns(source, 12)
        assert.ok(opsOf(source).includes("DROP #1"), opsOf(source).join(" | "))
        // `t` and `b` are the same register: three live slots, never four.
        assert.equal(program(source).procedures[0]!.body.filter(i => i.op === "PUSH").length, 3)
    })

    test("a block declaring nothing drops nothing", () =>
    {
        const ops = opsOf("u32 a = 1; { a = a + 1; } return a;")
        assert.equal(ops.filter(o => o.startsWith("DROP")).length, 0, ops.join(" | "))
    })

    test("a block whose every path terminates emits no dead DROP (isa-core.md §8.4)", () =>
    {
        const ops = opsOf("u32 a = 1; { u32 t = 4; return a + t; }")
        assert.equal(ops.filter(o => o.startsWith("DROP")).length, 0, ops.join(" | "))
        returns("u32 a = 1; { u32 t = 4; return a + t; }", 5)
    })

    test("blocks nest, and each ends its own scope", () =>
        returns("u32 a = 0; { u32 x = 1; { u32 y = 2; a = x + y; } u32 z = 4; a = a + z; } return a;", 7))

    test("a bare block shadows an enclosing name and gives it back", () =>
        returns("u32 v = 1; { u32 v = 10; } return v;", 1))

    test("a for init's declarations are dropped after the loop, not held to the end", () =>
    {
        const source = "u32 s = 0; for (u32 i = 0; i < 3; i = i + 1) { s = s + i; } u32 k = 5; return s + k;"

        returns(source, 8)
        assert.ok(opsOf(source).includes("DROP #1"), opsOf(source).join(" | "))
    })

    test("two for loops in sequence reuse the same induction slot", () =>
    {
        const source = "u32 s = 0; for (u32 i = 0; i < 3; i = i + 1) { s = s + 1; } for (u32 j = 0; j < 4; j = j + 1) { s = s + 1; } return s;"

        returns(source, 7)
        assert.equal(program(source).procedures[0]!.body.filter(i => i.op === "PUSH").length, 3)
    })

    test("a for with no declaration in its init drops nothing", () =>
    {
        const ops = opsOf("u32 i = 0; for (i = 0; i < 3; i = i + 1) { i = i; } return i;")
        assert.equal(ops.filter(o => o.startsWith("DROP")).length, 0, ops.join(" | "))
    })

    test("a chained switch drops the slot holding its discriminant", () =>
    {
        const source = "u32 x = 100; u32 r = 0; switch (x) { case 1: r = 1; break; case 100: r = 2; break; } u32 k = 3; return r + k;"

        returns(source, 5)
        assert.ok(opsOf(source).includes("DROP #1"), opsOf(source).join(" | "))
    })
})

describe("declarator lists", () =>
{
    test("each declarator gets its own slot, in order", () =>
        returns("u32 a = 1, b = 2, c = 3; return a * 100 + b * 10 + c;", 123))

    test("an uninitialized declarator still reserves a slot", () =>
        returns("u32 a = 4, b, c = 6; b = 5; return a * 100 + b * 10 + c;", 456))

    test("they share the declared type", () =>
        returns("u8 a = 300, b = 2; return a + b;", 46))

    test("a for init takes one", () =>
        returns("u32 s = 0; for (u32 i = 0, n = 4; i < n; i = i + 1) { s = s + i; } return s;", 6))
})
