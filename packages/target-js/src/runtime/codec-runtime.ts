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
 *  `Handle`-carrying one either.
 *
 *  `variantNames` stays image-side unconditionally (docs/codec-image.md
 *  §2.2), so a not-found name is exactly the union/local-only/encode trap
 *  (§3.4) once bridging is active — `CodecTrap`, not a plain `Error`,
 *  for the same reason every other bridging trap join point uses one
 *  (`codec-codegen-ext.ts`'s `emitCallCodec`). In a non-reconciled
 *  program the two lists are always the same node's own, so this stays
 *  defensive/unreachable there — a real hit means the local value's own
 *  active-variant bookkeeping is corrupted, not a bridging outcome. */
export function tagOf(variantName: string, variantNames: readonly string[]): number
{
    const idx = variantNames.indexOf(variantName)
    if(idx < 0)
    {
        throw new CodecTrap(-1, `active variant "${variantName}" isn't one of ${JSON.stringify(variantNames)}`)
    }

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
 *  `buffer` is a real `Uint8Array` throughout, on both the decode side
 *  (where it's the caller's own input, used directly — no copy) and the
 *  encode side (grown on demand, doubling, by `ensureCapacity` — the one
 *  place `buffer.length` is a *capacity*, not the actually-valid extent).
 *  `length` is that actually-valid extent: identical to `buffer.length`
 *  for decode (fixed, never grows), but tracked separately for encode
 *  since `ensureCapacity` may over-allocate ahead of what's actually
 *  been written so far. `generateCodecModule`'s own `encode${name}`
 *  returns `ctx.buffer.subarray(0, ctx.length)` — a *view*, not a copy,
 *  trimmed to exactly what was written; `decode${name}` passes its own
 *  `bytes` parameter straight through as `buffer`, no copy either. */
export interface Ctx { buffer: Uint8Array; length: number; iters: Iter[] }

function iterAt(ctx: Ctx, id: number): Iter
{
    const it = ctx.iters[id]
    if(!it)
    {
        throw new Error(`codec: no stream iterator ${id}`)
    }

    return it
}

/** Grow `ctx.buffer`'s own capacity, doubling (never shrinking, never
 *  called at all on the decode side, whose buffer is fixed-size by
 *  construction) — the one place a fixed-size `Uint8Array` would
 *  otherwise be a real constraint compiled `write`/`writeSeq` don't have
 *  to live with. */
function ensureCapacity(ctx: Ctx, upTo: number): void
{
    if(upTo <= ctx.buffer.length)
    {
        return
    }

    const grown = new Uint8Array(Math.max(upTo, ctx.buffer.length * 2, 64))
    grown.set(ctx.buffer.subarray(0, ctx.length))
    ctx.buffer = grown
}

/** Every wire width `intWireSize` (`@ppl/codecs`) ever produces is 1, 2,
 *  4, or 8 — the three common cases go straight through `DataView`
 *  (little-endian, matching this module's own byte order throughout);
 *  8 (and, defensively, anything else) falls back to the same manual
 *  per-byte loop this module always used — `DataView.getBigUint64`
 *  would be the genuinely correct 8-byte read, but the value crossing
 *  this boundary is a plain `number` throughout the rest of this module
 *  (an `Accessor.fromWire`/`toWire` already narrowed it, e.g.
 *  `wideIntegerRule`'s own `Number(x) >>> 0` on the way in), so nothing
 *  downstream could use the extra precision anyway; unchanged from this
 *  module's own pre-existing behavior, not a new gap this rework opens. */
function readBytes(dv: DataView, buffer: Uint8Array, pos: number, width: number): number
{
    if(width === 1)
    {
        return dv.getUint8(pos)
    }

    if(width === 2)
    {
        return dv.getUint16(pos, true)
    }

    if(width === 4)
    {
        return dv.getUint32(pos, true)
    }

    let value = 0
    for(let byte = 0; byte < width; byte++)
    {
        value |= (buffer[pos + byte] ?? 0) << (8 * byte)
    }

    return value >>> 0
}

function writeBytes(dv: DataView, buffer: Uint8Array, pos: number, width: number, value: number): void
{
    if(width === 1)
    {
        dv.setUint8(pos, value)
        return
    }

    if(width === 2)
    {
        dv.setUint16(pos, value, true)
        return
    }

    if(width === 4)
    {
        dv.setUint32(pos, value >>> 0, true)
        return
    }

    for(let byte = 0; byte < width; byte++)
    {
        buffer[pos + byte] = value & 0xFF
        value >>>= 8
    }
}

/** A fresh `DataView` over `ctx.buffer`'s own current backing — cheap (no
 *  data copy, just a small wrapper), but still built once per call rather
 *  than once per byte, and — critically — always *after* any growth
 *  (`ensureCapacity`) a caller already performed, since growing replaces
 *  `ctx.buffer` with a new `Uint8Array` entirely. */
function view(ctx: Ctx): DataView
{
    return new DataView(ctx.buffer.buffer, ctx.buffer.byteOffset, ctx.buffer.byteLength)
}

export function read(ctx: Ctx, iterIdx: number, width: number): number
{
    const it = iterAt(ctx, iterIdx)
    if(it.capability !== "read")
    {
        throw new Error(`codec: READ on write-only iterator ${iterIdx}`)
    }

    const value = readBytes(view(ctx), ctx.buffer, it.pos, width)
    it.pos += width
    return value
}

export function write(ctx: Ctx, iterIdx: number, width: number, value: number): void
{
    const it = iterAt(ctx, iterIdx)
    if(it.capability !== "write")
    {
        throw new Error(`codec: WRITE on read-only iterator ${iterIdx}`)
    }

    if(it.overwriteOnly && it.pos + width > ctx.length)
    {
        throw new Error(`codec: iterator ${iterIdx} (a CLONE_WR fork) can't append — only the root iterator appends`)
    }

    ensureCapacity(ctx, it.pos + width)
    writeBytes(view(ctx), ctx.buffer, it.pos, width, value)
    it.pos += width
    ctx.length = Math.max(ctx.length, it.pos)
}

export function hasNext(ctx: Ctx, iterIdx: number): number
{
    const it = iterAt(ctx, iterIdx)
    if(it.capability !== "read")
    {
        throw new Error(`codec: HAS_NEXT on write-only iterator ${iterIdx}`)
    }

    return it.pos < ctx.length ? 1 : 0
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
    if(it.pos + delta < 0)
    {
        throw new Error(`codec: SEEK would move iterator ${iterIdx} before the stream's start`)
    }

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

/** ROADMAP.md item 11's "snatch point": the per-element pump loop here
 *  matches codec-extension.ts's own WRITE_SEQ exec() case in spirit — a
 *  target codegen recognizing this op is free to specialize it into a
 *  raw-buffer/DMA copy, but this module doesn't (a straightforward,
 *  obviously-correct baseline is more valuable here than a premature
 *  optimization only exercised by the tests written against it). It does
 *  still grow the buffer *once*, for the whole transfer, rather than once
 *  per element (`ensureCapacity` before the loop, not inside it) and
 *  reuses one `DataView` across every element for the same reason.
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
    if(it.capability !== "write")
    {
        throw new Error(`codec: WRITE_SEQ on read-only iterator ${iterIdx}`)
    }

    if(it.overwriteOnly && it.pos + width * count > ctx.length)
    {
        throw new Error(`codec: iterator ${iterIdx} (a CLONE_WR fork) can't append — only the root iterator appends`)
    }

    ensureCapacity(ctx, it.pos + width * count)
    const dv = view(ctx)
    for(let i = 0; i < count; i++)
    {
        writeBytes(dv, ctx.buffer, it.pos, width, arr[i]!)
        it.pos += width
    }

    ctx.length = Math.max(ctx.length, it.pos)
}

export function readSeq(ctx: Ctx, iterIdx: number, arr: number[], width: number, signed: boolean, count: number): void
{
    const it = iterAt(ctx, iterIdx)
    if(it.capability !== "read")
    {
        throw new Error(`codec: READ_SEQ on write-only iterator ${iterIdx}`)
    }

    const dv = view(ctx)
    for(let i = 0; i < count; i++)
    {
        const value = readBytes(dv, ctx.buffer, it.pos, width)
        it.pos += width
        arr[i] = signed ? signExtend(width * 8, value) : value
    }
}

/** The genuinely direct alternative to `readSeq`/`writeSeq` above — for a
 *  rule whose own local representation *is* a typed array with byte
 *  layout matching the wire exactly (`ts-alternative-rules.ts`'s
 *  `int16ListAsInt16ArrayRule`), not a plain `number[]` that merely
 *  converts quickly. `readSeqView` doesn't copy at all: it returns a
 *  *view* directly over `ctx.buffer`'s own backing memory, advancing the
 *  iterator by the bytes it covers — the returned value's memory literally
 *  aliases the original input bytes, for a caller that never touches
 *  individual elements itself (e.g. handing a decoded burst straight to a
 *  raw file write). `writeSeqRaw`'s own copy — into `ctx.buffer`, which
 *  every procedure's own output necessarily assembles into — is a single
 *  native block copy (`Uint8Array.prototype.set`), never a per-element
 *  loop; encode has no "just return a view" option the way decode does,
 *  since the whole packet's bytes are one contiguous buffer this call is
 *  only ever one part of.
 *
 *  Deliberately does nothing defensive about endianness or alignment —
 *  the opposite tradeoff from every other helper in this file. A typed
 *  array's own backing bytes are always native/platform-endian; matching
 *  that against this module's own little-endian wire convention (`view`'s
 *  own `DataView` calls throughout this file) is the *rule's* contract to
 *  uphold, not something checked here — the whole point is to step out of
 *  the way and let bulk data move at the platform's own native speed. A
 *  misaligned wire position (not a multiple of `ctor.BYTES_PER_ELEMENT`)
 *  throws — via the typed-array constructor itself — rather than silently
 *  misbehaving; that's a schema-layout concern for whoever placed this
 *  field, not something this helper works around. */
export function readSeqView<A extends ArrayBufferView>(
    ctx: Ctx, iterIdx: number,
    ctor: new (buffer: ArrayBufferLike, byteOffset: number, length: number) => A,
    count: number,
): A
{
    const it = iterAt(ctx, iterIdx)
    if(it.capability !== "read")
    {
        throw new Error(`codec: READ_SEQ on write-only iterator ${iterIdx}`)
    }

    const result = new ctor(ctx.buffer.buffer, ctx.buffer.byteOffset + it.pos, count)
    it.pos += result.byteLength
    return result
}

export function writeSeqRaw(ctx: Ctx, iterIdx: number, src: ArrayBufferView): void
{
    const it = iterAt(ctx, iterIdx)
    if(it.capability !== "write")
    {
        throw new Error(`codec: WRITE_SEQ on read-only iterator ${iterIdx}`)
    }

    if(it.overwriteOnly && it.pos + src.byteLength > ctx.length)
    {
        throw new Error(`codec: iterator ${iterIdx} (a CLONE_WR fork) can't append — only the root iterator appends`)
    }

    ensureCapacity(ctx, it.pos + src.byteLength)
    ctx.buffer.set(new Uint8Array(src.buffer, src.byteOffset, src.byteLength), it.pos)
    it.pos += src.byteLength
    ctx.length = Math.max(ctx.length, it.pos)
}

/** `UnaryOpcode`'s one case that isn't a single JS expression — codegen
 *  (`codec-codegen.ts`'s `unaryOpToJs`) inlines every other op directly as
 *  text; this is the one that gets a named call instead, the same way
 *  `evalUnary`'s own `MUL`/`CLZ` equivalents lean on `Math.imul`/
 *  `Math.clz32` rather than hand-rolling them inline. Byte-for-byte the
 *  same algorithm as `@ppl/machine`'s own `evalUnary`'s `REVBITS` case —
 *  verified against it directly by `binary-op-codegen.runtime.test.ts`,
 *  not just asserted to match by comment. */
export function revBits(x: number): number
{
    let v = x
    v = ((v & 0x55555555) << 1) | ((v >>> 1) & 0x55555555)
    v = ((v & 0x33333333) << 2) | ((v >>> 2) & 0x33333333)
    v = ((v & 0x0F0F0F0F) << 4) | ((v >>> 4) & 0x0F0F0F0F)
    v = ((v & 0x00FF00FF) << 8) | ((v >>> 8) & 0x00FF00FF)
    return ((v << 16) | (v >>> 16)) >>> 0
}

export class CodecTrap extends Error
{
    /** `reason`, when given, is a bridging-specific trap (docs/codec-
     *  image.md §3) — reconciliation's own `resolve()` (`@ppl/codecs`)
     *  already produces a human-readable reason string, never a numeric
     *  RTL trap code (there's no RTL `TRAP` instruction behind one of
     *  these at all — the generated code raises it directly). `code`
     *  stays `-1` for one of these, a clear sentinel
     *  that it's not a real RTL-assigned code (those are opaque per-rule
     *  choices, isa-core.md §8.7 — never a fixed registry, so no risk of
     *  colliding with one). */
    constructor(readonly code: number, readonly reason?: string)
    {
        super(reason ? `codec trap ${code}: ${reason}` : `codec trap ${code}`)
        this.name = "CodecTrap"
    }
}
