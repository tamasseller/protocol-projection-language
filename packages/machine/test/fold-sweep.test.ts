/**
 * @ppl/machine/test — Constant-folding rule-coverage sweep
 *
 * Data-driven, mirrors coverage-sweep.test.ts's approach but for rules.ts's
 * `fold:*` rules: one probe per operator, each verifying the folded value
 * is correct, not just that "some tiling exists." `trap(<const>)` is the
 * vehicle — its argument is a `pConst()` position with no alternative
 * lowering (rules.ts's `builtin:trap`), so the trap code it captures *is*
 * the folded value.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { ir } from "../src/ir"
import { lowerProc } from "../src/lower"
import { run } from "../src/vm"
import type { RtlProgram } from "../src/rtl"

function trapCodeOf(source: string): number | null
{
    const frag = ir`${source}`
    const lowered = lowerProc(frag.body)
    const prog: RtlProgram = { procedures: [lowered] }
    return run(prog).trapCode
}

describe("Constant folding — binary operators (rules.ts's \"fold:binary:*\")", () =>
{
    // Small, non-negative operands throughout: sign/wraparound handling is
    // already covered by the unary "-" sweep below, so these only need to
    // pin down each operator's own arithmetic, unambiguously.
    const BINARY: readonly {ast: string; a: number; b: number; expect: number}[] = [
        {ast: "+", a: 3, b: 4, expect: 7},
        {ast: "-", a: 10, b: 4, expect: 6},
        {ast: "*", a: 3, b: 4, expect: 12},
        {ast: "|", a: 6, b: 1, expect: 7},
        {ast: "^", a: 6, b: 3, expect: 5},
        {ast: "&", a: 6, b: 3, expect: 2},
        {ast: "<<", a: 1, b: 3, expect: 8},
        {ast: ">>", a: 16, b: 2, expect: 4},
        {ast: "==", a: 5, b: 5, expect: 1},
        {ast: "!=", a: 5, b: 6, expect: 1},
        {ast: "<", a: 3, b: 5, expect: 1},
        {ast: "<=", a: 5, b: 5, expect: 1},
        {ast: ">", a: 5, b: 3, expect: 1},
        {ast: ">=", a: 5, b: 5, expect: 1},
    ] as const

    for(const {ast, a, b, expect} of BINARY)
    {
        test(`${a} ${ast} ${b} === ${expect}`, () =>
        {
            assert.equal(trapCodeOf(`trap(${a} ${ast} ${b});`), expect)
        })
    }
})

describe("Constant folding — unary operator (rules.ts's \"fold:unary:-\")", () =>
{
    test("negation, as a compile-time constant", () =>
    {
        assert.equal(trapCodeOf("trap(-1);"), -1)
    })

    test("negation composes with a binary fold", () =>
    {
        assert.equal(trapCodeOf("trap(5 + -3);"), 2)
    })
})
