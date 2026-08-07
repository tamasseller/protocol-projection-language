/**
 * @ppl/codecs — Codec extension (ROADMAP.md item 7, docs/codec-extension.md)
 *
 * Layer 1 (docs/ARCHITECTURE.md's "Mappings" section) — domain
 * infrastructure, not a codec: it doesn't encode anything by itself, it's
 * what makes encoding *expressible* as `ir` text at all. It lives in
 * `@ppl/codecs` rather than `@ppl/machine` only because `@ppl/machine` must
 * stay protocol-agnostic (ROADMAP.md item 7); conceptually it's still core.
 *
 * `createCodecExtension` implements `@ppl/machine`'s `Extension` hook
 * (packages/machine/src/extension.ts) for structs, unions, and lists —
 * `ENTER`, `ENTER_NEXT`, `LOAD_VAL`, `STORE_VAL`, `COUNT`, `TAG`,
 * `OPEN_LIST`, `READ`, `WRITE`, `CALL_CODEC`, `CALL_CODEC_NEXT` — plus
 * `codecRules()`, this same opcode set's `rules()` DSL surface (matching
 * `Extension["rules"]`, extension.ts:107), so codec bodies are authored as
 * real `ir\`...\`` text (`../engine/builders.ts`,
 * `../components/delta-leb128.ts`, `../components/json.ts`) instead of
 * hand-built `RtlInstr[]` arrays. Still out of scope, tracked in
 * codec-extension.md §3: `HAS_NEXT`/`CLONE_RD`/`CLONE_WR`/`SEEK` (stream
 * forks — nothing here needs more than one straight-through `i0`). Also
 * still out of scope: the wire-level `codec` byte layout (§6 says that's
 * deliberately unassigned until real codecs exist to measure against —
 * `../components/binary-rules.ts` is exactly that now, but the byte-layout
 * design pass itself is separate follow-on work).
 *
 * Direction (§2.1/§2.3) is a property of the whole program, not of this
 * extension — `createCodecExtension` takes it as a constructor argument,
 * matching the "one Extension instance per direction per program" shape
 * ROADMAP.md item 8's image-format sketch describes (an encoder and a
 * decoder for the same type are two separate programs sharing only the
 * semantic type, not one bidirectional call graph). It's read by
 * `computeChild`'s union branch (decode instantiates a variant; encode
 * only navigates one, checked against the value's already-active variant)
 * — every other opcode's behavior falls out of which handle/value it's
 * pointed at, not the direction flag itself. Nothing here enforces the
 * *rest* of direction-correctness (e.g. rejecting `STORE_VAL` while
 * encoding) — that's the validator work codec-extension.md §7.1 still has
 * open.
 */

import type { Extension, ExecState, ExtOpEffect } from "@ppl/machine"
import type { ExtInstr } from "@ppl/machine"
import type { Rule } from "@ppl/machine"
import type { EastMatch, LiteralMatch, IdentifierMatch } from "@ppl/machine"
import { rule, leafNode, extInstr, pBuiltinCallN, pLiteral, pIdentifier } from "@ppl/machine"
import type { IntegerType, TypeNode } from "@ppl/core"
import { kindOf, SemanticTypeKinds } from "@ppl/core"

export type Direction = "encode" | "decode"

/** Smallest byte width that fits an integer type's declared range — the
 *  source of truth for both `../components/binary-rules.ts` (which byte
 *  count to `WRITE`/`READ`) and `toHostNumber` below (which bit is the sign
 *  bit). Lives here, not in `binary-rules.ts`, so this file — the
 *  host-mapping layer — never has to import from the bytecode-*generation*
 *  layer (a component) built on top of it; `binary-rules.ts` imports it
 *  from here instead. */
export function intWireSize(t: IntegerType): number
{
    const range = t.max - t.min
    if(range <= 0xFF) return 1
    if(range <= 0xFFFF) return 2
    if(range <= 0xFFFFFFFF) return 4
    return 8
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
    const bits = intWireSize(type) * 8
    const signBit = 2 ** (bits - 1)
    return raw >= signBit ? raw - 2 ** bits : raw
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

const EFFECTS: Readonly<Record<string, ExtOpEffect>> = {
    ENTER:      { tosDelta: 0, maxTransient: 0 },
    ENTER_NEXT: { tosDelta: 0, maxTransient: 0 },
    LOAD_VAL:   { tosDelta: 0, maxTransient: 0 },
    STORE_VAL:  { tosDelta: 0, maxTransient: 0 },
    COUNT:      { tosDelta: 0, maxTransient: 0 },
    TAG:        { tosDelta: 0, maxTransient: 0 },
    OPEN_LIST:  { tosDelta: 0, maxTransient: 0 },
    READ:       { tosDelta: 0, maxTransient: 0 },
    WRITE:      { tosDelta: 0, maxTransient: 0 },
    // §3.3/§4: CALL_CODEC codec_idx, src, ref, [args...] — validate.ts
    // derives the actual pop count from the resolved callee's own
    // argCount header (extension.ts's `ExtOpEffect.call` doc comment), so
    // this declaration doesn't need to (and can't) know each call site's
    // codec's arity itself.
    CALL_CODEC:      { tosDelta: 0, maxTransient: 0, call: { calleeOperandIndex: 0 } },
    CALL_CODEC_NEXT: { tosDelta: 0, maxTransient: 0, call: { calleeOperandIndex: 0 } },
}

const literalArgs = (arity: number) => Array.from({ length: arity }, () => pLiteral())
const litValue = (m: EastMatch): number => (m as LiteralMatch).value

/** One opcode per literal-operand-only op in `EFFECTS` above (everything but
 *  the two call-shaped ones) — each just splices its arguments straight
 *  into an `ExtInstr`'s `operands`, the way `trap(code)` splices its one
 *  literal argument into `TRAP #code` (machine/rules.ts:185-186). None of
 *  these need `"acc"` to actually hold anything meaningful afterward (some
 *  read it, e.g. `WRITE`/`STORE_VAL`; some ignore it entirely, e.g.
 *  `ENTER`) — declaring `["acc"]` regardless is the same harmless
 *  over-statement `trap`'s own rule already makes (it never returns either),
 *  and is required for `lowerStatementExpr` to accept the call as a bare
 *  statement at all (an empty `output: []` fails its "any non-`tos`
 *  location" filter — orchestrator.ts:243-247). */
const LITERAL_OPS: readonly { name: string; ext: string; arity: number }[] = [
    { name: "enter", ext: "ENTER", arity: 3 },
    { name: "enter_next", ext: "ENTER_NEXT", arity: 2 },
    { name: "load_val", ext: "LOAD_VAL", arity: 1 },
    { name: "store_val", ext: "STORE_VAL", arity: 1 },
    { name: "count", ext: "COUNT", arity: 1 },
    { name: "tag", ext: "TAG", arity: 1 },
    { name: "open_list", ext: "OPEN_LIST", arity: 1 },
    { name: "read", ext: "READ", arity: 2 },
    { name: "write", ext: "WRITE", arity: 2 },
]

/**
 * `call_codec`/`call_codec_next` DSL syntax: `call_codec(${codecProc}, src, ref)`.
 * The callee-reference argument is matched with `pIdentifier()` — a pure
 * structural check (matcher.ts:236-239) — and resolved via `resolveCallee`,
 * exactly like a real procedure call (`callNode`, machine/rules.ts:395-411).
 * This never touches the generic value-tiling path at all, which is why the
 * previous pass's `${helper}` splice into a builtin-call *argument* crashed:
 * it used a `pRtl(...)` sub-pattern there instead of `pIdentifier()`.
 */
function callShapedRule(name: string, ext: string, tailArity: number, resolveCallee: (name: string) => number | undefined): Rule
{
    return rule(`codec:${name}`, pBuiltinCallN(name, [pIdentifier(), ...literalArgs(tailArity)]), m =>
    {
        const [calleeMatch, ...tail] = m.argumentMatches
        const calleeIndex = resolveCallee((calleeMatch as IdentifierMatch).name)
        if(calleeIndex === undefined) return undefined
        return leafNode(["acc"], [extInstr(ext, [calleeIndex, ...tail.map(litValue)])], [], 0, 0)
    })
}

/** The codec extension's `Extension.rules` — lets codec bodies be authored
 *  as `ir\`...\`` text (builders.ts and friends) instead of hand-built
 *  `RtlInstr[]` arrays. Matches `Extension["rules"]`'s signature
 *  (extension.ts:107) exactly; `resolveLocal` is unused (no codec opcode
 *  reads/writes a named local — every operand is either a literal or a
 *  callee reference resolved via `resolveCallee`). */
export function codecRules(_resolveLocal: (name: string) => number, resolveCallee: (name: string) => number | undefined): Rule[]
{
    return [
        ...LITERAL_OPS.map(({ name, ext, arity }) =>
            rule(`codec:${name}`, pBuiltinCallN(name, literalArgs(arity)), m =>
                leafNode(["acc"], [extInstr(ext, m.argumentMatches.map(litValue))], [], 0, 0))),
        callShapedRule("call_codec", "CALL_CODEC", 2, resolveCallee),
        callShapedRule("call_codec_next", "CALL_CODEC_NEXT", 1, resolveCallee),
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

/**
 * @param direction encoder or decoder — see the file header.
 * @param root      the handle the entry procedure's `o0` is bound to.
 * @param buffer    the wire byte sequence — `i0` (§2.1). Appended to by
 *                   `WRITE` (encode), read sequentially by `READ` (decode).
 *                   This pass supports only `i0`, so `buffer`/its cursor
 *                   are shared, run-wide, un-reset-by-frame state — exactly
 *                   what §2.1 requires ("`i0`... established once... never
 *                   rebound"), unlike the per-frame handle table above.
 */
export function createCodecExtension(direction: Direction, root: Handle, buffer: number[]): Extension
{
    const frames: Frame[] = [[root]]
    let pos = 0
    const top = (): Frame => frames[frames.length - 1]!

    function exec(instr: ExtInstr, state: ExecState): void
    {
        const frame = top()

        switch(instr.ext)
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
                const [, width] = instr.operands as readonly [number, number]
                let value = 0
                for(let byte = 0; byte < width; byte++)
                    value |= (buffer[pos++] ?? 0) << (8 * byte)
                state.acc = value >>> 0
                return
            }

            case "WRITE":
            {
                const [, width] = instr.operands as readonly [number, number]
                let value = state.acc
                for(let byte = 0; byte < width; byte++)
                {
                    buffer[pos++] = value & 0xFF
                    value >>>= 8
                }
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

            default:
                throw new Error(`codec extension: unhandled opcode EXT ${instr.ext}`)
        }
    }

    return { effects: EFFECTS, exec }
}
