/**
 * @ppl/core/test — Exhaustive tiling tests
 *
 * Tests `tileExpr` directly: for each DSL expression, asserts that specific
 * expected tilings are present among the exhaustive variant set, and that
 * the variant count meets a minimum (exploration is happening).
 *
 * `lowerExpr` (cost-based selection) is deliberately untested here — it will
 * be covered separately once the cost model and tie-breaking stabilize.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { ir } from "../src/ir"
import { DEFAULT_RULESET } from "../src/machine/rules"
import { tileExpr } from "../src/machine/orchestrator"
import { format, type OutputLocation } from "../src/machine/rtl"
import type { EastExpression } from "../src/machine/east"
import type { ReturnStatement } from "../src/machine/ast"

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract the `return` expression from a source string. */
function exprOf(source: string): EastExpression
{
    const frag = ir`${source}`
    const stmt = frag.body[0] as ReturnStatement
    return stmt.argument! as EastExpression
}

/**
 * Assert that `tileExpr` produces variants for `return <expr>;`.
 *
 * - `minCount`: the variant set must have at least this many entries.
 * - `contains`: each entry must appear as an exact formatted-instruction-list
 *   match in some variant.
 * - `containsOp`: each opcode string must appear in at least one variant's
 *   fragment (structural check for compound expressions).
 * - `containsCombo`: at least one variant must contain an instruction with
 *   the given combo (structural check for stack-bridge cases).
 */
interface VariantExpectations
{
    minCount?: number
    contains?: string[][]
    containsOp?: string[]
    containsCombo?: string[]
}

function checkVariants(source: string, exp: VariantExpectations): void
{
    const expr = exprOf(source)
    const variants = tileExpr(expr, DEFAULT_RULESET)
    if (variants.length === 0)
        assert.fail(`No viable tiling for: ${source}`)

    if (exp.minCount !== undefined && variants.length < exp.minCount)
        assert.fail(
            `${source}: expected ≥${exp.minCount} variants, got ${variants.length}`)

    // Format every variant once.
    const formatted = variants.map(v => v.fragment.map(format))

    // Each `contains` entry must appear exactly in some variant.
    if (exp.contains)
    {
        for (const want of exp.contains)
        {
            const found = formatted.some(f =>
                f.length === want.length && f.every((s, i) => s === want[i]))
            if (!found)
                assert.fail(
                    `${source}: expected variant [${want.join(", ")}] not found.\n` +
                    `Got ${variants.length} variants.`)
        }
    }

    // Each `containsOp` opcode must appear in at least one variant.
    if (exp.containsOp)
    {
        for (const wantOp of exp.containsOp)
        {
            const found = variants.some(v =>
                v.fragment.some(i => i.op === wantOp))
            if (!found)
                assert.fail(
                    `${source}: expected opcode ${wantOp} in some variant, none found.`)
        }
    }

    // Each `containsCombo` combo must appear in at least one variant.
    if (exp.containsCombo)
    {
        for (const wantCombo of exp.containsCombo)
        {
            const found = variants.some(v =>
                v.fragment.some(i => "combo" in i && i.combo === wantCombo))
            if (!found)
                assert.fail(
                    `${source}: expected combo ${wantCombo} in some variant, none found.`)
        }
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Leaf tiling", () =>
{
    test("literal → acc and tos variants", () =>
    {
        checkVariants("return 42;", {
            minCount: 2,
            contains: [
                // leafRules() literal→acc: pLiteral() → CONST(42)
                ["MOVE #42"],
                // leafRules() literal→tos: pLiteral() → CONST(42); PUSH()
                ["MOVE #42", "PUSH"],
            ],
        })
    })

    test("identifier → acc and tos variants", () =>
    {
        checkVariants("return x;", {
            minCount: 2,
            contains: [
                // leafRules() id→acc: pIdentifier() → LOAD("x")
                ["LOAD x"],
                // leafRules() id→tos: pIdentifier() → LOAD("x"); PUSH()
                ["LOAD x", "PUSH"],
            ],
        })
    })

    test("literal 0 (per-op inline for MOVE)", () =>
    {
        checkVariants("return 0;", {
            minCount: 2,
            contains: [
                // leafRules() literal→acc: CONST(0); MOVE's per-op inline literal is 0
                ["MOVE #0"],
                // leafRules() literal→tos: CONST(0); PUSH()
                ["MOVE #0", "PUSH"],
            ],
        })
    })
})

describe("Unary tiling", () =>
{
    test("negation", () =>
    {
        checkVariants("return -x;", {
            minCount: 1,
            contains: [
                // unaryRules() pUnary("-", pRtl("acc")) → child(LOAD x) + bare("NEG")
                ["LOAD x", "NEG"],
            ],
        })
    })

    test("bitwise not", () =>
    {
        checkVariants("return ~x;", {
            minCount: 1,
            contains: [
                // unaryRules() pUnary("~", pRtl("acc")) → child(LOAD x) + bare("NOT")
                ["LOAD x", "NOT"],
            ],
        })
    })

    test("double negation", () =>
    {
        checkVariants("return ~~x;", {
            minCount: 1,
            contains: [
                // outer unaryRules() pUnary("~", pRtl("acc")) applied to inner NOT's RtlNode
                ["LOAD x", "NOT", "NOT"],
            ],
        })
    })
})

describe("Binary — register operand", () =>
{
    test("x + y (commutative: both orders + stack variants)", () =>
    {
        checkVariants("return x + y;", {
            minCount: 8,
            contains: [
                // regOperandRules direct: pBinary("+", pRtl("acc"), pIdentifier(y)) → LOAD x; ADD y
                ["LOAD x", "ADD y"],
                // regOperandRules flipped: pBinary("+", pIdentifier(x), pRtl("acc")) → LOAD y; ADD x
                ["LOAD y", "ADD x"],
                // stackOperandRules POP_ACC: eval y→acc; PUSH; eval x→acc; ADD [--tos] (pickBinaryOrder)
                ["LOAD y", "PUSH", "LOAD x", "ADD [--tos]"],
                // stackOperandRules POP_ACC: opposite evaluation order
                ["LOAD x", "PUSH", "LOAD y", "ADD [--tos]"],
            ],
        })
    })

    test("x - y (paired: direct SUB + flipped RSUB + stack)", () =>
    {
        checkVariants("return x - y;", {
            minCount: 8,
            contains: [
                // regOperandRules direct: pBinary("-", pRtl("acc"), pIdentifier(y)) → LOAD x; SUB y
                ["LOAD x", "SUB y"],
                // regOperandRules flipped: pBinary("-", pIdentifier(x), pRtl("acc")) → LOAD y; RSUB x
                // RSUB x computes x - acc = x - y, yielding the correct result
                ["LOAD y", "RSUB x"],
            ],
        })
    })

    test("x & y (commutative)", () =>
    {
        checkVariants("return x & y;", {
            minCount: 4,
            contains: [
                // regOperandRules direct
                ["LOAD x", "AND y"],
                // regOperandRules flipped (commutative)
                ["LOAD y", "AND x"],
            ],
        })
    })

    test("x << y (strict: direct only, no flip)", () =>
    {
        checkVariants("return x << y;", {
            minCount: 4,
            contains: [
                // regOperandRules direct only; SHL is strict (no commutative/paired flip)
                ["LOAD x", "SHL y"],
            ],
        })
    })
})

describe("Binary — immediate operand", () =>
{
    test("x + 1 (per-op inline literal)", () =>
    {
        checkVariants("return x + 1;", {
            minCount: 4,
            contains: [
                // immOperandRules direct: pBinary("+", pRtl("acc"), pLiteral(1)) — acc output variant
                // 1 is ADD's per-op inline literal (§17.3), so this is 1 byte for the ADD itself
                ["LOAD x", "ADD #1"],
            ],
        })
    })

    test("x + 5 (imm-extended + flipped)", () =>
    {
        checkVariants("return x + 5;", {
            minCount: 4,
            contains: [
                // immOperandRules direct: 5 ≠ ADD's per-op inline (1) → imm-extended (2B)
                ["LOAD x", "ADD #5"],
                // regOperandRules flipped: pBinary("+", pIdentifier(x), pRtl("acc"))
                // right=CONST(5), left=raw x → MOVE #5; ADD x (commutative, 5+x = x+5)
                ["MOVE #5", "ADD x"],
            ],
        })
    })

    test("5 + x (commutative flip)", () =>
    {
        checkVariants("return 5 + x;", {
            minCount: 4,
            contains: [
                // immOperandRules direct: pBinary("+", pRtl("acc"), pLiteral(x) no—x is Identifier)
                // Actually immOperandRules direct: left=CONST(5), right=raw x → CONST(5); ADD x
                // No — imm pattern needs right to be pLiteral. x is Identifier, so this doesn't match.
                // The variants come from: (a) immOperandRules flipped(commutative):
                //   pBinary("+", pLiteral(5), pRtl("acc")) with right=LOAD x → LOAD x; ADD #5
                // (b) regOperandRules direct: pBinary("+", pRtl("acc"), pIdentifier(x))
                //   with left=CONST(5) → MOVE #5; ADD x
                ["LOAD x", "ADD #5"],
                ["MOVE #5", "ADD x"],
            ],
        })
    })

    test("x - 1 (per-op inline for SUB)", () =>
    {
        checkVariants("return x - 1;", {
            minCount: 2,
            contains: [
                // immOperandRules direct: pBinary("-", pRtl("acc"), pLiteral(1)) → LOAD x; SUB #1
                // 1 is SUB's per-op inline literal (§17.3)
                // No flipped imm variant — flipped would be RSUB #1 which computes 1-x, not x-1.
                // But flipped reg: pBinary("-", pIdentifier(x), pRtl("acc")) with right=CONST(1)
                //   → MOVE #1; RSUB x computes acc=1, then x - 1 ✅ (not asserted here but valid)
                ["LOAD x", "SUB #1"],
            ],
        })
    })

    test("x << 1 (per-op inline for SHL)", () =>
    {
        checkVariants("return x << 1;", {
            minCount: 2,
            contains: [
                // immOperandRules direct only; SHL is strict — 1 is its per-op inline literal
                ["LOAD x", "SHL #1"],
            ],
        })
    })

    test("x << 3 (imm-extended, no inline for 3)", () =>
    {
        checkVariants("return x << 3;", {
            minCount: 2,
            contains: [
                // immOperandRules direct: 3 ≠ SHL's per-op inline (1) → imm-extended (2B)
                ["LOAD x", "SHL #3"],
            ],
        })
    })

    test("x == 0 (zero-compare, both orientations)", () =>
    {
        checkVariants("return x == 0;", {
            minCount: 4,
            contains: [
                // immOperandRules direct: pBinary("==", pRtl("acc"), pLiteral(0))
                // 0 is the comparison imm-zero literal (§17.4)
                ["LOAD x", "EQ #0"],
                // regOperandRules flipped: pBinary("==", pIdentifier(x), pRtl("acc"))
                // with right=CONST(0) → MOVE #0; EQ x (EQ is commutative)
                ["MOVE #0", "EQ x"],
            ],
        })
    })

    test("x != 0 (zero-compare, both orientations)", () =>
    {
        checkVariants("return x != 0;", {
            minCount: 4,
            contains: [
                // immOperandRules direct: pBinary("!=", pRtl("acc"), pLiteral(0))
                ["LOAD x", "NE #0"],
                // regOperandRules flipped (NE is commutative)
                ["MOVE #0", "NE x"],
            ],
        })
    })
})

describe("Commutative & paired flips", () =>
{
    test("1 + x (literal-on-left, commutative flip)", () =>
    {
        checkVariants("return 1 + x;", {
            minCount: 4,
            contains: [
                // immOperandRules flipped(commutative): pBinary("+", pLiteral(1), pRtl("acc"))
                // right=LOAD x → LOAD x; ADD #1
                ["LOAD x", "ADD #1"],
                // regOperandRules direct: pBinary("+", pRtl("acc"), pIdentifier(x))
                // left=CONST(1) → MOVE #1; ADD x
                ["MOVE #1", "ADD x"],
            ],
        })
    })

    test("y - x (paired flip: SUB direct + RSUB flipped)", () =>
    {
        checkVariants("return y - x;", {
            minCount: 8,
            contains: [
                // regOperandRules direct: pBinary("-", pRtl("acc"), pIdentifier(x)) → LOAD y; SUB x
                ["LOAD y", "SUB x"],
                // regOperandRules flipped: pBinary("-", pIdentifier(y), pRtl("acc"))
                // right=LOAD x → LOAD x; RSUB y (RSUB computes y - acc = y - x) ✅
                ["LOAD x", "RSUB y"],
            ],
        })
    })
})

describe("Chained expressions", () =>
{
    test("x + y + z (all-register variants present)", () =>
    {
        checkVariants("return x + y + z;", {
            minCount: 20,
            contains: [
                // (x+y)+z: worklist tiles x+y→acc first (regOperandRules direct), then ADD z
                ["LOAD x", "ADD y", "ADD z"],
                // (y+x)+z: worklist tiles y→acc first, ADDs x, then ADD z (commutative flip)
                ["LOAD y", "ADD x", "ADD z"],
            ],
        })
    })

    test("x + y - z (mixed commutative + paired)", () =>
    {
        checkVariants("return x + y - z;", {
            minCount: 10,
            contains: [
                // (x+y)-z: inner ADD via regOperandRules direct, outer SUB via regOperandRules direct
                ["LOAD x", "ADD y", "SUB z"],
                // (y+x)-z: same but inner ADD uses commutative flip
                ["LOAD y", "ADD x", "SUB z"],
            ],
        })
    })
})

describe("Compound expressions (stack bridge)", () =>
{
    test("x + y * z (MUL present in some variant)", () =>
    {
        checkVariants("return x + y * z;", {
            minCount: 10,
            // parsed as x + (y * z); MUL must appear because * has higher precedence than +
            containsOp: ["MUL"],
        })
    })

    test("(a + b) * (c + d) (MUL + stack-combo present)", () =>
    {
        checkVariants("return (a + b) * (c + d);", {
            minCount: 10,
            // both sub-expressions are complex → must bridge through the stack
            containsOp: ["MUL"],
            // stackOperandRules MUL combos consume one operand from acc and one from TOS
            containsCombo: ["POP_ACC", "PEEK_ACC"],
        })
    })
})

describe("Assignment", () =>
{
    test("x = y", () =>
    {
        checkVariants("return x = y;", {
            minCount: 1,
            contains: [
                // assignmentRules() pAssign("=", pRtl("acc")) → child(LOAD y) + STORE("x")
                ["LOAD y", "STORE x"],
            ],
        })
    })

    test("x = 0 (const-zero assignment)", () =>
    {
        checkVariants("return x = 0;", {
            minCount: 1,
            contains: [
                // assignmentRules() → child(CONST(0)) + STORE("x"), 0 is MOVE's per-op inline
                ["MOVE #0", "STORE x"],
            ],
        })
    })

    test("x = y + 1 (compound assignment RHS)", () =>
    {
        checkVariants("return x = y + 1;", {
            minCount: 2,
            contains: [
                // immOperandRules direct tilings y+1 to acc, then assignmentRules appends STORE x
                ["LOAD y", "ADD #1", "STORE x"],
            ],
        })
    })
})

describe("Call", () =>
{
    test("foo(x) — single pushed arg", () =>
    {
        checkVariants("return foo(x);", {
            minCount: 1,
            contains: [
                // callRule() tiles arg x to tos (LOAD x; PUSH), then appends CALL foo
                ["LOAD x", "PUSH", "CALL foo"],
            ],
        })
    })

    test("foo(x, y) — two pushed args", () =>
    {
        checkVariants("return foo(x, y);", {
            minCount: 1,
            contains: [
                ["LOAD x", "PUSH", "LOAD y", "PUSH", "CALL foo"],
            ],
        })
    })

    test("foo(x + 1) — computed arg", () =>
    {
        checkVariants("return foo(x + 1);", {
            minCount: 2,
            contains: [
                // callRule() tiles x+1 to tos variant (immOperandRules acc+tos output) + CALL
                ["LOAD x", "ADD #1", "PUSH", "CALL foo"],
            ],
        })
    })
})

// ─── Root output demand ─────────────────────────────────────────────────────

describe("Root output demand (tileExpr with demand parameter)", () =>
{
    /** Tile `return <expr>;` with an optional root output demand. */
    function variantsOf(source: string, demand?: OutputLocation): string[][]
    {
        const expr = exprOf(source)
        const variants = tileExpr(expr, DEFAULT_RULESET, demand)
        return variants.map(v => v.fragment.map(format))
    }

    // ── Leaf ────────────────────────────────────────────────────────────────

    test("literal — no demand returns both acc and tos", () =>
    {
        const vs = variantsOf("return 42;")
        assert.equal(vs.length, 2,
            `no demand should return 2 variants (acc + tos), got ${vs.length}`)
    })

    test("literal — acc demand returns only acc variant", () =>
    {
        const vs = variantsOf("return 42;", "acc")
        assert.equal(vs.length, 1)
        // Only MOVE #42; no PUSH suffix
        assert.deepStrictEqual(vs[0], ["MOVE #42"])
    })

    test("literal — tos demand returns only tos variant", () =>
    {
        const vs = variantsOf("return 42;", "tos")
        assert.equal(vs.length, 1)
        assert.deepStrictEqual(vs[0], ["MOVE #42", "PUSH"])
    })

    test("identifier — acc demand returns only LOAD, no PUSH", () =>
    {
        const vs = variantsOf("return x;", "acc")
        assert.equal(vs.length, 1)
        assert.deepStrictEqual(vs[0], ["LOAD x"])
    })

    test("identifier — tos demand returns LOAD + PUSH", () =>
    {
        const vs = variantsOf("return x;", "tos")
        assert.equal(vs.length, 1)
        assert.deepStrictEqual(vs[0], ["LOAD x", "PUSH"])
    })

    // ── Binary — acc output combos only ─────────────────────────────────────

    test("x + y with acc demand — no tos-output stack combos survive", () =>
    {
        const all   = variantsOf("return x + y;")
        const acc   = variantsOf("return x + y;", "acc")
        // tos-output combos (PEEK_PUSH, PEEK_PEEK) are filtered;
        // acc-output combos (POP_ACC, PEEK_ACC, REG_ACC) survive even if they
        // contain intermediate PUSH instructions (the *root* output determines)
        assert.ok(acc.length < all.length,
            `acc demand should filter out tos-output variants (all=${all.length}, acc=${acc.length})`)
        // POP_ACC combo has intermediate PUSH but root output is acc — valid
        const hasPopAcc = acc.some(v => v.join(" ").includes("ADD [--tos]"))
        assert.ok(hasPopAcc,
            `acc demand should retain POP_ACC (stack bridge with acc output), got:\n` +
            acc.map(v => v.join(", ")).join("\n"))
    })

    test("x + y with tos demand — only tos-output stack combos survive", () =>
    {
        const all   = variantsOf("return x + y;")
        const tos   = variantsOf("return x + y;", "tos")
        assert.ok(tos.length < all.length,
            `tos demand should filter out acc variants (all=${all.length}, tos=${tos.length})`)
        // Every tos variant must push onto the stack at the end
        for (const v of tos)
        {
            const hasPush = v.some(s => s.includes("[tos++]") || s === "PUSH")
            assert.ok(hasPush,
                `expected tos-output (PUSH or PEEK_PUSH) in tos-demand variant: ${v.join(", ")}`)
        }
    })

    // ── Assignment — acc demand includes reg-output (write-back) ────────────

    // NOTE: a bare `"reg"` demand (no target index) is no longer expressible
    // — OutputLocation's reg case carries a concrete index (`{reg: number}`,
    // rtl.ts) rather than a bare string, per the more concrete register
    // target specification in rules.ts. There used to be a test here
    // asserting a bare `"reg"` demand yields 0 variants for `x = y`; it no
    // longer type-checks against the current OutputLocation shape and its
    // premise (an index-less reg demand) doesn't apply anymore.

    test("x = y with acc demand — assignment write-back satisfies acc", () =>
    {
        const vs = variantsOf("return x = y;", "acc")
        // assignmentRules produces output: ["acc", "reg"] — both satisfy "acc" demand
        assert.equal(vs.length, 1)
        assert.deepStrictEqual(vs[0], ["LOAD y", "STORE x"])
    })

    test("x = y with tos demand — zero variants (assignment never outputs tos)", () =>
    {
        const vs = variantsOf("return x = y;", "tos")
        assert.equal(vs.length, 0,
            `assignment cannot produce tos output, expected 0 variants, got ${vs.length}`)
    })

    // ── Compound — acc demand still allows stack bridging internally ─────────

    test("(a+b)*(c+d) with acc demand — stack bridging still works", () =>
    {
        const vs = variantsOf("return (a + b) * (c + d);", "acc")
        assert.ok(vs.length >= 3,
            `expected ≥3 acc-output variants for compound expression, got ${vs.length}`)
        // Verify at least one variant uses stack bridging (POP_ACC combo on MUL).
        // The internal operands may be pushed; only the root MUL must output to acc.
        const hasStackBridge = vs.some(v =>
            v.some(s => s.includes("ADD [--tos]") || s.includes("ADD [tos-1]")))
        assert.ok(hasStackBridge,
            `expected at least one acc-output variant with stack bridging, got:\n` +
            vs.map(v => v.join(", ")).join("\n"))
    })

    // ── Cost-optimal selection (smoke test on lowerExpr) ────────────────────

    test("lowerExpr with acc demand picks the cheapest acc variant", () =>
    {
        const { lowerExpr } = require("../src/machine/orchestrator") as typeof import("../src/machine/orchestrator")
        const expr = exprOf("return x + y;")
        const node = lowerExpr(expr, DEFAULT_RULESET, "acc")
        assert.ok(node, "must find at least one acc variant")
        // Cheapest acc variant for x+y: register-combo (2B) beats stack-combo (3B incl PUSH)
        assert.ok(node.fragment.length <= 3,
            `expected ≤3 instrs for optimal acc tiling, got ${node.fragment.length}: ${node.fragment.map(format).join(", ")}`)
    })
})
