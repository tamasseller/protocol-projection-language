/**
 * @ppl/target-js — Compiled-source JS/TS codegen for a codec program: the
 * `RaisedProc` → JS backbone.
 *
 * Turns one raised procedure body (`@ppl/machine`'s `raise.ts`) into a
 * real TypeScript `function` — real `if`/`while`/`switch`, direct calls
 * between the generated functions — instead of shipping the RTL program
 * itself and interpreting it via `run()` + `createCodecExtension` at every
 * encode/decode call. Built on two pieces from this session's earlier
 * work:
 *
 * - `@ppl/machine`'s `raise.ts`, for control-flow shape: every `BR_TABLE`/
 *   `LOOP` becomes a real `dispatch`/`loop` node once, so this module
 *   walks a tree instead of re-deriving block structure from a flat
 *   instruction stream itself.
 * - `@ppl/codecs`'s `resolveHandleTypes`/`resolveProcedureTypes`, for
 *   *meaning*: a raised `ENTER dst,src,ref` is just three numbers — it's
 *   only readable as "enter field `value` of the union payload" once
 *   something resolves `ref` against the handle's own statically-known
 *   `TypeNode`. That "something" is exactly what those two functions
 *   provide, header-independent, which is what makes this module possible
 *   at all: nothing here needs a `Procedure.header` to survive any
 *   particular way the `RtlProgram` was produced.
 *
 * Scope: any program built from the 17 codec-extension opcodes
 * (`@ppl/codecs/src/engine/opcodes.ts`) — not just the binary family
 * (`binary-rules.ts`); `delta-leb128.ts`/`json.ts`/a user's own
 * `CodecRule`s all compile down to the same opcode vocabulary via
 * `codecRules()`, so nothing here is binary-specific. What's genuinely
 * out of scope: a plain (non-`CALL_CODEC`) `CALL` between procedures —
 * no codec rule in this codebase emits one, and supporting it would mean
 * inventing a second, RTL-argument-based calling convention alongside
 * this module's Handle/Ctx one for a case nothing exercises.
 *
 * Lives in `engine/`, not `components/`, for the same reason
 * `@ppl/codecs/src/engine/codec-extension.ts` does: it's fixed
 * infrastructure for *any* wire-format convention built on the codec
 * extension's 17 opcodes, not itself a swappable convention the way
 * `components/ts-emitter.ts`/`ts-alternative-rules.ts`'s rule lists are —
 * there's no `CodecCodegenRule[]` a caller picks between, just one
 * opcode-vocabulary-to-JS translation every convention shares.
 *
 * Split across three siblings so this file stays just the tree walk:
 * `line-builder.ts` owns indentation (`LineBuilder`), `codec-type-nav.ts`
 * owns the pure `TypeNode`/`TypeEdge` questions, and `codec-module.ts` is
 * the whole-program entry point (`generateCodecModule`) that drives this
 * file once per procedure.
 *
 * ── Why no `acc` variable ──────────────────────────────────────────────
 *
 * A naive reading of `raise.ts`'s tree might expect this module to track
 * a JS-level stand-in for the VM's `acc` register, materializing every
 * EXT op's result into it and threading that through statement order.
 * That's unnecessary here: `raise.ts`'s `readsAcc` handling (this
 * session's own fix — see `ExtOpEffect.readsAcc`'s doc comment) means
 * every codec op that reads pre-existing acc (`WRITE`, `STORE_VAL`,
 * `WRITE_SEQ`, `READ_SEQ`) already carries that value as an explicit
 * trailing `args` entry in the raised tree. The data flow is fully
 * explicit; this module just translates each `Expr` node into a nested
 * JS expression, exactly like it already does for `binary`/`unary`/
 * `call`. The one thing that's genuinely stateful across statements is
 * the handle table (`ENTER`/`ENTER_NEXT` naming a *new* value at a given
 * index, later `CALL_CODEC`/`TAG`/etc. referencing it by that same
 * index) — real local variables (`h0`, `h1`, ...) handle that directly,
 * declared once per procedure and reassigned in place, mirroring
 * `codec-extension.ts`'s own per-call `Frame` array slot for slot.
 */

import type {Stmt, Expr, RaisedProc} from "@ppl/machine"
import {ExprKind, StmtKind} from "@ppl/machine"
import type {TypeNode, TypeEdge} from "@ppl/core"
import {kindOf, SemanticTypeKinds} from "@ppl/core"
import type {Direction, CodecExtInstr} from "@ppl/codecs"
import {requireSlotNode, intWireSize, assertNever} from "@ppl/codecs"
import {LineBuilder} from "./line-builder"
import {requireEdge, isStructKind, variantNamesOf, describeType} from "./codec-type-nav"

const jsString = (s: string): string => JSON.stringify(s)

// ─────────────────────────────────────────────────────────────────────────
// Generation context — the live, per-procedure handle-slot type map (see
// resolveHandleTypes's own doc comment for why this can't be a single
// precomputed snapshot: the same slot index can hold different types at
// different points within one procedure body).
// ─────────────────────────────────────────────────────────────────────────

interface GenCtx
{
    readonly direction: Direction
    readonly slotTypes: Map<number, TypeNode>
}

/** Pre-scan a raised body for the highest handle-table index referenced,
 *  so the generated function can declare `let h1, h2, ..., hN;` once up
 *  front — every handle var is function-scoped and reassigned in place
 *  (never re-`let`), so a value entered inside one `dispatch` case stays
 *  a plain JS variable visible after the dispatch too, matching the
 *  interpreted runtime's own flat, function-lifetime `Frame` array. */
function scanMaxHandleIndex(stmts: readonly Stmt<CodecExtInstr>[]): number
{
    let max = 0
    const bumpAll = (indices: readonly number[]): void => {for(const i of indices) if(i > max) max = i}

    function visitExpr(e: Expr<CodecExtInstr>): void
    {
        if(e.kind === ExprKind.Ext)
        {
            switch(e.ext)
            {
                case "ENTER": bumpAll([e.dst, e.src, e.ref]); break
                case "ENTER_NEXT": bumpAll([e.dst, e.src]); break
                case "LOAD_VAL": case "STORE_VAL": case "COUNT": case "TAG": case "OPEN_LIST":
                    bumpAll([e.src]); break
                case "CALL_CODEC": case "CALL_CODEC_NEXT": bumpAll([e.src]); break
                case "WRITE_SEQ": case "READ_SEQ": bumpAll([e.handle]); break
                // Iterator ids, never handle-table slots — nothing to bump.
                case "READ": case "WRITE": case "HAS_NEXT": case "CLONE_RD": case "CLONE_WR": case "SEEK": break
                default: assertNever(e)
            }
            for(const a of e.args) visitExpr(a)
        }
        else if(e.kind === ExprKind.Binary) {visitExpr(e.left); visitExpr(e.right)}
        else if(e.kind === ExprKind.Unary) visitExpr(e.value)
        else if(e.kind === ExprKind.Call) for(const a of e.args) visitExpr(a)
    }

    function visitStmts(stmts: readonly Stmt<CodecExtInstr>[]): void
    {
        for(const s of stmts)
        {
            switch(s.kind)
            {
                case StmtKind.Assign: visitExpr(s.value); break
                case StmtKind.ExprStmt: visitExpr(s.value); break
                case StmtKind.Return: visitExpr(s.value); break
                case StmtKind.Trap: break
                case StmtKind.Dispatch: visitExpr(s.test); for(const c of s.cases) visitStmts(c); break
                case StmtKind.Loop: visitStmts(s.cond); visitExpr(s.test); visitStmts(s.body); break
            }
        }
    }

    visitStmts(stmts)
    return max
}

function endsInTerminator(stmts: readonly Stmt<CodecExtInstr>[]): boolean
{
    const last = stmts[stmts.length - 1]
    return last?.kind === StmtKind.Return || last?.kind === StmtKind.Trap
}

// ─────────────────────────────────────────────────────────────────────────
// Expression translation
// ─────────────────────────────────────────────────────────────────────────

function translateExpr(e: Expr<CodecExtInstr>, g: GenCtx): string
{
    switch(e.kind)
    {
        case ExprKind.Const: return String(e.value)
        case ExprKind.Slot: return `s${e.index}`
        case ExprKind.Binary: return `evalBinary(${translateExpr(e.left, g)}, ${translateExpr(e.right, g)}, ${jsString(e.op)})`
        case ExprKind.Unary: return `evalUnary(${translateExpr(e.value, g)}, ${jsString(e.op)})`
        case ExprKind.Call: throw new Error(`codec-codegen: a plain CALL (to procedure ${e.calleeIndex}) isn't supported — no codec rule in this codebase emits one`)
        case ExprKind.Ext: return translateExt(e, g)
    }
}

/** Build the child-handle expression `ENTER`/`CALL_CODEC(_NEXT)` all
 *  share — struct field, union variant (direction-dependent), or list
 *  element — wrapped with `ensured(...)` when the target's own type is a
 *  struct and we're decoding (mirrors codec-extension.ts's
 *  `ensureDecodedStructExists`, applied uniformly to every handle
 *  `computeChild`/`computeNext` produces). Also advances `g.slotTypes` so
 *  code emitted after this point sees the new type — callers doing that
 *  themselves would be relying on this function's own internals, so it's
 *  done here once. */
function buildChildHandleExpr(srcVar: string, edge: TypeEdge, g: GenCtx): string
{
    let expr: string
    if("field" in edge.step) expr = `{ c: getH(${srcVar}), k: ${jsString(edge.step.field)} }`
    else if("variant" in edge.step)
        expr = g.direction === "decode"
            ? `enterVariant(${srcVar}, ${jsString(edge.step.variant)})`
            : `activeVariantPayload(${srcVar}, ${jsString(edge.step.variant)})`
    else expr = `nextChild(${srcVar})` // {element: true}

    if(g.direction === "decode" && isStructKind(edge.target)) expr = `ensured(${expr})`
    return expr
}

function translateExt(e: Extract<Expr<CodecExtInstr>, {kind: ExprKind.Ext}>, g: GenCtx): string
{
    const arg = (i: number): string => translateExpr(e.args[i]!, g)

    switch(e.ext)
    {
        case "ENTER": case "ENTER_NEXT":
            throw new Error(`codec-codegen: ${e.ext} should only ever appear as its own statement — never nested in an expression`)

        case "LOAD_VAL": return `loadVal(h${e.src})`
        case "COUNT": return `countOf(h${e.src})`

        case "TAG":
            {
                const node = requireSlotNode(g.slotTypes, e.src, "TAG")
                return `tagOf(h${e.src}, ${JSON.stringify(variantNamesOf(node))})`
            }

        case "OPEN_LIST": return `openList(h${e.src})`
        case "READ": return `read(ctx, ${e.iter}, ${e.width})`
        case "HAS_NEXT": return `hasNext(ctx, ${e.iter})`
        case "CLONE_RD": return `cloneRd(ctx, ${e.src}, ${e.dst})`
        case "CLONE_WR": return `cloneWr(ctx, ${e.src}, ${e.dst})`
        case "SEEK": return `seek(ctx, ${e.iter}, ${e.delta})`
        case "WRITE": return `write(ctx, ${e.iter}, ${e.width}, ${arg(0)})`

        case "STORE_VAL":
            {
                const node = requireSlotNode(g.slotTypes, e.src, "STORE_VAL")
                if(kindOf(node.type) !== SemanticTypeKinds.Integer) return `setH(h${e.src}, ${arg(0)})`
                const width = intWireSize(node.type as {min: number, max: number})
                const signed = (node.type as {min: number}).min < 0
                return `storeVal(h${e.src}, ${arg(0)}, ${width}, ${signed})`
            }

        case "WRITE_SEQ": return `writeSeq(ctx, ${e.iter}, h${e.handle}, ${e.width}, ${arg(0)})`
        case "READ_SEQ": return `readSeq(ctx, ${e.iter}, h${e.handle}, ${e.width}, ${e.signed}, ${arg(0)})`

        case "CALL_CODEC":
            {
                const srcNode = requireSlotNode(g.slotTypes, e.src, "CALL_CODEC")
                const edge = requireEdge(srcNode, e.ref, "CALL_CODEC")
                const childExpr = buildChildHandleExpr(`h${e.src}`, edge, g)
                return `${g.direction}_proc${e.calleeIndex}(${childExpr}, ctx)`
            }

        case "CALL_CODEC_NEXT":
            {
                const srcNode = requireSlotNode(g.slotTypes, e.src, "CALL_CODEC_NEXT")
                const edge = requireEdge(srcNode, 0, "CALL_CODEC_NEXT")
                const childExpr = buildChildHandleExpr(`h${e.src}`, edge, g)
                return `${g.direction}_proc${e.calleeIndex}(${childExpr}, ctx)`
            }

        default:
            return assertNever(e)
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Statement translation
// ─────────────────────────────────────────────────────────────────────────

/** `ENTER`/`ENTER_NEXT` are the one case that isn't "translate an
 *  expression": their result is a *name* (a handle-table slot), never a
 *  value anything reads, so they're recognized here — before generic
 *  expression translation ever sees them — and lowered to a plain
 *  variable assignment instead. */
function translateEnterStmt(e: Extract<Expr<CodecExtInstr>, {ext: "ENTER" | "ENTER_NEXT"}>, g: GenCtx, b: LineBuilder): void
{
    const [dst, src, ref] = e.ext === "ENTER" ? [e.dst, e.src, e.ref] : [e.dst, e.src, 0]

    const srcNode = requireSlotNode(g.slotTypes, src, e.ext)
    const edge = requireEdge(srcNode, ref, e.ext)
    b.line(`h${dst} = ${buildChildHandleExpr(`h${src}`, edge, g)};`)
    g.slotTypes.set(dst, edge.target)
}

function translateStmt(s: Stmt<CodecExtInstr>, g: GenCtx, b: LineBuilder): void
{
    switch(s.kind)
    {
        case StmtKind.Assign:
            b.line(`s${s.slot} = ${translateExpr(s.value, g)};`)
            return

        case StmtKind.ExprStmt:
            if(s.value.kind === ExprKind.Ext && (s.value.ext === "ENTER" || s.value.ext === "ENTER_NEXT"))
                translateEnterStmt(s.value, g, b)
            else
                b.line(`${translateExpr(s.value, g)};`)
            return

        case StmtKind.Return:
            // Every generated procedure is declared `: void` — matching
            // resolver.ts's own "codec-rule bodies are void; the return
            // value is discarded, never meaningful" convention — so the
            // expression is evaluated for its side effect only; `return
            // <expr>;` would be a real TS type error whenever expr's own
            // type isn't void (e.g. `return countOf(h0);`).
            b.line(`${translateExpr(s.value, g)};`)
            b.line("return;")
            return

        case StmtKind.Trap:
            b.line(`throw new CodecTrap(${s.code});`)
            return

        case StmtKind.Dispatch:
            b.block(`switch (${translateExpr(s.test, g)}) {`, () =>
            {
                s.cases.forEach((body, i) =>
                {
                    b.block(`case ${i}: {`, () =>
                    {
                        translateStmts(body, g, b)
                        if(!endsInTerminator(body)) b.line("break")
                    })
                })
            })
            return

        case StmtKind.Loop:
            b.block("for (;;) {", () =>
            {
                translateStmts(s.cond, g, b)
                b.line(`if (!(${translateExpr(s.test, g)})) break`)
                translateStmts(s.body, g, b)
            })
            return
    }
}

function translateStmts(stmts: readonly Stmt<CodecExtInstr>[], g: GenCtx, b: LineBuilder): void
{
    for(const s of stmts) translateStmt(s, g, b)
}

// ─────────────────────────────────────────────────────────────────────────
// Per-procedure driver
// ─────────────────────────────────────────────────────────────────────────

/** One `RaisedProc`, translated in isolation — `codec-module.ts` calls
 *  this once per procedure and stitches the results together. */
export function generateProcedure(index: number, raised: RaisedProc<CodecExtInstr>, entryNode: TypeNode, direction: Direction): string
{
    // Seeded with just slot 0 (the entry handle) — everything else is
    // discovered live, in translateStmts' own walk order, via the same
    // ENTER/ENTER_NEXT/CALL_CODEC(_NEXT) rules resolveHandleTypes uses
    // (childNode/nextNode/requireSlotNode), just interleaved with code
    // emission instead of run once over the flat pre-raise body.
    const slotTypes = new Map<number, TypeNode>([[0, entryNode]])
    const maxHandleIndex = scanMaxHandleIndex(raised.body)
    const g: GenCtx = {direction, slotTypes}

    const b = new LineBuilder()
    b.line(`// proc ${index}: ${describeType(entryNode)}`)
    b.block(`function ${direction}_proc${index}(h0: Handle, ctx: Ctx): void {`, () =>
    {
        if(raised.peakSlots > 0) b.line(`let ${Array.from({length: raised.peakSlots}, (_, i) => `s${i}`).join(", ")};`)
        if(maxHandleIndex > 0) b.line(`let ${Array.from({length: maxHandleIndex}, (_, i) => `h${i + 1}`).join(", ")};`)
        translateStmts(raised.body, g, b)
    })
    return b.toString()
}
