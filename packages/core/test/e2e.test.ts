/**
 * @ppl/core/test — End-to-end lowering + VM tests
 *
 * Each test: DSL source → parse → lower → VM execute → assert result.
 * Tests are "nontrivial but not complicated" — they verify the full
 * pipeline works for realistic small procedures.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { ir } from "../src/ir"
import { lowerProc } from "../src/machine/lower"
import { run } from "../src/machine/vm"
import {RtlProgram} from "../src/machine/rtl"

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Lower a DSL procedure body and run it, returning the VM result. */
function runDsl(source: string): { acc: number; ok: boolean; steps: number }
{
    const frag = ir`${source}`
    const proc = lowerProc(frag.body)
    const prog: RtlProgram = { procedures: [proc] }
    const result = run(prog)
    return { acc: result.acc, ok: result.ok, steps: result.steps }
}

/** Assert a DSL procedure returns the expected value. */
function assertReturn(source: string, expected: number): void
{
    const { acc, ok } = runDsl(source)
    assert.ok(ok, `expected normal return, got trap`)
    assert.equal(acc, expected >>> 0,
        `${source.trim()} → expected ${expected >>> 0}, got ${acc}`)
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Simple returns", () =>
{
    test("literal constant", () => assertReturn("return 42;", 42))
    test("expression", () => assertReturn("return 2 + 3 * 4;", 14))
    test("compound expression", () => assertReturn("return (10 - 3) * (2 + 2);", 28))
    test("bitwise", () => assertReturn("return 0xFF & 0x0F;", 0x0F))
    test("shift", () => assertReturn("return 1 << 5;", 32))
})

describe("Variables", () =>
{
    test("declare and use", () =>
    {
        assertReturn(`
            u32 x = 7;
            return x + 3;
        `, 10)
    })

    test("declare and mutate", () =>
    {
        assertReturn(`
            u32 x = 5;
            x = x * 2;
            return x;
        `, 10)
    })

    test("multiple variables", () =>
    {
        assertReturn(`
            u32 a = 3;
            u32 b = 4;
            return a + b;
        `, 7)
    })

    test("declare with compound init", () =>
    {
        assertReturn(`
            u32 a = 10 + 5;
            u32 b = a * 2;
            return b;
        `, 30)
    })
})

describe("If / else", () =>
{
    test("if-true", () =>
    {
        assertReturn(`
            u32 x = 1;
            if (x)
                return 42;
            return 0;
        `, 42)
    })

    test("if-false", () =>
    {
        assertReturn(`
            u32 x = 0;
            if (x)
                return 99;
            return 77;
        `, 77)
    })

    test("if-else", () =>
    {
        assertReturn(`
            u32 x = 5;
            if (x > 3)
                return 100;
            else
                return 200;
        `, 100)
    })

    test("if-else reverse", () =>
    {
        assertReturn(`
            u32 x = 2;
            if (x > 3)
                return 100;
            else
                return 200;
        `, 200)
    })
})

describe("While loop", () =>
{
    test("countdown", () =>
    {
        assertReturn(`
            u32 n = 5;
            while (n > 0)
                n = n - 1;
            return n;
        `, 0)
    })

    test("sum 1 to n", () =>
    {
        assertReturn(`
            u32 sum = 0;
            u32 i = 1;
            while (i <= 5)
            {
                sum = sum + i;
                i = i + 1;
            }
            return sum;
        `, 15)
    })

    test("product (factorial 5)", () =>
    {
        assertReturn(`
            u32 result = 1;
            u32 i = 5;
            while (i > 1)
            {
                result = result * i;
                i = i - 1;
            }
            return result;
        `, 120)
    })
})

describe("For loop", () =>
{
    test("classic for", () =>
    {
        assertReturn(`
            u32 sum = 0;
            for (u32 i = 0; i < 10; i = i + 1)
                sum = sum + i;
            return sum;
        `, 45)
    })
})

describe("Nested control flow", () =>
{
    test("nested if", () =>
    {
        assertReturn(`
            u32 a = 1;
            u32 b = 2;
            if (a)
                if (b)
                    return 99;
            return 0;
        `, 99)
    })

    test("if inside while", () =>
    {
        assertReturn(`
            u32 count = 0;
            u32 n = 0;
            while (n < 20)
            {
                n = n + 1;
                if ((n & 1) == 0)
                    count = count + 1;
            }
            return count;
        `, 10) // 10 even numbers in 1..20
    })

    test("loop with early return", () =>
    {
        assertReturn(`
            u32 i = 0;
            while (i < 100)
            {
                i = i + 1;
                if (i == 7)
                    return 77;
            }
            return 0;
        `, 77)
    })
})

describe("Switch", () =>
{
    test("switch three cases", () =>
    {
        assertReturn(`
            u32 x = 1;
            switch (x)
            {
                case 0:  return 10;
                case 1:  return 20;
                default: return 30;
            }
        `, 20)
    })

    test("switch default", () =>
    {
        assertReturn(`
            u32 x = 99;
            switch (x)
            {
                case 0:  return 10;
                case 1:  return 20;
                default: return 30;
            }
        `, 30)
    })
})

describe("Complex expressions", () =>
{
    test("bit manipulation", () =>
    {
        assertReturn(`
            u32 x = 0x12;
            u32 y = 0x34;
            return (x << 8) | y;
        `, 0x1234)
    })

    test("conditional chain", () =>
    {
        assertReturn(`
            u32 x = 42;
            if (x < 20) return 1;
            if (x < 50) return 2;
            return 3;
        `, 2)
    })

    test("multiply-accumulate", () =>
    {
        assertReturn(`
            u32 acc = 3;
            acc = acc + 2 * 3;
            acc = acc * 2;
            return acc;
        `, 18) // (3 + 6) * 2 = 18
    })
})