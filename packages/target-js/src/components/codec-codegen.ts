/**
 * @ppl/target-js — Compiled-source JS/TS codegen for a codec program
 *
 * Turns a `buildCodec`-produced `RtlProgram` (`@ppl/codecs`) into literal
 * TypeScript source — a real `function` per procedure, real `if`/`while`/
 * `switch`, direct calls between the generated functions — instead of
 * shipping the RTL program itself and interpreting it via `run()` +
 * `createCodecExtension` at every encode/decode call. Built on two pieces
 * from this session's earlier work:
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

import type { RtlProgram, Stmt, Expr, RaisedProc } from "@ppl/machine"
import { raiseProgram } from "@ppl/machine"
import type { SemanticType, TypeNode, TypeEdge } from "@ppl/core"
import { kindOf, SemanticTypeKinds } from "@ppl/core"
import type { Direction } from "@ppl/codecs"
import { resolveProcedureTypes, requireSlotNode, CODEC_EFFECTS, intWireSize } from "@ppl/codecs"
import { projectTSTypes, emitTSDeclarations } from "../engine/resolver"
import { tsTypeRules } from "./ts-emitter"
import { buildTypeGraph } from "@ppl/core"

// ─────────────────────────────────────────────────────────────────────────
// Small pure helpers
// ─────────────────────────────────────────────────────────────────────────

function requireEdge(node: TypeNode, ref: number, opName: string): TypeEdge
{
    const edge = node.edges[ref]
    if(!edge) throw new Error(`codec-codegen: ${opName}: no edge #${ref} on this ${node.type.kind} (${node.edges.length} edge(s))`)
    return edge
}

function isStructKind(node: TypeNode): boolean { return kindOf(node.type) === SemanticTypeKinds.Struct }

function variantNamesOf(node: TypeNode): string[]
{
    return node.edges.map(e =>
    {
        if(!("variant" in e.step)) throw new Error(`codec-codegen: expected a union edge, got ${JSON.stringify(e.step)}`)
        return e.step.variant
    })
}

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
function scanMaxHandleIndex(stmts: readonly Stmt[]): number
{
    let max = 0
    const bumpAll = (indices: readonly number[]): void => { for(const i of indices) if(i > max) max = i }

    function visitExpr(e: Expr): void
    {
        if(e.kind === "ext")
        {
            switch(e.ext)
            {
                case "ENTER": case "ENTER_NEXT": bumpAll(e.operands as readonly number[]); break
                case "LOAD_VAL": case "STORE_VAL": case "COUNT": case "TAG": case "OPEN_LIST":
                    bumpAll(e.operands as readonly number[]); break
                case "CALL_CODEC": bumpAll([(e.operands as readonly number[])[1]!]); break
                case "CALL_CODEC_NEXT": bumpAll([(e.operands as readonly number[])[1]!]); break
                case "WRITE_SEQ": case "READ_SEQ": bumpAll([(e.operands as readonly number[])[1]!]); break
            }
            for(const a of e.args) visitExpr(a)
        }
        else if(e.kind === "binary") { visitExpr(e.left); visitExpr(e.right) }
        else if(e.kind === "unary") visitExpr(e.value)
        else if(e.kind === "call") for(const a of e.args) visitExpr(a)
    }

    function visitStmts(stmts: readonly Stmt[]): void
    {
        for(const s of stmts)
        {
            switch(s.kind)
            {
                case "assign": visitExpr(s.value); break
                case "exprStmt": visitExpr(s.value); break
                case "extMulti": bumpAll(s.operands as readonly number[]); break
                case "return": visitExpr(s.value); break
                case "trap": break
                case "dispatch": visitExpr(s.test); for(const c of s.cases) visitStmts(c); break
                case "loop": visitStmts(s.cond); visitExpr(s.test); visitStmts(s.body); break
            }
        }
    }

    visitStmts(stmts)
    return max
}

function endsInTerminator(stmts: readonly Stmt[]): boolean
{
    const last = stmts[stmts.length - 1]
    return last?.kind === "return" || last?.kind === "trap"
}

// ─────────────────────────────────────────────────────────────────────────
// Expression translation
// ─────────────────────────────────────────────────────────────────────────

function translateExpr(e: Expr, g: GenCtx): string
{
    switch(e.kind)
    {
        case "const": return String(e.value)
        case "slot": return `s${e.index}`
        case "binary": return `evalBinary(${translateExpr(e.left, g)}, ${translateExpr(e.right, g)}, ${jsString(e.op)})`
        case "unary": return `evalUnary(${translateExpr(e.value, g)}, ${jsString(e.op)})`
        case "call": throw new Error(`codec-codegen: a plain CALL (to procedure ${e.calleeIndex}) isn't supported — no codec rule in this codebase emits one`)
        case "ext": return translateExt(e, g)
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

function translateExt(e: Extract<Expr, {kind: "ext"}>, g: GenCtx): string
{
    const ops = e.operands as readonly number[]
    const arg = (i: number): string => translateExpr(e.args[i]!, g)

    switch(e.ext)
    {
        case "ENTER": case "ENTER_NEXT":
            throw new Error(`codec-codegen: ${e.ext} should only ever appear as its own statement — never nested in an expression`)

        case "LOAD_VAL": return `loadVal(h${ops[0]})`
        case "COUNT": return `countOf(h${ops[0]})`

        case "TAG":
        {
            const node = requireSlotNode(g.slotTypes, ops[0]!, "TAG")
            return `tagOf(h${ops[0]}, ${JSON.stringify(variantNamesOf(node))})`
        }

        case "OPEN_LIST": return `openList(h${ops[0]})`
        case "READ": return `read(ctx, ${ops[0]}, ${ops[1]})`
        case "HAS_NEXT": return `hasNext(ctx, ${ops[0]})`
        case "CLONE_RD": return `cloneRd(ctx, ${ops[0]}, ${ops[1]})`
        case "CLONE_WR": return `cloneWr(ctx, ${ops[0]}, ${ops[1]})`
        case "SEEK": return `seek(ctx, ${ops[0]}, ${ops[1]})`
        case "WRITE": return `write(ctx, ${ops[0]}, ${ops[1]}, ${arg(0)})`

        case "STORE_VAL":
        {
            const node = requireSlotNode(g.slotTypes, ops[0]!, "STORE_VAL")
            if(kindOf(node.type) !== SemanticTypeKinds.Integer) return `setH(h${ops[0]}, ${arg(0)})`
            const width = intWireSize(node.type as {min: number, max: number})
            const signed = (node.type as {min: number}).min < 0
            return `storeVal(h${ops[0]}, ${arg(0)}, ${width}, ${signed})`
        }

        case "WRITE_SEQ": return `writeSeq(ctx, ${ops[0]}, h${ops[1]}, ${ops[2]}, ${arg(0)})`
        case "READ_SEQ": return `readSeq(ctx, ${ops[0]}, h${ops[1]}, ${ops[2]}, ${!!ops[3]}, ${arg(0)})`

        case "CALL_CODEC":
        {
            const [calleeIndex, src, ref] = ops as readonly [number, number, number]
            const srcNode = requireSlotNode(g.slotTypes, src, "CALL_CODEC")
            const edge = requireEdge(srcNode, ref, "CALL_CODEC")
            const childExpr = buildChildHandleExpr(`h${src}`, edge, g)
            return `${g.direction}_proc${calleeIndex}(${childExpr}, ctx)`
        }

        case "CALL_CODEC_NEXT":
        {
            const [calleeIndex, src] = ops as readonly [number, number]
            const srcNode = requireSlotNode(g.slotTypes, src, "CALL_CODEC_NEXT")
            const edge = requireEdge(srcNode, 0, "CALL_CODEC_NEXT")
            const childExpr = buildChildHandleExpr(`h${src}`, edge, g)
            return `${g.direction}_proc${calleeIndex}(${childExpr}, ctx)`
        }

        default:
            throw new Error(`codec-codegen: unhandled EXT op "${e.ext}" — not one of the 17 codec-extension opcodes`)
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
function translateEnterStmt(e: Extract<Expr, {kind: "ext"}>, g: GenCtx, out: string[], indent: string): void
{
    if(e.ext === "ENTER")
    {
        const [dst, src, ref] = e.operands as readonly [number, number, number]
        const srcNode = requireSlotNode(g.slotTypes, src, "ENTER")
        const edge = requireEdge(srcNode, ref, "ENTER")
        out.push(`${indent}h${dst} = ${buildChildHandleExpr(`h${src}`, edge, g)};`)
        g.slotTypes.set(dst, edge.target)
    }
    else // ENTER_NEXT
    {
        const [dst, src] = e.operands as readonly [number, number]
        const srcNode = requireSlotNode(g.slotTypes, src, "ENTER_NEXT")
        const edge = requireEdge(srcNode, 0, "ENTER_NEXT")
        out.push(`${indent}h${dst} = ${buildChildHandleExpr(`h${src}`, edge, g)};`)
        g.slotTypes.set(dst, edge.target)
    }
}

function translateStmt(s: Stmt, g: GenCtx, out: string[], indent: string): void
{
    switch(s.kind)
    {
        case "assign":
            out.push(`${indent}s${s.slot} = ${translateExpr(s.value, g)};`)
            return

        case "exprStmt":
            if(s.value.kind === "ext" && (s.value.ext === "ENTER" || s.value.ext === "ENTER_NEXT"))
                translateEnterStmt(s.value, g, out, indent)
            else
                out.push(`${indent}${translateExpr(s.value, g)};`)
            return

        case "extMulti":
            throw new Error(`codec-codegen: EXT ${s.ext} with ${s.slots.length} discrete results isn't supported — no codec opcode uses this shape (all 17 are tosDelta ≤ 0)`)

        case "return":
            // Every generated procedure is declared `: void` — matching
            // resolver.ts's own "codec-rule bodies are void; the return
            // value is discarded, never meaningful" convention — so the
            // expression is evaluated for its side effect only; `return
            // <expr>;` would be a real TS type error whenever expr's own
            // type isn't void (e.g. `return countOf(h0);`).
            out.push(`${indent}${translateExpr(s.value, g)};`)
            out.push(`${indent}return;`)
            return

        case "trap":
            out.push(`${indent}throw new CodecTrap(${s.code});`)
            return

        case "dispatch":
        {
            out.push(`${indent}switch (${translateExpr(s.test, g)}) {`)
            s.cases.forEach((body, i) =>
            {
                out.push(`${indent}    case ${i}: {`)
                translateStmts(body, g, out, indent + "        ")
                if(!endsInTerminator(body)) out.push(`${indent}        break`)
                out.push(`${indent}    }`)
            })
            out.push(`${indent}}`)
            return
        }

        case "loop":
        {
            out.push(`${indent}for (;;) {`)
            translateStmts(s.cond, g, out, indent + "    ")
            out.push(`${indent}    if (!(${translateExpr(s.test, g)})) break`)
            translateStmts(s.body, g, out, indent + "    ")
            out.push(`${indent}}`)
            return
        }
    }
}

function translateStmts(stmts: readonly Stmt[], g: GenCtx, out: string[], indent: string): void
{
    for(const s of stmts) translateStmt(s, g, out, indent)
}

// ─────────────────────────────────────────────────────────────────────────
// Per-procedure and per-direction drivers
// ─────────────────────────────────────────────────────────────────────────

function describeType(node: TypeNode): string
{
    const kind = kindOf(node.type)
    if(kind === SemanticTypeKinds.Struct || kind === SemanticTypeKinds.Union)
    {
        const named = (node.type as {name?: string}).name
        return named ? `${kind} ${named}` : kind
    }
    return kind
}

function generateProcedure(index: number, raised: RaisedProc, entryNode: TypeNode, direction: Direction): string
{
    // Seeded with just slot 0 (the entry handle) — everything else is
    // discovered live, in translateStmts' own walk order, via the same
    // ENTER/ENTER_NEXT/CALL_CODEC(_NEXT) rules resolveHandleTypes uses
    // (childNode/nextNode/requireSlotNode), just interleaved with code
    // emission instead of run once over the flat pre-raise body.
    const slotTypes = new Map<number, TypeNode>([[0, entryNode]])
    const maxHandleIndex = scanMaxHandleIndex(raised.body)
    const g: GenCtx = { direction, slotTypes }

    const out: string[] = []
    out.push(`// proc ${index}: ${describeType(entryNode)}`)
    out.push(`function ${direction}_proc${index}(h0: Handle, ctx: Ctx): void {`)
    if(raised.peakSlots > 0) out.push(`    let ${Array.from({length: raised.peakSlots}, (_, i) => `s${i}`).join(", ")};`)
    if(maxHandleIndex > 0) out.push(`    let ${Array.from({length: maxHandleIndex}, (_, i) => `h${i + 1}`).join(", ")};`)
    translateStmts(raised.body, g, out, "    ")
    out.push(`}`)
    return out.join("\n")
}

/** All procedures for one direction, as one source block — `program` and
 *  `rootType` must be the ones actually passed to the matching
 *  `buildCodec` call (encode/decode programs from the same schema have
 *  unrelated procedure indices; nothing here assumes otherwise, but a
 *  mismatched pair would generate nonsense silently, so get this from the
 *  same `buildCodec(root, {encode,decode}Rules, ...)` call it names). */
function generateProcedures(program: RtlProgram, rootType: SemanticType, direction: Direction): string
{
    const entryTypes = resolveProcedureTypes(program, rootType)
    const raisedProcs = raiseProgram(program, { effects: CODEC_EFFECTS })
    return raisedProcs
        .map((raised, i) => generateProcedure(i, raised, entryTypes.get(i)!, direction))
        .join("\n\n")
}

// ─────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────

export interface CodecModuleOptions
{
    /** Used to name the exported pair: `encode${name}`/`decode${name}`. */
    readonly name: string
    readonly rootType: SemanticType
    readonly encodeProgram: RtlProgram
    readonly decodeProgram: RtlProgram
}

const RUNTIME_IMPORTS = [
    "getH", "setH", "ensureStruct", "ensured", "enterVariant", "activeVariantPayload",
    "tagOf", "nextChild", "openList", "countOf", "loadVal", "storeVal",
    "read", "write", "hasNext", "cloneRd", "cloneWr", "seek", "writeSeq", "readSeq", "CodecTrap",
] as const

/**
 * Generate one self-contained TypeScript module: the projected TS type
 * declarations for `rootType` (this package's own existing type codegen,
 * `components/ts-emitter.ts`), every `encode_procN`/`decode_procN`
 * function, and a real, typed `encode${name}`/`decode${name}` entry-point
 * pair. Import it, or pass it to `ts-check.ts`'s `assertCompiles` (test
 * suite only) — this function only ever returns text, never touches
 * `ts.transpileModule`/`eval` itself.
 */
export function generateCodecModule(opts: CodecModuleOptions): string
{
    const { name, rootType, encodeProgram, decodeProgram } = opts

    const typeResult = projectTSTypes(rootType, tsTypeRules)
    const rootNode = buildTypeGraph(rootType).root
    const valueType = typeResult.get(rootNode.id)?.ref ?? "unknown"
    const rootIsStruct = isStructKind(resolveProcedureTypes(encodeProgram, rootType).get(0)!)

    const lines: string[] = []
    lines.push(`import { ${RUNTIME_IMPORTS.join(", ")} } from "@ppl/target-js/src/runtime/codec-runtime"`)
    lines.push(`import type { Handle, Ctx } from "@ppl/target-js/src/runtime/codec-runtime"`)
    lines.push(`import { evalBinary, evalUnary } from "@ppl/machine"`)
    lines.push("")
    lines.push(emitTSDeclarations(typeResult))
    lines.push(generateProcedures(encodeProgram, rootType, "encode"))
    lines.push("")
    lines.push(generateProcedures(decodeProgram, rootType, "decode"))
    lines.push("")
    lines.push(`export function encode${name}(value: ${valueType}): number[] {`)
    lines.push(`    const buffer: number[] = []`)
    lines.push(`    const ctx: Ctx = { buffer, iters: [{ pos: 0, capability: "write", overwriteOnly: false }] }`)
    lines.push(`    encode_proc0({ c: { v: value }, k: "v" }, ctx)`)
    lines.push(`    return buffer`)
    lines.push(`}`)
    lines.push("")
    lines.push(`export function decode${name}(bytes: number[]): ${valueType} {`)
    lines.push(`    const ctx: Ctx = { buffer: bytes, iters: [{ pos: 0, capability: "read", overwriteOnly: false }] }`)
    lines.push(`    const root: Handle = { c: {}, k: "v" }`)
    if(rootIsStruct) lines.push(`    ensureStruct(root)`)
    lines.push(`    decode_proc0(root, ctx)`)
    lines.push(`    return getH(root) as ${valueType}`)
    lines.push(`}`)

    return lines.join("\n")
}
