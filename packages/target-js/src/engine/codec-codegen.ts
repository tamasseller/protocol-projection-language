/**
 * @ppl/target-js — Compiled-source JS/TS codegen for a codec program: the
 * `RaisedProc` → JS backbone.
 *
 * Turns one raised procedure body (`@ppl/machine`'s `raise.ts`) into a
 * real TypeScript `function` — real `if`/`while`/`switch`, direct calls
 * between the generated functions — instead of shipping the RTL program
 * itself and interpreting it via `run()` + `createCodecExtension` at every
 * encode/decode call. Built on two pieces from earlier work:
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
 * this module's own for a case nothing exercises.
 *
 * ── Every procedure returns/takes a real value — no `Handle` ───────────
 *
 * Unlike `@ppl/codecs`'s own interpreter (`codec-extension.ts`), a
 * generated decode procedure **returns** the value it decoded and a
 * generated encode procedure **takes** the value it's encoding as a real
 * parameter — the interpreter's `(container, key)` pointer-pair `Handle`
 * exists only because a generic VM has no other way to write a decoded
 * primitive back into its parent; a compiled JS target doesn't have that
 * constraint. How a value of a given `TypeNode`'s own local shape is
 * actually constructed/read is never this module's own concern — that's
 * `resolver.ts`'s `Accessor`, supplied per rule (`ts-emitter.ts`'s default
 * plain-object/discriminated-union mapping, or an alternative like
 * `ts-alternative-rules.ts`'s class-hierarchy one) and looked up per
 * `TypeNode`, globally, via the same projection `codec-module.ts` already
 * builds for the public TS declarations.
 *
 * Translation stays fully generic, instruction-by-instruction, exactly as
 * it always has — there is no per-procedure shape recognition, so any
 * `CodecRule`-authored body compiles at any nesting depth, in any order.
 * What replaces `Handle` is two pieces of purely compile-time bookkeeping,
 * both scoped to one procedure's own body and never crossing a procedure
 * boundary as a runtime value — recorded and consulted in
 * `codec-codegen-ext.ts`, not here (see that file's own header):
 * a per-slot write-back descriptor and an encode-side ascending index
 * counter for list traversal.
 *
 * This file itself stays the generic half: the `Stmt`/`Expr` tree walk
 * that applies to *any* raised body (`Assign`/`ExprStmt`/`Return`/`Trap`/
 * `Dispatch`/`Loop`, and the non-`Ext` expression kinds), plus the
 * per-procedure driver (`generateProcedure`) that wraps it in a real
 * `function`. The one thing it doesn't know how to translate — an `Ext`
 * node, i.e. one of the 17 codec-extension opcodes — it simply hands off
 * to `codec-codegen-ext.ts` at the two join points a raised body actually
 * has one (a nestable expression, via `translateExt`; a statement-only
 * op, via `emitExtStmtIfApplicable`), plus `emitReturn` for a procedure's
 * own `Accessor`-dependent exit value.
 *
 * Split across five siblings so this file stays just the generic tree
 * walk: `line-builder.ts` owns indentation (`LineBuilder`),
 * `codec-type-nav.ts` owns the pure `TypeNode`/`TypeEdge` questions,
 * `codec-codegen-ext.ts` owns everything specific to the 17
 * `CodecExtInstr` opcodes (`GenCtx`, the write-back/index bookkeeping,
 * `Accessor` lookup, and `ENTER`/`CALL_CODEC`/`TAG`/`WRITE_SEQ`/...
 * translation), `resolver.ts` owns the `Accessor`/`TSTypeDecl` shapes
 * themselves, and `codec-module.ts` is the whole-program entry point
 * (`generateCodecModule`) that drives this file once per procedure,
 * threading through the `Accessor` projection.
 */

import type {Stmt, Expr, RaisedProc, BinaryOpcode, UnaryOpcode} from "@ppl/machine"
import {ExprKind, StmtKind} from "@ppl/machine"
import type {TypeNode} from "@ppl/core"
import type {Direction, Correspondence} from "@ppl/core"
import type {CodecExtInstr} from "@ppl/codecs"
import type {TSTypeDecl} from "./resolver"
import {LineBuilder} from "./line-builder"
import {describeType} from "./codec-type-nav"
import type {GenCtx} from "./codec-codegen-ext"
import {prescan, translateExt, emitExtStmtIfApplicable, emitReturn, idxCounter, localAccessorFor, injectLocalOnlyDefaults} from "./codec-codegen-ext"

// ─────────────────────────────────────────────────────────────────────────
// Binary/unary op rendering — inline JS text, not a runtime evalBinary/
// evalUnary call. `@ppl/machine`'s `vm.ts` (where those live) is an
// interpreter designed as a testing oracle, not a production dependency —
// generated code must not import it. `BinaryOpcode`/`UnaryOpcode` are
// small, closed enumerations (never extended by a rule author), so each
// case is inlined directly, exactly matching `evalBinary`/`evalUnary`'s
// own semantics (verified against them by
// `binary-op-codegen.runtime.test.ts`, the same differential-oracle
// pattern `raise.ts`'s own test suite already uses for the same reason).
// Every operand is parenthesized — `l`/`r`/`v` are arbitrary nested
// expression text, never guaranteed to already be atoms.
// ─────────────────────────────────────────────────────────────────────────

export function binaryOpToJs(op: BinaryOpcode, l: string, r: string): string
{
    switch(op)
    {
        case "ADD": return `((${l}) + (${r})) >>> 0`
        case "SUB": return `((${l}) - (${r})) >>> 0`
        case "RSUB": return `((${r}) - (${l})) >>> 0`
        case "MUL": return `Math.imul(${l}, ${r}) >>> 0`
        // No `>>> 0` wrap — matches evalBinary's own (unwrapped, signed-
        // result) behavior exactly, not "fixing" a quirk that isn't a bug.
        case "AND": return `(${l}) & (${r})`
        case "OR": return `(${l}) | (${r})`
        case "XOR": return `(${l}) ^ (${r})`
        case "SHL": return `((${l}) << ((${r}) & 31)) >>> 0`
        case "SHR": return `(${l}) >>> ((${r}) & 31)`
        case "ASR": return `((${l}) >> ((${r}) & 31)) >>> 0`
        case "EQ": return `((${l}) === (${r}) ? 1 : 0)`
        case "NE": return `((${l}) !== (${r}) ? 1 : 0)`
        case "LT_S": return `(((${l})|0) < ((${r})|0) ? 1 : 0)`
        case "LE_S": return `(((${l})|0) <= ((${r})|0) ? 1 : 0)`
        case "GT_S": return `(((${l})|0) > ((${r})|0) ? 1 : 0)`
        case "GE_S": return `(((${l})|0) >= ((${r})|0) ? 1 : 0)`
        case "LT_U": return `((${l}) < (${r}) ? 1 : 0)`
        case "LE_U": return `((${l}) <= (${r}) ? 1 : 0)`
        case "GT_U": return `((${l}) > (${r}) ? 1 : 0)`
        case "GE_U": return `((${l}) >= (${r}) ? 1 : 0)`
    }
}

export function unaryOpToJs(op: UnaryOpcode, v: string): string
{
    switch(op)
    {
        case "NEG": return `(-(${v})) >>> 0`
        case "NOT": return `(~(${v})) >>> 0`
        case "CLZ": return `Math.clz32(${v})`
        // Not a single JS expression (a 5-step bit-reversal) — a named
        // runtime helper instead, same idea as evalUnary's own MUL/CLZ
        // leaning on Math.imul/Math.clz32 rather than hand-rolling them.
        case "REVBITS": return `revBits(${v})`
        case "SXTB": return `((((${v}) << 24) >> 24) >>> 0)`
        case "SXTH": return `((((${v}) << 16) >> 16) >>> 0)`
        case "UXTB": return `((${v}) & 0xff)`
        case "UXTH": return `((${v}) & 0xffff)`
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Expression translation — everything that's still a single, nestable
// value expression (unaffected by the write-back rework: none of these
// ever depended on `Handle`, only on a slot's own current value).
// ─────────────────────────────────────────────────────────────────────────

export function translateExpr(e: Expr<CodecExtInstr>, g: GenCtx): string
{
    switch(e.kind)
    {
        case ExprKind.Const: return String(e.value)
        case ExprKind.Slot: return `s${e.index}`
        case ExprKind.Binary: return binaryOpToJs(e.op, translateExpr(e.left, g), translateExpr(e.right, g))
        case ExprKind.Unary: return unaryOpToJs(e.op, translateExpr(e.value, g))
        case ExprKind.Call: return `${g.direction}_proc${e.calleeIndex}(${[...e.args.map(a => translateExpr(a, g)), "ctx"].join(", ")})`
        case ExprKind.Ext: return translateExt(e, g)
    }
}

function endsInTerminator(stmts: readonly Stmt<CodecExtInstr>[]): boolean
{
    const last = stmts[stmts.length - 1]
    return last?.kind === StmtKind.Return || last?.kind === StmtKind.Trap
}

// ─────────────────────────────────────────────────────────────────────────
// Statement translation
// ─────────────────────────────────────────────────────────────────────────

function translateStmt(s: Stmt<CodecExtInstr>, entryNode: TypeNode | undefined, g: GenCtx, b: LineBuilder): void
{
    switch(s.kind)
    {
        case StmtKind.Assign:
            b.line(`s${s.slot} = ${translateExpr(s.value, g)};`)
            return

        case StmtKind.ExprStmt:
            if(s.value.kind === ExprKind.Ext && emitExtStmtIfApplicable(s.value, g, b)) return
            b.line(`${translateExpr(s.value, g)};`)
            return

        case StmtKind.Return:
            // A GENERIC-ABI procedure (no entryNode — a plain-CALL helper
            // like delta-leb128.ts's leb128_encode/decode) has no separate
            // handle/Accessor exit value: s.value *is* the real result.
            if(entryNode === undefined) { b.line(`return ${translateExpr(s.value, g)};`); return }

            // s.value's own evaluation can carry a real, still-pending
            // side effect (raise.ts's own killAcc/readAcc distinction —
            // e.g. delta-leb128.ts's `if (left == 0) { return; }` right
            // after a WRITE, where the WRITE was never flushed as its own
            // statement and only ever appears embedded in this RETURN's
            // own value) — so it still has to run, even though what it
            // evaluates to is never itself this procedure's real result
            // (that's entryNode's own accessor, via emitReturn).
            if(!(s.value.kind === ExprKind.Ext && emitExtStmtIfApplicable(s.value, g, b)))
                b.line(`${translateExpr(s.value, g)};`)
            emitReturn(g, b)
            return

        case StmtKind.Trap:
            b.line(`throw new CodecTrap(${s.code});`)
            return

        case StmtKind.Dispatch:
            b.block(`switch (${translateExpr(s.test, g)}) {`, () =>
            {
                s.cases.forEach((body, i) =>
                {
                    // The last arm is every other value (isa-core.md §4.5).
                    b.block(i === s.cases.length - 1 ? "default: {" : `case ${i}: {`, () =>
                    {
                        translateStmts(body, entryNode, g, b)
                        if(!endsInTerminator(body)) b.line("break")
                    })
                })
            })
            return

        case StmtKind.Loop:
            // One shape for both openers (isa-core.md §4.5): the test sits
            // ahead of the body for `LOOP_PRE` and after it for `LOOP_POST`,
            // which is the only thing the two differ in.
            b.block("for (;;) {", () =>
            {
                const test = (): void =>
                {
                    translateStmts(s.cond, entryNode, g, b)
                    b.line(`if (!(${translateExpr(s.test, g)})) break`)
                }

                if(s.pre) test()
                translateStmts(s.body, entryNode, g, b)
                if(!s.pre) test()
            })
            return
    }
}

function translateStmts(stmts: readonly Stmt<CodecExtInstr>[], entryNode: TypeNode | undefined, g: GenCtx, b: LineBuilder): void
{
    for(const s of stmts) translateStmt(s, entryNode, g, b)
}

// ─────────────────────────────────────────────────────────────────────────
// Per-procedure driver
// ─────────────────────────────────────────────────────────────────────────

/** One `RaisedProc`, translated in isolation — `codec-module.ts` calls
 *  this once per procedure and stitches the results together.
 *  `projection` is the same `Map<number, TSTypeDecl>` `projectTSTypes`
 *  produced for the public declarations — this is what supplies every
 *  `Accessor` this module consults, keyed by `TypeNode.id`.
 *
 *  `entryCorrespondence`, when given (docs/codec-image.md §2 — bridging a
 *  received codec image to a local schema), is this procedure's own
 *  boundary `Correspondence` — `entryNode` stays the *image* node
 *  unconditionally either way (wire-format concerns, unaffected by
 *  reconciliation), while `entryCorrespondence.localNode` (absent for a
 *  procedure boundary reached entirely through image-only navigation) is
 *  what actually governs this function's own declared parameter/return
 *  type and its `v0` accumulator's real shape — `localAccessorFor(0, g)`
 *  makes that same "local when present, else the trivial scratch shape"
 *  decision every other join point in `codec-codegen-ext.ts` already
 *  makes, so this reduces to exactly today's behavior whenever
 *  `entryCorrespondence` is omitted. */
export function generateProcedure(
    index: number, raised: RaisedProc<CodecExtInstr>, entryNode: TypeNode | undefined, direction: Direction,
    projection: ReadonlyMap<number, TSTypeDecl>,
    entryCorrespondence?: Correspondence,
): string
{
    const slotTypes = new Map<number, TypeNode>(entryNode ? [[0, entryNode]] : [])
    const {maxSlot, listTraversalSlots} = prescan(raised.body)
    const correspondences = entryCorrespondence ? new Map([[0, entryCorrespondence]]) : undefined
    const g: GenCtx = {direction, slotTypes, projection, writeBacks: new Map(), idxDeclared: new Set(), tempCounter: {n: 0}, correspondences}

    const b = new LineBuilder()

    // GENERIC-ABI helper procedure (no header, e.g. delta-leb128.ts's
    // leb128_encode/decode) — a plain-CALL callee: real numeric
    // parameters/return, no v0/Accessor/handle-slot machinery at all.
    // `entryTypes.get(i)` (codec-module.ts) is undefined for exactly these
    // — never a CALL_CODEC target, so procedureBoundaryTypes never visits
    // them.
    if(entryNode === undefined)
    {
        b.line(`// proc ${index}: GENERIC helper`)
        const params = [...Array.from({length: raised.argCount}, (_, i) => `s${i}: number`), "ctx: Ctx"].join(", ")
        b.block(`function ${direction}_proc${index}(${params}): number {`, () =>
        {
            if(raised.peakSlots > raised.argCount)
                b.line(`let ${Array.from({length: raised.peakSlots - raised.argCount}, (_, i) => `s${i + raised.argCount}`).join(", ")};`)
            translateStmts(raised.body, undefined, g, b)
        })
        return b.toString()
    }

    // A procedure boundary reached entirely through image-only navigation
    // (docs/codec-image.md §2/§3) has no local representation at all — no
    // `TSTypeDecl` to name a real declared type from, so its own
    // parameter/return type is `any` (there is no local type to mean).
    let ref: string
    if(entryCorrespondence && !entryCorrespondence.localNode)
    {
        ref = "any"
    }
    else
    {
        const node = entryCorrespondence?.localNode ?? entryNode
        const entryDecl = projection.get(node.id)
        if(!entryDecl) throw new Error(`codec-codegen: no local-representation projection for ${describeType(node)} (node #${node.id})`)
        ref = entryDecl.ref
    }
    const entryAccess = localAccessorFor(0, g)

    b.line(`// proc ${index}: ${describeType(entryNode)}`)

    if(direction === "decode")
    {
        b.block(`function decode_proc${index}(ctx: Ctx): ${ref} {`, () =>
        {
            if(raised.peakSlots > 0) b.line(`let ${Array.from({length: raised.peakSlots}, (_, i) => `s${i}`).join(", ")};`)
            if(maxSlot > 0) b.line(`let ${Array.from({length: maxSlot}, (_, i) => `v${i + 1}`).join(", ")};`)
            b.line(
                entryAccess.kind === "struct" ? `let v0: any = ${entryAccess.beginStruct?.() ?? "{}"};` :
                entryAccess.kind === "list" ? `let v0: any = ${entryAccess.beginList?.() ?? "[]"};` :
                "let v0: any;",
            )
            if(entryAccess.kind === "struct" && entryCorrespondence?.outcome === "matched")
                injectLocalOnlyDefaults(entryCorrespondence, "v0", g, b)
            translateStmts(raised.body, entryNode, g, b)
            if(!endsInTerminator(raised.body)) emitReturn(g, b)
        })
    }
    else
    {
        b.block(`function encode_proc${index}(v0: ${ref}, ctx: Ctx): void {`, () =>
        {
            if(raised.peakSlots > 0) b.line(`let ${Array.from({length: raised.peakSlots}, (_, i) => `s${i}`).join(", ")};`)
            if(maxSlot > 0) b.line(`let ${Array.from({length: maxSlot}, (_, i) => `v${i + 1}`).join(", ")};`)
            for(const slot of listTraversalSlots) idxCounter(slot, g, b)
            translateStmts(raised.body, entryNode, g, b)
        })
    }

    return b.toString()
}
