/**
 * @ppl/machine — Whole-program static validator (isa-core.md §8)
 *
 * Checks an assembled `RtlProgram` against isa-core.md §8's five static
 * guarantees — TOS balance (§8.1), call-graph acyclicity (§8.2), the
 * stack-depth bound (§8.3), dead-code rejection (§8.4), and header/block
 * well-formedness (§8.5) — and throws a descriptive `Error` on the first
 * violation found (fail-fast, matching this codebase's existing style —
 * see e.g. vm.ts's plain `throw new Error(...)` for malformed IR).
 *
 * On success, returns the per-procedure and whole-program stack-depth
 * figures (§8.3) as a genuine return value — never written into
 * `RtlProgram` itself, since that would mean paying wire-format bytes for
 * numbers a validator invocation can just hand back directly to whatever
 * codegen/JIT runs alongside it (ROADMAP.md item 3's discussion).
 *
 * §8.3's own text describes the bound as "the sum of per-procedure maxima
 * along the longest call chain" — a valid but *loose* upper bound. This
 * validator computes the *tight* one instead, at no extra cost: it uses
 * each call site's *actual* TOS depth (which is usually less than the
 * caller's own overall peak — that peak may be reached at some other,
 * unrelated point in the caller) rather than the caller's whole-procedure
 * maximum. See `totalDepthOf` below and validate.test.ts's dedicated test
 * for a worked example of the two bounds actually differing.
 */

import type { RtlProc, RtlProgram, RtlInstr } from "./rtl"
import { isCallInstr, isExtInstr, isStackComboInstr } from "./rtl"
import type { Extension, ExtOpEffect } from "./extension"

// ─────────────────────────────────────────────────────────────────────────────

export interface ProcedureStats
{
    /** Max TOS depth reached anywhere in this procedure's own frame —
     *  starting from `argCount` (isa-core.md §2.5's frame layout), never
     *  descending into any callee's own frame. */
    localPeak: number
}

export interface ProgramStats
{
    /** One entry per procedure, in procedure-table order. */
    procedures: readonly ProcedureStats[]
    /** Worst-case total TOS depth reachable from procedure 0 (the
     *  convention `lowerProgram` and `vm.ts`'s `run` both already use for
     *  "the entry procedure"), computed via each call site's actual depth
     *  — the tight bound described above, not the loose per-procedure-
     *  maxima sum. */
    totalDepth: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-procedure walk — §8.1, §8.4, §8.5, and the raw material for §8.2/§8.3
// ─────────────────────────────────────────────────────────────────────────────

/** How many of a call-shaped op's `argCount` logical arguments are actually
 *  popped off the stack — all but the last, which arrives in `acc` instead
 *  (rtl.ts's `call` doc comment). Shared by `CALL`'s own bookkeeping, an
 *  extension's call-shaped `effect.call`, and `totalDepthOf`'s frame-base
 *  computation, so the three stay in agreement about the convention. */
function stackArgsOf(argCount: number): number
{
    return Math.max(argCount - 1, 0)
}

interface CallSite
{
    calleeIndex: number
    /** TOS depth (relative to this procedure's own frame base) at the
     *  moment this CALL executes — i.e. including the pushed argument
     *  block. This is the "actual call-site depth" §8.3's tight
     *  computation uses in place of the caller's whole-procedure peak. */
    tos: number
}

interface WalkOutcome
{
    localPeak: number
    callSites: readonly CallSite[]
}

/**
 * Known limitation: dead code (§8.4) hidden inside a *non-final* sibling
 * of a `BR_TABLE`/`LOOP` — crafted so that skipping past it happens to
 * realign with a real subsequent boundary — is not guaranteed to be
 * caught by this walk in isolation; only §8.5's structural checks
 * (index/arg-count/close-kind mismatches) happen to catch every case
 * actually tried in validate.test.ts. Dead code as the tail of a
 * procedure (by far the common case, and the only shape a correct
 * lowerer can produce — lower.ts's `closeBlock` was fixed to never leave
 * trailing dead code, ROADMAP.md item 3's own prerequisite) is always
 * caught, via the `nextPc !== body.length` check below. Hardening against
 * adversarially-crafted mid-stream dead code is not worth the extra
 * machinery for what this project is (a small utility tool, not a
 * defense against malicious bytecode — see the cryptographic-signing
 * discussion in ROADMAP.md for where *that* concern actually belongs).
 */
function walkProcedure(
    proc: RtlProc,
    program: RtlProgram,
    procIndex: number,
    effects: Readonly<Record<string, ExtOpEffect>> | undefined,
): WalkOutcome
{
    const body = proc.body
    let peak = proc.argCount
    const callSites: CallSite[] = []

    function fail(pc: number, message: string): never
    {
        throw new Error(`procedure ${procIndex}, instruction ${pc}: ${message}`)
    }

    /** Walk one block (the top-level body, one `BR_TABLE` case, or one
     *  `LOOP` sub-block) from `pc`, starting at `entryTos`. Returns where
     *  its own close is and whether that close was a terminator. */
    function walk(pc: number, entryTos: number): { nextPc: number; terminated: boolean }
    {
        let tos = entryTos

        for(;;)
        {
            // A terminator or BLOCK_END always returns immediately, below —
            // so reaching the end of the array without ever finding one
            // means this specific block (at whatever nesting level it's
            // at) never got its own close at all.
            if(pc >= body.length) fail(pc, `ran off the end without finding this block's own close (RETURN/TRAP/BLOCK_END)`)

            const instr: RtlInstr = body[pc]!
            peak = Math.max(peak, tos)

            if(instr.op === "BLOCK_END") return { nextPc: pc + 1, terminated: false }
            if(instr.op === "RETURN" || instr.op === "TRAP") return { nextPc: pc + 1, terminated: true }

            if(instr.op === "PUSH") { tos++; pc++; continue }

            if(instr.op === "POP")
            {
                if(tos <= entryTos) fail(pc, `POP would underflow below this block's entry depth (${entryTos})`)
                tos--; pc++; continue
            }

            if(isStackComboInstr(instr))
            {
                if(tos <= entryTos)
                    fail(pc, `${instr.op} ${instr.combo} would read below this block's entry depth (${entryTos})`)
                if(instr.combo === "POP_ACC") tos--
                pc++; continue
            }

            if(isCallInstr(instr))
            {
                const callee = program.procedures[instr.calleeIndex]
                if(!callee) fail(pc, `CALL ${instr.calleeIndex}: no such procedure`)
                const stackArgs = stackArgsOf(callee.argCount)
                if(tos - stackArgs < entryTos)
                    fail(pc, `CALL ${instr.calleeIndex}: only ${tos - entryTos} value(s) pushed, needs ${stackArgs}`)
                callSites.push({ calleeIndex: instr.calleeIndex, tos })
                tos -= stackArgs
                pc++; continue
            }

            if(isExtInstr(instr))
            {
                const effect = effects?.[instr.ext]
                if(!effect) fail(pc, `EXT ${instr.ext}: no effect declaration registered for this opcode (no matching Extension.effects entry)`)

                peak = Math.max(peak, tos + effect.maxTransient)

                if(effect.call)
                {
                    const { calleeOperandIndex } = effect.call
                    const calleeIndex = instr.operands[calleeOperandIndex]
                    if(calleeIndex === undefined)
                        fail(pc, `EXT ${instr.ext}: call effect references operand ${calleeOperandIndex}, but only ${instr.operands.length} present`)
                    const callee = program.procedures[calleeIndex]
                    if(!callee) fail(pc, `EXT ${instr.ext}: no such procedure ${calleeIndex}`)
                    // The resolved callee's own argCount header decides the
                    // pop count — never a static per-opcode number — since
                    // different call sites of the same call-shaped op can
                    // target callees of different arity (mirrors the plain
                    // CALL case below exactly).
                    const stackArgs = stackArgsOf(callee.argCount)
                    if(tos - stackArgs < entryTos)
                        fail(pc, `EXT ${instr.ext}: only ${tos - entryTos} value(s) pushed, needs ${stackArgs}`)
                    callSites.push({ calleeIndex, tos })
                    tos -= stackArgs
                }

                tos += effect.tosDelta
                if(tos < entryTos) fail(pc, `EXT ${instr.ext}: net effect would underflow below this block's entry depth (${entryTos})`)

                if(effect.terminates) return { nextPc: pc + 1, terminated: true }
                pc++; continue
            }

            if(instr.op === "BR_TABLE")
            {
                let p = pc + 1
                for(let k = 0; k < instr.imm; k++)
                    ({ nextPc: p } = walk(p, tos))
                pc = p; continue
            }

            if(instr.op === "LOOP")
            {
                const cond = walk(pc + 1, tos)
                if(cond.terminated) fail(pc, `LOOP's condition sub-block must close with BLOCK_END, not a terminator`)
                const body_ = walk(cond.nextPc, tos)
                pc = body_.nextPc; continue
            }

            // LOAD/STORE/CONST, REG_ACC/REG_REG/IMM_ACC combos, unary ops:
            // none of these touch TOS.
            pc++
        }
    }

    const { nextPc, terminated } = walk(0, proc.argCount)
    if(!terminated) fail(nextPc, `BLOCK_END with no open block (procedure bodies close only via RETURN/TRAP)`)
    if(nextPc !== body.length) fail(nextPc, `unreachable instruction(s) after the procedure's terminator`)

    return { localPeak: peak, callSites }
}

// ─────────────────────────────────────────────────────────────────────────────
// Whole-program pass — §8.2 and the tight §8.3 total, in one DFS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The tight total: at each call site, the contribution is the *actual*
 * depth pushed at that specific site (`tos - stackArgsOf(callee.argCount)`,
 * i.e. how far above this procedure's own frame base the callee's frame
 * starts) plus however deep the callee itself can go — not this
 * procedure's own unrelated worst-case peak. `visiting` is this DFS path's
 * recursion stack; revisiting a procedure already on it means the call
 * graph has a cycle (§8.2) — acyclicity and the tight depth fall out of the
 * same walk.
 */
function totalDepthOf(
    index: number,
    program: RtlProgram,
    perProcedure: readonly WalkOutcome[],
    memo: Map<number, number>,
    visiting: Set<number>,
): number
{
    const cached = memo.get(index)
    if(cached !== undefined) return cached
    if(visiting.has(index)) throw new Error(`call-graph cycle detected: procedure ${index} calls itself, directly or transitively`)

    visiting.add(index)
    let best = perProcedure[index]!.localPeak
    for(const { calleeIndex, tos } of perProcedure[index]!.callSites)
    {
        const calleeFrameBase = tos - stackArgsOf(program.procedures[calleeIndex]!.argCount)
        const contribution = calleeFrameBase + totalDepthOf(calleeIndex, program, perProcedure, memo, visiting)
        best = Math.max(best, contribution)
    }
    visiting.delete(index)

    memo.set(index, best)
    return best
}

// ─────────────────────────────────────────────────────────────────────────────

export function validateProgram(program: RtlProgram, extension?: Extension): ProgramStats
{
    if(program.procedures.length === 0) throw new Error(`empty program`)

    const effects = extension?.effects
    const perProcedure = program.procedures.map((proc, i) => walkProcedure(proc, program, i, effects))

    const memo = new Map<number, number>()
    for(let i = 0; i < program.procedures.length; i++)
        totalDepthOf(i, program, perProcedure, memo, new Set())

    return {
        procedures: perProcedure.map(p => ({ localPeak: p.localPeak })),
        totalDepth: memo.get(0)!,
    }
}
