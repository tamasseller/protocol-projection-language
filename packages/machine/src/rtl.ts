/**
 * @ppl/machine — RTL instruction representation
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
 * Naming and semantics match isa-core.md §3 (addressing modes), §4
 * (instruction reference).
 */

// ─────────────────────────────────────────────────────────────────────────────
// Combo taxonomy
// ─────────────────────────────────────────────────────────────────────────────

export type OutputLocation = "acc" | "tos" | {"reg": number}

/**
 * Structural membership test for an `OutputLocation[]` array. Needed
 * because the `{reg: N}` case is an object — plain `Array.includes` is
 * reference equality, which two independently-constructed `{reg: N}`
 * literals (the common case: one built when a node was tiled, another
 * built later when checking a demand against it) will never satisfy even
 * when `N` matches. `"acc"`/`"tos"` are plain strings, so `===` (and hence
 * `includes`) already works correctly for them.
 */
export function outputHas(output: readonly OutputLocation[], want: OutputLocation): boolean
{
    if(typeof want === "object")
        return output.some(loc => typeof loc === "object" && loc.reg === want.reg)
    return output.includes(want)
}

export type Resource = "acc" | "tos"

/** Register addressing combos — carry a `target` register name. */
export type RegCombo = "REG_ACC" | "REG_REG"
/** Immediate combo — carries an `imm` literal. */
export type ImmCombo = "IMM_ACC"
/**
 * Stack-operand combos — no extra field. Only the two that reclaim what
 * they read: peek-and-write-back-in-place, and pop. There is deliberately
 * no peek-without-reclaiming and no push-on-top-of-peek combo — see
 * ir-engine.md, "Every stack-read combo also reclaims its operand".
 */
export type StackCombo = "PEEK_PEEK" | "POP_ACC"

/** All five valid binary-class combos (isa-core.md §3, §4.1). */
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
    PEEK_PEEK: { clobbers: ["acc", "tos"], tosDelta:  0},
    POP_ACC:   { clobbers: ["acc"],        tosDelta: -1},
    IMM_ACC:   { clobbers: ["acc"],        tosDelta:  0},
}

// ─────────────────────────────────────────────────────────────────────────────
// Opcode unions
// ─────────────────────────────────────────────────────────────────────────────

/** Binary-form opcodes — all take a combo (arithmetic + comparison). `MOVE`
 *  is not among them: data movement has its own dedicated move-class ops
 *  below, not a combo-driven identity op (isa-core.md §4.4). */
export type BinaryOpcode =
    // Arithmetic (§4.1)
    | "ADD" | "SUB" | "RSUB" | "MUL"
    | "AND" | "OR" | "XOR"
    | "SHL" | "SHR" | "ASR"
    // Comparison (§4.2)
    | "EQ" | "NE"
    | "LT_S" | "LE_S" | "GT_S" | "GE_S"
    | "LT_U" | "LE_U" | "GT_U" | "GE_U"

/** Comparison opcodes — carried by the small-immediate (`#0`-only) form in
 *  addition to the extended one (isa-core.md §4.2); arithmetic has no small
 *  form at all (§4.1). Shared source of truth for the cost model
 *  (`encoding.ts`) — kept here, not duplicated in the rule table. */
export const COMPARISON_OPS: ReadonlySet<BinaryOpcode> = new Set([
    "EQ", "NE", "LT_S", "LE_S", "GT_S", "GE_S", "LT_U", "LE_U", "GT_U", "GE_U",
])

/** Unary ALU opcodes — operate on acc in place, no combo (§4.3). */
export type UnaryOpcode = "NEG" | "NOT" | "CLZ" | "REVBITS"

/** No-operand control flow opcodes (§4.5). */
export type ControlOpcode =
    | "RETURN"
    | "BLOCK_END"
    | "LOOP"

/** Move-class opcodes with a register operand — unfused local access, no
 *  ALU combining (§4.4). */
export type MoveRegOpcode = "LOAD" | "STORE"

// ─────────────────────────────────────────────────────────────────────────────
// RtlInstr — discriminated union
// ─────────────────────────────────────────────────────────────────────────────

/** The default `EXT` payload shape — a bare opcode name plus an untyped,
 *  positional operand array. This is what every non-parameterized use of
 *  `RtlInstr`/`RtlProc`/`RtlProgram`/`Extension` means, unchanged from
 *  before `RtlInstr` grew a type parameter. A concrete extension that wants
 *  named-field operands (e.g. `@ppl/codecs`'s `CodecExtInstr`) supplies its
 *  own shape as `E` instead. */
export interface ExtOpPayload
{
    ext: string
    operands: readonly number[]
}

/**
 * Six instruction shapes, distinguished by `op` range and field presence.
 * The combo split makes `target`/`imm` *required when applicable* rather than
 * optional — TS enforces the combo→field correlation by construction.
 *
 * Consumer narrowing recipe:
 *   1. `"calleeIndex" in instr`        → CALL
 *   2. `instr.op === "BR_TABLE"/"TRAP"` → parametric
 *   3. `"combo" in instr`               → binary (arithmetic/comparison);
 *      sub-narrow by combo: `target` → register-combo, `imm` → IMM_ACC,
 *      else → stack-combo
 *   4. `instr.op === "LOAD"/"STORE"`    → move-register (`target`)
 *   5. `instr.op === "CONST"`           → move-immediate (`imm`)
 *   6. else                              → bare (unary / PUSH / POP / control)
 *
 * `E` parameterizes only the `EXT` arm's payload — every other arm is
 * fixed, core ISA shape, entirely independent of which extension (if any)
 * is active, and split out as `BaseRtlInstr` on that basis: a rule builder
 * that only ever constructs core instructions (every one of `rules.ts`'s
 * own, e.g.) can target `BaseRtlInstr` directly and never think about `E`
 * at all, rather than being parameterized over a type it never touches.
 * Defaulted to `ExtOpPayload` so every existing non-parameterized
 * `RtlInstr` means exactly what it always meant. The core
 * (`lower.ts`/`validate.ts`/`vm.ts`/`bytecode.ts`/`raise.ts`) never
 * interprets `E`'s contents itself — it only ever reads `.ext` (for
 * effect-table lookups) and passes the whole instruction through to
 * extension-supplied callbacks (`exec`, `codec`), so genericizing this one
 * arm costs the core nothing semantically, only type-parameter plumbing.
 */
export type BaseRtlInstr =
    // 1a. Register-combo binary: arithmetic/comparison reading a register
    //     operand. target is REQUIRED (it names the operand register).
    | { op: BinaryOpcode; combo: RegCombo; target: number }
    // 1b. Immediate-combo binary: arithmetic/comparison with a literal.
    //     imm is REQUIRED. Always the extended form for arithmetic; for
    //     comparison, small (#0) when imm===0, extended otherwise — a cost
    //     distinction only (encoding.ts), not a type distinction.
    | { op: BinaryOpcode; combo: "IMM_ACC"; imm: number }
    // 1c. Stack-combo binary: arithmetic/comparison on TOS (peek-writeback
    //     or pop).
    | { op: BinaryOpcode; combo: StackCombo }
    // 2. Move-class, register operand: unfused local access.
    | { op: MoveRegOpcode; target: number }
    // 3. Move-class, immediate: constant load. Small (0..15) vs extended is
    //    a cost distinction only (encoding.ts), not a type distinction.
    | { op: "CONST"; imm: number }
    // 4. Bare: unary ALU (acc in place), no-operand move (PUSH/POP), and
    //    no-operand control flow.
    | { op: UnaryOpcode | ControlOpcode | "PUSH" | "POP" }
    // 5. Parametric: single numeric parameter (BR_TABLE case count, TRAP code).
    | { op: "BR_TABLE" | "TRAP"; imm: number }
    // 6. Call: procedure invocation by resolved procedure-table index
    //    (isa-core.md §2.3, §4.6) — never a bare name; resolving a callee
    //    name to its table index is `lower.ts`'s job, on the fly, as it
    //    discovers each procedure (ROADMAP.md item 2).
    | { op: "CALL"; calleeIndex: number }

/**
 * `BaseRtlInstr` plus one more arm — extension: one domain-specific opcode
 * (isa-core.md §5.1, byte ≥128 — "owned by the active extension"). `ext`
 * is opaque to the generic core; `operands` (the default payload's shape)
 * are literal constants only, by design (ROADMAP.md item 6) — never a
 * register/stack reference resolved at runtime, so an AOT translator can
 * implement whatever an extension op abstracts away (a struct field
 * access, a `*ptr++` read, ...) with ordinary target-native code, not an
 * interpreter loop. What an `ext` name means — its stack effect, VM
 * execution, and wire encoding — comes from an `Extension<E>` object
 * threaded through `ruleset`/`lowerProgram`/`validateProgram`/`run`/
 * `encodeInstr`/`decodeInstr` as an optional parameter (see extension.ts);
 * with none registered, an `EXT` instruction is simply data no stage knows
 * how to interpret.
 */
export type RtlInstr<E extends { ext: string } = ExtOpPayload> =
    | BaseRtlInstr
    | ({ op: "EXT" } & E)


export const isCallInstr = <E extends { ext: string } = ExtOpPayload>(i: RtlInstr<E>): i is Extract<RtlInstr<E>, { op: "CALL" }> =>
    i.op === "CALL"

/** The `EXT` variant on its own, for a given `E` — the shape
 *  `Extension.exec`/`ExtCodec` (extension.ts) operate on. */
export type ExtInstrOf<E extends { ext: string } = ExtOpPayload> = Extract<RtlInstr<E>, { op: "EXT" }>

/** The default-payload `EXT` variant — unchanged meaning from before
 *  `RtlInstr` grew a type parameter (every existing import of this name
 *  keeps meaning exactly what it always meant). */
export type ExtInstr = ExtInstrOf

export const isExtInstr = <E extends { ext: string } = ExtOpPayload>(i: RtlInstr<E>): i is ExtInstrOf<E> =>
    i.op === "EXT"

export const isParametricInstr = <E extends { ext: string } = ExtOpPayload>(i: RtlInstr<E>): i is Extract<RtlInstr<E>, { op: "BR_TABLE" | "TRAP" }> =>
    i.op === "BR_TABLE" || i.op === "TRAP"

export const isRegComboInstr = <E extends { ext: string } = ExtOpPayload>(i: RtlInstr<E>): i is Extract<RtlInstr<E>, { combo: RegCombo }> =>
    "combo" in i && (i.combo === "REG_ACC" || i.combo === "REG_REG")

export const isImmComboInstr = <E extends { ext: string } = ExtOpPayload>(i: RtlInstr<E>): i is Extract<RtlInstr<E>, { combo: "IMM_ACC" }> =>
    "combo" in i && i.combo === "IMM_ACC"

export const isStackComboInstr = <E extends { ext: string } = ExtOpPayload>(i: RtlInstr<E>): i is Extract<RtlInstr<E>, { combo: StackCombo }> =>
    "combo" in i && (i.combo === "PEEK_PEEK" || i.combo === "POP_ACC")

/** `acc ← rN` — load register into accumulator (unfused; §4.4). */
export const LOAD = <E extends { ext: string } = ExtOpPayload>(target: number): RtlInstr<E> =>
    ({ op: "LOAD", target })

/** `rN ← acc` — store accumulator to register (unfused; §4.4). */
export const STORE = <E extends { ext: string } = ExtOpPayload>(target: number): RtlInstr<E> =>
    ({ op: "STORE", target })

/** `[tos++] ← acc` — push accumulator onto stack. */
export const PUSH = <E extends { ext: string } = ExtOpPayload>(): RtlInstr<E> =>
    ({ op: "PUSH" })

/** `acc ← [--tos]` — pop stack into accumulator. */
export const POP = <E extends { ext: string } = ExtOpPayload>(): RtlInstr<E> =>
    ({ op: "POP" })

/** `acc ← #imm` — load constant into accumulator. */
export const CONST = <E extends { ext: string } = ExtOpPayload>(imm: number): RtlInstr<E> =>
    ({ op: "CONST", imm })

/** `acc = acc ⟨op⟩ rN` — binary op with register operand, result → acc. */
export const opReg = <E extends { ext: string } = ExtOpPayload>(op: BinaryOpcode, target: number): RtlInstr<E> =>
    ({ op, combo: "REG_ACC", target })

/** `rN = acc ⟨op⟩ rN` — binary op with register operand, write-back to that
 *  same register (combo 2, §3). The single-instruction form of "compute
 *  into a register and store back into it" — e.g. `x += 1` reformulated as
 *  `1 + x` (commutative) folds to `CONST #1; ADD x → x`, no separate STORE. */
export const opRegWriteback = <E extends { ext: string } = ExtOpPayload>(op: BinaryOpcode, target: number): RtlInstr<E> =>
    ({ op, combo: "REG_REG", target })

/** `acc = acc ⟨op⟩ #imm` — binary op with immediate operand, result → acc. */
export const opImm = <E extends { ext: string } = ExtOpPayload>(op: BinaryOpcode, imm: number): RtlInstr<E> =>
    ({ op, combo: "IMM_ACC", imm })

/** Stack-combo binary op (peek-writeback or pop). */
export const opStack = <E extends { ext: string } = ExtOpPayload>(op: BinaryOpcode, combo: StackCombo): RtlInstr<E> =>
    ({ op, combo })

/** Bare unary ALU (`NEG`, `NOT`, `CLZ`, `REVBITS`) or no-operand control flow
 *  (`RETURN`, `BLOCK_END`, `LOOP`). */
export const bare = <E extends { ext: string } = ExtOpPayload>(op: UnaryOpcode | ControlOpcode): RtlInstr<E> =>
    ({ op })

/** `BR_TABLE #n` — open dispatch block with n cases. */
export const brTable = <E extends { ext: string } = ExtOpPayload>(n: number): RtlInstr<E> =>
    ({ op: "BR_TABLE", imm: n })

/** `TRAP #code` — abnormal exit with error code. */
export const trap = <E extends { ext: string } = ExtOpPayload>(code: number): RtlInstr<E> =>
    ({ op: "TRAP", imm: code })

/** `CALL proc_idx` — invoke `procedure[calleeIndex]` (isa-core.md §4.6).
 *  Calling convention: the callee's *last* argument (if any) arrives in
 *  `acc`, not via the stack — `acc` is clobbered by the call regardless
 *  (the callee's return value overwrites it), so routing the last argument
 *  through it costs nothing and saves a `PUSH` for the extremely common
 *  single-argument call. Only the callee's other `argCount - 1` arguments
 *  (0 for a 0- or 1-argument callee) are actually popped off the stack. */
export const call = <E extends { ext: string } = ExtOpPayload>(calleeIndex: number): RtlInstr<E> =>
    ({ op: "CALL", calleeIndex })

/** `EXT ext operands...` — one extension-defined opcode (isa-core.md §5.1),
 *  in the default flat-payload shape. `operands` are literal constants,
 *  resolved at lowering time (register indices, procedure-table indices,
 *  small handle literals, ...) — never computed at runtime. A concrete
 *  extension with its own named-field `E` defines its own per-opcode
 *  constructors instead (e.g. `@ppl/codecs`'s `codec-ext-instr.ts`). */
export const extInstr = (ext: string, operands: readonly number[]): ExtInstr =>
    ({ op: "EXT", ext, operands })


export interface RtlProc<E extends { ext: string } = ExtOpPayload>
{
    argCount: number
    body: RtlInstr<E>[]
    /** Extension-owned header data (isa-core.md §2.3's extension fields —
     *  e.g. the codec extension's ABI-kind selector). Opaque to the
     *  generic core: never read or interpreted by `lower.ts`/`validate.ts`/
     *  `vm.ts`/`bytecode.ts` themselves, only carried through from the
     *  `Procedure` it was lowered from for whatever extension put it there
     *  to read back. */
    header?: unknown
}

export interface RtlProgram<E extends { ext: string } = ExtOpPayload>
{
    procedures: RtlProc<E>[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Human-readable disassembly — `format(instr)`
//
// Produces the assembly-style notation used in isa-core.md's appendix:
//
//   LOAD r0            move-class, register
//   STORE r0           move-class, register
//   PUSH / POP         move-class, bare
//   CONST #5           move-class, immediate
//   ADD r0             <op> + REG_ACC
//   ADD r0 → r0        <op> + REG_REG (write-back)
//   ADD #5             <op> + IMM_ACC
//   ADD [--tos]        <op> + POP_ACC
//   ADD [tos-1] → [tos-1]  <op> + PEEK_PEEK
//   NEG / NOT / CLZ / REVBITS   bare unary
//   RETURN / BLOCK_END / ...    bare control
//   BR_TABLE 3                  parametric
//   TRAP 0                      parametric
//   CALL 2                      call
// ─────────────────────────────────────────────────────────────────────────────

const STACK_OPERAND: Record<StackCombo, string> = {
    PEEK_PEEK: "[tos-1]",
    POP_ACC:   "[--tos]",
}

const STACK_RESULT: Partial<Record<StackCombo, string>> = {
    PEEK_PEEK: "[tos-1]",
}

/**
 * Render one instruction as a human-readable string. The output is stable
 * and round-trips through visual inspection — intended for debug dumps,
 * test snapshots, and error messages. Not a serialization format.
 *
 * Only ever called with the default `ExtOpPayload` shape — a concrete
 * extension with named-field operands owns its own debug rendering (e.g.
 * a `describe(instr: CodecExtInstr)`), not worth solving generically for
 * one consumer when `EXT`'s own arm is the only one that varies by `E`.
 */
export function format(instr: RtlInstr): string
{
    // 7. EXT
    if (instr.op === "EXT")
        return [instr.ext, ...instr.operands].join(" ")

    // 6. CALL
    if (instr.op === "CALL")
        return `CALL ${instr.calleeIndex}`

    // 5. Parametric: BR_TABLE / TRAP
    if (instr.op === "BR_TABLE")
        return `BR_TABLE ${instr.imm}`
    if (instr.op === "TRAP")
        return `TRAP ${instr.imm}`

    // Move-class
    if (instr.op === "LOAD" || instr.op === "STORE")
        return `${instr.op} ${instr.target}`
    if (instr.op === "CONST")
        return `CONST #${instr.imm}`
    if (instr.op === "PUSH" || instr.op === "POP")
        return instr.op

    // 4. Bare unary/control
    if (!("combo" in instr))
        return instr.op

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
