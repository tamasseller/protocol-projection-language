/**
 * @ppl/machine — Bytecode codec (isa-core.md §5, Appendix — Opcode
 * Table)
 *
 * `encodeInstr`/`decodeInstr`/`encodeBody`/`decodeBody` handle one
 * procedure's flat instruction stream, no header, no length prefix — the
 * caller already knows where that buffer ends. `encodeProgram`/
 * `decodeProgram` (isa-core.md §5.5, ROADMAP.md item 8) are the layer
 * above: a whole program's procedure table, each procedure's own
 * `arg_count` immediately followed by its own body, no stored body length
 * — a body is self-delimiting (§8.4: nothing follows a terminator within
 * the same block), so `decodeProgram` derives each one's own end by
 * tracking open `LOOP`/`BR_TABLE` nesting the same way any consumer of the
 * bytecode already has to, stopping at the first terminator back at depth
 * zero (§7.2's bare-terminator loop-body closer means that's frame-*kind*
 * aware, not just a nesting count — see `decodeProcBody` below).
 * Deliberately *not* wire-encoding a procedure's extension header fields
 * (§2.3/§11.4); see §5.5 for why nothing has ever needed that to survive
 * serialization.
 * `encoding.ts` is unrelated: a relative cost estimate for the lowerer's
 * own candidate comparison, not a real serializer.
 *
 * `decodeInstr`/`encodeInstr` byte ≥128 (§5.1, "owned by the active
 * extension") delegates to an `Extension.codec` (extension.ts, ROADMAP.md
 * item 6), passed in as an optional trailing parameter; with none
 * registered, they throw a specific, well-labeled error at exactly that
 * point rather than misinterpreting the byte or failing generically.
 */

import type { RtlInstr, RtlProc, RtlProgram, BinaryOpcode, UnaryOpcode, ExtOpPayload } from "./rtl"
import type { Extension } from "./extension"
import { validateProgram } from "./validate"

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

const UNARY_OPS: readonly UnaryOpcode[] =
    ["NEG", "NOT", "SXTB", "SXTH", "UXTB", "UXTH"]

/** Sub-codes of the `MISC_UNARY` escape (§5.3), in sub-code order. */
const MISC_UNARY_OPS: readonly UnaryOpcode[] = ["REVBITS", "CLZ"]

/** §5.2's last three codes: one escape per instruction class, each taking a
 *  sub-code as its trailing LEB128 operand (§5.3). */
const MISC_CF = 125
const MISC_UNARY = 126
const MISC_BINARY = 127

const MISC_NAMES: Record<number, string> =
    { [MISC_CF]: "MISC_CF", [MISC_UNARY]: "MISC_UNARY", [MISC_BINARY]: "MISC_BINARY" }

/** `CONST #0..#15`'s first code — the small immediate is `code - this`. */
const SMALL_CONST_BASE = 109

// ── Encode ───────────────────────────────────────────────────────────────

/** Encode one instruction. Throws on anything not representable in the
 *  current wire format — extension opcodes with no registered
 *  `Extension.codec` (see this file's header comment); every other throw
 *  is a genuinely malformed `RtlInstr` (e.g. a comparison with a combo its
 *  addressing table doesn't have — isa-core.md §4.2 — which nothing in
 *  `rules.ts` should ever produce, but the codec checks anyway rather than
 *  silently emitting a wrong byte). */
export function encodeInstr<E extends { ext: string } = ExtOpPayload>(instr: RtlInstr<E>, extension?: Extension<E>): number[]
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

    const miscUnaryIdx = MISC_UNARY_OPS.indexOf(instr.op as UnaryOpcode)
    if (miscUnaryIdx >= 0) return [MISC_UNARY, ...encodeLeb128(miscUnaryIdx)]

    switch (instr.op)
    {
        case "BLOCK_END": return [96]
        case "LOOP": return [97]
        case "FALLTHROUGH": return [99]
        case "BR_TABLE":
            // §5.4: the extended operand is biased by 2, so `#1` has only
            // its own code and `#0` has no encoding at all (§4.5).
            if (instr.imm === 1) return [98]
            if (instr.imm < 1) throw new Error(`encodeInstr: BR_TABLE ${instr.imm} is not encodable (isa-core.md §4.5: N >= 1)`)
            return [100, ...encodeLeb128(instr.imm - 2)]
        case "CALL":
            return [101, ...encodeLeb128(instr.calleeIndex)]
        case "RETURN": return [102]
        case "TRAP":
            return instr.imm === 0 ? [103] : [104, ...encodeLeb128(instr.imm)]
        case "PUSH": return [105]
        case "LOAD": return [106, ...encodeLeb128(instr.target)]
        case "STORE": return [107, ...encodeLeb128(instr.target)]
        case "CONST":
            return instr.imm >= 0 && instr.imm <= 15
                ? [SMALL_CONST_BASE + instr.imm]
                : [108, ...encodeLeb128(instr.imm)]
    }

    throw new Error(`encodeInstr: unhandled instruction ${JSON.stringify(instr)}`)
}

/** Encode a full instruction stream (one procedure's body — no header). */
export function encodeBody<E extends { ext: string } = ExtOpPayload>(body: readonly RtlInstr<E>[], extension?: Extension<E>): Uint8Array
{
    return Uint8Array.from(body.flatMap(instr => encodeInstr(instr, extension)))
}

// ── Decode ───────────────────────────────────────────────────────────────

/** Decode one instruction starting at `bytes[offset]`. Returns the decoded
 *  instruction and the offset of the byte just past it. */
export function decodeInstr<E extends { ext: string } = ExtOpPayload>(bytes: Uint8Array, offset: number, extension?: Extension<E>): { instr: RtlInstr<E>; next: number }
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

    if (code <= 95) return { instr: { op: UNARY_OPS[code - 90]! }, next: pos }

    switch (code)
    {
        case 96: return { instr: { op: "BLOCK_END" }, next: pos }
        case 97: return { instr: { op: "LOOP" }, next: pos }
        case 98: return { instr: { op: "BR_TABLE", imm: 1 }, next: pos }
        case 99: return { instr: { op: "FALLTHROUGH" }, next: pos }
        case 100: { const r = decodeLeb128(bytes, pos); return { instr: { op: "BR_TABLE", imm: r.value + 2 }, next: r.next } }
        case 101: { const r = decodeLeb128(bytes, pos); return { instr: { op: "CALL", calleeIndex: r.value }, next: r.next } }
        case 102: return { instr: { op: "RETURN" }, next: pos }
        case 103: return { instr: { op: "TRAP", imm: 0 }, next: pos }
        case 104: { const r = decodeLeb128(bytes, pos); return { instr: { op: "TRAP", imm: r.value }, next: r.next } }
        case 105: return { instr: { op: "PUSH" }, next: pos }
        case 106: { const r = decodeLeb128(bytes, pos); return { instr: { op: "LOAD", target: r.value }, next: r.next } }
        case 107: { const r = decodeLeb128(bytes, pos); return { instr: { op: "STORE", target: r.value }, next: r.next } }
        case 108: { const r = decodeLeb128(bytes, pos); return { instr: { op: "CONST", imm: r.value }, next: r.next } }
    }

    if (code < MISC_CF) return { instr: { op: "CONST", imm: code - SMALL_CONST_BASE }, next: pos }

    return decodeMisc(code, decodeLeb128(bytes, pos), offset)
}

/**
 * The three §5.3 escapes. A sub-code's operand shape is defined only when
 * that sub-code is assigned, so an unassigned one has no known length —
 * hence every one of them is *rejected* here rather than skipped over.
 */
function decodeMisc<E extends { ext: string } = ExtOpPayload>(code: number, sub: { value: number; next: number }, offset: number): { instr: RtlInstr<E>; next: number }
{
    if (code === MISC_UNARY)
    {
        const op = MISC_UNARY_OPS[sub.value]
        if (op) return { instr: { op }, next: sub.next }
    }

    throw new Error(`decodeInstr: ${MISC_NAMES[code]!} at offset ${offset}: ` +
        `sub-code ${sub.value} is reserved (isa-core.md §5.3)`)
}

/** Decode a full instruction stream from exactly `bytes` — no header, no
 *  length prefix; the caller already knows where the buffer ends (one
 *  procedure's own byte range, sliced out by `decodeProgram` below, per
 *  §5.5). Throws if a trailing partial instruction would run past the end
 *  of the buffer. */
export function decodeBody<E extends { ext: string } = ExtOpPayload>(bytes: Uint8Array, extension?: Extension<E>): RtlInstr<E>[]
{
    const instrs: RtlInstr<E>[] = []
    let pos = 0
    while (pos < bytes.length)
    {
        const { instr, next } = decodeInstr(bytes, pos, extension)
        instrs.push(instr)
        pos = next
    }
    return instrs
}

// ── Program framing (isa-core.md §5.5) ─────────────────────────────────────

/** Encode a whole program: procedure count, then each procedure's own
 *  `arg_count` immediately followed by its own body — no header table, no
 *  stored body length (§5.5: a body is self-delimiting). Deliberately
 *  drops each `RtlProc.header` — see this file's header comment and §5.5
 *  for why extension header fields never need to cross the wire (nothing
 *  has ever needed them to survive serialization). */
export function encodeProgram<E extends { ext: string } = ExtOpPayload>(program: RtlProgram<E>, extension?: Extension<E>): Uint8Array
{
    return Uint8Array.from([
        ...encodeLeb128(program.procedures.length),
        ...program.procedures.flatMap(proc =>
            [...encodeLeb128(proc.argCount), ...encodeBody(proc.body, extension)]),
    ])
}

/** One frame of `decodeProcBody`'s own open-block tracking. Both openers
 *  are a count of closers still to come: `N + 1` for a `BR_TABLE`'s cases
 *  plus its default case (§4.5), two for a `LOOP`'s condition and body
 *  sub-blocks. `dispatch` is not needed to *count* — the two close
 *  identically — only to say what §8.5 lets close them. */
type ScanFrame = { remaining: number; dispatch: boolean }

/** Decode one procedure body starting at `offset`, stopping at the first
 *  terminator reached with *no* open block at all (§8.4 guarantees nothing
 *  wire-level follows it that still belongs to this procedure) — no
 *  separate length to bound the walk, unlike `decodeBody` above. §7.2 lets
 *  a `LOOP`'s own body block close via a bare `RETURN`/`TRAP` instead of
 *  `BLOCK_END`: that terminator closes its frame's last sub-block, same as
 *  a real closer would, but doesn't by itself end the body — the outer
 *  scope's own bytes (its cond-false exit path, say) may still follow. Only
 *  a terminator seen with the stack *already* empty — nothing open, nothing
 *  to close — is the real end. */
function decodeProcBody<E extends { ext: string } = ExtOpPayload>(bytes: Uint8Array, offset: number, extension?: Extension<E>): { body: RtlInstr<E>[]; next: number }
{
    const body: RtlInstr<E>[] = []
    const stack: ScanFrame[] = []
    let pos = offset

    for (;;)
    {
        const { instr, next } = decodeInstr(bytes, pos, extension)
        body.push(instr)
        pos = next

        if (instr.op === "BR_TABLE") { stack.push({ remaining: instr.imm + 1, dispatch: true }); continue }
        if (instr.op === "LOOP") { stack.push({ remaining: 2, dispatch: false }); continue }

        if (instr.op === "BLOCK_END" || instr.op === "FALLTHROUGH")
        {
            const top = stack[stack.length - 1]
            if (!top) throw new Error(`decodeProcBody: ${instr.op} with no open block at offset ${pos}`)
            if (!top.dispatch && instr.op === "FALLTHROUGH")
                throw new Error(`decodeProcBody: FALLTHROUGH closing a LOOP sub-block at offset ${pos}`)
            top.remaining -= 1
            if (top.remaining === 0) stack.pop()
            continue
        }

        if (instr.op === "RETURN" || instr.op === "TRAP")
        {
            // Empty stack *before* considering this terminator at all is
            // the real end — no open block means nothing was waiting on
            // it as a closer. A frame popping down to empty right here
            // (a loop's body, or a BR_TABLE's own last case) is a
            // different thing: it closes *that* construct, not
            // necessarily the procedure — the enclosing scope's own bytes
            // (a loop's cond-false exit path, a BR_TABLE's own shared-end
            // tail after its last case) may still follow, exactly as they
            // would after an ordinary BLOCK_END close. A LOOP/BR_TABLE
            // with nothing at all following it is validator-rejected
            // (§8.4: falling off the end is invalid) regardless of how its
            // last sub-block closes, so this function never has to tell
            // "really done" apart from "just closed one level" by itself —
            // the *next* terminator reached with the stack genuinely empty
            // always settles it.
            if (stack.length === 0) return { body, next: pos }
            const top = stack[stack.length - 1]!

            // §8.5: a terminator closes a dispatch case exactly as a
            // BLOCK_END would, counting against the same N + 1 closers, and
            // it closes a LOOP's *body* sub-block — but never a LOOP's
            // condition, which requires BLOCK_END. Leaving that frame open
            // is what surfaces such input as a later decode error instead
            // of silently accepting it here; counting it instead would let
            // a malformed body run into the next procedure's bytes.
            if (!top.dispatch && top.remaining === 2) continue

            top.remaining -= 1
            if (top.remaining === 0) stack.pop()
        }
    }
}

/** Decode a whole program starting at `offset` (§5.5) — no header table to
 *  read up front; each procedure's body is walked, self-delimited
 *  (`decodeProcBody`), immediately after its own `arg_count`. Decoded
 *  procedures always come back with `header: undefined` — nothing
 *  wire-level to restore it from (§5.5).
 *
 *  Returns `next` (the offset immediately past the last body byte), not
 *  just the program — a container holding more than one encoded program
 *  back-to-back (docs/codec-image.md §7) has no other way to know where
 *  this one ends and the next begins, since nothing here is
 *  self-delimiting from the *outside*. */
export function decodeProgram<E extends { ext: string } = ExtOpPayload>(bytes: Uint8Array, offset: number = 0, extension?: Extension<E>): { program: RtlProgram<E>; next: number }
{
    const countR = decodeLeb128(bytes, offset)
    const count = countR.value
    let pos = countR.next

    const procedures: RtlProc<E>[] = []
    for (let i = 0; i < count; i++)
    {
        const argCountR = decodeLeb128(bytes, pos)
        const { body, next } = decodeProcBody(bytes, argCountR.next, extension)
        procedures.push({ argCount: argCountR.value, body })
        pos = next
    }

    return { program: { procedures }, next: pos }
}
