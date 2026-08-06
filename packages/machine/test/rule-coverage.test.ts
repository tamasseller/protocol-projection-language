/**
 * @ppl/machine/test — Lowering rule coverage gate
 *
 * Asserts every lowering rule (rules.ts) appeared in a node `lowerExpr`
 * actually selected as its winning tiling somewhere in the suite. Must run
 * *last* (see test/run.ts) so `touchedRuleNames` (orchestrator.ts) has
 * accumulated across every prior test file — it's a process-wide Set
 * populated as a side effect of every `lowerExpr` call, whether from
 * lowering.test.ts's/coverage-sweep.test.ts's direct calls or from
 * e2e.test.ts's real DSL-program lowering via lower.ts.
 *
 * This is a real gate, not informational: coverage-sweep.test.ts drives
 * every rule to win somewhere, deliberately, so a rule going uncovered
 * here means either that sweep broke (a rule stopped winning where it
 * used to) or a newly-added rule has no probe forcing it to win yet —
 * either way, something to look at, not noise to ignore. Getting a
 * specific rule to win takes a deliberately-shaped probe (Pareto pruning,
 * orchestrator.ts's `pruneToFrontier`, means most rules lose to a cheaper
 * alternative on a generic expression) — see coverage-sweep.test.ts's file
 * comment for why each probe shape targets what it does.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { ruleset } from "../src/rules"
import { touchedRuleNames } from "../src/orchestrator"

describe("Rule coverage (gate)", () =>
{
    test("every rule won as a lowering somewhere in the suite", () =>
    {
        const all = ruleset(name => name as unknown as number, name => name as unknown as number)
        const allNames = new Set(all.map(r => r.name))
        const uncovered = [...allNames].filter(n => !touchedRuleNames.has(n)).sort()

        console.log(
            `rule coverage: ${allNames.size - uncovered.length}/${allNames.size} rules ` +
            `selected as a winner somewhere in the suite`,
        )

        assert.deepEqual(uncovered, [],
            `rule(s) never won a lowering: ${uncovered.join(", ")}`)
    })
})
