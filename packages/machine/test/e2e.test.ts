/**
 * @ppl/machine/test — End-to-end lowering + VM tests
 *
 * Each test: DSL source → parse → lower → VM execute → assert result.
 * Tests are "nontrivial but not complicated" — they verify the full
 * pipeline works for realistic small procedures.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { ir, proc } from "../src/ir"
import { lowerProc, lowerProgram } from "../src/lower"
import { run } from "../src/vm"
import {RtlProgram} from "../src/rtl"

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Lower a DSL procedure body and run it, returning the VM result. */
function runDsl(source: string): { acc: number; ok: boolean; steps: number; trapCode: number | null }
{
    const frag = ir`${source}`
    const lowered = lowerProc(frag.body)
    const prog: RtlProgram = { procedures: [lowered] }
    const result = run(prog)
    return { acc: result.acc, ok: result.ok, steps: result.steps, trapCode: result.trapCode }
}

/** Lower a whole `Procedure` graph (entry + everything it calls) and run
 *  it, also surfacing the assembled program for procedure-table-shape
 *  assertions. */
function runProgram(entry: ReturnType<typeof proc>): { acc: number; ok: boolean; program: RtlProgram }
{
    const program = lowerProgram(entry)
    const result = run(program)
    return { acc: result.acc, ok: result.ok, program }
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

    // Truthy (non-comparison) discriminant with an else arm: BR_TABLE 2 is
    // index-exact, so acc must be normalized to {0,1} regardless of what
    // kind of expression the test is — not just when it's a comparison.
    for(const [x, expected] of [[0, 200], [1, 100], [2, 100], [5, 100], [0x80, 100]] as const)
    {
        test(`if-else, truthy discriminant, x=${x}`, () =>
        {
            assertReturn(`
                u32 x = ${x};
                u32 y = 7;
                if (x) { y = 100; } else { y = 200; }
                return y;
            `, expected)
        })
    }
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

    // A non-last case whose own body is an if/else where both branches
    // return: `closeBlock`'s `alwaysTerminates` (lower.ts) treats this
    // case as needing no trailing BLOCK_END of its own, since every path
    // through it already ends in RETURN — but that BLOCK_END wasn't
    // closing the nested if/else (already fully closed, 2-for-2) in the
    // first place; it was closing *this switch case's own slot* among the
    // switch's N siblings. Omitting it desyncs skipBlocks'/the VM's
    // sibling counting for every case after this one.
    test("non-last case whose body is a fully-terminating if/else", () =>
    {
        assertReturn(`
            u32 x = 1;
            u32 y = 0;
            switch (x)
            {
                case 0:
                    if (y) { return 100; } else { return 200; }
                case 1:  return 300;
                default: return 400;
            }
        `, 300)
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

describe("Unary operators", () =>
{
    // Rule-coverage note: unary:-/unary:~ have no competing rule (there's
    // only ever one tiling for a bare UnaryExpression), so these just need
    // to appear as the root of a returned expression to win via lowerExpr
    // — see test/rule-coverage.test.ts.

    test("negation", () =>
    {
        assertReturn(`
            u32 x = 5;
            return -x;
        `, -5)
    })

    test("bitwise not", () =>
    {
        assertReturn(`
            u32 x = 5;
            return ~x;
        `, ~5)
    })

    // Multi-level rule (rules.ts, "unary:~~:cancel"/"unary:--:cancel"):
    // matches straight through the inner UnaryExpression's raw shape rather
    // than its one-level-reduced RtlNode, so double negation/double bitwise-
    // not costs nothing beyond the operand itself — see isa-rationale.md.
    test("double negation cancels", () =>
    {
        assertReturn(`
            u32 x = 5;
            return -(-x);
        `, 5)
    })
})

describe("Constant folding (rules.ts, \"fold:unary:-\")", () =>
{
    // A negative literal parses as `UnaryExpression("-", Literal(4))`, never
    // a negative `Literal` directly (grammer.pegjs's `PrefixExpression`
    // rule) — `fold:unary:-` collapses it back to a plain constant wherever
    // a `pConst()`-typed position (an IMM_ACC operand, `trap`'s argument)
    // needs to see through it, with no separate pre-pass.

    test("negative literal as an immediate binary operand", () =>
    {
        assertReturn(`
            u32 x = 5;
            return x + -4;
        `, 1)
    })

    test("negative literal as trap's compile-time-constant argument", () =>
    {
        const { ok, trapCode } = runDsl("trap(-1);")
        assert.equal(ok, false)
        assert.equal(trapCode, -1)
    })
})

describe("Builtin calls (clz, revbits)", () =>
{
    // isa-core.md §10.5 — `clz(x)`/`revbits(x)` are DSL-level built-ins with
    // fixed lowering to the CLZ/REVBITS unary ops, parsed as ordinary
    // Identifier(args) calls but not real procedure calls (rules.ts,
    // matcher.ts's BuiltinCall pattern).

    test("clz", () =>
    {
        assertReturn(`
            u32 x = 5;
            return clz(x);
        `, Math.clz32(5))
    })

    test("clz of zero", () =>
    {
        assertReturn("return clz(0);", 32)
    })

    test("revbits", () =>
    {
        assertReturn(`
            u32 x = 1;
            return revbits(x);
        `, 0x80000000)
    })

    test("revbits(clz(x)) — composed builtins", () =>
    {
        assertReturn(`
            u32 x = 5;
            return revbits(clz(x));
        `, 0xb8000000)
    })
})

describe("Builtin calls (trap)", () =>
{
    // isa-core.md §10.5 — `trap(code)` lowers straight to `TRAP #code`.
    // Unlike clz/revbits, `code` must be a compile-time literal (it's
    // encoded into the instruction's own immediate, not tiled to a
    // register location) and `trap` is a terminator, like `return` —
    // lower.ts's `alwaysTerminates` special-cases it so a block ending in
    // one doesn't get a spurious BLOCK_END appended after the TRAP.

    test("unconditional trap", () =>
    {
        const { ok, trapCode } = runDsl("trap(7);")
        assert.equal(ok, false)
        assert.equal(trapCode, 7)
    })

    test("trap as the sole statement of an if-branch (no else)", () =>
    {
        const { ok, trapCode } = runDsl(`
            u32 x = 1;
            if (x == 1)
                trap(3);
            return 0;
        `)
        assert.equal(ok, false)
        assert.equal(trapCode, 3)
    })

    test("trap on one branch, return on the other", () =>
    {
        const { ok, acc } = runDsl(`
            u32 x = 0;
            if (x == 1)
                trap(9);
            else
                return 42;
        `)
        assert.equal(ok, true)
        assert.equal(acc, 42)
    })

    test("falls through past an untaken trap branch", () =>
    {
        const { ok, acc } = runDsl(`
            u32 x = 0;
            if (x == 1)
                trap(9);
            return 5;
        `)
        assert.equal(ok, true)
        assert.equal(acc, 5)
    })

    test("double bitwise-not cancels", () =>
    {
        assertReturn(`
            u32 x = 5;
            return ~~x;
        `, 5)
    })
})

describe("Stack-bridging compound expressions", () =>
{
    // Rule-coverage note: whenever *both* operands of a binary op are
    // themselves complex sub-expressions (not a bare identifier/literal),
    // no register/immediate two-level pattern can consume them directly —
    // the only viable tiling bridges through the stack (stackOperandRules'
    // PEEK_PEEK/POP_ACC combos, rules.ts). These put that path through
    // lowerExpr's actual winner selection (not just tileExpr's candidate
    // search — see test/rule-coverage.test.ts), across a few operator
    // classes and both an acc-demand (`return`) and a tos-demand
    // (declaration initializer) context, since POP_ACC is the sole
    // acc-output stack combo and PEEK_PEEK the sole tos-output one
    // (isa-core.md §4.1).

    test("add: both sides complex, acc demand", () =>
    {
        assertReturn(`
            u32 a = 1;
            u32 b = 2;
            u32 c = 3;
            u32 d = 4;
            return (a + b) + (c + d);
        `, 10)
    })

    test("add: both sides complex, tos demand (via declaration)", () =>
    {
        assertReturn(`
            u32 a = 1;
            u32 b = 2;
            u32 c = 3;
            u32 d = 4;
            u32 r = (a + b) + (c + d);
            return r;
        `, 10)
    })

    // Regression: a `"tos"`-demand initializer wide enough (8+ leaves in a
    // balanced tree) used to net tosDelta=2 instead of 1 — the winning
    // combine's top-level `(tos, acc)` site tied on bytes/length/maxStack
    // between PEEK_PEEK (net-neutral) and the now-removed PEEK_PUSH
    // (net-positive), and the tie broke on worklist order rather than
    // preference (see isa-rationale.md, "Why these choices"). Removing PEEK_PUSH
    // entirely (isa-core.md §4.1 keeps only 5 combos) makes PEEK_PEEK the
    // sole tos-output combo at that site, so the tie can no longer arise.
    // This declaration would have thrown lowerVarDecl's `tosDelta === 1`
    // assertion before that fix; here it must lower and execute cleanly.
    test("add: 8-leaf balanced tree, tos demand (wide-tree regression)", () =>
    {
        assertReturn(`
            u32 v0 = 1;
            u32 v1 = 2;
            u32 v2 = 3;
            u32 v3 = 4;
            u32 v4 = 5;
            u32 v5 = 6;
            u32 v6 = 7;
            u32 v7 = 8;
            u32 sum = ((v0 + v1) + (v2 + v3)) + ((v4 + v5) + (v6 + v7));
            return sum;
        `, 36)
    })

    test("sub (paired/RSUB): both sides complex, acc demand", () =>
    {
        assertReturn(`
            u32 a = 10;
            u32 b = 2;
            u32 c = 3;
            u32 d = 1;
            return (a - b) - (c - d);
        `, 6)
    })

    test("sub (paired/RSUB): both sides complex, tos demand", () =>
    {
        assertReturn(`
            u32 a = 10;
            u32 b = 2;
            u32 c = 3;
            u32 d = 1;
            u32 r = (a - b) - (c - d);
            return r;
        `, 6)
    })

    test("mul: both sides complex, acc demand", () =>
    {
        assertReturn(`
            u32 a = 1;
            u32 b = 2;
            u32 c = 3;
            u32 d = 4;
            return (a + b) * (c + d);
        `, 21)
    })

    test("mul: both sides complex, tos demand", () =>
    {
        assertReturn(`
            u32 a = 1;
            u32 b = 2;
            u32 c = 3;
            u32 d = 4;
            u32 r = (a + b) * (c + d);
            return r;
        `, 21)
    })

    // Deliberately not 0xF0|0x0F=0xFF for (a|b): that's AND's identity
    // element, so the final result would always equal the (c^d)
    // intermediate regardless of whether the compiler reads the correct
    // final slot or a stale one below it — exactly the bug these tests
    // exist to catch (see the tosDelta note above the describe block).
    test("bitwise: both sides complex, acc demand", () =>
    {
        assertReturn(`
            u32 a = 0x0F;
            u32 b = 0x30;
            u32 c = 0xFF;
            u32 d = 0x00;
            return (a | b) & (c ^ d);
        `, 0x3F)
    })

    test("bitwise: both sides complex, tos demand", () =>
    {
        assertReturn(`
            u32 a = 0x0F;
            u32 b = 0x30;
            u32 c = 0xFF;
            u32 d = 0x00;
            u32 r = (a | b) & (c ^ d);
            return r;
        `, 0x3F)
    })

    test("comparison: both sides complex, acc demand", () =>
    {
        assertReturn(`
            u32 a = 1;
            u32 b = 2;
            u32 c = 3;
            u32 d = 4;
            return (a + b) < (c * d);
        `, 1)
    })

    test("comparison: both sides complex, tos demand", () =>
    {
        assertReturn(`
            u32 a = 1;
            u32 b = 2;
            u32 c = 3;
            u32 d = 4;
            u32 r = (a + b) < (c * d);
            return r;
        `, 1)
    })

    test("shift: both sides complex, acc demand", () =>
    {
        assertReturn(`
            u32 a = 1;
            u32 b = 2;
            u32 c = 3;
            u32 d = 1;
            return (a << b) >> (c - d);
        `, 1)
    })

    test("shift: both sides complex, tos demand", () =>
    {
        assertReturn(`
            u32 a = 1;
            u32 b = 2;
            u32 c = 3;
            u32 d = 1;
            u32 r = (a << b) >> (c - d);
            return r;
        `, 1)
    })
})

describe("Rule-coverage gap fill: identifier:tos", () =>
{
    // identifier:tos (a bare identifier used where the ISA demands a tos
    // output — e.g. a declaration initializer) never showed up in any
    // existing e2e case; all decl initializers were literals or compound
    // expressions.
    test("declare from a bare identifier", () =>
    {
        assertReturn(`
            u32 x = 5;
            u32 y = x;
            return y;
        `, 5)
    })
})

describe("Multi-procedure programs (ROADMAP.md item 2)", () =>
{
    test("entry calls a helper procedure", () =>
    {
        const double = proc(["x"], ir`return x + x;`)
        const entry = proc([], ir`return ${double}(21);`)

        const { acc, ok } = runProgram(entry)
        assert.ok(ok, `expected normal return, got trap`)
        assert.equal(acc, 42)
    })

    test("helper procedure with multiple arguments, in order", () =>
    {
        const sub = proc(["a", "b"], ir`return a - b;`)
        const entry = proc([], ir`return ${sub}(50, 8);`)

        const { acc, ok } = runProgram(entry)
        assert.ok(ok)
        assert.equal(acc, 42)
    })

    test("a call's result can initialize a declared local, not just be assigned to one", () =>
    {
        const inc = proc(["x"], ir`return x + 1;`)
        const entry = proc([], ir`
            u32 y = ${inc}(5);
            return y;
        `)

        const { acc, ok } = runProgram(entry)
        assert.ok(ok)
        assert.equal(acc, 6)
    })

    test("transitive calls resolve through more than one hop", () =>
    {
        const inc = proc(["x"], ir`return x + 1;`)
        const twice = proc(["x"], ir`return ${inc}(${inc}(x));`)
        const entry = proc([], ir`return ${twice}(40);`)

        const { acc, ok } = runProgram(entry)
        assert.ok(ok)
        assert.equal(acc, 42)
    })

    test("the same Procedure referenced from two call sites shares one table slot", () =>
    {
        const square = proc(["x"], ir`return x * x;`)
        const entry = proc([], ir`return ${square}(4) + ${square}(5);`)

        const { acc, ok, program } = runProgram(entry)
        assert.ok(ok)
        assert.equal(acc, 4 * 4 + 5 * 5)
        // entry + square — not three slots, even though square is called twice.
        assert.equal(program.procedures.length, 2)
    })

    test("a procedure body assembled via spliced IrFragment[] (ir.ts's computed-arity pattern) is callable like any other", () =>
    {
        const step = (n: number) => proc(["acc"], ir`return acc + ${n};`)
        const steps = [1, 2, 3].map(step)

        const body = ir`
            u32 acc = 0;
            ${steps.map(s => ir`acc = ${s}(acc);`)}
            return acc;
        `
        const entry = proc([], body)

        const { acc, ok, program } = runProgram(entry)
        assert.ok(ok)
        assert.equal(acc, 1 + 2 + 3)
        assert.equal(program.procedures.length, 4) // entry + the three step procedures
    })

    test("a call to an unresolvable name fails to lower, rather than crashing the tiler", () =>
    {
        const entry = proc([], ir`return doesNotExist(1);`)
        assert.throws(() => lowerProgram(entry), /Failed to lower return expression/)
    })
})