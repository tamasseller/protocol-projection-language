/**
 * @ppl/machine/test — Algorithm proofing / stress tests
 *
 * Rule coverage (coverage-sweep.test.ts) proves each *individual* rule
 * fires and produces correct isolated behavior, but says nothing about
 * whether long chains of decisions compose correctly end-to-end — nested
 * loops, in-loop mutation of several locals, loop-condition expressions
 * that themselves need stack bridging, and so on. This file lowers and
 * executes four short, well-known, "nothing up my sleeve" algorithms
 * (chosen for exercising a different loop/branch shape each) and checks
 * every result against a plain-JS reference across a wide input sweep,
 * rather than a couple of hand-picked values — cheap to do, and far more
 * convincing that the whole pipeline (parse → lower → VM) composes
 * correctly than a handful of spot checks would be.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { ir } from "../src/ir"
import { lowerProc } from "../src/lower"
import { run } from "../src/vm"
import { RtlProgram } from "../src/rtl"

function runDsl(source: string): number
{
    const frag = ir`${source}`
    const proc = lowerProc(frag.body)
    const prog: RtlProgram = { procedures: [proc] }
    const result = run(prog)
    assert.ok(result.ok, `expected normal return, got trap (source below)\n${source}`)
    return result.acc
}

describe("Algorithm proofing", () =>
{
    // ── Collatz sequence length ──────────────────────────────────────────
    //
    // Plain while + if/else, mutating one accumulator based on the parity
    // of another — the simplest nested-decision loop shape.

    test("Collatz: steps to reach 1, n = 1..2000", () =>
    {
        function reference(n: number): number
        {
            let steps = 0
            while (n !== 1)
            {
                n = (n & 1) === 0 ? n / 2 : (n * 3 + 1) >>> 0
                steps++
            }
            return steps
        }

        for (let n = 1; n <= 2000; n++)
        {
            const got = runDsl(`
                u32 n = ${n};
                u32 steps = 0;
                while (n != 1)
                {
                    if ((n & 1) == 0)
                        n = n >> 1;
                    else
                        n = n * 3 + 1;
                    steps = steps + 1;
                }
                return steps;
            `)
            assert.equal(got, reference(n), `collatz(${n}): expected ${reference(n)}, got ${got}`)
        }
    })

    // ── Stein's algorithm (binary GCD) ───────────────────────────────────
    //
    // Nested while loops, an in-loop conditional swap via a freshly
    // declared block-scoped local, and a final shift — the most
    // structurally complex control flow of the four. Restricted to
    // a, b > 0: the algorithm's own zero-handling needs an explicit early
    // return neither the DSL source nor the reference below bothers with,
    // since 0 isn't a meaningful GCD operand for this exercise's purpose.

    test("Stein's algorithm (binary GCD), a,b = 1..30", () =>
    {
        function reference(a: number, b: number): number
        {
            let shift = 0
            while (((a | b) & 1) === 0) { a >>>= 1; b >>>= 1; shift++ }
            while ((a & 1) === 0) a >>>= 1
            while (b !== 0)
            {
                while ((b & 1) === 0) b >>>= 1
                if (a > b) { const t = a; a = b; b = t }
                b -= a
            }
            return a << shift
        }

        for (let a = 1; a <= 30; a++)
        {
            for (let b = 1; b <= 30; b++)
            {
                const got = runDsl(`
                    u32 a = ${a};
                    u32 b = ${b};
                    u32 shift = 0;
                    while (((a | b) & 1) == 0)
                    {
                        a = a >> 1;
                        b = b >> 1;
                        shift = shift + 1;
                    }
                    while ((a & 1) == 0)
                        a = a >> 1;
                    while (b != 0)
                    {
                        while ((b & 1) == 0)
                            b = b >> 1;
                        if (a > b)
                        {
                            u32 t = a;
                            a = b;
                            b = t;
                        }
                        b = b - a;
                    }
                    return a << shift;
                `)
                const want = reference(a, b)
                assert.equal(got, want, `gcd(${a},${b}): expected ${want}, got ${got}`)
            }
        }
    })

    // ── Bitwise integer square root ──────────────────────────────────────
    //
    // Digit-by-digit restoring division shape: a setup loop that finds the
    // highest relevant bit pair, then a main loop combining a conditional
    // subtract-and-accumulate with two independent shifts every iteration.

    test("Bitwise integer square root, n = 0..3000 plus boundary values", () =>
    {
        function reference(n: number): number
        {
            return Math.floor(Math.sqrt(n))
        }

        const inputs = [
            ...Array.from({length: 3001}, (_, i) => i),
            (1 << 15) - 1, 1 << 15, (1 << 16) - 1, 1 << 16,
            (1 << 30), (2 ** 31) - 1, 4294836224, 4294967295,
        ]

        for (const n of inputs)
        {
            const got = runDsl(`
                u32 n = ${n};
                u32 res = 0;
                u32 bit = 1 << 30;
                while (bit > n)
                    bit = bit >> 2;
                while (bit != 0)
                {
                    if (n >= res + bit)
                    {
                        n = n - (res + bit);
                        res = res + (bit << 1);
                    }
                    res = res >> 1;
                    bit = bit >> 2;
                }
                return res;
            `)
            const want = reference(n)
            assert.equal(got, want, `isqrt(${n}): expected ${want}, got ${got}`)
        }
    })

    // ── Russian peasant multiplication ───────────────────────────────────
    //
    // The simplest shape of the four: one loop, one parity check, two
    // independent shifts, one conditional accumulate. Kept to inputs whose
    // true product fits in 32 bits so the reference (plain `a*b`) doesn't
    // need its own wraparound handling to compare correctly.

    test("Russian peasant multiplication, a,b = 0..200", () =>
    {
        for (let a = 0; a <= 200; a += 5)
        {
            for (let b = 0; b <= 200; b += 5)
            {
                const got = runDsl(`
                    u32 a = ${a};
                    u32 b = ${b};
                    u32 result = 0;
                    while (a != 0)
                    {
                        if ((a & 1) != 0)
                            result = result + b;
                        a = a >> 1;
                        b = b << 1;
                    }
                    return result;
                `)
                const want = a * b
                assert.equal(got, want, `${a} * ${b}: expected ${want}, got ${got}`)
            }
        }
    })
})
