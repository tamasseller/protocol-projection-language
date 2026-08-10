/**
 * @ppl/codecs — Wire-level encoding for the codec extension's own opcodes
 * (docs/codec-extension.md §6, ROADMAP.md item 7)
 *
 * `Extension.codec` (`ExtCodec`, `@ppl/machine/extension.ts`) is the hook
 * `bytecode.ts` needs for every `EXT` instruction byte ≥128;
 * `createCodecExtension` (codec-extension.ts) didn't populate it until now
 * — `codecWireCodec` here is that value, wired in there.
 *
 * Layout follows isa-core.md §5's own philosophy (§4.4's small-`CONST`
 * fast path, §4.2's zero-immediate comparison special case): segment the
 * common case into the opcode byte itself, escape to LEB128 for the rest.
 * §2.1/§2.2 already call handle and iterator IDs "small literals, typically
 * < 4" — so 0..3 is this file's one recurring "small" threshold, not a
 * fresh guess per opcode. `ENTER`'s `ref` gets the same threshold for the
 * same reason (§6.2's "segment the common case" principle): every struct/
 * union in packages/example's `TelemetryPacket` schema — the one real
 * schema this project measures against (ROADMAP.md item 7) — has ≤4
 * fields/variants, so `ref < 4` covers every real case measured so far,
 * not just handle/iterator IDs.
 *
 * One recurring shape, seen in `ENTER`/`ENTER_NEXT`/`CLONE_RD`/`CLONE_WR`:
 * every real body this package's own `binary-rules.ts` generates allocates
 * a fresh handle/iterator one slot past its source (`enter(1, 0, ref)`,
 * `CLONE_RD 0, 1`) — so each of these four ops' compact form encodes only
 * `src`, deriving `dst = src + 1`; an actual `dst != src + 1` (or `src >=
 * 4`) falls back to a fully-explicit extended form instead.
 *
 * Two operands never get a compact form: `CALL_CODEC`/`CALL_CODEC_NEXT`'s
 * `codec_idx` (a procedure-table index — unlike a handle/iterator ID, it
 * has no small natural ceiling; it grows with how many distinct codecs a
 * real program has) and `SEEK`'s `delta` (a genuine signed offset, not a
 * small-cardinality enum) — both are always LEB128'd (`delta` via zigzag,
 * since core's `encodeLeb128`/`decodeLeb128` are unsigned-only).
 *
 * `READ`/`WRITE`'s `width` is the one non-index operand that *does* get
 * folded into the opcode byte: `w ∈ {1, 2, 4}` (§3.1) is a fixed 3-way
 * enum, not an open-ended count, so it costs opcode-space multiplication
 * (×3) instead of a LEB128 byte, even in the "extended" (iterator ID ≥ 4)
 * form.
 *
 * Bands are assigned in `CODEC_OPCODES`' own declared order (opcodes.ts),
 * each reserving as many codes as its own compact/extended split needs —
 * see each `BANDS` entry below for the split. The original 15 opcodes
 * used 119 of the 128 available codes, leaving 9 (247..255) reserved and
 * unused per isa-core.md §5.3's "leave room, don't force a smaller
 * encoding to fill every slot" philosophy — `WRITE_SEQ`/`READ_SEQ`
 * (ROADMAP.md item 11) spend exactly that remaining budget (3 + 6 = 9
 * codes: `w ∈ WIDTHS` alone for `WRITE_SEQ`, `w × signed` for `READ_SEQ`),
 * filling the codec extension's 128-code space exactly, with `iter`/
 * `handle`/`count` always LEB128'd on both (no compact index form — see
 * `writeSeqBand`/`readSeqBand` below for why that split doesn't apply
 * the same way here).
 */

import type { ExtCodec, ExtInstr } from "@ppl/machine"
import { encodeLeb128, decodeLeb128 } from "@ppl/machine"
import { CODEC_OPCODES } from "./opcodes"
import type { CodecOpcode } from "./opcodes"

/** Handle IDs, iterator IDs, and (per this file's header) `ENTER`'s `ref`
 *  all share this one "small" threshold. */
const SMALL = 4

/** `READ`/`WRITE`'s only three valid widths (§3.1) — index into this array
 *  *is* the opcode-space selector, never a LEB128 payload. */
const WIDTHS = [1, 2, 4] as const

// ── Signed LEB128 (zigzag) — only `SEEK`'s `delta` needs this; every other
// operand here is a non-negative index or count. Standard 32-bit zigzag:
// bit 0 carries the sign, the rest is the magnitude shifted left one. ────

function encodeSigned(n: number): number[]
{
    return encodeLeb128(((n << 1) ^ (n >> 31)) >>> 0)
}

function decodeSigned(bytes: Uint8Array, offset: number): { value: number; next: number }
{
    const { value: zz, next } = decodeLeb128(bytes, offset)
    return { value: (zz >>> 1) ^ -(zz & 1), next }
}

/**
 * One opcode's compact/extended split. `width` is how many codes this band
 * reserves, in local (band-relative) space — the table below turns that
 * into absolute byte values by summing preceding bands' widths.
 * `encode`/`decode` work in that same local space: `encode` returns a code
 * in `0..width-1` plus whatever trailing LEB128 bytes that code's variant
 * needs; `decode` takes that local code back and reconstructs
 * `ExtInstr.operands` in the exact order `codec-extension.ts`'s `exec`/
 * `codecRules` already fix (each factory function below documents that
 * order in its own comment).
 */
interface Band
{
    readonly width: number
    readonly encode: (operands: readonly number[]) => { code: number; rest: number[] }
    readonly decode: (code: number, bytes: Uint8Array, pos: number) => { operands: number[]; next: number }
}

/** `LOAD_VAL`/`STORE_VAL`/`COUNT`/`TAG`/`OPEN_LIST`/`HAS_NEXT` — a single
 *  index operand (a handle ID for the first five, an iterator ID for
 *  `HAS_NEXT`). `operands = [idx]`. */
function smallIndexBand(): Band
{
    return {
        width: SMALL + 1,
        encode: ([idx]) => idx! < SMALL ? { code: idx!, rest: [] } : { code: SMALL, rest: encodeLeb128(idx!) },
        decode: (code, bytes, pos) => code < SMALL
            ? { operands: [code], next: pos }
            : (() => { const r = decodeLeb128(bytes, pos); return { operands: [r.value], next: r.next } })(),
    }
}

/** `ENTER_NEXT dst, src` / `CLONE_RD src, dst` / `CLONE_WR src, dst` — two
 *  index operands, compact when `dst === src + 1` and `src < SMALL`
 *  (§2.1/§3.4's real-body allocation pattern, this file's header). `order`
 *  fixes each op's own `ExtInstr.operands` order — `"dst-src"` for
 *  `ENTER_NEXT`, `"src-dst"` for the two `CLONE_*` ops. */
function impliedNextBand(order: "dst-src" | "src-dst"): Band
{
    const pack = (dst: number, src: number): number[] => order === "dst-src" ? [dst, src] : [src, dst]
    return {
        width: SMALL + 1,
        encode: (operands) =>
        {
            const [dst, src] = order === "dst-src" ? [operands[0]!, operands[1]!] : [operands[1]!, operands[0]!]
            if (src < SMALL && dst === src + 1) return { code: src, rest: [] }
            return { code: SMALL, rest: [...encodeLeb128(operands[0]!), ...encodeLeb128(operands[1]!)] }
        },
        decode: (code, bytes, pos) =>
        {
            if (code < SMALL) return { operands: pack(code + 1, code), next: pos }
            const a = decodeLeb128(bytes, pos)
            const b = decodeLeb128(bytes, a.next)
            return { operands: [a.value, b.value], next: b.next }
        },
    }
}

/** `ENTER dst, src, ref` — compact when `dst === src + 1` and both
 *  `src < SMALL` and `ref < SMALL`; one code per `(src, ref)` pair.
 *  `operands = [dst, src, ref]`. */
function enterBand(): Band
{
    const width = SMALL * SMALL + 1
    return {
        width,
        encode: ([dst, src, ref]) =>
        {
            if (src! < SMALL && ref! < SMALL && dst === src! + 1)
                return { code: src! * SMALL + ref!, rest: [] }
            return { code: width - 1, rest: [...encodeLeb128(dst!), ...encodeLeb128(src!), ...encodeLeb128(ref!)] }
        },
        decode: (code, bytes, pos) =>
        {
            if (code < width - 1)
            {
                const src = Math.floor(code / SMALL), ref = code % SMALL
                return { operands: [src + 1, src, ref], next: pos }
            }
            const dst = decodeLeb128(bytes, pos)
            const src = decodeLeb128(bytes, dst.next)
            const ref = decodeLeb128(bytes, src.next)
            return { operands: [dst.value, src.value, ref.value], next: ref.next }
        },
    }
}

/** `READ i, w` / `WRITE i, w` — `operands = [iterIdx, width]`, `width ∈
 *  WIDTHS`. Compact when `iterIdx < SMALL`: one code per `(iterIdx,
 *  widthIdx)` pair. Extended: one code per `widthIdx` (never a LEB128
 *  payload — see this file's header) plus `LEB128(iterIdx)`. */
function readWriteBand(): Band
{
    const width = SMALL * WIDTHS.length + WIDTHS.length
    return {
        width,
        encode: ([iterIdx, w]) =>
        {
            const widthIdx = WIDTHS.indexOf(w as typeof WIDTHS[number])
            if (widthIdx < 0) throw new Error(`wire: READ/WRITE width ${w} isn't one of ${WIDTHS.join(",")} (§3.1)`)
            if (iterIdx! < SMALL) return { code: iterIdx! * WIDTHS.length + widthIdx, rest: [] }
            return { code: SMALL * WIDTHS.length + widthIdx, rest: encodeLeb128(iterIdx!) }
        },
        decode: (code, bytes, pos) =>
        {
            if (code < SMALL * WIDTHS.length)
                return { operands: [Math.floor(code / WIDTHS.length), WIDTHS[code % WIDTHS.length]!], next: pos }
            const widthIdx = code - SMALL * WIDTHS.length
            const r = decodeLeb128(bytes, pos)
            return { operands: [r.value, WIDTHS[widthIdx]!], next: r.next }
        },
    }
}

/** `SEEK i, Δ` — `operands = [iterIdx, delta]`. `delta` is always
 *  zigzag-LEB128'd (a genuine signed offset, not a small-cardinality
 *  index); only `iterIdx` gets the compact/extended split. */
function seekBand(): Band
{
    return {
        width: SMALL + 1,
        encode: ([iterIdx, delta]) => iterIdx! < SMALL
            ? { code: iterIdx!, rest: encodeSigned(delta!) }
            : { code: SMALL, rest: [...encodeLeb128(iterIdx!), ...encodeSigned(delta!)] },
        decode: (code, bytes, pos) =>
        {
            if (code < SMALL) { const d = decodeSigned(bytes, pos); return { operands: [code, d.value], next: d.next } }
            const idx = decodeLeb128(bytes, pos)
            const d = decodeSigned(bytes, idx.next)
            return { operands: [idx.value, d.value], next: d.next }
        },
    }
}

/** `CALL_CODEC codec_idx, src, ref` — `operands = [codecIdx, src, ref]`.
 *  `codecIdx` is always LEB128'd (this file's header: a procedure-table
 *  index has no small natural ceiling); `src`/`ref` get the compact pair
 *  treatment, `LEB128(codecIdx)` following either way. */
function callCodecBand(): Band
{
    const width = SMALL * SMALL + 1
    return {
        width,
        encode: ([codecIdx, src, ref]) =>
        {
            if (src! < SMALL && ref! < SMALL)
                return { code: src! * SMALL + ref!, rest: encodeLeb128(codecIdx!) }
            return { code: width - 1, rest: [...encodeLeb128(codecIdx!), ...encodeLeb128(src!), ...encodeLeb128(ref!)] }
        },
        decode: (code, bytes, pos) =>
        {
            if (code < width - 1)
            {
                const src = Math.floor(code / SMALL), ref = code % SMALL
                const c = decodeLeb128(bytes, pos)
                return { operands: [c.value, src, ref], next: c.next }
            }
            const c = decodeLeb128(bytes, pos)
            const src = decodeLeb128(bytes, c.next)
            const ref = decodeLeb128(bytes, src.next)
            return { operands: [c.value, src.value, ref.value], next: ref.next }
        },
    }
}

/** `CALL_CODEC_NEXT codec_idx, src` — `operands = [codecIdx, src]`, same
 *  "codecIdx always LEB128'd" rule as `callCodecBand`, `src` alone gets
 *  the compact/extended split. */
function callCodecNextBand(): Band
{
    return {
        width: SMALL + 1,
        encode: ([codecIdx, src]) => src! < SMALL
            ? { code: src!, rest: encodeLeb128(codecIdx!) }
            : { code: SMALL, rest: [...encodeLeb128(codecIdx!), ...encodeLeb128(src!)] },
        decode: (code, bytes, pos) =>
        {
            if (code < SMALL) { const c = decodeLeb128(bytes, pos); return { operands: [c.value, code], next: c.next } }
            const c = decodeLeb128(bytes, pos)
            const s = decodeLeb128(bytes, c.next)
            return { operands: [c.value, s.value], next: s.next }
        },
    }
}

/** `WRITE_SEQ iter, handle, w, count` (ROADMAP.md item 11) —
 *  `operands = [iter, handle, w, count]`, `w ∈ WIDTHS`. Unlike
 *  `readWriteBand`, `iter`/`handle` get no compact/extended split here —
 *  this op costs one nested procedure call's worth of savings *per list*,
 *  not per element, so the same "measure real cases" budgeting that gave
 *  every earlier opcode a compact form doesn't apply: there are exactly
 *  `WIDTHS.length` codes left to spend (this file's header: 9 of 128
 *  reserved, `READ_SEQ` below spends the rest), so `w` alone is folded
 *  into the opcode byte and `iter`/`handle`/`count` are always LEB128'd. */
function writeSeqBand(): Band
{
    return {
        width: WIDTHS.length,
        encode: ([iter, handle, w, count]) =>
        {
            const widthIdx = WIDTHS.indexOf(w as typeof WIDTHS[number])
            if (widthIdx < 0) throw new Error(`wire: WRITE_SEQ width ${w} isn't one of ${WIDTHS.join(",")} (§3.1)`)
            return { code: widthIdx, rest: [...encodeLeb128(iter!), ...encodeLeb128(handle!), ...encodeLeb128(count!)] }
        },
        decode: (code, bytes, pos) =>
        {
            const iter = decodeLeb128(bytes, pos)
            const handle = decodeLeb128(bytes, iter.next)
            const count = decodeLeb128(bytes, handle.next)
            return { operands: [iter.value, handle.value, WIDTHS[code]!, count.value], next: count.next }
        },
    }
}

/** `READ_SEQ iter, handle, w, signed, count` (ROADMAP.md item 11) —
 *  `operands = [iter, handle, w, signed, count]`. `w` and `signed` both
 *  fold into the opcode byte (`WIDTHS.length * 2` codes — the last of the
 *  9 codes this file's header reserves for `WRITE_SEQ`/`READ_SEQ`
 *  together, filling the codec extension's 128-code budget exactly);
 *  `iter`/`handle`/`count` are always LEB128'd, same reasoning as
 *  `writeSeqBand`. */
function readSeqBand(): Band
{
    return {
        width: WIDTHS.length * 2,
        encode: ([iter, handle, w, signed, count]) =>
        {
            const widthIdx = WIDTHS.indexOf(w as typeof WIDTHS[number])
            if (widthIdx < 0) throw new Error(`wire: READ_SEQ width ${w} isn't one of ${WIDTHS.join(",")} (§3.1)`)
            const code = widthIdx * 2 + (signed! ? 1 : 0)
            return { code, rest: [...encodeLeb128(iter!), ...encodeLeb128(handle!), ...encodeLeb128(count!)] }
        },
        decode: (code, bytes, pos) =>
        {
            const widthIdx = Math.floor(code / 2)
            const signed = code % 2
            const iter = decodeLeb128(bytes, pos)
            const handle = decodeLeb128(bytes, iter.next)
            const count = decodeLeb128(bytes, handle.next)
            return { operands: [iter.value, handle.value, WIDTHS[widthIdx]!, signed, count.value], next: count.next }
        },
    }
}

const BAND_BY_OP: Readonly<Record<CodecOpcode, Band>> = {
    ENTER: enterBand(),
    ENTER_NEXT: impliedNextBand("dst-src"),
    LOAD_VAL: smallIndexBand(),
    STORE_VAL: smallIndexBand(),
    COUNT: smallIndexBand(),
    TAG: smallIndexBand(),
    OPEN_LIST: smallIndexBand(),
    READ: readWriteBand(),
    WRITE: readWriteBand(),
    HAS_NEXT: smallIndexBand(),
    CLONE_RD: impliedNextBand("src-dst"),
    CLONE_WR: impliedNextBand("src-dst"),
    SEEK: seekBand(),
    CALL_CODEC: callCodecBand(),
    CALL_CODEC_NEXT: callCodecNextBand(),
    WRITE_SEQ: writeSeqBand(),
    READ_SEQ: readSeqBand(),
}

/** `CODEC_OPCODES`' own declared order (opcodes.ts) fixes each band's base
 *  offset — the wire format's one source of truth for byte assignment,
 *  independent of `CODEC_OPCODES`' own reason for that ordering (opcode
 *  vocabulary, not wire layout). Recomputed once at module load, not
 *  hand-maintained as literal numbers — see this file's header for why a
 *  literal per-row table (bytecode.ts's own style, cross-checked against
 *  isa-core.md's Appendix) doesn't apply here: there is no pre-existing
 *  external byte assignment this table needs to match, only internal
 *  consistency between `encode`/`decode`. */
const BASE_BY_OP = new Map<CodecOpcode, number>()
let TOTAL_CODES = 0
for (const op of CODEC_OPCODES)
{
    BASE_BY_OP.set(op, TOTAL_CODES)
    TOTAL_CODES += BAND_BY_OP[op].width
}

// isa-core.md §5.1: the extension owns exactly the top 128 codes (bytes
// 128..255) — a band layout that overflowed that would silently corrupt
// wire output rather than failing loudly, so this is checked once, at
// module load, not left to be discovered via a wrong decoded opcode.
if (TOTAL_CODES > 128)
    throw new Error(`wire: codec opcode bands need ${TOTAL_CODES} codes, only 128 are available (isa-core.md §5.1)`)

function opAndLocalCodeOf(byte: number): { op: CodecOpcode; local: number }
{
    const code = byte - 128
    for (const op of CODEC_OPCODES)
    {
        const base = BASE_BY_OP.get(op)!
        const w = BAND_BY_OP[op].width
        if (code >= base && code < base + w) return { op, local: code - base }
    }
    throw new Error(`wire: byte ${byte} (local code ${code}) is reserved and unassigned`)
}

function encode(instr: ExtInstr): number[]
{
    const op = instr.ext as CodecOpcode
    const band = BAND_BY_OP[op]
    if (!band) throw new Error(`wire: unknown codec opcode "${instr.ext}"`)
    const base = BASE_BY_OP.get(op)!
    const { code, rest } = band.encode(instr.operands)
    return [128 + base + code, ...rest]
}

function decode(bytes: Uint8Array, offset: number): { instr: ExtInstr; next: number }
{
    const { op, local } = opAndLocalCodeOf(bytes[offset]!)
    const { operands, next } = BAND_BY_OP[op].decode(local, bytes, offset + 1)
    return { instr: { op: "EXT", ext: op, operands }, next }
}

/** The codec extension's `Extension.codec` — wired into
 *  `createCodecExtension`'s returned `Extension` (codec-extension.ts). */
export const codecWireCodec: ExtCodec = { encode, decode }
