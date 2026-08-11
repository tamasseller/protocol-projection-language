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
    /** Set when this op is call-shaped (like the codec extension's fused
     *  `CALL_CODEC`, docs/codec-extension.md §3.3) — which `operands` index
     *  carries the resolved callee's procedure-table index. Lets
     *  validate.ts's §8.2/§8.3 call-graph walk fold it into the same
     *  `callSites` bookkeeping as a plain `CALL`, without knowing the op's
     *  name: the callee's own `argCount` header decides how many values the
     *  call site pops — never a static number here, since different sites
     *  of the same call-shaped op can target callees of different arity
     *  (codec-extension.md §6.3: "argCount from the invoked codec's
     *  header") — mirroring `CALL`'s own last-arg-in-`acc` convention
     *  exactly (rtl.ts's `call` doc comment): only `argCount - 1` values (0
     *  for `argCount` 0 or 1) are expected to actually be on the stack.
     *  `ExecState.callProc` is the matching VM-side capability — the
     *  extension's own `exec` decides *when* to call it and what to bind
     *  first (e.g. a codec's object handle), but the invocation itself runs
     *  through the same machinery a plain `CALL` does. */
    call?: { calleeOperandIndex: number }
    /** True for an op whose real input includes whatever `acc` already
     *  holds, *in addition to* whatever `-tosDelta` says it pops off the
     *  stack — the codec extension's `WRITE`/`STORE_VAL`/`WRITE_SEQ`/
     *  `READ_SEQ` (codec-extension.ts) are the motivating case: their
     *  `ir\`...\`` rule always places a value-producing sub-fragment
     *  (`load_val(0)`, a plain slot read, …) immediately before the op with
     *  nothing in between, so at `exec()` time `state.acc` already holds
     *  it — no stack push/pop involved, because `tosDelta` for these is 0.
     *  `raise.ts` needs this declared explicitly: without it, its own
     *  acc-tracking (which treats "about to overwrite acc" as license to
     *  either flush-and-discard or drop a pure reference) has no way to
     *  know this op is about to *read* that value rather than clobber it,
     *  and the resulting tree silently loses the data-flow edge — every
     *  `vm.ts`-based consumer (`run()`) is unaffected (it always reads the
     *  real `acc` register directly), but any tree-based consumer of
     *  `raise.ts`'s own output loses it entirely. Defaults to falsy —
     *  every existing effect this doesn't apply to is unaffected. */
    readsAcc?: boolean
}

/** The subset of VM state one extension opcode's `exec` is allowed to
 *  touch — accumulator and stack/register access, nothing about control
 *  flow (no pc, no block stack) since a generic extension op is
 *  straight-line by construction (isa-core.md §5.1).
 *
 *  `callProc` is the one exception to "straight-line": it's what a
 *  call-shaped op (`ExtOpEffect.call`, e.g. the codec extension's
 *  `CALL_CODEC`) uses to actually invoke the callee `validate.ts` already
 *  folded into its call-graph bookkeeping — mirroring `vm.ts`'s own `CALL`
 *  case exactly (resolve the callee by table index, run it to completion,
 *  return its `acc`). Invoking it is nested, synchronous, and returns
 *  before `exec` does, so it doesn't reintroduce control flow into the
 *  op's own execution — the callee runs in its own fresh frame, entirely
 *  managed by `vm.ts`, and any state an extension needs to rebind across
 *  that call (e.g. a codec's object handle) is the extension's own
 *  responsibility to push/pop around this call, not something `vm.ts`
 *  tracks. */
export interface ExecState
{
    acc: number
    push(value: number): void
    pop(): number
    reg(index: number): number
    setReg(index: number, value: number): void
    callProc(calleeIndex: number, args: readonly number[]): number
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
