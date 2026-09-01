/**
 * @ppl/machine/test — What a failed lowering says
 *
 * A rule that does not apply returns no candidate, so the tiler cannot
 * tell "this operator has no opcode" from "this name resolves to nothing"
 * from "these operands could not be arranged" — every one of them just
 * leaves zero candidates. `explainFailure` (expr.ts) reconstructs the
 * reason from the source, and these are the reasons it has to get right.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { ir, proc } from "../src/ir"
import { lowerProc, lowerProgram } from "../src/lower"

const lower = (source: string) => () => lowerProc(ir`${source}`.body)

describe("diagnostics — the cause", () =>
{
    test("an operator with no opcode is named, with why", () =>
    {
        assert.throws(lower("u32 a = 7; return a / 2;"),
            /no lowering for '\/' — the ISA has no divide/)
        assert.throws(lower("u32 a = 7; return a % 2;"),
            /no lowering for '%' — the ISA has no divide/)
    })

    test("a compound assignment reports the operator it desugars to", () =>
        assert.throws(lower("u32 a = 7; a /= 2; return a;"),
            /no lowering for '\/'/))

    test("an unknown variable is named", () =>
    {
        assert.throws(lower("return nope;"), /unknown variable 'nope'/)
        assert.throws(lower("return nope + 1;"), /Unknown variable 'nope'/)
    })

    test("a name that has gone out of scope reads as unknown", () =>
        assert.throws(lower("u32 s = 0; for(u32 i = 0; i < 2; i = i + 1) { s += 1; } return i;"),
            /unknown variable 'i'/))

    test("an unresolvable call is named", () =>
        assert.throws(lower("return nosuch(1);"),
            /unknown procedure or built-in 'nosuch'/))

    test("a built-in called with the wrong number of arguments", () =>
    {
        assert.throws(lower("u32 a = 1; return clz(a, 2);"), /'clz' takes 1 argument, not 2/)
        assert.throws(lower("return revbits();"), /'revbits' takes 1 argument, not 0/)
    })

    // The ruleset is what knows this: `trap`'s own pattern demands a
    // constant, so the message comes from the rule, not a hardcoded list —
    // an extension's call-shaped ops get the same treatment.
    test("a built-in needing a constant, given an expression", () =>
        assert.throws(lower("u32 a = 1; trap(a);"),
            /'trap' needs a compile-time constant/))

    test("a value that no tiling can put where the site needs it", () =>
        assert.throws(lower("u32 x = trap(1); return x;"),
            /no tiling leaves its value in tos/))
})

describe("diagnostics — where it points", () =>
{
    test("the innermost cause wins, not the outermost failure", () =>
        assert.throws(lower("u32 a = 1; return (a + 1) * (a / 2) - 3;"),
            /no lowering for '\/'/))

    test("every site says which expression it was lowering", () =>
    {
        assert.throws(lower("u32 a = 1; if(a / 2) { return 1; } return 0;"),
            /Failed to lower if test expression:/)
        assert.throws(lower("u32 a = 1; u32 b = a % 3; return b;"),
            /Failed to lower variable initializer for b:/)
        assert.throws(lower("u32 a = 1; while(a / 2) { a = 0; } return a;"),
            /Failed to lower while test expression:/)
        assert.throws(lower("u32 a = 1; switch(a / 2) { case 0: return 1; default: return 2; }"),
            /Failed to lower switch discriminant expression:/)
        assert.throws(lower("u32 a = 1; a / 2;"),
            /Failed to lower expression statement:/)
        assert.throws(lower("u32 a = 1; return a / 2;"),
            /Failed to lower return expression:/)
    })

    test("a ternary's own parts name themselves", () =>
    {
        assert.throws(lower("u32 a = 1; return a ? a / 2 : 1;"), /Failed to lower ternary arm:/)
        assert.throws(lower("u32 a = 1; return (a / 2) ? 1 : 2;"), /Failed to lower ternary condition:/)
    })

    test("a call argument points at the argument", () =>
        assert.throws(lower("u32 a = 1; return clz(a / 2);"),
            /no lowering for '\/'/))

    test("a mismatched call arity is reported before any of this", () =>
    {
        const two = proc(["a", "b"], ir`return a - b;`)
        assert.throws(() => lowerProgram(proc([], ir`return ${two}(1);`)),
            /passes 1 argument\(s\), but it takes 2/)
    })
})
