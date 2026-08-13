/**
 * @ppl/target-js — Runtime support for compiled codec functions
 *
 * `engine/codec-codegen.ts` turns a raised (`@ppl/machine`'s raise.ts)
 * codec program into real control flow — real `function`s, real `if`/
 * `while`, direct calls between the generated functions instead of an
 * index into a procedure table, every `ENTER`'s `ref` resolved to a real
 * field/variant *name* at generation time (`@ppl/codecs`'s
 * `resolveHandleTypes`) — and, unlike `@ppl/codecs`'s own interpreter
 * (`codec-extension.ts`), every generated procedure *returns* the value
 * it decoded or *takes* the value it's encoding as a real parameter,
 * rather than writing through a `(container, key)` pointer pair threaded
 * across procedure boundaries. How a value of a given `TypeNode`'s own
 * type is actually constructed/read is never this module's concern — see
 * `engine/resolver.ts`'s `Accessor` — so what's left here is only what's
 * genuinely irreducible at generation time: buffer position and byte
 * read/write, identical in spirit to `codec-extension.ts`'s own stream-
 * iterator primitives, minus everything codegen now resolves statically
 * (no `TypeNode` carried at runtime, no schema-edge lookup, no dynamic
 * opcode dispatch, and — since this rework — no pointer-pair indirection
 * either).
 */

/** TAG: which variant is currently active, as its declaration-order
 *  index — codegen bakes in the variant name list itself (from the
 *  union's own `TypeNode.edges`, in order) and resolves the active
 *  variant's own *name* via `Accessor.activeVariantName` before calling
 *  in here, so this is a plain array lookup, never a schema-edge search
 *  the way `codec-extension.ts`'s own TAG case does it, and never a
 *  `Handle`-carrying one either. */
export function tagOf(variantName: string, variantNames: readonly string[]): number
{
    const idx = variantNames.indexOf(variantName)
    if(idx < 0) throw new Error(`codec: active variant "${variantName}" isn't one of ${JSON.stringify(variantNames)}`)
    return idx
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

/** Reinterpret an unsigned `bits`-wide bit pattern as a signed host
 *  number — two's-complement, mandatory wire-correctness (not a
 *  representation choice an `Accessor` gets to opt out of): a raw wire
 *  read is always unsigned bits; a signed integer type's own `fromWire`
 *  (`ts-emitter.ts`'s `integerRule`, and any alternative like
 *  `bigIntEscalationRules`) calls this to recover the real host value
 *  before doing anything representation-specific of its own. */
export function signExtend(bits: number, raw: number): number
{
    const signBit = 2 ** (bits - 1)
    return raw >= signBit ? raw - 2 ** bits : raw
}

/** ROADMAP.md item 11's "snatch point": the dumb per-element pump loop
 *  here matches codec-extension.ts's own WRITE_SEQ exec() case exactly —
 *  a target codegen recognizing this op is free to specialize it into a
 *  raw-buffer/DMA copy, but this module doesn't (a straightforward,
 *  obviously-correct baseline is more valuable here than a premature
 *  optimization only exercised by the tests written against it).
 *
 *  `arr` is the *finished* list value directly, never a `Handle` — an
 *  encode-side caller passes it as such (already representation-
 *  converted by whichever `Accessor.finishList` produced it), and both a
 *  plain `number[]` and a `Uint8Array` support the same `[i]` indexing
 *  this loop needs, so no `Accessor` involvement belongs here at all: the
 *  whole point of a bulk transfer is that it never touches representation
 *  per element, only once, at the value's own boundary. */
export function writeSeq(ctx: Ctx, iterIdx: number, arr: { readonly [i: number]: number }, width: number, count: number): void
{
    const it = iterAt(ctx, iterIdx)
    if(it.capability !== "write") throw new Error(`codec: WRITE_SEQ on read-only iterator ${iterIdx}`)
    if(it.overwriteOnly && it.pos + width * count > ctx.buffer.length)
        throw new Error(`codec: iterator ${iterIdx} (a CLONE_WR fork) can't append — only the root iterator appends`)
    for(let i = 0; i < count; i++)
    {
        let value = arr[i]!
        for(let byte = 0; byte < width; byte++) { ctx.buffer[it.pos++] = value & 0xFF; value >>>= 8 }
    }
}

/** `arr` is decode's own plain, growable accumulator — filled in directly,
 *  the same "no `Accessor` per element" reasoning as `writeSeq` above;
 *  whatever `finishList` eventually converts it to happens once, later,
 *  at the owning procedure's own `return`. */
export function readSeq(ctx: Ctx, iterIdx: number, arr: number[], width: number, signed: boolean, count: number): void
{
    const it = iterAt(ctx, iterIdx)
    if(it.capability !== "read") throw new Error(`codec: READ_SEQ on write-only iterator ${iterIdx}`)
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
