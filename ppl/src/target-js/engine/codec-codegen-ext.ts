/**
 * target-js — Translation for the 17 codec-extension opcodes
 * (`src/codecs/engine/opcodes.ts`) that `codec-codegen.ts`'s generic
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

import type {Stmt, Expr} from "mog-core"
import {ExprKind, StmtKind} from "mog-core"
import type {TypeNode} from "../../core/index"
import {kindOf, concreteKindOf, SemanticTypeKinds} from "../../core/index"
import type {Direction, Correspondence, Resolution} from "../../core/index"
import {resolve} from "../../core/index"
import type {CodecExtInstr} from "../../codecs/index"
import {requireSlotNode, intWireSize, assertNever, correspondenceChild, correspondenceElement} from "../../codecs/index"
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
    /** Per-slot `Correspondence` (docs/codec-image.md §2, `core`'s
     *  `reconcile`) — set only when this program is being compiled against
     *  a reconciled local schema rather than its own, i.e. this whole field
     *  is absent/empty for every ordinary (non-bridging) call, which is the
     *  load-bearing invariant that keeps this rework from changing a single
     *  byte of ordinary output. When present for a given slot, its own
     *  `localNode` (never `slotTypes`' image node) is what `localAccessorFor`
     *  looks the `Accessor` up by — `slotTypes` itself stays image-keyed
     *  unconditionally, since wire-format concerns (width, tag order) are
     *  always the image's to define, reconciled or not. */
    readonly correspondences?: Map<number, Correspondence>
}

export function accessorFor(node: TypeNode, g: GenCtx): Accessor
{
    const decl = g.projection.get(node.id)
    if(!decl) throw new Error(`codec-codegen: no local-representation projection for ${describeType(node)} (node #${node.id}) — pass the same rule list to projectTSTypes and generateCodecModule`)
    return decl.access
}

/** The `Accessor` a handle slot's own local representation should be read/
 *  written through — `accessorFor` itself, keyed by whichever `TypeNode`
 *  actually describes that representation: the slot's own tracked
 *  `Correspondence.localNode` when bridging (`g.correspondences` has an
 *  entry for it), else its plain image `TypeNode` (`g.slotTypes`) exactly
 *  as every call site already did before this field existed. Every
 *  existing `accessorFor` call site in this file that's keyed by a handle
 *  slot goes through this now, so bridging support is purely additive:
 *  with `g.correspondences` absent/empty, this reduces to exactly the old
 *  `accessorFor(requireSlotNode(...), g)` call it replaced. */
export function localAccessorFor(slot: number, g: GenCtx): Accessor
{
    const c = g.correspondences?.get(slot)
    if(!c) return accessorFor(requireSlotNode(g.slotTypes, slot, "accessor lookup"), g)
    if(c.localNode) return accessorFor(c.localNode, g)
    // Image-only: no local representation exists at all for this slot.
    // Its own value is either discarded outright (decode's own "drop") or
    // synthesized purely from the image's own declared default and never
    // touches real local storage either way (encode's own "default") —
    // any shape that round-trips through itself is fine, so the trivial
    // one (the same fallback every Accessor's own optional methods
    // already use) avoids needing a second, image-side rule projection
    // just for subtrees nothing ever actually reads.
    return scratchAccessorFor(concreteKindOf(c.imageNode!.type))
}

/** The trivial plain-object/array `Accessor` every rule-supplied one
 *  already falls back to when it doesn't override `beginStruct`/
 *  `setField`/`beginList`/`appendElement` (`resolver.ts`'s own `Accessor`
 *  doc comment) — used here, unconditionally, for a slot with no local
 *  representation to honor at all (see `localAccessorFor`'s own comment).
 *  Not looked up via any projection — there is no `TypeNode` to key one
 *  by on the local side, so this is a fixed constant per kind instead. */
function scratchAccessorFor(kind: SemanticTypeKinds): Accessor
{
    switch(kind)
    {
        case SemanticTypeKinds.Integer: return {kind: "integer", fromWire: raw => raw, toWire: host => host}
        case SemanticTypeKinds.Unit: return {kind: "unit", unitValue: () => "undefined"}
        case SemanticTypeKinds.Struct: return {
            kind: "struct", finishStruct: x => x, readField: (v, f) => `${v}.${f}`,
            beginStruct: () => "{}", setField: (acc, f, v) => `${acc}.${f} = ${v}`,
        }
        case SemanticTypeKinds.Union: return {
            kind: "union",
            finishUnion: (variant, payload) => `{variant: ${JSON.stringify(variant)}, value: ${payload ?? "undefined"}}`,
            activeVariantName: v => `${v}.variant`, activeVariantPayload: v => `${v}.value`,
        }
        case SemanticTypeKinds.List: return {
            kind: "list", finishList: x => x, count: v => `${v}.length`, elementAt: (v, i) => `${v}[${i}]`,
            beginList: () => "[]", appendElement: (acc, v) => `${acc}.push(${v})`,
        }
    }
}

/**
 * Recursively synthesizes a JS expression for `node`'s own declared
 * default (docs/codec-image.md §4) — driven entirely by `accessorOf`
 * rather than by walking `defaultValueOf`'s own pre-flattened plain-JS
 * value, so the result is representation-faithful (e.g. a bigint rule's
 * own conversion, or a class rule's own constructor) wherever `accessorOf`
 * points at a real rule's own `Accessor` — never a raw object literal
 * that would silently be the *wrong* shape for an alternative rule.
 * `accessorOf` is the caller's own choice of *which* accessor a given
 * node's default should be built through: the real local one for §3.1's
 * "default from local" (decode, local-only field — `emitEnter`/
 * `emitEnterNext`'s own `injectLocalOnlyDefaults`), the trivial scratch
 * one for §3.3's "default from image" (encode, image-only field: there is
 * no local representation for it at all).
 *
 * A struct's own accumulator needs real statements (`beginStruct`/
 * `setField`/`finishStruct`, exactly decode's own construction protocol)
 * to stay representation-faithful, not a plain object-literal shortcut —
 * so this emits into `b` via a fresh temp, reusing `GenCtx.tempCounter`
 * (already shared with `emitCallCodec`'s own flushing, for the same
 * "unique name, not a per-slot key" reason), and returns the temp's name.
 */
function emitDefaultValue(node: TypeNode, accessorOf: (n: TypeNode) => Accessor, g: GenCtx, b: LineBuilder): string
{
    const access = accessorOf(node)
    switch(access.kind)
    {
        case "unit": return access.unitValue()

        case "integer":
        {
            const intType = node.type as {min: number; max: number; default: number}
            return access.fromWire(String(intType.default), intWireSize(intType), intType.min < 0)
        }

        case "union":
        {
            const unionType = node.type as {defaultVariant?: string}
            if(unionType.defaultVariant === undefined)
                throw new Error(`codec-codegen: default value needed for ${describeType(node)}, but it declares no defaultVariant`)
            return access.finishUnion(unionType.defaultVariant, undefined)
        }

        // Always empty (defaultValueOf's own List case, core) — no
        // elements to append, so no statements needed either.
        case "list": return access.finishList(access.beginList?.() ?? "[]")

        case "struct":
        {
            const temp = `__def${g.tempCounter.n++}`
            // `: any` matters, not just style — `let x = {}` (no
            // annotation) infers the empty-object *type* `{}`, not `any`,
            // so a later `x.field = v` would fail to typecheck (exactly
            // `generateProcedure`'s own `v0: any` reasoning).
            b.line(`let ${temp}: any = ${access.beginStruct?.() ?? "{}"};`)
            for(const edge of node.edges)
            {
                const name = (edge.step as {field: string}).field
                const v = emitDefaultValue(edge.target, accessorOf, g, b)
                b.line(`${access.setField?.(temp, name, v) ?? `${temp}.${name} = ${v}`};`)
            }
            return access.finishStruct(temp)
        }
    }
}

/** For every local-only field on a `"matched"` struct correspondence
 *  (docs/codec-image.md §3.1, decode only — encode's own mirror, §3.4, is
 *  free: the image-derived bytecode simply never writes a local-only
 *  field at all, so there's nothing to inject or suppress there), seed it
 *  with its own declared default right after the struct's own accumulator
 *  is created. There is no existing wire instruction to hook this into —
 *  the bytecode never mentions a field the image doesn't declare — so
 *  this is a pure injection, not a modified existing site. */
export function injectLocalOnlyDefaults(structCorr: Correspondence, accExpr: string, g: GenCtx, b: LineBuilder): void
{
    const access = expectAccessor(accessorFor(structCorr.localNode!, g), "struct", structCorr.localNode!)
    for(const edge of structCorr.children ?? [])
    {
        if(edge.correspondence.outcome !== "local-only") continue
        const v = emitDefaultValue(edge.correspondence.localNode!, n => accessorFor(n, g), g, b)
        b.line(`${access.setField?.(accExpr, edge.name, v) ?? `${accExpr}.${edge.name} = ${v}`};`)
    }
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
                return expectAccessor(localAccessorFor(e.src, g), "integer", node).toWire(`v${e.src}`)
            }

        case "COUNT":
            {
                const node = requireSlotNode(g.slotTypes, e.src, "COUNT")
                return expectAccessor(localAccessorFor(e.src, g), "list", node).count(`v${e.src}`)
            }

        case "TAG":
            {
                // activeVariantName reads the *local* representation
                // (whatever the rule actually stores); variantNamesOf
                // stays image-side unconditionally — tagOf's own comparison
                // set is always the image's own wire-declared variant
                // order, reconciled or not (docs/codec-image.md §2.2).
                const node = requireSlotNode(g.slotTypes, e.src, "TAG")
                const activeName = expectAccessor(localAccessorFor(e.src, g), "union", node).activeVariantName(`v${e.src}`)
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
                const bulk = expectAccessor(localAccessorFor(e.handle, g), "list", node).bulk
                if(!bulk) throw new Error(`codec-codegen: no bulk sequential-transfer support for ${describeType(node)} (node #${node.id}) — the rule that claimed this type's Accessor doesn't provide "bulk"`)
                return bulk.writeSeq(`v${e.handle}`, `${e.iter}`, `${e.width}`, arg(0))
            }

        case "READ_SEQ":
            {
                const node = requireSlotNode(g.slotTypes, e.handle, "READ_SEQ")
                const bulk = expectAccessor(localAccessorFor(e.handle, g), "list", node).bulk
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
        const access = expectAccessor(localAccessorFor(wb.parentSlot, g), "struct", parentNode)
        b.line(`${access.setField?.(`v${wb.parentSlot}`, wb.name, `v${slot}`) ?? `v${wb.parentSlot}.${wb.name} = v${slot}`};`)
    }
    else
    {
        const access = expectAccessor(localAccessorFor(wb.parentSlot, g), "list", parentNode)
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
    g.slotTypes.set(dst, edge.target)

    // Bridging (docs/codec-image.md §2/§3): a struct field's own edge is
    // either "matched" (bridge — everything below is unaffected), an
    // image-only field on decode (drop — still read/skipped normally
    // below, never written back anywhere real), or an image-only field on
    // encode (default — the wire still needs real bytes at this position,
    // substituted from the image's own declared default; a local-only
    // field never reaches this function at all — there's no image-side
    // ref for one to navigate by in the first place, §3.4/§3.1's own
    // "nothing to hook into" reasoning).
    const parentCorr = g.correspondences?.get(src)
    const childEdge = parentCorr ? correspondenceChild(parentCorr, name) : undefined
    const resolution: Resolution | undefined = childEdge ? resolve(parentCorr!, childEdge, g.direction) : undefined
    if(childEdge) g.correspondences!.set(dst, childEdge.correspondence)

    if(resolution?.action === "default")
    {
        g.writeBacks.set(dst, {into: "field", parentSlot: src, name})
        const defaultExpr = emitDefaultValue(childEdge!.correspondence.imageNode!, n => scratchAccessorFor(concreteKindOf(n.type)), g, b)
        emitWriteBack(dst, defaultExpr, g, b)
        return
    }

    if(resolution?.action !== "drop") g.writeBacks.set(dst, {into: "field", parentSlot: src, name})

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
            const access = expectAccessor(localAccessorFor(dst, g), "struct", edge.target)
            b.line(`v${dst} = ${access.beginStruct?.() ?? "{}"};`)
            const dstCorr = g.correspondences?.get(dst)
            if(dstCorr?.outcome === "matched") injectLocalOnlyDefaults(dstCorr, `v${dst}`, g, b)
        }
    }
    else
    {
        // Eager: encode already holds src's full value; pull the field
        // out right now, since a later statement (load_val, or tag for a
        // hoisted union field) reads v${dst} immediately.
        const access = localAccessorFor(src, g)
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

    // A list's own element edge is always "matched" once its own kind
    // check passes (`reconcile.ts`'s own doc comment) — only what's
    // *nested inside* an element can diverge, handled at that nested
    // position's own ENTER/CALL_CODEC site, never here. So this is a
    // plain propagation, never a `resolve()` call.
    const srcCorr = g.correspondences?.get(src)
    if(srcCorr) g.correspondences!.set(dst, correspondenceElement(srcCorr))

    if(g.direction === "decode")
    {
        if(kindOf(edge.target.type) === SemanticTypeKinds.Struct)
        {
            const access = expectAccessor(localAccessorFor(dst, g), "struct", edge.target)
            b.line(`v${dst} = ${access.beginStruct?.() ?? "{}"};`)
            const dstCorr = g.correspondences?.get(dst)
            if(dstCorr?.outcome === "matched") injectLocalOnlyDefaults(dstCorr, `v${dst}`, g, b)
        }
    }
    else
    {
        const access = localAccessorFor(src, g)
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
        ? expectAccessor(localAccessorFor(src, g), "integer", node).fromWire(raw, intWireSize(node.type as {min: number, max: number}), (node.type as {min: number}).min < 0)
        : raw
    emitWriteBack(src, value, g, b)
}

function emitOpenList(src: number, g: GenCtx, b: LineBuilder): void
{
    const node = requireSlotNode(g.slotTypes, src, "OPEN_LIST")
    const access = expectAccessor(localAccessorFor(src, g), "list", node)
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
    const access = localAccessorFor(src, g)

    // Bridging (docs/codec-image.md §2/§3). `ref`-based navigation always
    // addresses a real image edge, so the only outcomes actually reachable
    // here are: "bridge" (either kind); a struct's own image-only/decode
    // ("drop") or image-only/encode ("default", from the image); a
    // union's own image-only/decode ("default", from local, or "trap" with
    // no local default). A union's local-only variant is caught earlier,
    // at TAG's own `tagOf` call (`translateExt`) — it never has an image
    // edge to reach this function through at all. "unreachable" (a real
    // union/image-only/encode dispatch case, or a defensive fallback) is
    // structurally dead at runtime but the bytecode still contains the
    // instruction, so it still has to compile to *something* — a runtime
    // throw, same as an explicit "trap", never a codegen-time error.
    const parentCorr = g.correspondences?.get(src)
    let childCorr: Correspondence | undefined
    let resolution: Resolution | undefined
    if(parentCorr)
    {
        if(isNext) childCorr = correspondenceElement(parentCorr)
        else
        {
            const name = srcKind === SemanticTypeKinds.Union ? (edge.step as {variant: string}).variant : (edge.step as {field: string}).field
            const childEdge = correspondenceChild(parentCorr, name)
            childCorr = childEdge.correspondence
            resolution = resolve(parentCorr, childEdge, g.direction)
        }
    }

    if(resolution?.action === "trap" || resolution?.action === "unreachable")
    {
        const reason = resolution.action === "trap" ? resolution.reason : "structurally unreachable (docs/codec-image.md §2.4)"
        b.line(`throw new CodecTrap(-1, ${JSON.stringify(reason)});`)
        return
    }

    if(g.direction === "decode")
    {
        if(resolution?.action === "default")
        {
            // Union image-only variant, local declares a default (§3.2):
            // still call the callee to correctly consume its own wire
            // bytes (the bytecode already knows this variant's shape),
            // but materialize the local default instead of the real,
            // locally-unrecognized payload.
            b.line(`${g.direction}_proc${calleeIndex}(ctx);`)
            const localUnion = parentCorr!.localNode!.type as {defaultVariant?: string}
            emitWriteBack(src, expectAccessor(access, "union", srcNode).finishUnion(localUnion.defaultVariant!, undefined), g, b)
            return
        }

        const result = `${g.direction}_proc${calleeIndex}(ctx)`
        const temp = `__tmp${g.tempCounter.n++}`
        b.line(`const ${temp} = ${result};`)

        // Struct image-only field (§3.2): consumed above for wire-cursor
        // correctness, never written back anywhere real.
        if(resolution?.action === "drop") return

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
        if(resolution?.action === "default")
        {
            // Struct image-only field, encode (§3.3): the wire still
            // needs real bytes at this position — substitute the field's
            // own declared default, read from the image (the only place
            // a value for a field the local model doesn't have at all
            // could come from), instead of ever reading local storage.
            argExpr = emitDefaultValue(childCorr!.imageNode!, n => scratchAccessorFor(concreteKindOf(n.type)), g, b)
        }
        else if(srcKind === SemanticTypeKinds.Union)
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
export function emitReturn(g: GenCtx, b: LineBuilder): void
{
    if(g.direction === "encode") { b.line("return;"); return }

    // Slot 0 always — a procedure's own entry point.
    const access = localAccessorFor(0, g)
    if(access.kind === "struct") b.line(`return ${access.finishStruct("v0")};`)
    else if(access.kind === "list") b.line(`return ${access.finishList("v0")};`)
    else if(access.kind === "unit") b.line(`return ${access.unitValue()};`)
    else b.line("return v0;")
}
