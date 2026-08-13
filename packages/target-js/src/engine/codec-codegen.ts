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
 * boundary as a runtime value:
 *
 * - A **write-back descriptor** per handle slot (`WriteBack`, below):
 *   where does *this* slot's eventual value belong, once known — a named
 *   field of another slot's own accumulator, or an appended list element.
 *   Recorded once, whenever `ENTER`/`ENTER_NEXT` names a new slot.
 * - A plain, uniform, per-slot **accumulator** local (`v0`, `v1`, ...) —
 *   `{}` for a struct, `[]` for a list, reassigned wholesale (never
 *   incrementally mutated) for a union or leaf. Always this shape
 *   internally, regardless of what the target `TypeNode`'s own `Accessor`
 *   eventually converts it to — that conversion (`finishStruct`/
 *   `finishUnion`/`finishList`) happens exactly once, at the point a
 *   value is about to cross a procedure boundary (a `return`, or a
 *   `call_codec` argument), never per field/element.
 *
 * Decode and encode are asymmetric here, not by an oversight but because
 * they have opposite jobs at a slot's own creation site: decode has
 * nothing to compute yet at `ENTER`/`ENTER_NEXT` (the value doesn't exist
 * until something *writes* it later), so it's pure, deferred bookkeeping.
 * Encode already holds the full parent value and has nothing to defer —
 * `ENTER`/`ENTER_NEXT` must *eagerly* pull the child value out right
 * there, because a later statement (`load_val`, or `tag`, for a hoisted
 * union field) reads it immediately after. List traversal specifically
 * needs one further piece of encode-only bookkeeping the RTL doesn't hand
 * over for free: the raised loop only counts elements *down* (`left`),
 * but `Accessor.elementAt` needs an *ascending* index — so this module
 * introduces its own counter, once per list slot ever traversed for
 * encode.
 *
 * Split across three siblings so this file stays just the tree walk:
 * `line-builder.ts` owns indentation (`LineBuilder`), `codec-type-nav.ts`
 * owns the pure `TypeNode`/`TypeEdge` questions, and `codec-module.ts` is
 * the whole-program entry point (`generateCodecModule`) that drives this
 * file once per procedure, threading through the `Accessor` projection.
 */

import type {Stmt, Expr, RaisedProc} from "@ppl/machine"
import {ExprKind, StmtKind} from "@ppl/machine"
import type {TypeNode, TypeEdge} from "@ppl/core"
import {kindOf, SemanticTypeKinds} from "@ppl/core"
import type {Direction, CodecExtInstr} from "@ppl/codecs"
import {requireSlotNode, intWireSize, assertNever} from "@ppl/codecs"
import type {Accessor, TSTypeDecl} from "./resolver"
import {LineBuilder} from "./line-builder"
import {requireEdge, variantNamesOf, describeType} from "./codec-type-nav"

const jsString = (s: string): string => JSON.stringify(s)

// ─────────────────────────────────────────────────────────────────────────
// Generation context
// ─────────────────────────────────────────────────────────────────────────

/** Where a handle slot's own eventual value belongs, once known — recorded
 *  when `ENTER`/`ENTER_NEXT` names the slot, consulted whenever something
 *  later produces that slot's real value (`STORE_VAL`, or a nested
 *  `CALL_CODEC(_NEXT)`'s own return). A slot with none at all is either
 *  slot 0 (a procedure's own top — never written back into anything
 *  *within* this procedure; its value crosses the procedure boundary
 *  itself, via `return`/the parameter) or a slot re-entered from a
 *  hoisted union field (`{into: "field", ...}` already recorded once,
 *  reused as-is across the field's own bitmap `switch`). */
type WriteBack =
    | {readonly into: "field"; readonly parentSlot: number; readonly name: string}
    | {readonly into: "append"; readonly parentSlot: number}

interface GenCtx
{
    readonly direction: Direction
    /** Image `TypeNode` per handle slot — wire-format concerns only
     *  (width, tag-index-into-the-image's-own-variant-order). Unaffected
     *  by anything in this rework. */
    readonly slotTypes: Map<number, TypeNode>
    /** Local-representation projection, keyed by `TypeNode.id` — the
     *  source of every `Accessor` this module consults. Built once per
     *  whole program (`codec-module.ts`), shared read-only across every
     *  procedure. */
    readonly projection: ReadonlyMap<number, TSTypeDecl>
    readonly writeBacks: Map<number, WriteBack>
    /** Which slots already have an encode-side ascending index counter
     *  (`__idx${slot}`) declared — `ENTER_NEXT`/`CALL_CODEC_NEXT` need one
     *  the first time a given slot is traversed, never again after. */
    readonly idxDeclared: Set<number>
}

function accessorFor(node: TypeNode, g: GenCtx): Accessor
{
    const decl = g.projection.get(node.id)
    if(!decl) throw new Error(`codec-codegen: no local-representation projection for ${describeType(node)} (node #${node.id}) — pass the same rule list to projectTSTypes and generateCodecModule`)
    return decl.access
}

/** Narrow an `Accessor` to one `kind` or throw — every call site already
 *  knows which kind it expects from the surrounding opcode/slot-kind
 *  logic; this is purely what lets TS's own discriminated-union narrowing
 *  see it too, with a clear error if a rule's own `access` disagreed with
 *  its `pattern` (a rule bug, not a codegen one). */
function expectAccessor<K extends Accessor["kind"]>(access: Accessor, kind: K, node: TypeNode): Extract<Accessor, {kind: K}>
{
    if(access.kind !== kind)
        throw new Error(`codec-codegen: expected a "${kind}" accessor for ${describeType(node)}, got "${access.kind}" — the rule that claimed this type has an access() that disagrees with its own pattern`)
    return access as Extract<Accessor, {kind: K}>
}

// ─────────────────────────────────────────────────────────────────────────
// Pre-scan — handle-slot count and which slots need an encode-side index
// ─────────────────────────────────────────────────────────────────────────

/** Pre-scan a raised body for the highest handle-table index referenced
 *  (so the generated function can declare `let v1, v2, ..., vN;` once up
 *  front — every slot var is function-scoped and reassigned in place,
 *  never re-`let`, matching the interpreted runtime's own flat, function-
 *  lifetime frame) and which slots are ever the `src` of an `ENTER_NEXT`/
 *  `CALL_CODEC_NEXT` (encode needs an ascending index counter for each,
 *  declared alongside — see this file's own header for why). */
function prescan(stmts: readonly Stmt<CodecExtInstr>[]): {maxSlot: number; listTraversalSlots: ReadonlySet<number>}
{
    let max = 0
    const bumpAll = (indices: readonly number[]): void => {for(const i of indices) if(i > max) max = i}
    const listTraversalSlots = new Set<number>()

    function visitExpr(e: Expr<CodecExtInstr>): void
    {
        if(e.kind === ExprKind.Ext)
        {
            switch(e.ext)
            {
                case "ENTER": bumpAll([e.dst, e.src, e.ref]); break
                case "ENTER_NEXT": bumpAll([e.dst, e.src]); listTraversalSlots.add(e.src); break
                case "LOAD_VAL": case "STORE_VAL": case "COUNT": case "TAG": case "OPEN_LIST":
                    bumpAll([e.src]); break
                case "CALL_CODEC": bumpAll([e.src]); break
                case "CALL_CODEC_NEXT": bumpAll([e.src]); listTraversalSlots.add(e.src); break
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
    return {maxSlot: max, listTraversalSlots}
}

function endsInTerminator(stmts: readonly Stmt<CodecExtInstr>[]): boolean
{
    const last = stmts[stmts.length - 1]
    return last?.kind === StmtKind.Return || last?.kind === StmtKind.Trap
}

// ─────────────────────────────────────────────────────────────────────────
// Expression translation — everything that's still a single, nestable
// value expression (unaffected by the write-back rework: none of these
// ever depended on `Handle`, only on a slot's own current value).
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

function translateExt(e: Extract<Expr<CodecExtInstr>, {kind: ExprKind.Ext}>, g: GenCtx): string
{
    const arg = (i: number): string => translateExpr(e.args[i]!, g)

    switch(e.ext)
    {
        case "ENTER": case "ENTER_NEXT": case "STORE_VAL": case "OPEN_LIST":
        case "CALL_CODEC": case "CALL_CODEC_NEXT":
            throw new Error(`codec-codegen: ${e.ext} should only ever appear as its own statement, never nested in an expression`)

        case "LOAD_VAL":
            {
                const node = requireSlotNode(g.slotTypes, e.src, "LOAD_VAL")
                return expectAccessor(accessorFor(node, g), "integer", node).toWire(`v${e.src}`)
            }

        case "COUNT":
            {
                const node = requireSlotNode(g.slotTypes, e.src, "COUNT")
                return expectAccessor(accessorFor(node, g), "list", node).count(`v${e.src}`)
            }

        case "TAG":
            {
                const node = requireSlotNode(g.slotTypes, e.src, "TAG")
                const activeName = expectAccessor(accessorFor(node, g), "union", node).activeVariantName(`v${e.src}`)
                return `tagOf(${activeName}, ${JSON.stringify(variantNamesOf(node))})`
            }

        case "READ": return `read(ctx, ${e.iter}, ${e.width})`
        case "HAS_NEXT": return `hasNext(ctx, ${e.iter})`
        case "CLONE_RD": return `cloneRd(ctx, ${e.src}, ${e.dst})`
        case "CLONE_WR": return `cloneWr(ctx, ${e.src}, ${e.dst})`
        case "SEEK": return `seek(ctx, ${e.iter}, ${e.delta})`
        case "WRITE": return `write(ctx, ${e.iter}, ${e.width}, ${arg(0)})`
        case "WRITE_SEQ": return `writeSeq(ctx, ${e.iter}, v${e.handle}, ${e.width}, ${arg(0)})`
        case "READ_SEQ": return `readSeq(ctx, ${e.iter}, v${e.handle}, ${e.width}, ${e.signed}, ${arg(0)})`

        default:
            return assertNever(e)
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Statement-only ops — everything that writes a slot's own value, or
// names/traverses one. None of these can appear nested in an expression
// (confirmed by reading every existing `CodecRule` in this codebase); see
// `emitExtStmt` for the one place that still has to check, since a raised
// `RETURN`'s own value can embed a pending one of these (`raise.ts`'s own
// `killAcc`/`readAcc` — a value read here was never necessarily flushed as
// its own statement first).
// ─────────────────────────────────────────────────────────────────────────

/** Assign `value` into slot `slot`'s own accumulator variable, then
 *  propagate it into whatever `slot` itself was written back into, if
 *  anything (a named field, or an appended list element) — the one place
 *  a slot's value ever moves "up" to its own parent within a procedure.
 *  A no-op propagation for slot 0: it has no write-back descriptor by
 *  construction (its value crosses the *procedure* boundary instead, via
 *  `return`/the parameter, handled separately by `emitReturn`). */
function emitWriteBack(slot: number, value: string, g: GenCtx, b: LineBuilder): void
{
    b.line(`v${slot} = ${value};`)
    const wb = g.writeBacks.get(slot)
    if(!wb) return
    if(wb.into === "field") b.line(`v${wb.parentSlot}.${wb.name} = v${slot};`)
    else b.line(`v${wb.parentSlot}.push(v${slot});`)
}

/** The encode-side ascending index counter `ENTER_NEXT`/`CALL_CODEC_NEXT`
 *  need for `Accessor.elementAt` (this file's own header explains why the
 *  RTL's descending `left` isn't enough) — declared once, at the point of
 *  first use, then just referenced (and incremented) everywhere else. */
function idxCounter(slot: number, g: GenCtx, b: LineBuilder): string
{
    const name = `__idx${slot}`
    if(!g.idxDeclared.has(slot))
    {
        g.idxDeclared.add(slot)
        b.line(`let ${name} = 0;`)
    }
    return name
}

function emitEnter(dst: number, src: number, ref: number, g: GenCtx, b: LineBuilder): void
{
    // Bare ENTER's own parent is always struct-kind — union navigation is
    // always atomic, via CALL_CODEC (see emitCallCodec); a list has no
    // named field/variant to ENTER by ref at all (ENTER_NEXT only).
    const srcNode = requireSlotNode(g.slotTypes, src, "ENTER")
    const edge = requireEdge(srcNode, ref, "ENTER")
    const name = (edge.step as {field: string}).field
    g.writeBacks.set(dst, {into: "field", parentSlot: src, name})
    g.slotTypes.set(dst, edge.target)

    if(g.direction === "decode")
    {
        // Deferred: nothing to compute yet. A struct-kind dst needs its
        // own fresh accumulator right away, though, so whatever writes
        // into it later (STORE_VAL, or a nested CALL_CODEC's own return)
        // has a real object to assign a field on. A union-kind dst gets
        // its real value later, atomically, via CALL_CODEC — nothing to
        // initialize here for it at all.
        if(kindOf(edge.target.type) === SemanticTypeKinds.Struct) b.line(`v${dst} = {};`)
    }
    else
    {
        // Eager: encode already holds src's full value; pull the field
        // out right now, since a later statement (load_val, or tag for a
        // hoisted union field) reads v${dst} immediately.
        const access = accessorFor(srcNode, g)
        if(access.kind !== "struct") throw new Error(`codec-codegen: ENTER's parent (slot ${src}) isn't struct-kind`)
        b.line(`v${dst} = ${access.readField(`v${src}`, name)};`)
    }
}

function emitEnterNext(dst: number, src: number, g: GenCtx, b: LineBuilder): void
{
    const srcNode = requireSlotNode(g.slotTypes, src, "ENTER_NEXT")
    const edge = requireEdge(srcNode, 0, "ENTER_NEXT")
    g.writeBacks.set(dst, {into: "append", parentSlot: src})
    g.slotTypes.set(dst, edge.target)

    if(g.direction === "decode")
    {
        if(kindOf(edge.target.type) === SemanticTypeKinds.Struct) b.line(`v${dst} = {};`)
    }
    else
    {
        const access = accessorFor(srcNode, g)
        if(access.kind !== "list") throw new Error(`codec-codegen: ENTER_NEXT's parent (slot ${src}) isn't list-kind`)
        const idx = idxCounter(src, g, b)
        b.line(`v${dst} = ${access.elementAt(`v${src}`, `${idx}++`)};`)
    }
}

function emitStoreVal(src: number, arg0: Expr<CodecExtInstr>, g: GenCtx, b: LineBuilder): void
{
    const node = requireSlotNode(g.slotTypes, src, "STORE_VAL")
    const raw = translateExpr(arg0, g)
    const value = kindOf(node.type) === SemanticTypeKinds.Integer
        ? expectAccessor(accessorFor(node, g), "integer", node).fromWire(raw, intWireSize(node.type as {min: number, max: number}), (node.type as {min: number}).min < 0)
        : raw
    emitWriteBack(src, value, g, b)
}

function emitOpenList(src: number, g: GenCtx, b: LineBuilder): void
{
    b.line(`v${src} = [];`)
}

/** `CALL_CODEC`/`CALL_CODEC_NEXT` — the one place a real function call
 *  happens, and the one place a *union* is ever resolved: whether `ref`
 *  is a field or a variant index is decided by `src`'s own kind (not the
 *  target's — mirrors `codec-extension.ts`'s own `computeChild` exactly:
 *  a struct-kind src writes the callee's result into one of its own named
 *  fields; a union-kind src has its *entire* value replaced with
 *  `{variant, payload}`, atomically, the moment the payload is known — no
 *  intermediate state survives across statements for a union at all). */
function emitCallCodec(calleeIndex: number, src: number, ref: number | undefined, g: GenCtx, b: LineBuilder): void
{
    const isNext = ref === undefined
    const srcNode = requireSlotNode(g.slotTypes, src, isNext ? "CALL_CODEC_NEXT" : "CALL_CODEC")
    const edge = isNext ? requireEdge(srcNode, 0, "CALL_CODEC_NEXT") : requireEdge(srcNode, ref, "CALL_CODEC")
    const srcKind = kindOf(srcNode.type)
    const access = accessorFor(srcNode, g)

    if(g.direction === "decode")
    {
        const result = `${g.direction}_proc${calleeIndex}(ctx)`
        if(srcKind === SemanticTypeKinds.Union)
        {
            if(access.kind !== "union") throw new Error(`codec-codegen: CALL_CODEC's union-kind src (slot ${src}) has a non-union accessor`)
            const variant = (edge.step as {variant: string}).variant
            b.line(`const payload = ${result};`)
            emitWriteBack(src, access.finishUnion(variant, "payload"), g, b)
        }
        else if(isNext) b.line(`v${src}.push(${result});`)
        else b.line(`v${src}.${(edge.step as {field: string}).field} = ${result};`)
    }
    else
    {
        let argExpr: string
        if(srcKind === SemanticTypeKinds.Union)
        {
            if(access.kind !== "union") throw new Error(`codec-codegen: CALL_CODEC's union-kind src (slot ${src}) has a non-union accessor`)
            argExpr = access.activeVariantPayload(`v${src}`, (edge.step as {variant: string}).variant)
        }
        else if(isNext)
        {
            if(access.kind !== "list") throw new Error(`codec-codegen: CALL_CODEC_NEXT's src (slot ${src}) isn't list-kind`)
            argExpr = access.elementAt(`v${src}`, `${idxCounter(src, g, b)}++`)
        }
        else
        {
            if(access.kind !== "struct") throw new Error(`codec-codegen: CALL_CODEC's src (slot ${src}) isn't struct-kind`)
            argExpr = access.readField(`v${src}`, (edge.step as {field: string}).field)
        }
        b.line(`${g.direction}_proc${calleeIndex}(${argExpr}, ctx);`)
    }
}

/** Every EXT op that writes/names a slot rather than yielding a nestable
 *  expression — used both for a bare `ExprStmt` and (see `emitReturn`'s
 *  own caller) a `RETURN` whose own value embeds one of these unflushed
 *  (`raise.ts`'s own `readAcc`, called without a prior flush whenever the
 *  preceding op's effect didn't declare `readsAcc`). Returns `false` for
 *  anything that isn't one of these, so the caller falls back to plain
 *  expression translation. */
function emitExtStmtIfApplicable(e: Extract<Expr<CodecExtInstr>, {kind: ExprKind.Ext}>, g: GenCtx, b: LineBuilder): boolean
{
    switch(e.ext)
    {
        case "ENTER": emitEnter(e.dst, e.src, e.ref, g, b); return true
        case "ENTER_NEXT": emitEnterNext(e.dst, e.src, g, b); return true
        case "STORE_VAL": emitStoreVal(e.src, e.args[0]!, g, b); return true
        case "OPEN_LIST": emitOpenList(e.src, g, b); return true
        case "CALL_CODEC": emitCallCodec(e.calleeIndex, e.src, e.ref, g, b); return true
        case "CALL_CODEC_NEXT": emitCallCodec(e.calleeIndex, e.src, undefined, g, b); return true
        default: return false
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Statement translation
// ─────────────────────────────────────────────────────────────────────────

/** The value this procedure's own body eventually returns — `v0`, run
 *  through the entry `TypeNode`'s own `finishStruct`/`finishList` (the one
 *  conversion from "plain accumulator" to this rule's chosen shape), or
 *  used directly for a union/leaf (already finished — a union the moment
 *  its own CALL_CODEC resolved it, a leaf the moment STORE_VAL ran) or a
 *  unit (never touched at all — `unitValue()` stands in for the v0 that
 *  was never assigned, since a unit's own procedure body is empty).
 *
 *  Encode never builds a value of its own type at all (it only ever reads
 *  *from* the value it was given) — its own procedures stay `void`
 *  exactly as they always have, so this is a bare `return;`, matching
 *  what a raised RETURN's own value already had evaluated for whatever
 *  side effect it might still carry (the caller already emitted that). */
function emitReturn(entryNode: TypeNode, g: GenCtx, b: LineBuilder): void
{
    if(g.direction === "encode") { b.line("return;"); return }

    const access = accessorFor(entryNode, g)
    if(access.kind === "struct") b.line(`return ${access.finishStruct("v0")};`)
    else if(access.kind === "list") b.line(`return ${access.finishList("v0")};`)
    else if(access.kind === "unit") b.line(`return ${access.unitValue()};`)
    else b.line("return v0;")
}

function translateStmt(s: Stmt<CodecExtInstr>, entryNode: TypeNode, g: GenCtx, b: LineBuilder): void
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
            emitReturn(entryNode, g, b)
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
                        translateStmts(body, entryNode, g, b)
                        if(!endsInTerminator(body)) b.line("break")
                    })
                })
            })
            return

        case StmtKind.Loop:
            b.block("for (;;) {", () =>
            {
                translateStmts(s.cond, entryNode, g, b)
                b.line(`if (!(${translateExpr(s.test, g)})) break`)
                translateStmts(s.body, entryNode, g, b)
            })
            return
    }
}

function translateStmts(stmts: readonly Stmt<CodecExtInstr>[], entryNode: TypeNode, g: GenCtx, b: LineBuilder): void
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
 *  `Accessor` this module consults, keyed by `TypeNode.id`. */
export function generateProcedure(
    index: number, raised: RaisedProc<CodecExtInstr>, entryNode: TypeNode, direction: Direction,
    projection: ReadonlyMap<number, TSTypeDecl>,
): string
{
    const slotTypes = new Map<number, TypeNode>([[0, entryNode]])
    const {maxSlot, listTraversalSlots} = prescan(raised.body)
    const g: GenCtx = {direction, slotTypes, projection, writeBacks: new Map(), idxDeclared: new Set()}

    const entryDecl = g.projection.get(entryNode.id)
    if(!entryDecl) throw new Error(`codec-codegen: no local-representation projection for ${describeType(entryNode)} (node #${entryNode.id})`)
    const entryKind = kindOf(entryNode.type)

    const b = new LineBuilder()
    b.line(`// proc ${index}: ${describeType(entryNode)}`)

    if(direction === "decode")
    {
        b.block(`function decode_proc${index}(ctx: Ctx): ${entryDecl.ref} {`, () =>
        {
            if(raised.peakSlots > 0) b.line(`let ${Array.from({length: raised.peakSlots}, (_, i) => `s${i}`).join(", ")};`)
            if(maxSlot > 0) b.line(`let ${Array.from({length: maxSlot}, (_, i) => `v${i + 1}`).join(", ")};`)
            b.line(
                entryKind === SemanticTypeKinds.Struct ? "let v0: any = {};" :
                entryKind === SemanticTypeKinds.List ? "let v0: any = [];" :
                "let v0: any;",
            )
            translateStmts(raised.body, entryNode, g, b)
            if(!endsInTerminator(raised.body)) emitReturn(entryNode, g, b)
        })
    }
    else
    {
        b.block(`function encode_proc${index}(v0: ${entryDecl.ref}, ctx: Ctx): void {`, () =>
        {
            if(raised.peakSlots > 0) b.line(`let ${Array.from({length: raised.peakSlots}, (_, i) => `s${i}`).join(", ")};`)
            if(maxSlot > 0) b.line(`let ${Array.from({length: maxSlot}, (_, i) => `v${i + 1}`).join(", ")};`)
            for(const slot of listTraversalSlots) idxCounter(slot, g, b)
            translateStmts(raised.body, entryNode, g, b)
        })
    }

    return b.toString()
}
