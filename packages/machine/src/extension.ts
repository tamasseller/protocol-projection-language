/**
 * @ppl/machine — Generic extension hook (ROADMAP.md item 6)
 *
 * The generic core (rules.ts/lower.ts/validate.ts/vm.ts/bytecode.ts) never
 * hardcodes any domain-specific opcode. An `Extension` bundles everything a
 * concrete extension (e.g. the codec extension — ROADMAP.md item 7,
 * docs/codec-extension.md) needs to plug into every stage: DSL-side
 * call resolution, the validator's stack-effect bookkeeping, VM execution,
 * and wire encode/decode. Every core entry point takes its `extension` as
 * an optional trailing parameter, defaulting to none — so nothing about an
 * existing call site changes when no extension is registered.
 *
 * Every field is optional: a header-only extension (opaque `Procedure`/
 * `RtlProc.header` data, no new opcodes) needs none of them.
 */

import type { Rule } from "./rules"
import type { ExtInstr } from "./rtl"

/**
 * Declared stack effect of one extension opcode (the "effect declarations"
 * idea from the codec extension spec — docs/codec-extension.md §6.3) — lets
 * validate.ts's per-procedure walk and vm.ts's
 * dispatch stay ignorant of what the op actually does, needing only these
 * numbers/flags to keep isa-core.md §8's guarantees.
 */
export interface ExtOpEffect
{
    /** Net TOS depth change contributed by the op itself, mirroring
     *  `ComboMeta.tosDelta` for core ops. */
    tosDelta: number
    /** Peak *transient* TOS depth the op reaches above its own entry depth
     *  while executing — e.g. an op that pushes two temporaries and pops
     *  them before returning nets `tosDelta: 0` but transiently reaches
     *  `maxTransient: 2`. */
    maxTransient: number
    /** True for an op that terminates its enclosing block on its own, like
     *  `RETURN`/`TRAP` (isa-core.md §4.5). Only consulted by validate.ts's
     *  walk; lower.ts's `alwaysTerminates`/`closeBlock` do not yet consult
     *  it (they only recognize `return`/`trap(...)` at the DSL level) — a
     *  DSL-level terminating call-shaped extension op is future work, not
     *  needed by this hook itself. */
    terminates?: boolean
    /** Set when this op is call-shaped (like the codec draft's fused
     *  `CALL_CODEC`) — which `operands` index carries the resolved callee's
     *  procedure-table index, and the callee's total logical `argCount`.
     *  Lets validate.ts's §8.2/§8.3 call-graph walk fold it into the same
     *  `callSites` bookkeeping as a plain `CALL`, without knowing the op's
     *  name — including `CALL`'s own last-arg-in-`acc` convention (rtl.ts's
     *  `call` doc comment): only `argCount - 1` values (0 for `argCount`
     *  0 or 1) are expected to actually be on the stack. This is a
     *  validator-only concern — the VM's own execution of a call-shaped
     *  extension op (actually invoking the callee) is the extension's own
     *  responsibility; `ExecState` below deliberately does not expose
     *  procedure dispatch. */
    call?: { calleeOperandIndex: number; argCount: number }
}

/** The subset of VM state one extension opcode's `exec` is allowed to
 *  touch — accumulator and stack/register access, nothing about control
 *  flow (no pc, no block stack) since a generic extension op is
 *  straight-line by construction (isa-core.md §5.1). */
export interface ExecState
{
    acc: number
    push(value: number): void
    pop(): number
    reg(index: number): number
    setReg(index: number, value: number): void
}

export interface ExtCodec
{
    /** Encode one extension instruction to its wire bytes, including the
     *  leading opcode byte (≥128). */
    encode(instr: ExtInstr): number[]
    /** Decode one extension instruction starting at `bytes[offset]`, where
     *  `bytes[offset]` is the leading opcode byte (≥128) — mirrors
     *  `decodeInstr`'s own `{instr, next}` contract for every core opcode. */
    decode(bytes: Uint8Array, offset: number): { instr: ExtInstr; next: number }
}

export interface Extension
{
    /** DSL-side call-like syntax with fixed lowering — the same mechanism
     *  `builtinCallRules()` (rules.ts) already uses for `clz`/`trap`/
     *  `revbits`, generalized so an extension contributes its own rules
     *  instead of them being hardcoded there. */
    rules?: (resolveLocal: (name: string) => number, resolveCallee: (name: string) => number | undefined) => Rule[]
    /** One `ExtOpEffect` per opcode this extension defines, keyed by the
     *  `ExtInstr.ext` name validate.ts will see. */
    effects?: Readonly<Record<string, ExtOpEffect>>
    /** VM execution for one extension instruction. */
    exec?: (instr: ExtInstr, state: ExecState) => void
    /** Wire encode/decode for this extension's opcode range. */
    codec?: ExtCodec
}
