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
 * maximum. See `depthsOf` below and validate.test.ts's dedicated test
 * for a worked example of the two bounds actually differing.
 */

import type { RtlProc, RtlProgram, RtlInstr, ExtOpPayload } from "./rtl"
import { isExtInstr, isStackComboInstr, isRegComboInstr, isImmComboInstr } from "./rtl"
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
    /** The largest number of simultaneously active frames on any path from
     *  procedure 0 (isa-core.md §8.3's second DFS figure) — each call
     *  site's own contribution is `1 + ` the callee's own worst case.
     *  Independent of `totalDepth`: a long shallow chain has a small
     *  `totalDepth` and a large `maxCallDepth`, an operand-heavy single
     *  frame the reverse. Sizes whatever a backend remembers "resume here"
     *  across a call with — free for one implementing `CALL`/`RETURN` by
     *  native recursion, load-bearing for one threading invocation through
     *  an explicit loop with a pre-sized array of return records. */
    maxCallDepth: number
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
 *  extension's call-shaped `effect.calleeOf`, and `depthsOf`'s frame-base
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
function walkProcedure<E extends { ext: string } = ExtOpPayload>(
    proc: RtlProc<E>,
    program: RtlProgram<E>,
    procIndex: number,
    effects: Readonly<Record<string, ExtOpEffect<E>>> | undefined,
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
     *  `LOOP` sub-block) from `pc`, starting at `entryTos`/`entryAccLive`.
     *  Returns where its own close is, whether that close was a
     *  terminator, and what `acc`'s liveness is by the time it closes.
     *
     *  `accLive` mirrors rtl.ts's own acc-clobbering convention
     *  (docs/design.md §10.1, §16 item 2): every op either reads acc,
     *  produces a fresh value into it, or (a write-back-in-place combo,
     *  REG_REG/PEEK_PEEK) clobbers it — matching `raise.ts`'s own
     *  `this.acc = undefined` and `vm.ts`'s own dynamic tracking. `LOOP`'s
     *  condition sub-block is walked using whatever `accLive` was
     *  immediately before `LOOP` opened, then the body inherits the
     *  condition's own exit — a *forward*, single-pass account, same as
     *  `tos`; it does not also re-verify the condition sub-block against
     *  whatever the body's own back-edge would leave pending, the way
     *  `BR_TABLE`'s sibling cases get reconciled below. A hand-crafted
     *  program that's only unsafe on that specific back-edge is a known,
     *  accepted gap here — `vm.ts`'s own dynamic check (§16 item 2) still
     *  catches it the moment that path actually executes — matching this
     *  file's existing tolerance for similar static-analysis gaps (see
     *  this function's own doc comment on dead-code detection). */
    function walk(pc: number, entryTos: number, entryAccLive: boolean): { nextPc: number; terminated: boolean; exitAccLive: boolean }
    {
        let tos = entryTos
        let accLive = entryAccLive

        function requireAcc(context: string): void
        {
            if(!accLive) fail(pc, `${context}: read of acc after a write-back-in-place combo clobbered it (docs/design.md §10.1's acc-clobbering convention)`)
        }

        for(;;)
        {
            // A terminator or BLOCK_END always returns immediately, below —
            // so reaching the end of the array without ever finding one
            // means this specific block (at whatever nesting level it's
            // at) never got its own close at all.
            if(pc >= body.length) fail(pc, `ran off the end without finding this block's own close (RETURN/TRAP/BLOCK_END)`)

            const instr: RtlInstr<E> = body[pc]!
            peak = Math.max(peak, tos)

            if(instr.op === "BLOCK_END") return { nextPc: pc + 1, terminated: false, exitAccLive: accLive }
            if(instr.op === "RETURN") { requireAcc("RETURN"); return { nextPc: pc + 1, terminated: true, exitAccLive: accLive } }
            if(instr.op === "TRAP") return { nextPc: pc + 1, terminated: true, exitAccLive: accLive }

            if(instr.op === "PUSH") { requireAcc("PUSH"); tos++; pc++; continue }

            if(instr.op === "POP")
            {
                if(tos <= entryTos) fail(pc, `POP would underflow below this block's entry depth (${entryTos})`)
                tos--; accLive = true; pc++; continue
            }

            if(isStackComboInstr(instr))
            {
                if(tos <= entryTos)
                    fail(pc, `${instr.op} ${instr.combo} would read below this block's entry depth (${entryTos})`)
                requireAcc(`${instr.op} ${instr.combo}`)
                accLive = instr.combo === "POP_ACC" // POP_ACC produces a fresh value; PEEK_PEEK clobbers (write-back-in-place)
                if(instr.combo === "POP_ACC") tos--
                pc++; continue
            }

            if(instr.op === "CALL")
            {
                const callee = program.procedures[instr.calleeIndex]
                if(!callee) fail(pc, `CALL ${instr.calleeIndex}: no such procedure`)
                const stackArgs = stackArgsOf(callee.argCount)
                if(tos - stackArgs < entryTos)
                    fail(pc, `CALL ${instr.calleeIndex}: only ${tos - entryTos} value(s) pushed, needs ${stackArgs}`)
                if(callee.argCount > 0) requireAcc(`CALL ${instr.calleeIndex}`)
                callSites.push({ calleeIndex: instr.calleeIndex, tos })
                tos -= stackArgs
                accLive = true // the callee's return value
                pc++; continue
            }

            if(isExtInstr(instr))
            {
                const effect = effects?.[instr.ext]
                if(!effect) fail(pc, `EXT ${instr.ext}: no effect declaration registered for this opcode (no matching Extension.effects entry)`)

                peak = Math.max(peak, tos + effect.maxTransient)

                if(effect.calleeOf)
                {
                    const calleeIndex = effect.calleeOf(instr)
                    if(calleeIndex === undefined)
                        fail(pc, `EXT ${instr.ext}: call effect declared but didn't resolve a callee for this instruction`)
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

                // Extension ops are opaque to the core's own acc-clobbering
                // convention (their effect on acc, if any, is entirely
                // their own business — vm.ts's EXT case doesn't model
                // accLive either) — accLive passes through unchanged.
                if(effect.terminates) return { nextPc: pc + 1, terminated: true, exitAccLive: accLive }
                pc++; continue
            }

            if(instr.op === "BR_TABLE")
            {
                requireAcc("BR_TABLE")
                let p = pc + 1
                let combinedAccLive = true
                for(let k = 0; k < instr.imm; k++)
                {
                    const caseResult = walk(p, tos, accLive)
                    p = caseResult.nextPc
                    combinedAccLive = combinedAccLive && caseResult.exitAccLive
                }
                pc = p
                // Safe regardless of which sibling case actually ran at
                // runtime only if *every* case agrees acc is live — one
                // case leaving it pending/poisoned while another leaves it
                // live would let the merged code's own belief depend on
                // which case happened to run (this file's own bottom-row
                // acc-fold hazard, one level up).
                accLive = combinedAccLive
                continue
            }

            if(instr.op === "LOOP")
            {
                const cond = walk(pc + 1, tos, accLive)
                if(cond.terminated) fail(pc, `LOOP's condition sub-block must close with BLOCK_END, not a terminator`)
                const body_ = walk(cond.nextPc, tos, cond.exitAccLive)
                pc = body_.nextPc
                // Code after the whole LOOP is reached only via the
                // condition sub-block's own exit path (isa-core.md §7.2) —
                // never via the body, which either loops back or
                // terminates on its own.
                accLive = cond.exitAccLive
                continue
            }

            // A register only becomes live once TOS has grown past it (via
            // PUSH, or the initial arg_count frame slots) — never touching
            // TOS itself doesn't mean "no constraint," it means the
            // constraint is a plain bound against whatever TOS already is.
            if((instr.op === "LOAD" || instr.op === "STORE") && instr.target >= tos)
                fail(pc, `${instr.op} ${instr.target}: register not below current TOS (${tos}) — never established by a PUSH`)

            if(isRegComboInstr(instr) && instr.target >= tos)
                fail(pc, `${instr.op} ${instr.combo} ${instr.target}: register not below current TOS (${tos}) — never established by a PUSH`)

            if(instr.op === "STORE") requireAcc("STORE")
            else if(isRegComboInstr(instr)) requireAcc(`${instr.op} ${instr.combo} ${instr.target}`)
            else if(isImmComboInstr(instr)) requireAcc(`${instr.op} #${instr.imm}`)
            else if(instr.op === "NEG" || instr.op === "NOT" || instr.op === "CLZ" || instr.op === "REVBITS") requireAcc(instr.op)

            if(instr.op === "LOAD" || instr.op === "CONST") accLive = true
            else if(isRegComboInstr(instr)) accLive = instr.combo === "REG_ACC" // REG_REG clobbers (write-back-in-place)
            else if(isImmComboInstr(instr)) accLive = true
            else if(instr.op === "NEG" || instr.op === "NOT" || instr.op === "CLZ" || instr.op === "REVBITS") accLive = true
            // STORE: acc keeps whatever it already held.

            pc++
        }
    }

    const { nextPc, terminated } = walk(0, proc.argCount, true)
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
interface Depths { totalDepth: number; maxCallDepth: number }

/** One memoized DFS yields both isa-core.md §8.3 figures at once — same
 *  recursion, same cycle guard, so `maxCallDepth` never needed a second
 *  walk of its own. `totalDepth`: `max(localPeak, max over call sites of
 *  calleeFrameBase + the callee's own totalDepth)`. `maxCallDepth`: `max(0,
 *  max over call sites of 1 + the callee's own maxCallDepth)` — the largest
 *  number of simultaneously active frames on any path, independent of how
 *  deep any one of those frames' own operand stack goes. */
function depthsOf<E extends { ext: string } = ExtOpPayload>(
    index: number,
    program: RtlProgram<E>,
    perProcedure: readonly WalkOutcome[],
    memo: Map<number, Depths>,
    visiting: Set<number>,
): Depths
{
    const cached = memo.get(index)
    if(cached !== undefined) return cached
    if(visiting.has(index)) throw new Error(`call-graph cycle detected: procedure ${index} calls itself, directly or transitively`)

    visiting.add(index)
    let totalDepth = perProcedure[index]!.localPeak
    let maxCallDepth = 0
    for(const { calleeIndex, tos } of perProcedure[index]!.callSites)
    {
        const calleeFrameBase = tos - stackArgsOf(program.procedures[calleeIndex]!.argCount)
        const callee = depthsOf(calleeIndex, program, perProcedure, memo, visiting)
        totalDepth = Math.max(totalDepth, calleeFrameBase + callee.totalDepth)
        maxCallDepth = Math.max(maxCallDepth, 1 + callee.maxCallDepth)
    }
    visiting.delete(index)

    const result: Depths = { totalDepth, maxCallDepth }
    memo.set(index, result)
    return result
}

// ─────────────────────────────────────────────────────────────────────────────

export function validateProgram<E extends { ext: string } = ExtOpPayload>(program: RtlProgram<E>, extension?: Extension<E>): ProgramStats
{
    if(program.procedures.length === 0) throw new Error(`empty program`)

    const effects = extension?.effects
    const perProcedure = program.procedures.map((proc, i) => walkProcedure(proc, program, i, effects))

    const memo = new Map<number, Depths>()
    for(let i = 0; i < program.procedures.length; i++)
        depthsOf(i, program, perProcedure, memo, new Set())

    const { totalDepth, maxCallDepth } = memo.get(0)!
    return {
        procedures: perProcedure.map(p => ({ localPeak: p.localPeak })),
        totalDepth,
        maxCallDepth,
    }
}
