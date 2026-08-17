/**
 * @ppl/target-js — Translation for the 17 codec-extension opcodes
 * (`@ppl/codecs/src/engine/opcodes.ts`) that `codec-codegen.ts`'s generic
 * `Stmt`/`Expr` tree walk hands off to whenever it hits an `Ext` node:
 *
 * - The nestable-expression ops (`LOAD_VAL`/`COUNT`/`TAG`/`READ`/`WRITE`/
 *   `CLONE_RD`/`CLONE_WR`/`SEEK`/`WRITE_SEQ`/`READ_SEQ`), via `translateExt`.
 * - The statement-only ops that write/name a slot rather than yielding a
 *   value (`ENTER`/`ENTER_NEXT`/`STORE_VAL`/`OPEN_LIST`/`CALL_CODEC(_NEXT)`),
 *   via `emitExtStmtIfApplicable`.
 *
 * This is also where every `Accessor` lookup happens (`accessorFor`,
 * `expectAccessor`) and where the two pieces of purely compile-time,
 * per-procedure bookkeeping `codec-codegen.ts`'s own header explains live:
 * the write-back descriptor (`WriteBack`) and the encode-side ascending
 * list index counter (`idxCounter`). `GenCtx` — threaded through both this
 * file and `codec-codegen.ts` — is the shared per-procedure state: the
 * `Accessor` projection, per-slot image `TypeNode`s, write-backs, and
 * declared index counters.
 *
 * `emitReturn` lives here too, not in `codec-codegen.ts`, because a
 * procedure's own exit value is exactly as `Accessor`-dependent as
 * anything else in this file (`finishStruct`/`finishList`/`unitValue`).
 */

import type {Stmt, Expr} from "@ppl/machine"
import {ExprKind, StmtKind} from "@ppl/machine"
import type {TypeNode} from "@ppl/core"
import {kindOf, SemanticTypeKinds} from "@ppl/core"
import type {Direction, CodecExtInstr} from "@ppl/codecs"
import {requireSlotNode, intWireSize, assertNever} from "@ppl/codecs"
import type {Accessor, TSTypeDecl} from "./resolver"
import {LineBuilder} from "./line-builder"
import {requireEdge, variantNamesOf, describeType} from "./codec-type-nav"
import {translateExpr} from "./codec-codegen"

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

export interface GenCtx
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
    /** Source of unique `__tmp${n}` names for `emitCallCodec`'s own
     *  decode-side result flushing (see its own comment) — a mutable
     *  counter, not a per-slot key, since a `CALL_CODEC`'s own result has
     *  no slot number of its own until it's written back. */
    readonly tempCounter: {n: number}
}

export function accessorFor(node: TypeNode, g: GenCtx): Accessor
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
export function expectAccessor<K extends Accessor["kind"]>(access: Accessor, kind: K, node: TypeNode): Extract<Accessor, {kind: K}>
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
export function prescan(stmts: readonly Stmt<CodecExtInstr>[]): {maxSlot: number; listTraversalSlots: ReadonlySet<number>}
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

// ─────────────────────────────────────────────────────────────────────────
// Nestable-expression ops
// ─────────────────────────────────────────────────────────────────────────

export function translateExt(e: Extract<Expr<CodecExtInstr>, {kind: ExprKind.Ext}>, g: GenCtx): string
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

        case "WRITE_SEQ":
            {
                const node = requireSlotNode(g.slotTypes, e.handle, "WRITE_SEQ")
                const bulk = expectAccessor(accessorFor(node, g), "list", node).bulk
                if(!bulk) throw new Error(`codec-codegen: no bulk sequential-transfer support for ${describeType(node)} (node #${node.id}) — the rule that claimed this type's Accessor doesn't provide "bulk"`)
                return bulk.writeSeq(`v${e.handle}`, `${e.iter}`, `${e.width}`, arg(0))
            }

        case "READ_SEQ":
            {
                const node = requireSlotNode(g.slotTypes, e.handle, "READ_SEQ")
                const bulk = expectAccessor(accessorFor(node, g), "list", node).bulk
                if(!bulk) throw new Error(`codec-codegen: no bulk sequential-transfer support for ${describeType(node)} (node #${node.id}) — the rule that claimed this type's Accessor doesn't provide "bulk"`)
                return bulk.readSeq(`v${e.handle}`, `${e.iter}`, `${e.width}`, `${e.signed}`, arg(0))
            }

        default:
            return assertNever(e)
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Statement-only ops — everything that writes a slot's own value, or
// names/traverses one. None of these can appear nested in an expression
// (confirmed by reading every existing `CodecRule` in this codebase); see
// `emitExtStmtIfApplicable` for the one place that still has to check,
// since a raised `RETURN`'s own value can embed a pending one of these
// (`raise.ts`'s own `killAcc`/`readAcc` — a value read here was never
// necessarily flushed as its own statement first).
// ─────────────────────────────────────────────────────────────────────────

/** Assign `value` into slot `slot`'s own accumulator variable, then
 *  propagate it into whatever `slot` itself was written back into, if
 *  anything (a named field, or an appended list element) — the one place
 *  a slot's value ever moves "up" to its own parent within a procedure.
 *  A no-op propagation for slot 0: it has no write-back descriptor by
 *  construction (its value crosses the *procedure* boundary instead, via
 *  `return`/the parameter, handled separately by `emitReturn`). The
 *  parent's own `Accessor` decides how that propagation actually happens
 *  (`setField`/`appendElement`), falling back to plain property
 *  assignment/`push` if it doesn't care. */
function emitWriteBack(slot: number, value: string, g: GenCtx, b: LineBuilder): void
{
    b.line(`v${slot} = ${value};`)
    const wb = g.writeBacks.get(slot)
    if(!wb) return
    const parentNode = requireSlotNode(g.slotTypes, wb.parentSlot, "write-back")
    if(wb.into === "field")
    {
        const access = expectAccessor(accessorFor(parentNode, g), "struct", parentNode)
        b.line(`${access.setField?.(`v${wb.parentSlot}`, wb.name, `v${slot}`) ?? `v${wb.parentSlot}.${wb.name} = v${slot}`};`)
    }
    else
    {
        const access = expectAccessor(accessorFor(parentNode, g), "list", parentNode)
        b.line(`${access.appendElement?.(`v${wb.parentSlot}`, `v${slot}`) ?? `v${wb.parentSlot}.push(v${slot})`};`)
    }
}

/** The encode-side ascending index counter `ENTER_NEXT`/`CALL_CODEC_NEXT`
 *  need for `Accessor.elementAt` (this file's own header explains why the
 *  RTL's descending `left` isn't enough) — declared once, at the point of
 *  first use, then just referenced (and incremented) everywhere else. */
export function idxCounter(slot: number, g: GenCtx, b: LineBuilder): string
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
        if(kindOf(edge.target.type) === SemanticTypeKinds.Struct)
        {
            const access = expectAccessor(accessorFor(edge.target, g), "struct", edge.target)
            b.line(`v${dst} = ${access.beginStruct?.() ?? "{}"};`)
        }
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
        if(kindOf(edge.target.type) === SemanticTypeKinds.Struct)
        {
            const access = expectAccessor(accessorFor(edge.target, g), "struct", edge.target)
            b.line(`v${dst} = ${access.beginStruct?.() ?? "{}"};`)
        }
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
    const node = requireSlotNode(g.slotTypes, src, "OPEN_LIST")
    const access = expectAccessor(accessorFor(node, g), "list", node)
    b.line(`v${src} = ${access.beginList?.() ?? "[]"};`)
}

/** `CALL_CODEC`/`CALL_CODEC_NEXT` — the one place a real function call
 *  happens, and the one place a *union* is ever resolved: whether `ref`
 *  is a field or a variant index is decided by `src`'s own kind (not the
 *  target's — mirrors `codec-extension.ts`'s own `computeChild` exactly:
 *  a struct-kind src writes the callee's result into one of its own named
 *  fields; a union-kind src has its *entire* value replaced with
 *  `{variant, payload}`, atomically, the moment the payload is known — no
 *  intermediate state survives across statements for a union at all).
 *
 *  Decode always flushes the callee's own call expression into a fresh
 *  `__tmp${n}` local before handing it anywhere else: `setField`/
 *  `appendElement`/`finishUnion` are rule-supplied and free to reference
 *  their own value argument any number of times (or zero), but the raw
 *  call expression itself has a real side effect (advancing the decode
 *  cursor) that must happen exactly once — a hazard invisible when the
 *  codegen only ever wrote `.push(result)`/`.field = result` itself, since
 *  those always reference `result` exactly once. `n` is a monotonic
 *  per-procedure counter, not reused across call sites, since two sibling
 *  fields decoded back to back share the same block scope. */
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
        const temp = `__tmp${g.tempCounter.n++}`
        b.line(`const ${temp} = ${result};`)

        if(srcKind === SemanticTypeKinds.Union)
        {
            if(access.kind !== "union") throw new Error(`codec-codegen: CALL_CODEC's union-kind src (slot ${src}) has a non-union accessor`)
            const variant = (edge.step as {variant: string}).variant
            emitWriteBack(src, access.finishUnion(variant, temp), g, b)
        }
        else if(isNext)
        {
            const listAccess = expectAccessor(access, "list", srcNode)
            b.line(`${listAccess.appendElement?.(`v${src}`, temp) ?? `v${src}.push(${temp})`};`)
        }
        else
        {
            const structAccess = expectAccessor(access, "struct", srcNode)
            const field = (edge.step as {field: string}).field
            b.line(`${structAccess.setField?.(`v${src}`, field, temp) ?? `v${src}.${field} = ${temp}`};`)
        }
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
 *  expression — used both for a bare `ExprStmt` and (see `codec-codegen.ts`'s
 *  own `translateStmt`) a `RETURN` whose own value embeds one of these
 *  unflushed (`raise.ts`'s own `readAcc`, called without a prior flush
 *  whenever the preceding op's effect didn't declare `readsAcc`). Returns
 *  `false` for anything that isn't one of these, so the caller falls back
 *  to plain expression translation. */
export function emitExtStmtIfApplicable(e: Extract<Expr<CodecExtInstr>, {kind: ExprKind.Ext}>, g: GenCtx, b: LineBuilder): boolean
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
// Procedure exit — exactly as `Accessor`-dependent as everything else above
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
export function emitReturn(entryNode: TypeNode, g: GenCtx, b: LineBuilder): void
{
    if(g.direction === "encode") { b.line("return;"); return }

    const access = accessorFor(entryNode, g)
    if(access.kind === "struct") b.line(`return ${access.finishStruct("v0")};`)
    else if(access.kind === "list") b.line(`return ${access.finishList("v0")};`)
    else if(access.kind === "unit") b.line(`return ${access.unitValue()};`)
    else b.line("return v0;")
}
