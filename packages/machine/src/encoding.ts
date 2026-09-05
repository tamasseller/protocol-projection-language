import {COMPARISON_OPS, RtlInstr} from "./rtl"
import type {ExtOpPayload} from "./rtl"

/** Bytes an unsigned LEB128 encoding of a u32 value would need — 7 payload
 *  bits per byte, up to 5 bytes for the full 32-bit range. */
function leb128Bytes(n: number): number
{
    if (n < 0x80) return 1
    if (n < 0x4000) return 2
    if (n < 0x200000) return 3
    if (n < 0x10000000) return 4
    return 5
}

/**
 * Relative byte-cost estimate used by the lowerer's cost model
 * (orchestrator.ts's `pickCheapest`) to compare candidate tilings — not a
 * real serializer (isa-core.md §5 has no implementation here yet). Costs
 * follow the encoding described there: register operands and register-mode
 * combos cost 2 bytes (opcode + index); peek/pop combos cost 1 (no trailing
 * operand); arithmetic's immediate combo is always the extended form
 * (isa-core.md §4.1 — no per-op inline literal); comparison's immediate
 * combo gets a 1-byte form only for `#0` (§4.2); `CONST` gets a 1-byte form
 * for `0..15` (§4.4).
 */
export function instrBytes<E extends { ext: string } = ExtOpPayload>(instr: RtlInstr<E>): number
{
    if (instr.op === "CALL") return 2
    if (instr.op === "TRAP") return 2
    // §5.4: `#1` has its own code, everything else the extended form biased by 2.
    if (instr.op === "BR_TABLE") return instr.imm === 1 ? 1 : 1 + leb128Bytes(instr.imm - 2)
    if (instr.op === "LOAD" || instr.op === "STORE") return 2
    if (instr.op === "PUSH") return 1
    // §5.3's escapes: opcode byte plus a sub-code.
    if (instr.op === "CLZ" || instr.op === "REVBITS") return 2
    if (instr.op === "FALLTHROUGH" || instr.op === "DEFAULT") return 2
    // §5.4: `#1..#4` have their own sub-codes, the rest is biased by 5.
    if (instr.op === "DROP") return instr.imm <= 4 ? 2 : 2 + leb128Bytes(instr.imm - 5)
    if (instr.op === "CONST")
        return instr.imm >= 0 && instr.imm <= 15 ? 1 : 1 + leb128Bytes(instr.imm)
    if (!("combo" in instr)) return 1
    switch (instr.combo)
    {
        case "REG_ACC": case "REG_REG": return 2
        case "PEEK_PEEK": case "POP_ACC": return 1
        case "IMM_ACC": {
            const smallEligible = COMPARISON_OPS.has(instr.op) && instr.imm === 0
            return smallEligible ? 1 : 1 + leb128Bytes(instr.imm)
        }
    }
}
