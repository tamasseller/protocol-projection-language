/**
 * @ppl/machine — Bytecode codec (isa-core.md §5, Appendix — Opcode
 * Table)
 *
 * Encodes/decodes one procedure's flat instruction stream — deliberately
 * scoped to just that. There is no procedure header (`arg_count` +
 * extension fields, §2.3) and no multi-procedure program framing yet
 * (ROADMAP.md items 1 and 6 respectively), so there's nothing to wrap this
 * codec in beyond a raw byte length. `encoding.ts` is unrelated: a
 * relative cost estimate for the lowerer's own candidate comparison, not a
 * real serializer.
 *
 * `decodeInstr`/`encodeInstr` byte ≥128 (§5.1, "owned by the active
 * extension") delegates to an `Extension.codec` (extension.ts, ROADMAP.md
 * item 6), passed in as an optional trailing parameter; with none
 * registered, they throw a specific, well-labeled error at exactly that
 * point rather than misinterpreting the byte or failing generically.
 * `CALL` is the other deliberate stub: it
 * now carries the same resolved `calleeIndex: number` §4.6's `proc_idx`
 * wants (ROADMAP.md items 1–2 landed name→index resolution), but there is
 * still no multi-procedure program framing to encode/decode it *against*
 * — a lone `CALL` inside one procedure's body has nothing to check its
 * index against without the program-wide procedure table (ROADMAP.md
 * item 4's program envelope, not yet built).
 */

import type { RtlInstr, BinaryOpcode, UnaryOpcode } from "./rtl"
import type { Extension } from "./extension"

// ── LEB128 ───────────────────────────────────────────────────────────────
//
// Unsigned varint, 7 payload bits per byte, continuation bit (0x80) set on
// every byte but the last. Accumulation on decode uses multiplication by
// a power of two rather than `<<`, since `<<` operates on *signed* 32-bit
// ints in JS and the top bit of a full-range u32 would flip the sign at
// the last (5th) byte.

/** Encode `n` (an integer in `0..2**32-1`) as unsigned LEB128 bytes. */
export function encodeLeb128(n: number): number[]
{
    if (!Number.isInteger(n) || n < 0 || n > 0xFFFFFFFF)
        throw new Error(`encodeLeb128: ${n} is not a u32`)

    const bytes: number[] = []
    let rest = n >>> 0
    do
    {
        const byte = rest & 0x7F
        rest >>>= 7
        bytes.push(rest !== 0 ? byte | 0x80 : byte)
    }
    while (rest !== 0)
    return bytes
}

/** Decode one unsigned LEB128 varint starting at `bytes[offset]`. Returns
 *  the decoded value and the offset of the byte just past it. */
export function decodeLeb128(bytes: Uint8Array, offset: number): { value: number; next: number }
{
    let value = 0, shift = 0, pos = offset
    for (;;)
    {
        if (pos >= bytes.length)
            throw new Error(`decodeLeb128: ran off the end of the buffer at offset ${offset}`)
        const byte = bytes[pos]!
        value += (byte & 0x7F) * 2 ** shift
        pos++
        if ((byte & 0x80) === 0) break
        shift += 7
    }
    return { value: value >>> 0, next: pos }
}

// ── Op/mode index tables (isa-core.md §5.2) ─────────────────────────────
//
// Ordering here is the wire format's authority, independent of any other
// module's internal ordering (rules.ts's OP_TABLE groups operators for
// rule generation, not for opcode assignment, and doesn't list `RSUB`/
// `ASR` as their own rows) — getting this wrong silently corrupts opcodes,
// so it's kept as one explicit, minimal array per class, matching §5.2's
// text exactly, and cross-checked byte-for-byte against the Appendix in
// bytecode.test.ts.

const ARITH_OPS: readonly BinaryOpcode[] =
    ["ADD", "SUB", "RSUB", "MUL", "AND", "OR", "XOR", "SHL", "SHR", "ASR"]

const CMP_OPS: readonly BinaryOpcode[] =
    ["EQ", "NE", "LT_S", "LE_S", "GT_S", "GE_S", "LT_U", "LE_U", "GT_U", "GE_U"]

const UNARY_OPS: readonly UnaryOpcode[] = ["NEG", "NOT", "CLZ", "REVBITS"]

// ── Encode ───────────────────────────────────────────────────────────────

/** Encode one instruction. Throws on anything not representable in the
 *  current wire format — see this file's header comment for `CALL` and
 *  extension opcodes; every other throw is a genuinely malformed
 *  `RtlInstr` (e.g. a comparison with a combo its addressing table
 *  doesn't have — isa-core.md §4.2 — which nothing in `rules.ts` should
 *  ever produce, but the codec checks anyway rather than silently
 *  emitting a wrong byte). */
export function encodeInstr(instr: RtlInstr, extension?: Extension): number[]
{
    if (instr.op === "EXT")
    {
        if (!extension?.codec)
            throw new Error(`encodeInstr: EXT ${instr.ext} has no registered extension codec (ROADMAP.md item 6)`)
        return extension.codec.encode(instr)
    }

    const arithIdx = ARITH_OPS.indexOf(instr.op as BinaryOpcode)
    if (arithIdx >= 0 && "combo" in instr)
    {
        switch (instr.combo)
        {
            case "REG_ACC": return [arithIdx * 5 + 0, ...encodeLeb128(instr.target)]
            case "REG_REG": return [arithIdx * 5 + 1, ...encodeLeb128(instr.target)]
            case "PEEK_PEEK": return [arithIdx * 5 + 2]
            case "POP_ACC": return [arithIdx * 5 + 3]
            case "IMM_ACC": return [arithIdx * 5 + 4, ...encodeLeb128(instr.imm)]
        }
    }

    const cmpIdx = CMP_OPS.indexOf(instr.op as BinaryOpcode)
    if (cmpIdx >= 0 && "combo" in instr)
    {
        switch (instr.combo)
        {
            case "REG_ACC": return [50 + cmpIdx * 4 + 0, ...encodeLeb128(instr.target)]
            case "POP_ACC": return [50 + cmpIdx * 4 + 1]
            case "IMM_ACC": return instr.imm === 0
                ? [50 + cmpIdx * 4 + 2]
                : [50 + cmpIdx * 4 + 3, ...encodeLeb128(instr.imm)]
            case "REG_REG": case "PEEK_PEEK":
                throw new Error(`encodeInstr: comparison ${instr.op} has no ${instr.combo} combo (isa-core.md §4.2)`)
        }
    }

    const unaryIdx = UNARY_OPS.indexOf(instr.op as UnaryOpcode)
    if (unaryIdx >= 0) return [90 + unaryIdx]

    switch (instr.op)
    {
        case "BLOCK_END": return [94]
        case "LOOP": return [95]
        case "BR_TABLE":
            if (instr.imm === 1) return [96]
            if (instr.imm === 2) return [97]
            return [98, ...encodeLeb128(instr.imm)]
        case "CALL":
            throw new Error(`encodeInstr: CALL has no program-table wire framing yet (ROADMAP.md item 4)`)
        case "RETURN": return [100]
        case "TRAP":
            return instr.imm === 0 ? [101] : [102, ...encodeLeb128(instr.imm)]
        case "PUSH": return [103]
        case "POP": return [104]
        case "LOAD": return [105, ...encodeLeb128(instr.target)]
        case "STORE": return [106, ...encodeLeb128(instr.target)]
        case "CONST":
            return instr.imm >= 0 && instr.imm <= 15
                ? [108 + instr.imm]
                : [107, ...encodeLeb128(instr.imm)]
    }

    throw new Error(`encodeInstr: unhandled instruction ${JSON.stringify(instr)}`)
}

/** Encode a full instruction stream (one procedure's body — no header). */
export function encodeBody(body: readonly RtlInstr[], extension?: Extension): Uint8Array
{
    return Uint8Array.from(body.flatMap(instr => encodeInstr(instr, extension)))
}

// ── Decode ───────────────────────────────────────────────────────────────

/** Decode one instruction starting at `bytes[offset]`. Returns the decoded
 *  instruction and the offset of the byte just past it. */
export function decodeInstr(bytes: Uint8Array, offset: number, extension?: Extension): { instr: RtlInstr; next: number }
{
    if (offset >= bytes.length)
        throw new Error(`decodeInstr: ran off the end of the buffer at offset ${offset}`)
    const code = bytes[offset]!
    let pos = offset + 1

    if (code >= 128)
    {
        if (!extension?.codec)
            throw new Error(`decodeInstr: byte ${code} at offset ${offset} is an extension opcode ` +
                `(isa-core.md §5.1) — no extension mechanism registered (ROADMAP.md item 6)`)
        return extension.codec.decode(bytes, offset)
    }

    if (code <= 49)
    {
        const op = ARITH_OPS[Math.floor(code / 5)]!
        const mode = code % 5
        if (mode === 0) { const r = decodeLeb128(bytes, pos); return { instr: { op, combo: "REG_ACC", target: r.value }, next: r.next } }
        if (mode === 1) { const r = decodeLeb128(bytes, pos); return { instr: { op, combo: "REG_REG", target: r.value }, next: r.next } }
        if (mode === 2) return { instr: { op, combo: "PEEK_PEEK" }, next: pos }
        if (mode === 3) return { instr: { op, combo: "POP_ACC" }, next: pos }
        const r = decodeLeb128(bytes, pos)
        return { instr: { op, combo: "IMM_ACC", imm: r.value }, next: r.next }
    }

    if (code <= 89)
    {
        const rel = code - 50
        const op = CMP_OPS[Math.floor(rel / 4)]!
        const mode = rel % 4
        if (mode === 0) { const r = decodeLeb128(bytes, pos); return { instr: { op, combo: "REG_ACC", target: r.value }, next: r.next } }
        if (mode === 1) return { instr: { op, combo: "POP_ACC" }, next: pos }
        if (mode === 2) return { instr: { op, combo: "IMM_ACC", imm: 0 }, next: pos }
        const r = decodeLeb128(bytes, pos)
        return { instr: { op, combo: "IMM_ACC", imm: r.value }, next: r.next }
    }

    if (code <= 93) return { instr: { op: UNARY_OPS[code - 90]! }, next: pos }

    switch (code)
    {
        case 94: return { instr: { op: "BLOCK_END" }, next: pos }
        case 95: return { instr: { op: "LOOP" }, next: pos }
        case 96: return { instr: { op: "BR_TABLE", imm: 1 }, next: pos }
        case 97: return { instr: { op: "BR_TABLE", imm: 2 }, next: pos }
        case 98: { const r = decodeLeb128(bytes, pos); return { instr: { op: "BR_TABLE", imm: r.value }, next: r.next } }
        case 99:
            throw new Error(`decodeInstr: byte 99 (CALL) has no program-table wire framing yet (ROADMAP.md item 4)`)
        case 100: return { instr: { op: "RETURN" }, next: pos }
        case 101: return { instr: { op: "TRAP", imm: 0 }, next: pos }
        case 102: { const r = decodeLeb128(bytes, pos); return { instr: { op: "TRAP", imm: r.value }, next: r.next } }
        case 103: return { instr: { op: "PUSH" }, next: pos }
        case 104: return { instr: { op: "POP" }, next: pos }
        case 105: { const r = decodeLeb128(bytes, pos); return { instr: { op: "LOAD", target: r.value }, next: r.next } }
        case 106: { const r = decodeLeb128(bytes, pos); return { instr: { op: "STORE", target: r.value }, next: r.next } }
        case 107: { const r = decodeLeb128(bytes, pos); return { instr: { op: "CONST", imm: r.value }, next: r.next } }
    }

    if (code <= 123) return { instr: { op: "CONST", imm: code - 108 }, next: pos }

    throw new Error(`decodeInstr: byte ${code} at offset ${offset} is reserved and unassigned (isa-core.md §5.3)`)
}

/** Decode a full instruction stream from exactly `bytes` — no header, no
 *  length prefix; the caller already knows where the buffer ends (a
 *  length-prefixed container is a program-framing concern, ROADMAP.md
 *  item 1, not this codec's). Throws if a trailing partial instruction
 *  would run past the end of the buffer. */
export function decodeBody(bytes: Uint8Array, extension?: Extension): RtlInstr[]
{
    const instrs: RtlInstr[] = []
    let pos = 0
    while (pos < bytes.length)
    {
        const { instr, next } = decodeInstr(bytes, pos, extension)
        instrs.push(instr)
        pos = next
    }
    return instrs
}
