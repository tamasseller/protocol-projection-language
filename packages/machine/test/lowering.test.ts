/**
 * @ppl/machine/test — Cost-optimal tiling tests
 *
 * Tests `lowerExpr` directly: for each DSL expression, asserts the exact
 * instruction sequence its cost-optimal tiling produces. `tileNode`
 * (orchestrator.ts) prunes every node's candidate set to a Pareto frontier
 * as it builds it, so a dominated tiling (e.g. a stack-bridge combo when a
 * cheaper register combo is available for the same output) never survives
 * to be picked — these tests check the *winner*, not "does some candidate
 * exist somewhere," since a merely-realizable-but-dominated candidate is no
 * longer part of what `tileExpr` returns at all.
 *
 * Some expressions have more than one tiling tied on every cost axis
 * (bytes, fragment length, maxStack) — `pickCheapest` resolves those
 * arbitrarily, by whichever the ruleset happens to construct first. Those
 * cases use `checkWinnerOneOf`, asserting the winner is *a* member of the
 * tied set rather than pinning one arbitrary-among-equals choice.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { ir } from "../src/ir"
import { DEFAULT_RULESET } from "../src/rules"
import { tileExpr, lowerExpr } from "../src/orchestrator"
import { format, type OutputLocation } from "../src/rtl"
import type { EastExpression } from "../src/east"
import type { ReturnStatement } from "../src/ast"

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract the `return` expression from a source string. */
function exprOf(source: string): EastExpression
{
    const frag = ir`${source}`
    const stmt = frag.body[0] as ReturnStatement
    return stmt.argument! as EastExpression
}

/** Assert the cost-optimal tiling of `return <expr>;` under `demand` is
 *  exactly `expected` — the unique winner, no tie among candidates. */
function checkWinner(source: string, demand: OutputLocation, expected: string[]): void
{
    const node = lowerExpr(exprOf(source), DEFAULT_RULESET, demand)
    assert.ok(node, `No viable tiling for: ${source}`)
    assert.deepStrictEqual(node.fragment.map(format), expected,
        `${source} (demand=${demand}): expected optimal tiling [${expected.join(", ")}], ` +
        `got [${node.fragment.map(format).join(", ")}]`)
}

/** Like `checkWinner`, for expressions where several tilings genuinely tie
 *  on every cost axis — asserts the winner is *some* member of `acceptable`
 *  rather than pinning one arbitrary-among-equals choice. */
function checkWinnerOneOf(source: string, demand: OutputLocation, acceptable: string[][]): void
{
    const node = lowerExpr(exprOf(source), DEFAULT_RULESET, demand)
    assert.ok(node, `No viable tiling for: ${source}`)
    const got = node.fragment.map(format)
    const ok = acceptable.some(a => a.length === got.length && a.every((s, i) => s === got[i]))
    assert.ok(ok,
        `${source} (demand=${demand}): winner [${got.join(", ")}] not among the tied-acceptable set:\n` +
        acceptable.map(a => `  [${a.join(", ")}]`).join("\n"))
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Leaf tiling", () =>
{
    test("literal", () =>
    {
        checkWinner("return 42;", "acc", ["CONST #42"])
        checkWinner("return 42;", "tos", ["CONST #42", "PUSH"])
    })

    test("identifier", () =>
    {
        checkWinner("return x;", "acc", ["LOAD x"])
        checkWinner("return x;", "tos", ["LOAD x", "PUSH"])
    })

    test("literal 0", () =>
    {
        checkWinner("return 0;", "acc", ["CONST #0"])
        checkWinner("return 0;", "tos", ["CONST #0", "PUSH"])
    })
})

describe("Unary tiling", () =>
{
    test("negation", () =>
    {
        checkWinner("return -x;", "acc", ["LOAD x", "NEG"])
    })

    test("bitwise not", () =>
    {
        checkWinner("return ~x;", "acc", ["LOAD x", "NOT"])
    })

    // rules.ts, "unary:~~:cancel" — a multi-level rule matching straight
    // through the inner UnaryExpression's raw shape. It strictly beats
    // applying unary:~ twice (2 fewer instructions), so it's the unique
    // winner, not merely a candidate among others.
    test("double negation cancels", () =>
    {
        checkWinner("return ~~x;", "acc", ["LOAD x"])
    })
})

describe("Builtin calls (clz, revbits)", () =>
{
    // rules.ts, "builtin:clz"/"builtin:revbits" (matcher.ts's BuiltinCall
    // pattern) — `clz(x)`/`revbits(x)` parse as an ordinary Identifier(args)
    // call (isa-core.md §10.5) but lower to a bare unary op on the argument
    // in acc, not a real procedure call with a pushed/popped argument.
    test("clz(x)", () =>
    {
        checkWinner("return clz(x);", "acc", ["LOAD x", "CLZ"])
    })

    test("revbits(x)", () =>
    {
        checkWinner("return revbits(x);", "acc", ["LOAD x", "REVBITS"])
    })
})

describe("Binary — register operand", () =>
{
    // Commutative ops: both evaluation orders cost the same (2 LOADs +
    // 1 register-combo ALU op either way), so this is a genuine tie.
    test("x + y", () =>
    {
        checkWinnerOneOf("return x + y;", "acc", [
            ["LOAD x", "ADD y"],
            ["LOAD y", "ADD x"],
        ])
    })

    test("x - y (paired: direct SUB ties with flipped RSUB)", () =>
    {
        checkWinnerOneOf("return x - y;", "acc", [
            ["LOAD x", "SUB y"],
            ["LOAD y", "RSUB x"],
        ])
    })

    test("x & y", () =>
    {
        checkWinnerOneOf("return x & y;", "acc", [
            ["LOAD x", "AND y"],
            ["LOAD y", "AND x"],
        ])
    })

    // SHL is strict (no commutative/paired flip), so there's exactly one
    // candidate at all — no tie to resolve.
    test("x << y (strict: no flip)", () =>
    {
        checkWinner("return x << y;", "acc", ["LOAD x", "SHL y"])
    })
})

describe("Binary — immediate operand", () =>
{
    // Arithmetic's immediate combo has no small form (isa-rationale.md), so it
    // always costs LOAD(2) + op-imm-extended(2) = 4 bytes. But reformulating
    // commutatively as `1 + x` and tiling the literal via CONST's small
    // 0–15 range costs CONST(1) + op-register(2) = 3 bytes instead — cheaper
    // whenever the literal fits that range, so it's the unique winner, not
    // the direct-immediate form these expressions might suggest at a glance.
    test("x + 1 (small-literal reg-flip beats direct immediate)", () =>
    {
        checkWinner("return x + 1;", "acc", ["CONST #1", "ADD x"])
    })

    test("x + 5 (small-literal reg-flip beats direct immediate)", () =>
    {
        checkWinner("return x + 5;", "acc", ["CONST #5", "ADD x"])
    })

    test("5 + x (already literal-on-left; same winner as x + 5)", () =>
    {
        checkWinner("return 5 + x;", "acc", ["CONST #5", "ADD x"])
    })

    // Paired (SUB/RSUB) gets the same reg-flip win: CONST #1 tiles the
    // literal to acc, then RSUB x computes target(x) − acc(1) = x − 1.
    test("x - 1 (small-literal reg-flip via RSUB beats direct immediate)", () =>
    {
        checkWinner("return x - 1;", "acc", ["CONST #1", "RSUB x"])
    })

    // SHL is strict — no flipped form exists at all, so the direct
    // immediate is the only candidate regardless of the constant's size
    // (arithmetic's immediate has no small form to make 1 cheaper than 3).
    test("x << 1 (strict: direct immediate only)", () =>
    {
        checkWinner("return x << 1;", "acc", ["LOAD x", "SHL #1"])
    })

    test("x << 3 (strict: direct immediate only)", () =>
    {
        checkWinner("return x << 3;", "acc", ["LOAD x", "SHL #3"])
    })

    // Comparison's #0 gets its own dedicated small form (isa-core.md §4.2),
    // so direct-immediate and reg-flip-via-CONST both cost 3 bytes here —
    // a genuine tie, unlike the arithmetic cases above.
    test("x == 0 (zero-compare: direct and reg-flip tie)", () =>
    {
        checkWinnerOneOf("return x == 0;", "acc", [
            ["LOAD x", "EQ #0"],
            ["CONST #0", "EQ x"],
        ])
    })

    test("x != 0 (zero-compare: direct and reg-flip tie)", () =>
    {
        checkWinnerOneOf("return x != 0;", "acc", [
            ["LOAD x", "NE #0"],
            ["CONST #0", "NE x"],
        ])
    })
})

describe("Commutative & paired flips", () =>
{
    test("1 + x (literal already on the left)", () =>
    {
        checkWinner("return 1 + x;", "acc", ["CONST #1", "ADD x"])
    })

    test("y - x (paired flip: direct SUB ties with flipped RSUB)", () =>
    {
        checkWinnerOneOf("return y - x;", "acc", [
            ["LOAD y", "SUB x"],
            ["LOAD x", "RSUB y"],
        ])
    })
})

describe("Chained expressions", () =>
{
    test("x + y + z (evaluation order ties)", () =>
    {
        checkWinnerOneOf("return x + y + z;", "acc", [
            ["LOAD x", "ADD y", "ADD z"],
            ["LOAD y", "ADD x", "ADD z"],
        ])
    })

    test("x + y - z (mixed commutative + paired, evaluation order ties)", () =>
    {
        checkWinnerOneOf("return x + y - z;", "acc", [
            ["LOAD x", "ADD y", "SUB z"],
            ["LOAD y", "ADD x", "SUB z"],
        ])
    })
})

describe("Compound expressions (stack bridge)", () =>
{
    test("x + y * z (MUL binds tighter; evaluation order ties)", () =>
    {
        checkWinnerOneOf("return x + y * z;", "acc", [
            ["LOAD y", "MUL z", "ADD x"],
            ["LOAD z", "MUL y", "ADD x"],
        ])
    })

    // Both operands are themselves compound, so no register/immediate
    // pattern can reach either one directly — every viable tiling must
    // bridge through the stack, and none dominates another (all 8
    // evaluation-order permutations tie at the same byte/maxStack cost).
    // Pruning still discards nothing here, unlike the register-operand
    // cases above, precisely because nothing cheaper is realizable.
    test("(a + b) * (c + d) — stack bridging is the only option", () =>
    {
        const node = lowerExpr(exprOf("return (a + b) * (c + d);"), DEFAULT_RULESET, "acc")
        assert.ok(node, "must find a tiling")
        const formatted = node.fragment.map(format)
        assert.ok(formatted.includes("MUL [--tos]"),
            `expected a stack-bridge MUL, got: ${formatted.join(", ")}`)
        assert.ok(formatted.includes("PUSH"),
            `expected an intermediate PUSH bridging the two sums, got: ${formatted.join(", ")}`)
    })
})

describe("Assignment", () =>
{
    test("x = y", () =>
    {
        checkWinner("return x = y;", "acc", ["LOAD y", "STORE x"])
    })

    test("x = 0 (const-zero assignment)", () =>
    {
        checkWinner("return x = 0;", "acc", ["CONST #0", "STORE x"])
    })

    // Same small-literal reg-flip win as the "x + 1" case above, just with
    // an assignment's STORE appended.
    test("x = y + 1 (compound assignment RHS)", () =>
    {
        checkWinner("return x = y + 1;", "acc", ["CONST #1", "ADD y", "STORE x"])
    })
})

describe("Call", () =>
{
    // The calling convention passes the *last* argument in acc, not via the
    // stack (rtl.ts's `call` doc comment) — a single-argument call needs no
    // PUSH at all.
    test("foo(x) — single arg via acc, no push", () =>
    {
        checkWinner("return foo(x);", "acc", ["LOAD x", "CALL foo"])
    })

    test("foo(x, y) — first arg pushed, last via acc", () =>
    {
        checkWinner("return foo(x, y);", "acc", ["LOAD x", "PUSH", "LOAD y", "CALL foo"])
    })

    // foo(x + 1)'s only argument is the *last* (only) one, so it's demanded
    // at "acc", not "tos" — the same demand, and hence the same winner, as
    // the "1 + x (literal already on the left)" test above: the flipped
    // reg-combo form (`CONST #1; ADD x`) beats the direct immediate form
    // (`LOAD x; ADD #1`) for an "acc" demand.
    test("foo(x + 1) — computed arg", () =>
    {
        checkWinner("return foo(x + 1);", "acc", ["CONST #1", "ADD x", "CALL foo"])
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
        // Only CONST #42; no PUSH suffix
        assert.deepStrictEqual(vs[0], ["CONST #42"])
    })

    test("literal — tos demand returns only tos variant", () =>
    {
        const vs = variantsOf("return 42;", "tos")
        assert.equal(vs.length, 1)
        assert.deepStrictEqual(vs[0], ["CONST #42", "PUSH"])
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

    // ── Binary — pruning discards a dominated stack combo entirely ─────────

    // When a register alternative is available for the same output tag, the
    // stack-bridge combo (PEEK_PEEK/POP_ACC) is strictly dominated — it
    // never survives pruning at all, regardless of demand. And since the
    // register combo's two evaluation orders (`LOAD x;ADD y` vs `LOAD
    // y;ADD x`) tie exactly on every cost axis, pruning collapses them to a
    // single representative too — there's only one acc-output candidate
    // left, not merely "no stack combo among several."
    test("x + y with acc demand — dominated stack combo doesn't survive", () =>
    {
        const acc = variantsOf("return x + y;", "acc")
        assert.equal(acc.length, 1, `expected the tied register-combo variants collapsed to one, got ${acc.length}`)
        assert.ok(!acc[0]!.join(" ").includes("tos"),
            `acc-output candidate should never be a stack-bridge combo: ${acc[0]!.join(", ")}`)
    })

    test("x + y with tos demand — the (non-dominated) stack combo survives", () =>
    {
        const all = variantsOf("return x + y;")
        const tos = variantsOf("return x + y;", "tos")
        assert.ok(tos.length < all.length,
            `tos demand should filter out acc variants (all=${all.length}, tos=${tos.length})`)
        // There is no register-combo alternative for "tos" output at all, so
        // the stack-bridge candidate isn't dominated by anything — but its
        // two evaluation orders still tie exactly, so only one survives.
        assert.equal(tos.length, 1, `expected the tied evaluation orders collapsed to one, got ${tos.length}`)
        assert.ok(tos[0]!.includes("PUSH"),
            `expected a PUSH in the tos-demand variant: ${tos[0]!.join(", ")}`)
    })

    // ── Assignment — acc demand includes reg-output (write-back) ────────────

    // A bare `"reg"` demand (no target index) is not expressible:
    // OutputLocation's reg case carries a concrete index (`{reg: number}`,
    // rtl.ts), per rules.ts's register target specification.

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

    // All 8 evaluation-order permutations of this shape tie exactly on
    // bytes/maxStack/clobbers (neither operand is a bare identifier, so no
    // register/immediate rule can apply at all — every viable tiling must
    // bridge through the stack the same way), so pruning collapses them to
    // a single representative rather than leaving "several."
    test("(a+b)*(c+d) with acc demand — stack bridging still works", () =>
    {
        const vs = variantsOf("return (a + b) * (c + d);", "acc")
        assert.equal(vs.length, 1, `expected the tied evaluation orders collapsed to one, got ${vs.length}`)
        assert.ok(vs[0]!.includes("MUL [--tos]"),
            `expected the acc-output variant to use a stack-bridge MUL, got: ${vs[0]!.join(", ")}`)
    })

    // ── Cost-optimal selection (smoke test on lowerExpr) ────────────────────

    test("lowerExpr with acc demand picks the cheapest acc variant", () =>
    {
        const expr = exprOf("return x + y;")
        const node = lowerExpr(expr, DEFAULT_RULESET, "acc")
        assert.ok(node, "must find at least one acc variant")
        // Cheapest acc variant for x+y: register-combo (2 instrs) beats stack-combo
        assert.ok(node.fragment.length <= 3,
            `expected ≤3 instrs for optimal acc tiling, got ${node.fragment.length}: ${node.fragment.map(format).join(", ")}`)
    })

    // ── Winning-rule coverage: `call` and `identifier:acc` ──────────────────
    //
    // This calls `lowerExpr` directly, exactly like the acc-demand smoke
    // test above, just to put `call` through the rule that `lowerExpr`
    // actually *selects* (test/rule-coverage.test.ts only counts winners).
    // `foo(x)`'s only argument is also its *last*, so it's demanded at
    // "acc" (the calling convention's last-arg-in-acc rule) — no PUSH.

    test("lowerExpr on foo(x) selects the call rule (and identifier:acc for the arg)", () =>
    {
        const expr = exprOf("return foo(x);")
        const node = lowerExpr(expr, DEFAULT_RULESET, "acc")
        assert.ok(node, "must find a call lowering")
        assert.deepStrictEqual(node.fragment.map(format), ["LOAD x", "CALL foo"])
    })
})
