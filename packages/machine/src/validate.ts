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
import { isExtInstr, isStackComboInstr, isRegComboInstr, isImmComboInstr, SHIFT_OPS } from "./rtl"
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
     *  (isa-core.md §8.7): every op either reads acc, produces a fresh
     *  value into it, or (a write-back-in-place combo, REG_REG/PEEK_PEEK,
     *  or entering a `BR_TABLE`/`LOOP` split successor) clobbers it —
     *  matching `raise.ts`'s own `this.acc = undefined` and `vm.ts`'s own
     *  dynamic tracking.
     *
     *  `commit` is false only for a probe walk that exists purely to
     *  confirm a second possible entry value doesn't fail (see `LOOP`
     *  below) — it must not append to `callSites` a second time for the
     *  same call site, so it's threaded through every recursive `walk`
     *  call and gates that one push. Nothing else needs gating: `walk`'s
     *  own structural shape (which `pc`s it visits, `terminated`,
     *  `nextPc`) never depends on `accLive`, only whether `requireAcc`
     *  throws does — so a probe walk always visits exactly the same
     *  instructions a committed walk of the same sub-block would, and
     *  `peak = Math.max(...)` below can't come out differently either. */
    function walk(pc: number, entryTos: number, entryAccLive: boolean, commit: boolean = true): { nextPc: number; terminated: boolean; exitAccLive: boolean }
    {
        let tos = entryTos
        let accLive = entryAccLive

        function requireAcc(context: string): void
        {
            if(!accLive) fail(pc, `${context}: read of acc after a write-back-in-place combo or a CFG split clobbered it (isa-core.md §8.7's acc-clobbering convention)`)
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
                if(commit) callSites.push({ calleeIndex: instr.calleeIndex, tos })
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
                    if(commit) callSites.push({ calleeIndex, tos })
                    tos -= stackArgs
                }

                tos += effect.tosDelta
                if(tos < entryTos) fail(pc, `EXT ${instr.ext}: net effect would underflow below this block's entry depth (${entryTos})`)

                // Extension ops are otherwise opaque to the core's own
                // acc-clobbering convention (their effect on acc is their
                // own business), so accLive passes through unchanged
                // unless the effect declares one of the two directions.
                // vm.ts's own EXT case reads the same two flags in the
                // same order — it has to, or this accepts programs it then
                // refuses to run.
                if(effect.readsAcc) requireAcc(`EXT ${instr.ext}`)
                if(effect.writesAcc) accLive = true

                if(effect.terminates) return { nextPc: pc + 1, terminated: true, exitAccLive: accLive }
                pc++; continue
            }

            if(instr.op === "BR_TABLE")
            {
                requireAcc("BR_TABLE")
                let p = pc + 1
                for(let k = 0; k < instr.imm; k++)
                {
                    // isa-core.md §8.7: a split clobbers acc unconditionally
                    // — each case is a split successor, so it starts dead
                    // regardless of what was live going into the dispatch.
                    p = walk(p, tos, false, commit).nextPc
                }
                pc = p
                // And acc is dead *after* the whole construct too, however
                // the cases end (isa-core.md §8.7). Carrying a value past
                // the merge would need every incoming edge to establish it,
                // and §4.5's implicit default (`acc >= N` runs no case at
                // all) is the one edge in this ISA that holds no
                // instructions — pure fall-through from the split point,
                // with nowhere to put the value. So this is a local
                // property of the opcode: no case's exit liveness is
                // consulted, and nothing here ever has to reason about
                // whether `acc >= N` can actually happen. Same treatment
                // LOOP's exit gets below.
                accLive = false
                continue
            }

            if(instr.op === "LOOP")
            {
                // Entering the condition sub-block for the first time
                // (from before LOOP) is ordinary sequential flow, not a
                // split successor — it inherits whatever accLive already
                // was. The body, though, IS a split successor of the
                // condition's own branch decision (isa-core.md §8.7), so
                // it always starts dead, regardless of what the condition
                // itself leaves behind.
                const cond = walk(pc + 1, tos, accLive, commit)
                if(cond.terminated) fail(pc, `LOOP's condition sub-block must close with BLOCK_END, not a terminator`)
                // That BLOCK_END is the loop's own continue/exit dispatch
                // (§4.5), and a dispatch reads acc (§8.7) — same
                // requirement BR_TABLE's own requireAcc above imposes,
                // just carried by the sub-block's exit rather than by the
                // opener.
                if(!cond.exitAccLive)
                    fail(cond.nextPc - 1, `LOOP condition sub-block's BLOCK_END: read of acc after a write-back-in-place combo or a CFG split clobbered it (isa-core.md §8.7's acc-clobbering convention)`)
                const body_ = walk(cond.nextPc, tos, false, commit)
                if(!body_.terminated && body_.exitAccLive !== accLive)
                {
                    // A real back-edge exists, and it feeds the condition
                    // sub-block a different entry value than the external
                    // one just walked above (accLive is boolean, so this
                    // is the only other value that could ever reach it on
                    // iteration 2+). Confirm the condition sub-block
                    // doesn't fail under that entry either — probe-only,
                    // so nested call sites aren't double-counted. Bounded
                    // to one extra walk, never a fixed-point search.
                    const reentry = walk(pc + 1, tos, body_.exitAccLive, false)
                    if(!reentry.exitAccLive)
                        fail(reentry.nextPc - 1, `LOOP condition sub-block's BLOCK_END: read of acc, dead on the back-edge's own entry (isa-core.md §8.7's acc-clobbering convention)`)
                }
                pc = body_.nextPc
                // Code after the whole LOOP is reached only via the
                // condition sub-block's own external-entry exit path
                // (isa-core.md §7.2, §8.7) — never via the body or its
                // back-edge, and the exit is itself a split successor of
                // the condition's branch, so it starts dead too.
                accLive = false
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

            // isa-core.md §4.1 defines a shift only for amounts 0..31;
            // outside that the result is unspecified, and a projection is
            // free to produce whatever its target's shift instruction does
            // (ARMv6-M's register form reads Rm[7:0], a JS `<<` masks to
            // five). The immediate combo carries the amount right here, so
            // that whole compile-time half of the class is a load-time
            // error instead of a divergence nobody would notice until two
            // projections of the same program disagreed. The register,
            // peek and pop combos cannot be checked here and stay
            // unspecified by design.
            if(isImmComboInstr(instr) && SHIFT_OPS.has(instr.op) && (instr.imm < 0 || instr.imm > 31))
                fail(pc, `${instr.op} #${instr.imm}: shift amount outside 0..31, where the result is unspecified (isa-core.md §4.1) — mask it in the program if it can genuinely exceed 31`)

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

    // isa-core.md §4.6 puts a value in acc on entry only when the procedure
    // takes at least one argument — "the *last* argument (if N >= 1) stays
    // in acc". With none, nothing has established acc, so it starts *dead*
    // and a body that reads it before writing it is a validation error.
    //
    // This used to pass `true` unconditionally, which made
    // `{argCount: 0, body: [RETURN]}` a valid program with no defined
    // result: vm.ts seeds such a frame's acc to 0, while jit-armv6m's
    // translateProc emits no entry flush and so returns whatever the
    // *caller* left in ACC_REG. Found by fuzz/qemu_exec as exactly that
    // divergence — the reference VM returning 0 where the emitted code
    // returned the caller's own leftover accumulator.
    const { nextPc, terminated } = walk(0, proc.argCount, proc.argCount >= 1)
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
