import {isInlineLiteral, RtlInstr} from "./rtl"

export function instrBytes(instr: RtlInstr): number
{
    if (instr.op === "CALL") return 2
    if (instr.op === "BR_TABLE" || instr.op === "TRAP") return 2
    if (!("combo" in instr)) return 1
    if (instr.combo === "PEEK_ACC" || instr.combo === "PEEK_PEEK"
     || instr.combo === "POP_ACC" || instr.combo === "PEEK_PUSH") return 1
    if (instr.combo === "REG_ACC" || instr.combo === "REG_REG") return 2
    if (instr.combo === "IMM_ACC")
        return isInlineLiteral(instr.op, instr.imm) ? 1 : 2
    return 2
}
