/**
 * @ppl/core/test — Lowering rule coverage report
 *
 * Reports which lowering rules (rules.ts) never appeared in a node
 * `lowerExpr` actually selected as its winning tiling, anywhere in the
 * suite. Must run *last* (see test/run.ts) so `touchedRuleNames`
 * (orchestrator.ts) has accumulated across every prior test file — it's a
 * process-wide Set populated as a side effect of every `lowerExpr` call,
 * whether from lowering.test.ts's direct calls or from e2e.test.ts's real
 * DSL-program lowering via lower.ts.
 *
 * Informational only for now, not a hard gate: a rule not appearing here
 * doesn't necessarily mean it's broken — many exist for tilings that are
 * only optimal in shapes the current suite doesn't happen to construct
 * (e.g. most stack-combo rules lose to a register-combo whenever both
 * operands are simple identifiers, so they'd only win on a deliberately
 * stack-forcing expression). Once coverage is deliberately pushed higher,
 * turn the assertion at the bottom into `assert.deepEqual(uncovered, [])`.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { ruleset } from "../src/machine/rules"
import { touchedRuleNames } from "../src/machine/orchestrator"

describe("Rule coverage (informational)", () =>
{
    test("report rules never selected as a winning lowering", () =>
    {
        const all = ruleset(name => name as unknown as number)
        const allNames = new Set(all.map(r => r.name))
        const uncovered = [...allNames].filter(n => !touchedRuleNames.has(n)).sort()

        console.log(
            `rule coverage: ${allNames.size - uncovered.length}/${allNames.size} rules ` +
            `selected as a winner somewhere in the suite`,
        )
        if (uncovered.length > 0)
            console.log(`uncovered:\n  ${uncovered.join("\n  ")}`)

        assert.ok(allNames.size > 0, "rule table should not be empty")
    })
})
