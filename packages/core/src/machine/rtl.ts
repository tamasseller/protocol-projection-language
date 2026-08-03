/**
 * @ppl/core/machine — RTL instruction representation
 *
 * Single source of truth for the lowered IR's instruction type. Consolidates
 * the former `RtlInstr` (east.ts), `ComboName`/`OutputLocation`/`Resource`
 * (east.ts), and `ComboMeta`/`COMBO` (combo-meta.ts) into one cohesive module
 * with a discriminated-union instruction type.
 *
 * The combo split is baked into the union: register-combo, immediate-combo,
 * and stack-combo ops are distinct variants, so TS narrows `target`/`imm`
 * availability by construction.
 *
 * Naming and semantics match isa-core.md §6.3 (combos), §8–§10 (opcodes).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Combo taxonomy
// ─────────────────────────────────────────────────────────────────────────────

export type OutputLocation = "acc" | "tos" | {"reg": number}

export type Resource = "acc" | "tos"

/** Register addressing combos — carry a `target` register name. */
export type RegCombo = "REG_ACC" | "REG_REG"
/** Immediate combo — carries an `imm` literal. */
export type ImmCombo = "IMM_ACC"
/** Stack-operand combos — no extra field. */
export type StackCombo = "PEEK_ACC" | "PEEK_PEEK" | "POP_ACC" | "PEEK_PUSH"

/** All seven valid combos per isa-core.md §6.3. */
export type ComboName = RegCombo | ImmCombo | StackCombo

export interface ComboMeta
{
    /** Resources the op disturbs beyond its declared output. */
    readonly clobbers: readonly Resource[]
    /** Net TOS depth change contributed by the op itself (excluding children). */
    readonly tosDelta: number
}

export const COMBO: Record<ComboName, ComboMeta> = {
    REG_ACC:   { clobbers: ["acc"],        tosDelta:  0},
    REG_REG:   { clobbers: ["acc"],        tosDelta:  0},
    PEEK_ACC:  { clobbers: ["acc"],        tosDelta:  0},
    PEEK_PEEK: { clobbers: ["acc", "tos"], tosDelta:  0},
    POP_ACC:   { clobbers: ["acc"],        tosDelta: -1},
    PEEK_PUSH: { clobbers: ["acc", "tos"], tosDelta:  1},
    IMM_ACC:   { clobbers: ["acc"],        tosDelta:  0},
}

// ─────────────────────────────────────────────────────────────────────────────
// Opcode unions
// ─────────────────────────────────────────────────────────────────────────────

/** Binary-form opcodes — all take a combo (ALU + comparison + identity MOVE). */
export type BinaryOpcode =
    // ALU (§8.1)
    | "ADD" | "SUB" | "RSUB" | "MUL"
    | "AND" | "OR" | "XOR"
    | "SHL" | "SHR" | "ASR"
    | "MOVE"
    // Comparison (§9.1)
    | "EQ" | "NE"
    | "LT_S" | "LE_S" | "GT_S" | "GE_S"
    | "LT_U" | "LE_U" | "GT_U" | "GE_U"

/** Unary ALU opcodes — operate on acc in place, no combo (§10.1). */
export type UnaryOpcode = "NEG" | "NOT" | "CLZ" | "REVBITS"

/** No-operand control flow opcodes (§11). */
export type ControlOpcode =
    | "RETURN"
    | "BLOCK_END"
    | "LOOP"

// ─────────────────────────────────────────────────────────────────────────────
// RtlInstr — discriminated union
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Four instruction shapes, distinguished by `op` range and field presence.
 * The combo split makes `target`/`imm` *required when applicable* rather than
 * optional — TS enforces the combo→field correlation by construction.
 *
 * Consumer narrowing recipe:
 *   1. `"callee" in instr`            → CALL
 *   2. `instr.op === "BR_TABLE"/"TRAP"` → parametric
 *   3. `!("combo" in instr)`           → bare unary/control
 *   4. else `"target" in instr`        → register-combo binary
 *   5. else `"imm" in instr`           → immediate-combo binary
 *   6. else                             → stack-combo binary
 */
export type RtlInstr =
    // 1a. Register-combo binary: ALU/CMP/MOVE reading a register operand.
    //     target is REQUIRED (it names the operand register).
    | { op: BinaryOpcode; combo: RegCombo; target: number }
    // 1b. Immediate-combo binary: ALU/CMP/MOVE with an inline literal.
    //     imm is REQUIRED.
    | { op: BinaryOpcode; combo: "IMM_ACC"; imm: number }
    // 1c. Stack-combo binary: ALU/CMP/MOVE on TOS (peek/pop/push).
    | { op: BinaryOpcode; combo: StackCombo }
    // 2. Bare: unary ALU (acc in place) + no-operand control flow.
    | { op: UnaryOpcode | ControlOpcode }
    // 3. Parametric: single numeric parameter (BR_TABLE case count, TRAP code).
    | { op: "BR_TABLE" | "TRAP"; imm: number }
    // 4. Call: procedure invocation by name.
    | { op: "CALL"; callee: string }


export const isCallInstr = (i: RtlInstr): i is Extract<RtlInstr, { op: "CALL" }> =>
    i.op === "CALL"

export const isParametricInstr = (i: RtlInstr): i is Extract<RtlInstr, { op: "BR_TABLE" | "TRAP" }> =>
    i.op === "BR_TABLE" || i.op === "TRAP"

export const isRegComboInstr = (i: RtlInstr): i is Extract<RtlInstr, { combo: RegCombo }> =>
    "combo" in i && (i.combo === "REG_ACC" || i.combo === "REG_REG")

export const isImmComboInstr = (i: RtlInstr): i is Extract<RtlInstr, { combo: "IMM_ACC" }> =>
    "combo" in i && i.combo === "IMM_ACC"

export const isStackComboInstr = (i: RtlInstr): i is Extract<RtlInstr, { combo: StackCombo }> =>
    "combo" in i && (i.combo === "PEEK_ACC" || i.combo === "PEEK_PEEK"
                  || i.combo === "POP_ACC" || i.combo === "PEEK_PUSH")

/** `acc ← rN` — load register into accumulator. (MOVE + REG_ACC) */
export const LOAD = (target: number): RtlInstr =>
    ({ op: "MOVE", combo: "REG_ACC", target })

/** `rN ← acc` — store accumulator to register. (MOVE + REG_REG) */
export const STORE = (target: number): RtlInstr =>
    ({ op: "MOVE", combo: "REG_REG", target })

/** `[tos++] ← acc` — push accumulator onto stack. (MOVE + PEEK_PUSH, ≡ DUP) */
export const PUSH = (): RtlInstr =>
    ({ op: "MOVE", combo: "PEEK_PUSH" })

/** `acc ← #imm` — load constant into accumulator. (MOVE + IMM_ACC) */
export const CONST = (imm: number): RtlInstr =>
    ({ op: "MOVE", combo: "IMM_ACC", imm })

/** `acc = acc ⟨op⟩ rN` — binary op with register operand, result → acc. */
export const opReg = (op: BinaryOpcode, target: number): RtlInstr =>
    ({ op, combo: "REG_ACC", target })

/** `acc = acc ⟨op⟩ #imm` — binary op with immediate operand, result → acc. */
export const opImm = (op: BinaryOpcode, imm: number): RtlInstr =>
    ({ op, combo: "IMM_ACC", imm })

/** Stack-combo binary op (peek/pop/push variants). */
export const opStack = (op: BinaryOpcode, combo: StackCombo): RtlInstr =>
    ({ op, combo })

/** Bare unary ALU (`NEG`, `NOT`, `CLZ`, `REVBITS`) or no-operand control flow
 *  (`RETURN`, `BLOCK_END`, `BREAK`, `CONTINUE`, `LOOP`). */
export const bare = (op: UnaryOpcode | ControlOpcode): RtlInstr =>
    ({ op })

/** `BR_TABLE #n` — open dispatch block with n cases. */
export const brTable = (n: number): RtlInstr =>
    ({ op: "BR_TABLE", imm: n })

/** `TRAP #code` — abnormal exit with error code. */
export const trap = (code: number): RtlInstr =>
    ({ op: "TRAP", imm: code })

/** `CALL callee` — procedure invocation by name. */
export const call = (callee: string): RtlInstr =>
    ({ op: "CALL", callee })


export interface RtlProc
{
    argCount: number
    body: RtlInstr[]
}

export interface RtlProgram
{
    procedures: RtlProc[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Human-readable disassembly — `format(instr)`
//
// Produces the assembly-style notation used in isa-core.md Appendix A:
//
//   LOAD r0            MOVE + REG_ACC
//   STORE r0           MOVE + REG_REG
//   PUSH               MOVE + PEEK_PUSH
//   MOVE #5            MOVE + IMM_ACC (also: CONST(5))
//   ADD r0             <op> + REG_ACC
//   ADD r0 → r0        <op> + REG_REG (write-back)
//   ADD #5             <op> + IMM_ACC
//   ADD [--tos]        <op> + POP_ACC
//   ADD [tos-1]        <op> + PEEK_ACC
//   ADD [tos-1] → [tos-1]  <op> + PEEK_PEEK
//   ADD [tos-1] → [tos++]  <op> + PEEK_PUSH (RPN)
//   NEG / NOT / CLZ / REVBITS   bare unary
//   RETURN / BLOCK_END / ...    bare control
//   BR_TABLE 3                  parametric
//   TRAP 0                      parametric
//   CALL foo                    call
//
// MOVE is special-cased to the LOAD/STORE/PUSH/CONST mnemonics for the
// common data-movement idioms; other MOVE combos render literally.
// ─────────────────────────────────────────────────────────────────────────────

const STACK_OPERAND: Record<StackCombo, string> = {
    PEEK_ACC:  "[tos-1]",
    PEEK_PEEK: "[tos-1]",
    POP_ACC:   "[--tos]",
    PEEK_PUSH: "[tos-1]",
}

const STACK_RESULT: Partial<Record<StackCombo, string>> = {
    PEEK_PEEK: "[tos-1]",
    PEEK_PUSH: "[tos++]",
}

const PER_OP_INLINE: Partial<Record<BinaryOpcode, number>> = {
    ADD: 1, SUB: 1, SHL: 1, SHR: 1,
    MOVE: 0,
    AND: 0xFF, OR: 0x80, XOR: 0xFF,
}

export const isInlineLiteral = (op: BinaryOpcode, imm: number): boolean =>
    PER_OP_INLINE[op] === imm

/**
 * Render one instruction as a human-readable string. The output is stable
 * and round-trips through visual inspection — intended for debug dumps,
 * test snapshots, and error messages. Not a serialization format.
 */
export function format(instr: RtlInstr): string
{
    // 4. CALL
    if (instr.op === "CALL")
        return `CALL ${instr.callee}`

    // 3. Parametric: BR_TABLE / TRAP
    if (instr.op === "BR_TABLE")
        return `BR_TABLE ${instr.imm}`
    if (instr.op === "TRAP")
        return `TRAP ${instr.imm}`

    // 2. Bare unary/control
    if (!("combo" in instr))
        return instr.op

    // 1. Binary-form. Special-case MOVE into the idiomatic names.
    if (instr.op === "MOVE")
    {
        switch (instr.combo)
        {
            case "REG_ACC":   return `LOAD ${instr.target}`      // acc ← rN
            case "REG_REG":   return `STORE ${instr.target}`     // rN ← acc
            case "PEEK_PUSH": return `PUSH`                      // [tos++] ← acc
            case "IMM_ACC":   return `MOVE #${instr.imm}`        // acc ← #imm
            // PEEK_ACC / PEEK_PEEK / POP_ACC on MOVE are unusual; render literally.
            case "PEEK_ACC":  return `MOVE ${STACK_OPERAND.PEEK_ACC}`
            case "PEEK_PEEK": return `MOVE ${STACK_OPERAND.PEEK_PEEK} → ${STACK_RESULT.PEEK_PEEK}`
            case "POP_ACC":   return `MOVE ${STACK_OPERAND.POP_ACC}`
        }
    }

    // 1a. Register-combo binary
    if (instr.combo === "REG_ACC")
        return `${instr.op} ${instr.target}`                     // acc = acc OP rN
    if (instr.combo === "REG_REG")
        return `${instr.op} ${instr.target} → ${instr.target}`   // rN = acc OP rN

    // 1b. Immediate-combo binary
    if (instr.combo === "IMM_ACC")
        return `${instr.op} #${instr.imm}`                       // acc = acc OP #imm

    // 1c. Stack-combo binary
    {
        const operand = STACK_OPERAND[instr.combo]
        const result = STACK_RESULT[instr.combo]
        return result === undefined
            ? `${instr.op} ${operand}`                           // → acc
            : `${instr.op} ${operand} → ${result}`               // → tos
    }
}
