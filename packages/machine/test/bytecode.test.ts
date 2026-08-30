/**
 * @ppl/machine/test — Bytecode codec
 *
 * Two kinds of coverage:
 *  1. A literal, 128-entry table mirroring isa-core.md's Appendix — Opcode
 *     Table row for row (one canonical instruction per byte value, using a
 *     representative operand value for whichever field is LEB128-encoded)
 *     — this is what actually catches a transcription slip between the
 *     doc and `bytecode.ts`'s formulas, not just "some round trip works."
 *  2. Round-trip + edge-case tests for LEB128 and the three small/extended
 *     dual-opcode schemes (CONST, comparison immediate, BR_TABLE case
 *     count, TRAP code) at their exact boundaries.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import {
    encodeInstr, decodeInstr, encodeBody, decodeBody,
    encodeProgram, decodeProgram, encodeLeb128, decodeLeb128,
} from "../src/bytecode"
import {
    opReg, opRegWriteback, opStack, opImm, bare, brTable, trap, call,
    LOAD, STORE, PUSH, POP, CONST,
} from "../src/rtl"
import type { RtlInstr, RtlProgram, BinaryOpcode } from "../src/rtl"
import { validateProgram } from "../src/validate"
import { run } from "../src/vm"

// ─── The 128-row opcode table (isa-core.md, Appendix — Opcode Table) ──────

const ARITH: readonly BinaryOpcode[] = ["ADD", "SUB", "RSUB", "MUL", "AND", "OR", "XOR", "SHL", "SHR", "ASR"]
const CMP: readonly BinaryOpcode[] = ["EQ", "NE", "LT_S", "LE_S", "GT_S", "GE_S", "LT_U", "LE_U", "GT_U", "GE_U"]
const REG = 5 // representative register index (>127 tested separately for LEB128 multi-byte)
const EXT_IMM = 1000 // representative immediate outside every small-form range

interface Row { byte: number; instr: RtlInstr }

const rows: Row[] = []
for (const [i, op] of ARITH.entries())
{
    rows.push({ byte: i * 5 + 0, instr: opReg(op, REG) })
    rows.push({ byte: i * 5 + 1, instr: opRegWriteback(op, REG) })
    rows.push({ byte: i * 5 + 2, instr: opStack(op, "PEEK_PEEK") })
    rows.push({ byte: i * 5 + 3, instr: opStack(op, "POP_ACC") })
    rows.push({ byte: i * 5 + 4, instr: opImm(op, EXT_IMM) })
}
for (const [i, op] of CMP.entries())
{
    rows.push({ byte: 50 + i * 4 + 0, instr: opReg(op, REG) })
    rows.push({ byte: 50 + i * 4 + 1, instr: opStack(op, "POP_ACC") })
    rows.push({ byte: 50 + i * 4 + 2, instr: opImm(op, 0) })
    rows.push({ byte: 50 + i * 4 + 3, instr: opImm(op, EXT_IMM) })
}
for (const [i, op] of (["NEG", "NOT", "CLZ", "REVBITS"] as const).entries())
    rows.push({ byte: 90 + i, instr: bare(op) })
rows.push({ byte: 94, instr: bare("BLOCK_END") })
rows.push({ byte: 95, instr: bare("LOOP") })
rows.push({ byte: 96, instr: brTable(1) })
rows.push({ byte: 97, instr: brTable(2) })
rows.push({ byte: 98, instr: brTable(3) })
rows.push({ byte: 99, instr: call(REG) })
rows.push({ byte: 100, instr: bare("RETURN") })
rows.push({ byte: 101, instr: trap(0) })
rows.push({ byte: 102, instr: trap(5) })
rows.push({ byte: 103, instr: PUSH() })
rows.push({ byte: 104, instr: POP() })
rows.push({ byte: 105, instr: LOAD(REG) })
rows.push({ byte: 106, instr: STORE(REG) })
rows.push({ byte: 107, instr: CONST(EXT_IMM) })
for (let k = 0; k <= 15; k++)
    rows.push({ byte: 108 + k, instr: CONST(k) })

describe("Bytecode codec — 128-row opcode table (isa-core.md Appendix)", () =>
{
    test("every row's first encoded byte matches its assigned opcode", () =>
    {
        for (const { byte, instr } of rows)
        {
            const encoded = encodeInstr(instr)
            assert.equal(encoded[0], byte,
                `${JSON.stringify(instr)}: expected first byte ${byte}, got ${encoded[0]}`)
        }
    })

    test("every row round-trips through decode", () =>
    {
        for (const { byte, instr } of rows)
        {
            const encoded = encodeInstr(instr)
            const { instr: decoded, next } = decodeInstr(Uint8Array.from(encoded), 0)
            assert.deepEqual(decoded, instr, `byte ${byte}: decode(encode(x)) !== x`)
            assert.equal(next, encoded.length, `byte ${byte}: decode didn't consume the whole instruction`)
        }
    })

    test("all 128 byte values are accounted for (124 assigned + 4 reserved)", () =>
    {
        const assigned = new Set(rows.map(r => r.byte))
        for (let b = 0; b < 128; b++)
        {
            if (b >= 124) continue // reserved, checked separately
            assert.ok(assigned.has(b), `byte ${b} has no row — a gap in the table`)
        }
        assert.equal(assigned.size, 124)
    })

    test("reserved bytes 124-127 are rejected on decode", () =>
    {
        for (let b = 124; b <= 127; b++)
            assert.throws(() => decodeInstr(Uint8Array.of(b), 0), /reserved/)
    })

    test("extension bytes (>=128) are rejected on decode", () =>
    {
        assert.throws(() => decodeInstr(Uint8Array.of(128), 0), /extension opcode/)
        assert.throws(() => decodeInstr(Uint8Array.of(255), 0), /extension opcode/)
    })

    test("a comparison with a combo its addressing table doesn't have is rejected", () =>
    {
        // isa-core.md §4.2: comparisons have no REG_REG (write-back) and no
        // PEEK_PEEK (peek) combo — rules.ts's stackOperandRules/regOperandRules
        // already gate these out, but the codec checks independently.
        assert.throws(() => encodeInstr(opRegWriteback("EQ", REG)))
        assert.throws(() => encodeInstr(opStack("EQ", "PEEK_PEEK")))
    })
})

describe("Bytecode codec — small/extended boundary cases", () =>
{
    test("CONST: #15 stays small, #16 switches to extended", () =>
    {
        assert.deepEqual(encodeInstr(CONST(15)), [108 + 15])
        assert.deepEqual(encodeInstr(CONST(16)), [107, 16])
    })

    test("comparison immediate: #0 stays small, #1 switches to extended", () =>
    {
        assert.deepEqual(encodeInstr(opImm("EQ", 0)), [52])
        assert.deepEqual(encodeInstr(opImm("EQ", 1)), [53, 1])
    })

    test("arithmetic immediate has no small form even at #0", () =>
    {
        // isa-core.md §4.1: arithmetic's immediate combo is extended-only —
        // unlike comparison, there is no dedicated zero opcode.
        assert.deepEqual(encodeInstr(opImm("ADD", 0)), [4, 0])
    })

    test("BR_TABLE: N=1 and N=2 stay dedicated, N=0 and N=3 switch to extended", () =>
    {
        assert.deepEqual(encodeInstr(brTable(1)), [96])
        assert.deepEqual(encodeInstr(brTable(2)), [97])
        assert.deepEqual(encodeInstr(brTable(0)), [98, 0])
        assert.deepEqual(encodeInstr(brTable(3)), [98, 3])
    })

    test("TRAP: code=0 stays dedicated, any other code switches to extended", () =>
    {
        assert.deepEqual(encodeInstr(trap(0)), [101])
        assert.deepEqual(encodeInstr(trap(1)), [102, 1])
    })
})

describe("LEB128", () =>
{
    test("round-trips across every byte-count boundary", () =>
    {
        const values = [0, 1, 15, 127, 128, 16383, 16384, 2097151, 2097152, 268435455, 268435456, 0xFFFFFFFF]
        for (const v of values)
        {
            const encoded = Uint8Array.from(encodeLeb128(v))
            const { value, next } = decodeLeb128(encoded, 0)
            assert.equal(value, v, `LEB128 round-trip failed for ${v}`)
            assert.equal(next, encoded.length)
        }
    })

    test("byte count matches the documented 1-5 byte range", () =>
    {
        assert.equal(encodeLeb128(0).length, 1)
        assert.equal(encodeLeb128(127).length, 1)
        assert.equal(encodeLeb128(128).length, 2)
        assert.equal(encodeLeb128(0xFFFFFFFF).length, 5)
    })

    test("rejects negative numbers and non-integers", () =>
    {
        assert.throws(() => encodeLeb128(-1))
        assert.throws(() => encodeLeb128(1.5))
        assert.throws(() => encodeLeb128(0x100000000))
    })
})

describe("Bytecode codec — full-body round trip", () =>
{
    test("a small procedure body round-trips exactly", () =>
    {
        // u32 n = 5; while (n != 1) { n = n >> 1; } return n; — a plausible
        // shape (LOOP, comparison, shift, arithmetic write-back, RETURN),
        // not a real lowered procedure (no register allocation performed
        // here, just instruction variety).
        const body: RtlInstr[] = [
            CONST(5), STORE(0),
            bare("LOOP"),
            LOAD(0), opImm("NE", 1),
            bare("BLOCK_END"),
            LOAD(0), opImm("SHR", 1), STORE(0),
            bare("BLOCK_END"),
            LOAD(0), bare("RETURN"),
        ]
        const bytes = encodeBody(body)
        assert.deepEqual(decodeBody(bytes), body)
    })

    test("a trailing partial instruction throws rather than silently truncating", () =>
    {
        const bytes = encodeBody([opImm("ADD", EXT_IMM)]) // [4, ...leb128(1000)]
        assert.throws(() => decodeBody(bytes.slice(0, bytes.length - 1)))
    })
})

describe("Bytecode codec — program framing (isa-core.md §5.5)", () =>
{
    // proc 0 (entry): CONST 5; CALL 1; RETURN — calls proc 1 with 5 in acc.
    // proc 1 (argCount 1): LOAD 0; ADD #10; RETURN — returns arg0 + 10.
    function twoProcProgram(): RtlProgram
    {
        return {
            procedures: [
                { argCount: 0, body: [CONST(5), call(1), bare("RETURN")] },
                { argCount: 1, body: [LOAD(0), opImm("ADD", 10), bare("RETURN")] },
            ],
        }
    }

    test("round-trips a multi-procedure program exactly", () =>
    {
        const program = twoProcProgram()
        const bytes = encodeProgram(program)
        const decoded = decodeProgram(bytes)
        assert.deepEqual(decoded.program, program)
        assert.equal(decoded.next, bytes.length)
    })

    test("the round-tripped program still validates and runs correctly", () =>
    {
        const { program: decoded } = decodeProgram(encodeProgram(twoProcProgram()))
        validateProgram(decoded)
        const result = run(decoded)
        assert.equal(result.ok, true)
        assert.equal(result.acc, 15) // 5 + 10, via a real CALL across the wire
    })

    test("a procedure's own header never survives the round trip", () =>
    {
        // §5.5: extension header fields are deliberately not wire-encoded —
        // only `arg_count` is. A caller-supplied header (as any extension,
        // e.g. the codec extension, would set) comes back `undefined`.
        const program: RtlProgram = {
            procedures: [{ argCount: 0, body: [bare("RETURN")], header: { some: "extension data" } }],
        }
        const { program: decoded } = decodeProgram(encodeProgram(program))
        assert.equal(decoded.procedures[0]!.header, undefined)
    })

    test("an empty program round-trips to zero procedures", () =>
    {
        const { program: decoded } = decodeProgram(encodeProgram({ procedures: [] }))
        assert.deepEqual(decoded, { procedures: [] })
    })

    test("decodeProgram reports where it stopped, for a container holding more than one program back-to-back", () =>
    {
        const a = encodeProgram(twoProcProgram())
        const b = encodeProgram({ procedures: [{ argCount: 0, body: [bare("RETURN")] }] })
        const combined = Uint8Array.from([...a, ...b])

        const first = decodeProgram(combined)
        assert.deepEqual(first.program, twoProcProgram())
        assert.equal(first.next, a.length)

        const second = decodeProgram(combined, first.next)
        assert.deepEqual(second.program, { procedures: [{ argCount: 0, body: [bare("RETURN")] }] })
        assert.equal(second.next, combined.length)
    })

    test("no header table — each procedure's own arg_count sits directly before its own body", () =>
    {
        // §5.5: no stored body length, no separate header block — decode
        // finds each body's own end by walking it (`decodeProcBody`), so
        // the wire bytes interleave arg_count with that same procedure's
        // body instead of grouping every arg_count up front.
        const program: RtlProgram = {
            procedures: [
                { argCount: 0, body: [bare("RETURN")] },                    // 1 byte body
                { argCount: 0, body: [CONST(1), bare("RETURN")] },          // 2 byte body
            ],
        }
        const bytes = encodeProgram(program)
        // count(2), argCount_0(0), body_0's RETURN(100), argCount_1(0),
        // body_1's CONST(108+1)/RETURN(100) — no bodyLength byte anywhere.
        assert.deepEqual([...bytes], [2, 0, 100, 0, 108 + 1, 100])
    })

    test("a LOOP body block closed by a bare terminator (isa-core.md §7.2) still self-delimits correctly", () =>
    {
        // The one shape decodeProcBody's frame-*kind* tracking exists for:
        // a terminator that closes an inner loop must not be mistaken for
        // the end of the whole procedure when an outer scope's own bytes
        // still follow it.
        const program: RtlProgram = {
            procedures: [
                {
                    argCount: 0,
                    body: [
                        CONST(1), bare("LOOP"), bare("BLOCK_END"),
                        CONST(42), bare("RETURN"), // bare terminator closes the loop body — not the procedure
                        CONST(0), bare("RETURN"),  // the outer scope's own tail, reached via the cond-false exit
                    ],
                },
                { argCount: 0, body: [bare("RETURN")] }, // proves decode didn't run past proc 0 into this one
            ],
        }
        const bytes = encodeProgram(program)
        const decoded = decodeProgram(bytes)
        assert.deepEqual(decoded.program, program)
        assert.equal(decoded.next, bytes.length)
    })

    test("a BR_TABLE case closed by a bare terminator (isa-core.md §8.5) still counts against N and self-delimits correctly", () =>
    {
        // Mirrors compiler/src/blocks.cpp's resolveCaseClose: a bare
        // RETURN/TRAP closes a case exactly like a BLOCK_END would, so a
        // non-last case using one still lets decode find the *next*
        // sibling case, and ultimately the procedure's own real end.
        const program: RtlProgram = {
            procedures: [
                {
                    argCount: 0,
                    body: [
                        CONST(0), brTable(2),
                        CONST(111), bare("RETURN"),    // case[0]: bare-terminator close — not the whole construct
                        CONST(222), bare("BLOCK_END"), // case[1]: ordinary close — the construct's own real end
                        CONST(333), bare("RETURN"),    // the procedure's own real end
                    ],
                },
                { argCount: 0, body: [bare("RETURN")] }, // proves decode didn't run past proc 0 into this one
            ],
        }
        const bytes = encodeProgram(program)
        const decoded = decodeProgram(bytes)
        assert.deepEqual(decoded.program, program)
        assert.equal(decoded.next, bytes.length)
    })
})
