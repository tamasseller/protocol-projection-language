/**
 * @ppl/machine/test — Signed types, end to end
 *
 * Every case runs the whole pipeline (source → types.ts → lowering → VM)
 * and is chosen so the signed and unsigned answers *differ* — a probe whose
 * two candidates agree would pass whichever opcode the lowerer picked, and
 * would test nothing.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { ir } from "../src/ir"
import { lowerProc } from "../src/lower"
import { run } from "../src/vm"
import { format } from "../src/rtl"
import type { RtlProgram } from "../src/rtl"

function lower(source: string)
{
    return lowerProc(ir`${source}`.body)
}

/** The whole lowered body, as `format`ed mnemonics. */
function opsOf(source: string): string[]
{
    return lower(source).body.map(format)
}

function returns(source: string): number
{
    const result = run({ procedures: [lower(source)] } as RtlProgram)
    assert.ok(result.ok, `${source}: expected a normal return, got a trap`)
    return result.acc
}

describe("types — which opcode a comparison picks", () =>
{
    test("i32 operands compare signed", () =>
    {
        assert.ok(opsOf("i32 a = 0; return a < 5;").includes("LT_S #5"))
    })

    test("a u32 operand on either side makes it unsigned", () =>
    {
        assert.ok(opsOf("u32 a = 0; return a < 5;").includes("LT_U #5"))
        assert.ok(opsOf("i32 a = 0; u32 b = 5; return a < b;").some(o => o.startsWith("LT_U")))
    })

    test("narrow types promote to i32, so u8 < u8 is a *signed* compare", () =>
    {
        // Surprising but correct C: integer promotion sends u8 to int. It
        // is also harmless, because a u8 variable holds an already
        // zero-extended word — which is what the UXTB below guarantees.
        const ops = opsOf("u8 a = 1; u8 b = 2; return a < b;")
        assert.ok(ops.some(o => o.startsWith("LT_S")), ops.join(" "))
        assert.ok(ops.includes("UXTB"), ops.join(" "))
    })
})

describe("types — shifts take their signedness from the left operand alone", () =>
{
    // C's usual arithmetic conversions do not apply to << and >>.
    test("i32 >> u32 is still an arithmetic shift", () =>
    {
        assert.ok(opsOf("i32 a = 0; u32 b = 1; return a >> b;").some(o => o.startsWith("ASR")))
    })

    test("u32 >> i32 is still a logical one", () =>
    {
        assert.ok(opsOf("u32 a = 0; i32 b = 1; return a >> b;").some(o => o.startsWith("SHR")))
    })

    test("and the two disagree on a negative value", () =>
    {
        assert.equal(returns("i32 a = 0 - 8; return a >> 1;"), 0xfffffffc)
        assert.equal(returns("u32 a = 0 - 8; return a >> 1;"), 0x7ffffffc)
    })
})

describe("types — narrowing on the way into a variable", () =>
{
    test("u8 keeps the low byte", () =>
    {
        assert.equal(returns("u8 x = 300; return x;"), 44)
    })

    test("i8 sign-extends it", () =>
    {
        assert.equal(returns("i8 x = 200; return x;"), 0xffffffc8)
    })

    test("u16 and i16 do the same at sixteen bits", () =>
    {
        assert.equal(returns("u16 x = 0x1beef; return x;"), 0xbeef)
        assert.equal(returns("i16 x = 0x1beef; return x;"), 0xffffbeef)
    })

    test("a plain assignment narrows too, not just the declaration", () =>
    {
        assert.equal(returns("u8 x = 0; x = 511; return x;"), 255)
    })

    test("a u32 or i32 declaration costs no extend at all", () =>
    {
        for(const t of ["u32", "i32"])
        {
            const ops = opsOf(`${t} x = 300; return x;`)
            assert.ok(!ops.some(o => o.endsWith("XTB") || o.endsWith("XTH")), ops.join(" "))
        }
    })
})

describe("types — explicit casts", () =>
{
    test("a cast narrows an expression in place", () =>
    {
        assert.equal(returns("u32 x = 0xdeadbeef; return u8(x);"), 0xef)
        assert.equal(returns("u32 x = 0xdeadbeef; return i8(x);"), 0xffffffef)
        assert.equal(returns("u32 x = 0xdeadbeef; return u16(x);"), 0xbeef)
        assert.equal(returns("u32 x = 0xdeadbeef; return i16(x);"), 0xffffbeef)
    })

    test("a cast also decides the signedness of what reads it", () =>
    {
        // i8(x) is i8, which promotes to i32 — so this compares signed and
        // the value is negative. Without the cast both sides are u32.
        assert.equal(returns("u32 x = 200; return i8(x) < 0;"), 1)
        assert.equal(returns("u32 x = 200; return x < 0;"), 0)
    })

    test("a widening cast emits nothing", () =>
    {
        // The declaration is `i32`, so the only extend that could appear
        // here would be the cast's own.
        const ops = opsOf("i32 x = 1; return u32(x);")
        assert.ok(!ops.some(o => o.endsWith("XTB") || o.endsWith("XTH")), ops.join(" "))
    })
})

describe("types — a program whose answer depends on the whole rule", () =>
{
    test("clamping a signed delta", () =>
    {
        // i16 arithmetic on two bytes: the difference is negative, the
        // comparison must see it as such, and the result narrows back.
        const source = `
            u8 lo = 10;
            u8 hi = 250;
            i16 delta = lo - hi;
            if (delta < 0) { return 0 - delta; }
            return delta;
        `
        assert.equal(returns(source), 240)
    })
})
