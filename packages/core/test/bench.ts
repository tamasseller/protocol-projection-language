/**
 * @ppl/core/test — Manual tiling performance probe
 *
 * Not part of `npm test` (not imported by run.ts) — measures `tileExpr`'s
 * wall-clock cost on wide balanced-sum expression trees, the shape that
 * previously blew up under the worklist-based search (see docs/ir-engine.md,
 * "Known gaps and open work"). Run directly: `npx ts-node --project
 * tsconfig.test.json test/bench.ts`.
 *
 * Reports parse and tile time separately: `tileExpr` itself now stays flat
 * (single-digit ms) out to at least n=128, since Pareto-frontier pruning
 * (orchestrator.ts's `pruneToFrontier`) collapses same-cost evaluation-order
 * ties instead of letting them multiply up the tree. The *parser*
 * (grammer.pegjs's generated recursive-descent parser, unrelated to
 * anything in machine/) is a separate, pre-existing bottleneck that this
 * file's default range deliberately stays under — its cost grows sharply
 * past n≈64 (parsing alone, not tiling) and isn't something this session's
 * work touched or fixed; see docs/ir-engine.md.
 */

import { ir } from "../src/ir"
import { DEFAULT_RULESET } from "../src/machine/rules"
import { tileExpr } from "../src/machine/orchestrator"
import type { EastExpression } from "../src/machine/east"
import type { ReturnStatement } from "../src/machine/ast"

function exprOf(source: string): EastExpression
{
    const frag = ir`${source}`
    const stmt = frag.body[frag.body.length - 1] as ReturnStatement
    return stmt.argument! as EastExpression
}

/** A balanced binary sum of `n` leaves, e.g. n=4 → "((v0+v1)+(v2+v3))". */
function balancedSum(n: number): string
{
    if (n === 1) return "v0"
    function build(lo: number, hi: number): string
    {
        if (hi - lo === 1) return `v${lo}`
        const mid = lo + Math.floor((hi - lo) / 2)
        return `(${build(lo, mid)} + ${build(mid, hi)})`
    }
    return build(0, n)
}

function decls(n: number): string
{
    return Array.from({length: n}, (_, i) => `u32 v${i} = ${i};`).join("\n")
}

const targets = process.argv.slice(2).map(Number)
for (const n of (targets.length ? targets : [6, 8, 9, 10, 12, 16, 24, 32, 48]))
{
    const source = `${decls(n)}\nreturn ${balancedSum(n)};`
    const parseStart = process.hrtime.bigint()
    const expr = exprOf(source)
    const parseMs = Number(process.hrtime.bigint() - parseStart) / 1e6
    const start = process.hrtime.bigint()
    const variants = tileExpr(expr, DEFAULT_RULESET, "acc")
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6
    console.log(`n=${n}: parse=${parseMs.toFixed(1)}ms tile=${elapsedMs.toFixed(1)}ms, ${variants.length} variants`)
}
