/**
 * @ppl/machine/test — Rule-coverage sweep
 *
 * Data-driven: for every binary operator in rules.ts's op table, probes
 * every addressing-combo shape (register, immediate, stack) in both
 * orientations (direct/flip) and both demands (acc/tos), plus the
 * register-writeback shortcut via an assignment statement. Each probe
 * asserts the *specific* rule name it targets actually won — see
 * `touchedRuleNames` (orchestrator.ts) — not just "some tiling exists."
 *
 * This exists because Pareto pruning (orchestrator.ts's `pruneToFrontier`)
 * makes rule coverage nontrivial to drive: a rule only shows up as a
 * winner if some expression makes it strictly cheapest (or the
 * first-inserted member of an exact cost tie), so getting a specific
 * combo/orientation to win takes a deliberately-shaped probe, not just
 * "any expression using that operator." The probes below were derived by
 * reasoning about what shape forces a match and verified against the
 * actual lowerer's output, not assumed — see each shape's comment for why
 * it targets what it does. Must run before test/rule-coverage.test.ts
 * (test/run.ts's import order) so its wins count toward that report.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { ir } from "../src/ir"
import { DEFAULT_RULESET } from "../src/rules"
import { lowerExpr, lowerStatementExpr, touchedRuleNames } from "../src/orchestrator"
import type { EastExpression } from "../src/east"
import type { ReturnStatement, ExpressionStatement } from "../src/ast"
import type { OutputLocation } from "../src/rtl"

/** Parse a bare expression (no `return`/`;`) by wrapping it into one. */
function exprOf(expr: string): EastExpression
{
    const frag = ir`return ${expr};`
    const stmt = frag.body[0] as ReturnStatement
    return stmt.argument! as EastExpression
}

function stmtExprOf(source: string): EastExpression
{
    const frag = ir`${source}`
    const stmt = frag.body[0] as ExpressionStatement
    return stmt.expression as EastExpression
}

/** Lower `return <source>;` under `demand` and assert `wantRule` won. */
function winsRule(source: string, demand: OutputLocation, wantRule: string): void
{
    const node = lowerExpr(exprOf(source), DEFAULT_RULESET, demand)
    assert.ok(node, `${source} (demand=${demand}): no viable tiling`)
    assert.ok(touchedRuleNames.has(wantRule),
        `${source} (demand=${demand}): expected "${wantRule}" to win, ` +
        `got [${node.fragment.map(i => i.op).join(", ")}]`)
}

/** Like `winsRule`, but for an assignment used as a discarded-value
 *  statement — the only context REG_REG's write-back shortcut ever wins
 *  in, since a `return`'s "acc" demand would need a reload afterward
 *  anyway (lowerStatementExpr's own doc comment, orchestrator.ts). */
function winsRuleAsStatement(source: string, wantRule: string): void
{
    const node = lowerStatementExpr(stmtExprOf(source), DEFAULT_RULESET)
    assert.ok(node, `${source} (statement): no viable tiling`)
    assert.ok(touchedRuleNames.has(wantRule),
        `${source} (statement): expected "${wantRule}" to win, ` +
        `got [${node.fragment.map(i => i.op).join(", ")}]`)
}

interface OpSpec { ast: string; isa: string; swap?: string; hasFlip: boolean; writeback: boolean }

// Mirrors rules.ts's OP_TABLE (ast/isa/class/kind) — kept here rather than
// imported so this file documents its own probe targets explicitly.
const OPS: readonly OpSpec[] = [
    {ast: "+", isa: "ADD", hasFlip: true, writeback: true},
    {ast: "-", isa: "SUB", swap: "RSUB", hasFlip: true, writeback: true},
    {ast: "*", isa: "MUL", hasFlip: true, writeback: true},
    {ast: "|", isa: "OR", hasFlip: true, writeback: true},
    {ast: "^", isa: "XOR", hasFlip: true, writeback: true},
    {ast: "&", isa: "AND", hasFlip: true, writeback: true},
    {ast: "<<", isa: "SHL", hasFlip: false, writeback: true},
    {ast: ">>", isa: "SHR", hasFlip: false, writeback: true},
    {ast: "==", isa: "EQ", hasFlip: true, writeback: false},
    {ast: "!=", isa: "NE", hasFlip: true, writeback: false},
    {ast: "<", isa: "LT_U", hasFlip: false, writeback: false},
    {ast: "<=", isa: "LE_U", hasFlip: false, writeback: false},
    {ast: ">", isa: "GT_U", hasFlip: false, writeback: false},
    {ast: ">=", isa: "GE_U", hasFlip: false, writeback: false},
] as const

for (const {ast, isa, swap, hasFlip, writeback} of OPS)
{
    const flipIsa = swap ?? isa

    describe(`Rule-coverage sweep: ${ast} (${isa}${swap ? "/" + swap : ""})`, () =>
    {
        // REG_ACC:direct — two bare identifiers; regOperandRules' direct
        // pattern (left=already-tiled-acc, right=raw identifier) matches
        // and nothing competes (no literal, no compound side).
        test("REG_ACC (direct)", () =>
        {
            winsRule(`w ${ast} x`, "acc", `${ast}->${isa}:REG_ACC`)
        })

        if (hasFlip)
        {
            // REG_ACC:flip — identifier on the left, a genuinely compound
            // (non-leaf) expression on the right. Direct's pattern needs a
            // *raw identifier* on its non-acc side, which the compound
            // isn't, so only flip's pattern (identifier on the left,
            // already-tiled-acc on the right) matches.
            test("REG_ACC (flip)", () =>
            {
                winsRule(`x ${ast} (p + q)`, "acc", `${ast}->${flipIsa}:REG_ACC:flip`)
            })
        }

        // IMM_ACC:acc/tos (direct) — identifier op a literal outside
        // CONST's 0-15 small range (100), so the "reg-flip via CONST"
        // alternative (regOperandRules' flip pattern, treating the tiled
        // literal as an acc operand) can't undercut it on bytes — direct
        // immediate wins outright.
        test("IMM_ACC:acc (direct)", () =>
        {
            winsRule(`x ${ast} 100`, "acc", `${ast}->${isa}:IMM_ACC:acc`)
        })

        test("IMM_ACC:tos (direct)", () =>
        {
            winsRule(`x ${ast} 100`, "tos", `${ast}->${isa}:IMM_ACC:tos`)
        })

        if (hasFlip)
        {
            // IMM_ACC (flip) — a large literal on the left, a compound
            // (non-identifier) expression on the right. Every *other*
            // pattern needs a raw identifier or raw literal on the
            // non-acc side; the compound satisfies neither, so only
            // immOperandRules' flip pattern (literal on the left,
            // already-tiled-acc on the right) matches at all.
            test("IMM_ACC:acc (flip)", () =>
            {
                winsRule(`100 ${ast} (p + q)`, "acc", `${ast}->${flipIsa}:IMM_ACC:acc:flip`)
            })

            test("IMM_ACC:tos (flip)", () =>
            {
                winsRule(`100 ${ast} (p + q)`, "tos", `${ast}->${flipIsa}:IMM_ACC:tos:flip`)
            })
        }

        // POP_ACC/PEEK_PEEK (direct) — both sides genuinely compound (no
        // bare identifier or literal anywhere), so regOperandRules and
        // immOperandRules can't match at all; only the stack-bridge combo
        // can realize this, and direct wins the (otherwise exact) tie
        // against flip by insertion order.
        test("POP_ACC (direct)", () =>
        {
            winsRule(`(p + q) ${ast} (r + s)`, "acc", `${ast}->${isa}:POP_ACC`)
        })

        // PEEK_PEEK only exists for `alu` ops (isa-core.md §4.2 gives
        // comparisons no peek combo at all — see rules.ts's
        // stackOperandRules doc comment). A comparison reaches `"tos"` via
        // POP_ACC + an explicit PUSH instead (`:POP_ACC:tos`), the only
        // candidate at all for two compound operands, so it wins without
        // needing PEEK_PEEK's tie-breaking setup.
        if (writeback)
        {
            test("PEEK_PEEK (direct)", () =>
            {
                winsRule(`(p + q) ${ast} (r + s)`, "tos", `${ast}->${isa}:PEEK_PEEK`)
            })
        }
        else
        {
            test("POP_ACC:tos (direct, no peek combo for comparisons)", () =>
            {
                winsRule(`(p + q) ${ast} (r + s)`, "tos", `${ast}->${isa}:POP_ACC:tos`)
            })
        }

        if (hasFlip)
        {
            // POP_ACC/PEEK_PEEK (flip) — a symmetric "(p+q) op (r+s)" ties
            // direct and flip exactly (relabeling which side plays which
            // role costs the same either way), and direct always wins
            // that tie. Breaking it needs two compound operands whose
            // tos-vs-acc cost *delta* differs: "(8+9)" (both literals)
            // costs exactly 1 byte more as tos than as acc
            // (immOperandRules' dedicated tos variant is a flat
            // one-PUSH delta over its acc form); "(p+q)" (both
            // identifiers) costs 2 more, since its only tos route is a
            // stack combo with no cheaper direct alternative. Putting the
            // cheaper-as-tos side on the left is exactly what flip's role
            // assignment (left=tos, right=acc) benefits from — direct
            // would have to eat the pricier delta instead. Same reasoning
            // applies whether the top-level op ends in PEEK_PEEK or
            // POP_ACC+PUSH, since the asymmetry is about the *children's*
            // cost, not the top-level combo.
            test("POP_ACC (flip)", () =>
            {
                winsRule(`(8 + 9) ${ast} (p + q)`, "acc", `${ast}->${flipIsa}:POP_ACC:flip`)
            })

            if (writeback)
            {
                test("PEEK_PEEK (flip)", () =>
                {
                    winsRule(`(8 + 9) ${ast} (p + q)`, "tos", `${ast}->${flipIsa}:PEEK_PEEK:flip`)
                })
            }
            else
            {
                test("POP_ACC:tos (flip, no peek combo for comparisons)", () =>
                {
                    winsRule(`(8 + 9) ${ast} (p + q)`, "tos", `${ast}->${flipIsa}:POP_ACC:tos:flip`)
                })
            }
        }

        if (writeback)
        {
            // REG_REG (direct) — `y = x op y`, target on the right in
            // direct's convention (identifier-operand side). Only
            // profitable as a discarded-value statement — see
            // winsRuleAsStatement's doc comment.
            test("REG_REG (direct, as a statement)", () =>
            {
                winsRuleAsStatement(`y = x ${ast} y;`, `${ast}->${isa}:REG_REG`)
            })

            if (hasFlip)
            {
                // REG_REG (flip) — `x = x op y`, target on the left —
                // the canonical `x op= y` shape (rules.ts's own doc
                // comment on regOperandRules).
                test("REG_REG (flip, as a statement)", () =>
                {
                    winsRuleAsStatement(`x = x ${ast} y;`, `${ast}->${flipIsa}:REG_REG:flip`)
                })
            }
        }
    })
}
