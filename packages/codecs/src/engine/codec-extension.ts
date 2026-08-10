/**
 * @ppl/codecs — Codec extension (ROADMAP.md item 7, docs/codec-extension.md)
 *
 * Implements `@ppl/machine`'s `Extension` hook for all 17 opcodes
 * `./opcodes.ts` names (§2/§3), plus `codecRules()`, their `ir\`...\`` DSL
 * surface. Lives here rather than `@ppl/machine` because that package must
 * stay protocol-agnostic; conceptually it's still core infrastructure, not
 * a codec itself. The wire-level `codec` byte layout (§6, ROADMAP.md item
 * 8) lives in `./wire.ts`, wired in below as `Extension.codec`.
 *
 * Direction (§2.1/§2.3) is a whole-program property, passed in once here.
 * It's read by `computeChild`'s union branch (decode instantiates a
 * variant; encode only navigates one) and by `i0`'s own initial stream
 * capability (§2.1: read-only for a decoder, write-only for an encoder) —
 * every other opcode's behavior follows from which handle/iterator it's
 * pointed at.
 */

import type { Extension, ExecState, ExtOpEffect } from "@ppl/machine"
import type { ExtInstr } from "@ppl/machine"
import type { Rule } from "@ppl/machine"
import { rule, leafNode, unaryNode, extInstr, pBuiltinCall, pConst, pIdentifier, pRtl } from "@ppl/machine"
import type { IntegerType, TypeNode } from "@ppl/core"
import { kindOf, SemanticTypeKinds } from "@ppl/core"
import type { CodecOpcode } from "./opcodes"
import { isCodecOpcode, assertNever } from "./opcodes"
import { codecWireCodec } from "./wire"

export type Direction = "encode" | "decode"

/** Smallest byte width that fits an integer type's declared range — the
 *  source of truth for both `../components/binary-rules.ts` (which byte
 *  count to `WRITE`/`READ`) and `toHostNumber` below (which bit is the sign
 *  bit). Lives here, not in `binary-rules.ts`, so this file — the
 *  host-mapping layer — never has to import from the bytecode-*generation*
 *  layer (a component) built on top of it; `binary-rules.ts` imports it
 *  from here instead. */
export function intWireSize(t: {min: number, max: number}): number
{
    const range = t.max - t.min
    if(range <= 0xFF) return 1
    if(range <= 0xFFFF) return 2
    if(range <= 0xFFFFFFFF) return 4
    return 8
}

/**
 * Reinterpret an unsigned `bits`-wide bit pattern as a signed JS number —
 * two's-complement, the same reinterpretation a real target gets for free
 * from its type system (a C `int16_t`, a JS `Int16Array`) when writing
 * into a typed variable. Factored out of `toHostNumber` below so
 * `READ_SEQ` — which only ever has a plain `width`/`signed` pair to work
 * with, never a full `IntegerType` — can reuse it directly.
 */
function signExtend(bits: number, raw: number): number
{
    const signBit = 2 ** (bits - 1)
    return raw >= signBit ? raw - 2 ** bits : raw
}

/**
 * `LOAD_VAL`/`STORE_VAL` move raw values through `acc`, which — like every
 * register in this VM (vm.ts's own `>>> 0` throughout) — only ever holds
 * an unsigned 32-bit pattern. A signed type's negative values arrive at
 * `STORE_VAL` as that pattern (e.g. `-1` as an `i16` reads back as
 * `65535`, not `-1`), which is exactly correct as *bits* but wrong as the
 * plain JS number a caller handed in and expects back. A real target
 * writing into a typed variable (a C `int16_t`, a JS `Int16Array`) gets
 * this reinterpretation for free from the type system; this Handle model
 * stores plain numbers, so it has to do it explicitly — once, here, using
 * the width `intWireSize` already establishes as canonical for this type.
 */
function toHostNumber(type: IntegerType, raw: number): number
{
    if(type.min >= 0) return raw
    return signExtend(intWireSize(type) * 8, raw)
}

/**
 * A handle (§2.2) as this implementation actually represents it: not just
 * "the current value" but a (container, key) pair, so `STORE_VAL` can write
 * a decoded primitive back into its parent object — plain JS numbers/
 * strings aren't mutable references, so a handle has to carry enough to
 * write *through* to where the value lives, not just a snapshot of it.
 */
export interface Handle
{
    readonly container: Record<string | number, unknown>
    readonly key: string | number
    readonly type: TypeNode
    /** Lazily initialized by `ENTER_NEXT`/`CALL_CODEC_NEXT` — a list
     *  handle's own read/append position, kept separate from the
     *  underlying array's `.length` because encode reads elements without
     *  consuming them (so `.length` never changes) while decode appends
     *  (so it does) — one mechanism instead of two direction-specific
     *  ones. Every `ENTER` produces a brand-new `Handle` object with no
     *  `cursor` yet, so multipass read (re-entering the same list from its
     *  parent) gets a fresh position for free, per §3.4. Absent/irrelevant
     *  on any non-list handle. */
    cursor?: { i: number }
}

/** A union value's in-memory shape — the active variant's name plus its
 *  payload (`undefined`/absent for a `unit` variant). */
interface UnionValue
{
    variant: string
    value: unknown
}

const get = (h: Handle): unknown => h.container[h.key]
const set = (h: Handle, v: unknown): void => { h.container[h.key] = v }

/**
 * A struct value is never "instantiated" the way a list (`OPEN_LIST`) or a
 * union (the decoder branch below) is — the design assumed a struct
 * handle's value already exists, true for the root handle the caller
 * provides but *not* for a nested struct field/element/payload reached
 * during decode, whose slot is simply `undefined` until something writes
 * to it. Without this, entering that field's own first field would try to
 * write through `undefined`. Applied to every handle `computeChild`/
 * `computeNext` produce, right before returning it — struct-kind targets
 * only; lists get `OPEN_LIST`, unions get their own instantiation, and a
 * primitive has nothing to instantiate at all.
 */
function ensureDecodedStructExists(handle: Handle, direction: Direction): Handle
{
    if(direction === "decode" && kindOf(handle.type.type) === SemanticTypeKinds.Struct && get(handle) === undefined)
        set(handle, {})
    return handle
}

/** One call frame's handle table — index 0 is always that frame's `o0`
 *  (§2.2: "`o0` is bound at codec entry to the object the procedure must
 *  encode/decode"). A fresh frame per `CALL_CODEC`/`CALL_CODEC_NEXT`
 *  mirrors the generic core's own register-frame semantics (isa-core.md
 *  §2.5): a callee's own `o1`/`o2`... never alias or clobber the caller's,
 *  and the caller's own frame is exactly as it left it once the callee
 *  returns. */
type Frame = Handle[]

const EFFECTS: Readonly<Record<CodecOpcode, ExtOpEffect>> = {
    ENTER:      { tosDelta: 0, maxTransient: 0 },
    ENTER_NEXT: { tosDelta: 0, maxTransient: 0 },
    LOAD_VAL:   { tosDelta: 0, maxTransient: 0 },
    STORE_VAL:  { tosDelta: 0, maxTransient: 0 },
    COUNT:      { tosDelta: 0, maxTransient: 0 },
    TAG:        { tosDelta: 0, maxTransient: 0 },
    OPEN_LIST:  { tosDelta: 0, maxTransient: 0 },
    READ:       { tosDelta: 0, maxTransient: 0 },
    WRITE:      { tosDelta: 0, maxTransient: 0 },
    HAS_NEXT:   { tosDelta: 0, maxTransient: 0 },
    CLONE_RD:   { tosDelta: 0, maxTransient: 0 },
    CLONE_WR:   { tosDelta: 0, maxTransient: 0 },
    SEEK:       { tosDelta: 0, maxTransient: 0 },
    // §3.3/§4: CALL_CODEC codec_idx, src, ref, [args...] — validate.ts
    // derives the actual pop count from the resolved callee's own
    // argCount header (extension.ts's `ExtOpEffect.call` doc comment), so
    // this declaration doesn't need to (and can't) know each call site's
    // codec's arity itself.
    CALL_CODEC:      { tosDelta: 0, maxTransient: 0, call: { calleeOperandIndex: 0 } },
    CALL_CODEC_NEXT: { tosDelta: 0, maxTransient: 0, call: { calleeOperandIndex: 0 } },
    // ROADMAP.md item 11: bulk transfer of `acc` (the element count) many
    // elements between a stream iterator and a list handle's own array
    // storage — the "snatch point" a target codegen can specialize into a
    // raw-buffer/DMA copy; `exec()`'s own semantics are always the dumb
    // per-element pump loop (§11's "generic semantics first" split).
    WRITE_SEQ: { tosDelta: 0, maxTransient: 0 },
    READ_SEQ:  { tosDelta: 0, maxTransient: 0 },
}

/** The codec extension's `Extension.rules` — lets codec bodies be authored
 *  as `ir\`...\`` text (builders.ts and friends) instead of hand-built
 *  `RtlInstr[]` arrays. Matches `Extension["rules"]`'s signature
 *  (extension.ts:107) exactly; `resolveLocal` is unused (no codec opcode
 *  reads/writes a named local — every operand is either a literal or a
 *  callee reference resolved via `resolveCallee`).
 *
 *  Every non-call rule below declares `output: ["acc"]`, regardless of
 *  whether its own opcode actually leaves anything meaningful there
 *  (`ENTER`/`ENTER_NEXT`/`OPEN_LIST` don't) — the same harmless
 *  over-statement `trap`'s own rule already makes (it never returns
 *  either), required for `lowerStatementExpr` to accept the call as a bare
 *  statement at all (an empty `output: []` fails its "any non-`tos`
 *  location" filter — orchestrator.ts:243-247).
 *
 *  Every argument is a plain rest argument to `pBuiltinCall` — `enter`'s
 *  three literals, `write`'s two literals plus a trailing `pRtl("acc")`,
 *  `call_codec`'s callee identifier plus its literal operands — all typed
 *  positionally by rest-parameter inference, so each rule's `m
 *  .argumentMatches` destructures straight into exactly-typed locals with
 *  no manual cast anywhere below.
 *
 *  `write`/`store_val` are two ops whose real semantics *read* `acc` as an
 *  input (`stream[i].write(acc, w)`, `handle.value = acc`), so their last
 *  argument is a real `pRtl("acc")` demand instead of a literal, and their
 *  builder splices that argument's own tiled fragment in ahead of the
 *  opcode (`unaryNode`) rather than assuming the value is already sitting
 *  in `acc` by the time the call runs. `write_seq`/`read_seq` follow the
 *  same shape for their own dynamic operand, `count` (ROADMAP.md item
 *  11) — never a codegen-time literal, since it's a decoder's own decoded
 *  list length — while `iter`/`handle`/`width`/`signed` stay plain
 *  `pConst()` literals exactly like every other index/enum operand above.
 *
 *  `call_codec`/`call_codec_next` (`call_codec(${codecProc}, src, ref)`)
 *  are call-shaped rather than value-shaped: their first argument is the
 *  callee reference, matched with `pIdentifier()` — a pure structural check
 *  (matcher.ts:236-239) — and resolved via `resolveCallee`, exactly like a
 *  real procedure call (`callNode`, machine/rules.ts:395-411), never
 *  touching the generic value-tiling path at all. Neither currently uses
 *  `pBuiltinCall`'s `pTail(...)` marker — both take a fixed number of
 *  operands today — but it's exactly what would carry `CALL_CODEC`'s
 *  still-unimplemented optional runtime value args (docs/codec-
 *  extension.md §3.3, §4: `codec_idx, src, ref, [args…]`) whenever that
 *  lands. */
export function codecRules(_resolveLocal: (name: string) => number, resolveCallee: (name: string) => number | undefined): Rule[]
{
    return [
        rule("codec:enter", pBuiltinCall("enter", pConst(), pConst(), pConst()), m =>
            leafNode(["acc"], [extInstr("ENTER", m.argumentMatches.map(a => a.value))], [], 0, 0)),

        rule("codec:enter_next", pBuiltinCall("enter_next", pConst(), pConst()), m =>
            leafNode(["acc"], [extInstr("ENTER_NEXT", m.argumentMatches.map(a => a.value))], [], 0, 0)),

        rule("codec:load_val", pBuiltinCall("load_val", pConst()), m =>
            leafNode(["acc"], [extInstr("LOAD_VAL", m.argumentMatches.map(a => a.value))], [], 0, 0)),

        rule("codec:count", pBuiltinCall("count", pConst()), m =>
            leafNode(["acc"], [extInstr("COUNT", m.argumentMatches.map(a => a.value))], [], 0, 0)),

        rule("codec:tag", pBuiltinCall("tag", pConst()), m =>
            leafNode(["acc"], [extInstr("TAG", m.argumentMatches.map(a => a.value))], [], 0, 0)),

        rule("codec:open_list", pBuiltinCall("open_list", pConst()), m =>
            leafNode(["acc"], [extInstr("OPEN_LIST", m.argumentMatches.map(a => a.value))], [], 0, 0)),

        rule("codec:read", pBuiltinCall("read", pConst(), pConst()), m =>
            leafNode(["acc"], [extInstr("READ", m.argumentMatches.map(a => a.value))], [], 0, 0)),

        rule("codec:write", pBuiltinCall("write", pConst(), pConst(), pRtl("acc")), m =>
        {
            const [iter, width, value] = m.argumentMatches
            return unaryNode(value.node, ["acc"], [...value.node.fragment, extInstr("WRITE", [iter.value, width.value])])
        }),

        rule("codec:store_val", pBuiltinCall("store_val", pConst(), pRtl("acc")), m =>
        {
            const [src, value] = m.argumentMatches
            return unaryNode(value.node, ["acc"], [...value.node.fragment, extInstr("STORE_VAL", [src.value])])
        }),

        // `write_seq(iter, handle, width, count)` / `read_seq(iter, handle,
        // width, signed, count)` (ROADMAP.md item 11) — `count` is the one
        // dynamic operand (a decoder's own decoded length, never known at
        // codegen time), so it's the trailing `pRtl("acc")` demand, exactly
        // like `write`'s value argument above; `iter`/`handle`/`width`
        // (and `read_seq`'s `signed`) are always codegen-time literals.
        rule("codec:write_seq", pBuiltinCall("write_seq", pConst(), pConst(), pConst(), pRtl("acc")), m =>
        {
            const [iter, handle, width, count] = m.argumentMatches
            return unaryNode(count.node, ["acc"],
                [...count.node.fragment, extInstr("WRITE_SEQ", [iter.value, handle.value, width.value])])
        }),

        rule("codec:read_seq", pBuiltinCall("read_seq", pConst(), pConst(), pConst(), pConst(), pRtl("acc")), m =>
        {
            const [iter, handle, width, signed, count] = m.argumentMatches
            return unaryNode(count.node, ["acc"],
                [...count.node.fragment, extInstr("READ_SEQ", [iter.value, handle.value, width.value, signed.value])])
        }),

        rule("codec:has_next", pBuiltinCall("has_next", pConst()), m =>
            leafNode(["acc"], [extInstr("HAS_NEXT", m.argumentMatches.map(a => a.value))], [], 0, 0)),

        rule("codec:clone_rd", pBuiltinCall("clone_rd", pConst(), pConst()), m =>
            leafNode(["acc"], [extInstr("CLONE_RD", m.argumentMatches.map(a => a.value))], [], 0, 0)),

        rule("codec:clone_wr", pBuiltinCall("clone_wr", pConst(), pConst()), m =>
            leafNode(["acc"], [extInstr("CLONE_WR", m.argumentMatches.map(a => a.value))], [], 0, 0)),

        // `pConst()` alone is enough for a *negative* delta too: `-4` parses
        // as `UnaryExpression("-", Literal(4))` (matcher.ts), but
        // rules.ts's `fold:unary:-` — an ordinary Rule, tried like any
        // other — resolves it to a plain constant wherever a `pConst()`
        // position asks, so no second rule is needed for the negative case.
        rule("codec:seek", pBuiltinCall("seek", pConst(), pConst()), m =>
            leafNode(["acc"], [extInstr("SEEK", m.argumentMatches.map(a => a.value))], [], 0, 0)),

        rule("codec:call_codec", pBuiltinCall("call_codec", pIdentifier(), pConst(), pConst()), m =>
        {
            const [callee, src, ref] = m.argumentMatches
            const calleeIndex = resolveCallee(callee.name)
            if(calleeIndex === undefined) return undefined
            return leafNode(["acc"], [extInstr("CALL_CODEC", [calleeIndex, src.value, ref.value])], [], 0, 0)
        }),

        rule("codec:call_codec_next", pBuiltinCall("call_codec_next", pIdentifier(), pConst()), m =>
        {
            const [callee, src] = m.argumentMatches
            const calleeIndex = resolveCallee(callee.name)
            if(calleeIndex === undefined) return undefined
            return leafNode(["acc"], [extInstr("CALL_CODEC_NEXT", [calleeIndex, src.value])], [], 0, 0)
        }),
    ]
}

/**
 * Navigate from handle `srcId` (in `frame`) to its child at field/variant
 * index `ref` — struct and union (list elements are `ENTER_NEXT`-only,
 * §3.4; see `computeNext`). `ref` is a *position* into the source type's
 * field/variant table, matching codec-extension.md §2.4's "no per-
 * instruction type_ref" design: `TypeNode.edges` (buildTypeGraph,
 * @ppl/core/type-graph.ts) is already in declaration order, so
 * `edges[ref]` *is* the field/variant, no name lookup needed to resolve
 * `ref` itself — only to then read/write the actual host value under that
 * field's/variant's name.
 */
function computeChild(frame: Frame, srcId: number, ref: number, direction: Direction): Handle
{
    const src = frame[srcId]
    if(!src) throw new Error(`codec extension: no handle ${srcId} in the current frame (ENTER before use?)`)

    const kind = kindOf(src.type.type)

    if(kind === SemanticTypeKinds.Struct)
    {
        const edge = src.type.edges[ref]
        if(!edge || !("field" in edge.step))
            throw new Error(`codec extension: no field #${ref} on this struct (${src.type.edges.length} field(s))`)

        return ensureDecodedStructExists(
            { container: get(src) as Record<string, unknown>, key: edge.step.field, type: edge.target },
            direction)
    }

    if(kind === SemanticTypeKinds.Union)
    {
        const edge = src.type.edges[ref]
        if(!edge || !("variant" in edge.step))
            throw new Error(`codec extension: no variant #${ref} on this union (${src.type.edges.length} variant(s))`)

        if(direction === "decode")
        {
            // §2.3's decoder row: ENTER on a union selects+instantiates it.
            set(src, { variant: edge.step.variant, value: undefined } satisfies UnionValue)
        }
        else
        {
            // Encoder side navigates only — the caller (a TAG+BR_TABLE
            // dispatch, §8.2) is expected to have already picked `ref` to
            // match the value's own active variant. This check is a cheap
            // stand-in for the real per-handle type check codec-
            // extension.md §7.1 still leaves open, not that check itself.
            const active = get(src) as UnionValue | undefined
            if(!active || active.variant !== edge.step.variant)
                throw new Error(`codec extension: ENTER/CALL_CODEC variant #${ref} (${edge.step.variant}) doesn't match the active variant (${active?.variant ?? "none"})`)
        }

        const unionValue = get(src) as UnionValue
        return ensureDecodedStructExists(
            { container: unionValue as unknown as Record<string, unknown>, key: "value", type: edge.target },
            direction)
    }

    if(kind === SemanticTypeKinds.List)
        throw new Error(`codec extension: list elements are accessed via ENTER_NEXT/CALL_CODEC_NEXT, not ENTER/CALL_CODEC`)

    throw new Error(`codec extension: ENTER/CALL_CODEC on a ${kind} handle isn't supported`)
}

/**
 * Advance to `srcId`'s (a list handle's) next element — the sequential-
 * only access §3.4 requires. Shared by `ENTER_NEXT` and `CALL_CODEC_NEXT`.
 * A list `TypeNode` always has exactly one outgoing edge, the
 * `{element: true}` one (`type-graph.ts`'s `edgesOf`), so `edges[0]` is
 * unambiguous — no `ref` operand needed, matching the spec's own
 * `ENTER_NEXT dst, src` (no `ref`).
 */
function computeNext(frame: Frame, srcId: number, direction: Direction): Handle
{
    const src = frame[srcId]
    if(!src) throw new Error(`codec extension: no handle ${srcId} in the current frame (ENTER before use?)`)

    const kind = kindOf(src.type.type)
    if(kind !== SemanticTypeKinds.List)
        throw new Error(`codec extension: ENTER_NEXT/CALL_CODEC_NEXT on a ${kind} handle isn't supported (list only)`)

    const elementType = src.type.edges[0]?.target
    if(!elementType) throw new Error(`codec extension: list type has no element edge`)

    src.cursor ??= { i: 0 }
    const index = src.cursor.i++

    return ensureDecodedStructExists(
        { container: get(src) as unknown as Record<number, unknown>, key: index, type: elementType },
        direction)
}

/** One stream iterator's live state (§2.1). `capability` is fixed at
 *  creation — `i0`'s from the program's `direction`, a fork's from which of
 *  `CLONE_RD`/`CLONE_WR` made it, independent of its source (§2.1) — and
 *  never changes. `overwriteOnly` is `CLONE_WR`'s own restriction: only
 *  `i0` ever appends past the buffer's current end; every `CLONE_WR` fork
 *  may only overwrite bytes an earlier `i0` write already established. */
interface StreamIter
{
    pos: number
    capability: "read" | "write"
    overwriteOnly: boolean
}

/**
 * @param direction encoder or decoder — see the file header.
 * @param root      the handle the entry procedure's `o0` is bound to.
 * @param buffer    the wire byte sequence. Iterator 0 (`i0`) is seeded here
 *                   at position 0 with `direction`'s capability; `iters`, like
 *                   `buffer`, is shared, run-wide, un-reset-by-frame state —
 *                   §2.1 requires this for `i0`, and a fork's whole point
 *                   (§8.4's checksum-with-fixup) is to stay live across
 *                   whatever the frame does next — unlike the per-frame
 *                   handle table above.
 */
export function createCodecExtension(direction: Direction, root: Handle, buffer: number[]): Extension
{
    const frames: Frame[] = [[root]]
    const iters: StreamIter[] = [{ pos: 0, capability: direction === "encode" ? "write" : "read", overwriteOnly: false }]
    const top = (): Frame => frames[frames.length - 1]!

    function iterAt(id: number): StreamIter
    {
        const it = iters[id]
        if(!it) throw new Error(`codec extension: no stream iterator ${id} (CLONE_RD/CLONE_WR before use?)`)
        return it
    }

    function exec(instr: ExtInstr, state: ExecState): void
    {
        const frame = top()

        if(!isCodecOpcode(instr.ext)) throw new Error(`codec extension: unhandled opcode EXT ${instr.ext}`)
        const op: CodecOpcode = instr.ext

        switch(op)
        {
            case "ENTER":
            {
                const [dst, src, ref] = instr.operands as readonly [number, number, number]
                frame[dst] = computeChild(frame, src, ref, direction)
                return
            }

            case "ENTER_NEXT":
            {
                const [dst, src] = instr.operands as readonly [number, number]
                frame[dst] = computeNext(frame, src, direction)
                return
            }

            case "LOAD_VAL":
            {
                const [src] = instr.operands as readonly [number]
                const h = frame[src]
                if(!h) throw new Error(`codec extension: LOAD_VAL on unbound handle ${src}`)
                state.acc = (get(h) as number) >>> 0
                return
            }

            case "STORE_VAL":
            {
                const [src] = instr.operands as readonly [number]
                const h = frame[src]
                if(!h) throw new Error(`codec extension: STORE_VAL on unbound handle ${src}`)
                const value = kindOf(h.type.type) === SemanticTypeKinds.Integer
                    ? toHostNumber(h.type.type as IntegerType, state.acc)
                    : state.acc
                set(h, value)
                return
            }

            case "COUNT":
            {
                const [src] = instr.operands as readonly [number]
                const h = frame[src]
                if(!h) throw new Error(`codec extension: COUNT on unbound handle ${src}`)
                state.acc = (get(h) as unknown[]).length >>> 0
                return
            }

            case "TAG":
            {
                const [src] = instr.operands as readonly [number]
                const h = frame[src]
                if(!h) throw new Error(`codec extension: TAG on unbound handle ${src}`)
                const active = get(h) as UnionValue
                const idx = h.type.edges.findIndex(e => "variant" in e.step && e.step.variant === active.variant)
                if(idx < 0) throw new Error(`codec extension: TAG: active variant "${active.variant}" not found on this union's type`)
                state.acc = idx >>> 0
                return
            }

            case "OPEN_LIST":
            {
                const [src] = instr.operands as readonly [number]
                const h = frame[src]
                if(!h) throw new Error(`codec extension: OPEN_LIST on unbound handle ${src}`)
                set(h, []) // capacity hint in acc intentionally ignored — §3.4
                return
            }

            case "READ":
            {
                const [iterId, width] = instr.operands as readonly [number, number]
                const it = iterAt(iterId)
                if(it.capability !== "read") throw new Error(`codec extension: READ on write-only iterator ${iterId}`)
                let value = 0
                for(let byte = 0; byte < width; byte++)
                    value |= (buffer[it.pos++] ?? 0) << (8 * byte)
                state.acc = value >>> 0
                return
            }

            case "WRITE":
            {
                const [iterId, width] = instr.operands as readonly [number, number]
                const it = iterAt(iterId)
                if(it.capability !== "write") throw new Error(`codec extension: WRITE on read-only iterator ${iterId}`)
                if(it.overwriteOnly && it.pos + width > buffer.length)
                    throw new Error(`codec extension: iterator ${iterId} (a CLONE_WR fork) can't append — only i0 appends (§2.1)`)
                let value = state.acc
                for(let byte = 0; byte < width; byte++)
                {
                    buffer[it.pos++] = value & 0xFF
                    value >>>= 8
                }
                return
            }

            case "HAS_NEXT":
            {
                const [iterId] = instr.operands as readonly [number]
                const it = iterAt(iterId)
                if(it.capability !== "read") throw new Error(`codec extension: HAS_NEXT on write-only iterator ${iterId}`)
                state.acc = it.pos < buffer.length ? 1 : 0
                return
            }

            case "CLONE_RD":
            {
                const [src, dst] = instr.operands as readonly [number, number]
                iters[dst] = { pos: iterAt(src).pos, capability: "read", overwriteOnly: false }
                return
            }

            case "CLONE_WR":
            {
                const [src, dst] = instr.operands as readonly [number, number]
                iters[dst] = { pos: iterAt(src).pos, capability: "write", overwriteOnly: true }
                return
            }

            case "SEEK":
            {
                const [iterId, delta] = instr.operands as readonly [number, number]
                const it = iterAt(iterId)
                if(it.pos + delta < 0) throw new Error(`codec extension: SEEK would move iterator ${iterId} before the stream's start`)
                it.pos += delta
                return
            }

            case "CALL_CODEC":
            {
                const [codecIdx, src, ref] = instr.operands as readonly [number, number, number]
                const child = computeChild(frame, src, ref, direction)
                frames.push([child])
                try { state.acc = state.callProc(codecIdx, []) }
                finally { frames.pop() }
                return
            }

            case "CALL_CODEC_NEXT":
            {
                const [codecIdx, src] = instr.operands as readonly [number, number]
                const child = computeNext(frame, src, direction)
                frames.push([child])
                try { state.acc = state.callProc(codecIdx, []) }
                finally { frames.pop() }
                return
            }

            // ROADMAP.md item 11: bulk transfer, `acc` many elements, each
            // `width` bytes, between `iterId` and `handleId`'s own array
            // storage. Always the dumb per-element pump loop here — the
            // "generic semantics first" half of §11's split; a target
            // codegen recognizing this op at `raise.ts` time is free to
            // specialize it into a raw-buffer/DMA copy instead, but nothing
            // about `exec`/`validateProgram`/`run` needs to know that.
            case "WRITE_SEQ":
            {
                const [iterId, handleId, width] = instr.operands as readonly [number, number, number]
                const it = iterAt(iterId)
                if(it.capability !== "write") throw new Error(`codec extension: WRITE_SEQ on read-only iterator ${iterId}`)
                const h = frame[handleId]
                if(!h) throw new Error(`codec extension: WRITE_SEQ on unbound handle ${handleId}`)
                const count = state.acc
                if(it.overwriteOnly && it.pos + width * count > buffer.length)
                    throw new Error(`codec extension: iterator ${iterId} (a CLONE_WR fork) can't append — only i0 appends (§2.1)`)
                const arr = get(h) as number[]
                for(let i = 0; i < count; i++)
                {
                    let value = arr[i]!
                    for(let byte = 0; byte < width; byte++)
                    {
                        buffer[it.pos++] = value & 0xFF
                        value >>>= 8
                    }
                }
                return
            }

            case "READ_SEQ":
            {
                const [iterId, handleId, width, signed] = instr.operands as readonly [number, number, number, number]
                const it = iterAt(iterId)
                if(it.capability !== "read") throw new Error(`codec extension: READ_SEQ on write-only iterator ${iterId}`)
                const h = frame[handleId]
                if(!h) throw new Error(`codec extension: READ_SEQ on unbound handle ${handleId}`)
                const arr = get(h) as number[]
                const count = state.acc
                for(let i = 0; i < count; i++)
                {
                    let value = 0
                    for(let byte = 0; byte < width; byte++)
                        value |= (buffer[it.pos++] ?? 0) << (8 * byte)
                    value = value >>> 0
                    arr[i] = signed ? signExtend(width * 8, value) : value
                }
                return
            }

            default:
                return assertNever(op)
        }
    }

    return { effects: EFFECTS, exec, codec: codecWireCodec }
}

