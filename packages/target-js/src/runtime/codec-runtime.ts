/**
 * @ppl/target-js — Runtime support for compiled codec functions
 *
 * `engine/codec-codegen.ts` turns a raised (`@ppl/machine`'s raise.ts)
 * codec program into real control flow — real `function`s, real `if`/
 * `while`, direct calls between the generated functions instead of an
 * index into a procedure table — with every `ENTER`'s `ref` resolved to a
 * real field/variant *name* at generation time (`@ppl/codecs`'s
 * `resolveHandleTypes`). What's left, genuinely irreducible at generation
 * time, is this module: buffer position, byte read/write, and the
 * (container, key) indirection a decoder needs to write a freshly-decoded
 * value back into its parent — the same handful of primitives
 * `@ppl/codecs`'s own `codec-extension.ts` interprets at runtime, minus
 * the parts codegen now does statically (no `TypeNode` carried at
 * runtime, no per-call schema-edge lookup, no dynamic opcode dispatch).
 *
 * `Handle`/`Iter` deliberately mirror `codec-extension.ts`'s own
 * `Handle`/`StreamIter` shapes closely — not by necessity (compiled code
 * has no obligation to look like the interpreter it replaces) but because
 * it makes every runtime helper here directly comparable, line for line,
 * against the exec() case it stands in for, which is exactly what made
 * this module easy to get right the first time and will make it easy to
 * keep right.
 */

export interface Handle
{
    c: any
    k: string | number
    /** List-iteration position — lazily created by `nextChild`, shared
     *  across every `nextChild` call against the same `Handle` object
     *  (mirrors codec-extension.ts's own per-Handle `cursor`). Sequential
     *  access only, matching codec-extension.md §3.4. */
    cursor?: number
}

export const getH = (h: Handle): any => h.c[h.k]
export const setH = (h: Handle, v: unknown): void => { h.c[h.k] = v }

/** A freshly-navigated handle whose own type is a struct needs a real
 *  backing object before anything writes a field into it — codegen only
 *  ever calls this where the target's type is statically known to be a
 *  struct and only while decoding (both baked in at generation time; see
 *  `ensureDecodedStructExists`, codec-extension.ts). Also what a compiled
 *  `decode()` entry point uses to seed a struct-typed root, replacing the
 *  manual `{ root: {} }` callers of the interpreted path have to set up
 *  themselves (codec-extension.ts's own root handle is never passed
 *  through `computeChild`, so nothing instantiates it automatically). */
export function ensureStruct(h: Handle): void
{
    if(getH(h) === undefined) setH(h, {})
}

/** Wraps a freshly-built child `Handle` with `ensureStruct` only where
 *  codegen has determined it's needed — kept as a one-line passthrough so
 *  every `ENTER`/`CALL_CODEC(_NEXT)` call site can stay a single
 *  expression regardless of whether the wrap applies (`ensured(x)` vs.
 *  just `x`), rather than needing a separate statement. */
export function ensured(h: Handle): Handle
{
    ensureStruct(h)
    return h
}

/** ENTER/CALL_CODEC into a union payload, decode direction: instantiate
 *  the active variant — codegen already knows the variant name statically
 *  (codec-extension.ts's computeChild union/decode branch), so this never
 *  needs a schema lookup to pick it. */
export function enterVariant(h: Handle, variant: string): Handle
{
    setH(h, { variant, value: undefined })
    return { c: getH(h), k: "value" }
}

/** ENTER/CALL_CODEC into a union payload, encode direction: navigate
 *  only — codegen has already picked `expectedVariant` to match a
 *  TAG-driven dispatch, so this never re-derives it; the active-variant
 *  check is a runtime sanity check carried over from codec-extension.ts's
 *  own encode branch (catches a caller handing in a value whose active
 *  variant disagrees with the schema, not a codegen bug). */
export function activeVariantPayload(h: Handle, expectedVariant: string): Handle
{
    const active = getH(h) as { variant: string; value: unknown } | undefined
    if(!active || active.variant !== expectedVariant)
        throw new Error(`codec: active variant "${active?.variant ?? "none"}" doesn't match the expected variant "${expectedVariant}"`)
    return { c: active, k: "value" }
}

/** TAG: which variant is currently active, as its declaration-order
 *  index — codegen bakes in the variant name list itself (from the
 *  union's own `TypeNode.edges`, in order), so this is a plain array
 *  lookup, never a schema-edge search the way codec-extension.ts's own
 *  TAG case does it. */
export function tagOf(h: Handle, variantNames: readonly string[]): number
{
    const active = getH(h) as { variant: string }
    const idx = variantNames.indexOf(active.variant)
    if(idx < 0) throw new Error(`codec: active variant "${active.variant}" isn't one of ${JSON.stringify(variantNames)}`)
    return idx
}

/** ENTER_NEXT/CALL_CODEC_NEXT: advance to the list's next element. */
export function nextChild(h: Handle): Handle
{
    const i = (h.cursor ??= 0)
    h.cursor = i + 1
    return { c: getH(h), k: i }
}

export function openList(h: Handle): void { setH(h, []) }
export function countOf(h: Handle): number { return (getH(h) as unknown[]).length }

/** LOAD_VAL: read a leaf value as raw wire bits — `>>> 0` matches
 *  codec-extension.ts's own LOAD_VAL exactly (a negative signed host value
 *  gets reinterpreted as an unsigned 32-bit pattern here, the same
 *  reinterpretation the interpreted runtime performs). */
export function loadVal(h: Handle): number { return (getH(h) as number) >>> 0 }

function signExtend(bits: number, raw: number): number
{
    const signBit = 2 ** (bits - 1)
    return raw >= signBit ? raw - 2 ** bits : raw
}

/** STORE_VAL: write a decoded wire value back as a real (possibly signed)
 *  host number. `width`/`signed` are baked in at generation time from the
 *  field's own static integer type (`intWireSize`, @ppl/codecs) — the
 *  interpreted runtime derives the same two facts from a `Handle.type` it
 *  carries at runtime; compiled code has no need to carry that, since
 *  every STORE_VAL call site already knows its own field. */
export function storeVal(h: Handle, raw: number, width: number, signed: boolean): void
{
    setH(h, signed ? signExtend(width * 8, raw) : raw)
}

// ── The byte stream ─────────────────────────────────────────────────────

export interface Iter { pos: number; capability: "read" | "write"; overwriteOnly: boolean }

/** Shared, run-wide state every generated procedure function threads
 *  through unchanged — the direct counterpart of codec-extension.ts's own
 *  `buffer`/`iters`, which are shared across every procedure call for the
 *  same reason (`createCodecExtension`'s own doc comment: "run-wide,
 *  un-reset-by-frame state"). Handle-table slots, by contrast, are real
 *  local variables in generated code — genuinely local to one procedure
 *  call, never threaded through `Ctx`.
 *
 *  `buffer` is `number[]`, not `Uint8Array`, purely so encoding has a sink
 *  it can *grow* (`write`'s own `buffer[it.pos++] = ...` past the current
 *  length) — a fixed-size Uint8Array can't do that. This is an internal
 *  contract only: `generateCodecModule`'s generated `encode`/`decode`
 *  entry points convert at the boundary (`new Uint8Array(buffer)` /
 *  `Array.from(bytes)`), so the *public* API a caller actually sees is
 *  `Uint8Array` in, `Uint8Array` out — the standard cross-runtime binary
 *  type, not this module's own internal growable-array detail leaking
 *  out. */
export interface Ctx { buffer: number[]; iters: Iter[] }

function iterAt(ctx: Ctx, id: number): Iter
{
    const it = ctx.iters[id]
    if(!it) throw new Error(`codec: no stream iterator ${id}`)
    return it
}

export function read(ctx: Ctx, iterIdx: number, width: number): number
{
    const it = iterAt(ctx, iterIdx)
    if(it.capability !== "read") throw new Error(`codec: READ on write-only iterator ${iterIdx}`)
    let value = 0
    for(let byte = 0; byte < width; byte++) value |= (ctx.buffer[it.pos++] ?? 0) << (8 * byte)
    return value >>> 0
}

export function write(ctx: Ctx, iterIdx: number, width: number, value: number): void
{
    const it = iterAt(ctx, iterIdx)
    if(it.capability !== "write") throw new Error(`codec: WRITE on read-only iterator ${iterIdx}`)
    if(it.overwriteOnly && it.pos + width > ctx.buffer.length)
        throw new Error(`codec: iterator ${iterIdx} (a CLONE_WR fork) can't append — only the root iterator appends`)
    for(let byte = 0; byte < width; byte++) { ctx.buffer[it.pos++] = value & 0xFF; value >>>= 8 }
}

export function hasNext(ctx: Ctx, iterIdx: number): number
{
    const it = iterAt(ctx, iterIdx)
    if(it.capability !== "read") throw new Error(`codec: HAS_NEXT on write-only iterator ${iterIdx}`)
    return it.pos < ctx.buffer.length ? 1 : 0
}

export function cloneRd(ctx: Ctx, srcIdx: number, dstIdx: number): void
{
    ctx.iters[dstIdx] = { pos: iterAt(ctx, srcIdx).pos, capability: "read", overwriteOnly: false }
}

export function cloneWr(ctx: Ctx, srcIdx: number, dstIdx: number): void
{
    ctx.iters[dstIdx] = { pos: iterAt(ctx, srcIdx).pos, capability: "write", overwriteOnly: true }
}

export function seek(ctx: Ctx, iterIdx: number, delta: number): void
{
    const it = iterAt(ctx, iterIdx)
    if(it.pos + delta < 0) throw new Error(`codec: SEEK would move iterator ${iterIdx} before the stream's start`)
    it.pos += delta
}

/** ROADMAP.md item 11's "snatch point": the dumb per-element pump loop
 *  here matches codec-extension.ts's own WRITE_SEQ exec() case exactly —
 *  a target codegen recognizing this op is free to specialize it into a
 *  raw-buffer/DMA copy, but this module doesn't (a straightforward,
 *  obviously-correct baseline is more valuable here than a premature
 *  optimization only exercised by the tests written against it). */
export function writeSeq(ctx: Ctx, iterIdx: number, h: Handle, width: number, count: number): void
{
    const it = iterAt(ctx, iterIdx)
    if(it.capability !== "write") throw new Error(`codec: WRITE_SEQ on read-only iterator ${iterIdx}`)
    if(it.overwriteOnly && it.pos + width * count > ctx.buffer.length)
        throw new Error(`codec: iterator ${iterIdx} (a CLONE_WR fork) can't append — only the root iterator appends`)
    const arr = getH(h) as number[]
    for(let i = 0; i < count; i++)
    {
        let value = arr[i]!
        for(let byte = 0; byte < width; byte++) { ctx.buffer[it.pos++] = value & 0xFF; value >>>= 8 }
    }
}

export function readSeq(ctx: Ctx, iterIdx: number, h: Handle, width: number, signed: boolean, count: number): void
{
    const it = iterAt(ctx, iterIdx)
    if(it.capability !== "read") throw new Error(`codec: READ_SEQ on write-only iterator ${iterIdx}`)
    const arr = getH(h) as number[]
    for(let i = 0; i < count; i++)
    {
        let value = 0
        for(let byte = 0; byte < width; byte++) value |= (ctx.buffer[it.pos++] ?? 0) << (8 * byte)
        value = value >>> 0
        arr[i] = signed ? signExtend(width * 8, value) : value
    }
}

export class CodecTrap extends Error
{
    constructor(readonly code: number) { super(`codec trap ${code}`); this.name = "CodecTrap" }
}
