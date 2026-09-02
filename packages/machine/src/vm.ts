/**
 * @ppl/machine — Minimal Core VM
 *
 * A single-pass, structured-control-flow interpreter — no pre-scan, no
 * precomputed jump table. A live control stack of "open blocks" tells
 * `BLOCK_END` what it's closing; branch targets it can't reach by falling
 * through (an untaken `BR_TABLE` case, a loop's exit) are found by scanning
 * forward from where we are, on demand.
 *
 * One call to `runProc` executes exactly one procedure: all its state (pc,
 * acc, registers, TOS, the control stack) is local to that call. A nested
 * `CALL` is just a nested recursive call to `runProc` against
 * `program.procedures[calleeIndex]` — `calleeIndex` is already a resolved
 * table index by the time the VM sees it (lower.ts's job, ROADMAP.md item
 * 2), so this layer never does any name resolution of its own. `RETURN`
 * and `TRAP` need no bookkeeping beyond a plain `return`/`throw`:
 * unwinding the JS call stack unwinds the control stack with it, which is
 * exactly the ISA's "a terminator closes its block on its own" rule
 * (isa-core.md §4.5, §7.2) for free. A cyclic call graph (isa-core.md §8.2
 * forbids one, but that's checked by the whole-program validator, not
 * built yet) recurses here exactly as a cyclic call would in any
 * interpreter — there is no cycle guard at this layer, only `MAX_STEPS`
 * bounding each individual procedure's own instruction loop.
 *
 * Designed as an oracle for testing — correctness and clarity over
 * performance. Malformed IR (a stray `BLOCK_END`, an unknown opcode) throws
 * a plain `Error`, not a magic trap code — that's a bug in whatever
 * produced the IR, not a program-level trap.
 */

import assert from "assert"
import type {RtlProgram, RtlProc, RtlInstr, ExtOpPayload} from "./rtl"
import type {Extension, ExtOpEffect} from "./extension"
import {accOutOf} from "./extension"

const MAX_STEPS = 10_000_000

/** Thrown by `TRAP`, caught once at the top of `run`.
 *
 *  `depth` is how many frames down from the entry procedure the trap fired:
 *  0 for the entry procedure itself, 1 for something it called, and so on.
 *  Reported rather than discarded because a consumer using this VM as an
 *  oracle may be checking a backend that only agrees with it at depth 0 —
 *  a trap that returns instead of unwinding looks identical to a normal
 *  return one frame up. jit-armv6m was such a backend until runtime.S grew
 *  a trapHelper; nothing in this repo needs the distinction now, and the
 *  value is cheap enough to keep for the next such backend. */
class Trap
{
    constructor(readonly code: number, readonly steps: number, readonly depth: number = 0) {}
}

/** The `MAX_STEPS` watchdog tripping — its own type rather than a plain
 *  `Error`, because it is emphatically *not* the same kind of event as the
 *  malformed-IR throws around it. isa-core.md §9 is explicit that
 *  termination is not guaranteed ("a `LOOP` whose condition block never
 *  tests false runs indefinitely. The ISA promises bounded resource usage,
 *  not termination"), so a program that trips this is legal, and a caller
 *  using this VM as an oracle needs to tell "the interpreter gave up on a
 *  legal non-terminating program" apart from "the interpreter disagrees
 *  with the validator", which is a real bug. Distinguishing them by
 *  message text is the alternative, and it silently stops working the
 *  moment the wording changes. */
export class StepLimitExceeded extends Error
{
    constructor(readonly steps: number)
    {
        super(`exceeded ${steps} steps — termination is not guaranteed (isa-core.md §9), so this may be a legitimately non-terminating program`)
        this.name = "StepLimitExceeded"
    }
}

/** A shift whose amount is outside `0..31`, where isa-core.md §4.1 leaves
 *  the result unspecified.
 *
 *  Its own type, and emphatically *not* a `Trap`: a trap is a program-level
 *  event with a code that every projection must agree on, and no projection
 *  will ever raise this one — the ARM backend just lets the hardware shift
 *  by `Rm[7:0]`, a JS backend lets `<<` mask to five bits. This is the
 *  oracle refusing to invent an answer, so that a differential harness sees
 *  "there is nothing to compare here" rather than a manufactured mismatch
 *  against whichever value this VM happened to pick. Malformed IR still
 *  throws a plain `Error`: an out-of-range *dynamic* amount is a legal
 *  program, just one whose result no projection owes another. The
 *  compile-time half of the class never reaches here at all — validate.ts
 *  rejects an out-of-range immediate amount outright. */
export class UnspecifiedShiftAmount extends Error
{
    constructor(readonly op: string, readonly amount: number)
    {
        super(`${op} by ${amount >>> 0}: shift amounts outside 0..31 have an unspecified result (isa-core.md §4.1) — this VM will not invent one`)
        this.name = "UnspecifiedShiftAmount"
    }
}

/** Exported for reuse by raise.ts's own test suite (a differential check
 *  against this exact opcode semantics, not a second hand-copied
 *  implementation that could quietly drift from it) — no other consumer. */
export function evalBinary(L: number, R: number, op: RtlInstr["op"]): number
{
    switch(op)
    {
        case "ADD": return (L + R) >>> 0
        case "SUB": return (L - R) >>> 0
        case "RSUB": return (R - L) >>> 0
        case "MUL": return Math.imul(L, R) >>> 0
        case "AND": return L & R
        case "OR": return L | R
        case "XOR": return L ^ R
        // The `> 31` guard makes the `& 31` beside it redundant, and both
        // stay: the guard is the semantics (isa-core.md §4.1 defines
        // `0..31` and nothing else), the mask is only JS's own `<<`
        // behaviour spelled out rather than left implicit. A negative
        // amount arrives as a large unsigned one and is rejected the same
        // way.
        case "SHL": case "SHR": case "ASR":
            if((R >>> 0) > 31) throw new UnspecifiedShiftAmount(op, R)
            return op === "SHL" ? (L << (R & 31)) >>> 0
                 : op === "SHR" ? L >>> (R & 31)
                 :                (L >> (R & 31)) >>> 0
        case "EQ": return (L === R) ? 1 : 0
        case "NE": return (L !== R) ? 1 : 0
        case "LT_S": return ((L | 0) < (R | 0)) ? 1 : 0
        case "LE_S": return ((L | 0) <= (R | 0)) ? 1 : 0
        case "GT_S": return ((L | 0) > (R | 0)) ? 1 : 0
        case "GE_S": return ((L | 0) >= (R | 0)) ? 1 : 0
        case "LT_U": return (L < R) ? 1 : 0
        case "LE_U": return (L <= R) ? 1 : 0
        case "GT_U": return (L > R) ? 1 : 0
        case "GE_U": return (L >= R) ? 1 : 0
        default: return 0
    }
}

/** Exported for the same reason as evalBinary above. */
export function evalUnary(V: number, op: RtlInstr["op"]): number
{
    switch(op)
    {
        case "NEG": return (-V) >>> 0
        case "NOT": return (~V) >>> 0
        case "CLZ": return Math.clz32(V)
        case "SXTB": return ((V << 24) >> 24) >>> 0
        case "SXTH": return ((V << 16) >> 16) >>> 0
        case "UXTB": return V & 0xff
        case "UXTH": return V & 0xffff
        case "REVBITS":
        {
            let x = V
            x = ((x & 0x55555555) << 1) | ((x >>> 1) & 0x55555555)
            x = ((x & 0x33333333) << 2) | ((x >>> 2) & 0x33333333)
            x = ((x & 0x0F0F0F0F) << 4) | ((x >>> 4) & 0x0F0F0F0F)
            x = ((x & 0x00FF00FF) << 8) | ((x >>> 8) & 0x00FF00FF)
            return ((x << 16) | (x >>> 16)) >>> 0
        }
        default: return 0
    }
}

// ── Skipping over not-taken blocks ──────────────────────────────────────────
//
// A "block" is one BR_TABLE case-body or one LOOP sub-block: a run of
// instructions ending at its own BLOCK_END or terminator. Skipping a nested
// BR_TABLE/LOOP requires skipping *all* of its own sub-blocks first — a flat
// nesting counter gets this wrong for a BR_TABLE with more than one case, so
// this is real (if shallow) recursive descent, mirroring the grammar
// directly: "skip a construct" = skip its N case-blocks or its 2 loop
// sub-blocks; "skip a block" = advance until a BLOCK_END/terminator at this
// level, skipping any nested construct whole along the way.

function skipConstruct<E extends { ext: string } = ExtOpPayload>(body: RtlInstr<E>[], pc: number): number
{
    const opener = body[pc]
    if(opener.op === "BR_TABLE") return skipBlocks(body, pc + 1, opener.imm + 1)
    // LOOP: condition block + body block.
    return skipBlocks(body, pc + 1, 2)
}

/** Skip over `count` sibling blocks starting at `pc`; return the pc just
 *  past the last one. `count === 0` is a no-op (already past the last). */
function skipBlocks<E extends { ext: string } = ExtOpPayload>(body: RtlInstr<E>[], pc: number, count: number): number
{
    let p = pc
    for(let k = 0; k < count; k++)
    {
        for(;;)
        {
            if(p >= body.length) throw new Error(`ran off the end of the procedure body while skipping`)
            const i = body[p]
            if(i.op === "BR_TABLE" || i.op === "LOOP") { p = skipConstruct(body, p); continue }
            p++
            if(i.op === "BLOCK_END" || i.op === "FALLTHROUGH" || i.op === "RETURN" || i.op === "TRAP") break
        }
    }
    return p
}

// ── The control stack ───────────────────────────────────────────────────────
//
// What BLOCK_END does depends on what's on top: closing a BR_TABLE case
// falls through past the remaining sibling cases; closing a LOOP's
// condition block either exits (skip the body block) or enters it;
// closing a LOOP's body block is an unconditional back-edge to the opener.

type BlockFrame =
    | {kind: "case"; remaining: number; entryTos: number}
    | {kind: "loopCond"; loopPc: number; entryTos: number}
    | {kind: "loopBody"; loopPc: number; entryTos: number}

/** Run one procedure to completion. All VM state is local to this call —
 *  a nested CALL is just a nested call to this function, against
 *  `program`'s procedure table. */
function runProc<E extends { ext: string } = ExtOpPayload>(program: RtlProgram<E>, proc: RtlProc<E>, args: readonly number[], extension?: Extension<E>, maxSteps: number = MAX_STEPS, depth: number = 0): {acc: number; steps: number}
{
    const body = proc.body
    const regs: number[] = [...args]
    let tos = args.length
    // isa-core.md §4.6: the callee's *last* argument arrives in acc as well
    // as in its own frame slot r(N-1) — the caller left it sitting there
    // rather than pushing it, which is the whole point of the convention.
    // Seeding acc to 0 instead made every callee that reads acc before
    // writing it compute with 0: `CALL` a one-argument procedure whose body
    // is `MUL REG_ACC r0` and this VM returned 0 where the real emitted
    // Thumb returned x*x. jit-armv6m's translateProc flushes the incoming
    // acc into r(N-1) at entry precisely because it is already there.
    let acc = args.length > 0 ? args[args.length - 1]! : 0
    // Poisoned by a write-back-in-place combo (REG_REG/PEEK_PEEK) or by
    // entering a BR_TABLE/LOOP split successor (isa-core.md §8.7) — matches
    // raise.ts's own `this.acc = undefined`. `acc` itself stays a plain
    // `number` (whatever it last held) so reading it while poisoned still
    // throws instead of silently returning a stale, bit-accurate-by-luck
    // value.
    let accLive = true
    let pc = 0
    let steps = 0
    const ctrl: BlockFrame[] = []

    function requireAccLive(context: string): void
    {
        assert.ok(accLive, `${context}: read of acc after a write-back-in-place combo or a CFG split clobbered it (isa-core.md §8.7's acc-clobbering convention)`)
    }

    // The state surface an extension's `exec` is allowed to touch — no pc,
    // no control stack, since a generic extension op is straight-line by
    // construction (isa-core.md §5.1).
    // The op currently inside `exec`, so the accessors below can hold it to
    // its own §11.2 declaration. `extEffect` is undefined for an exec-only
    // extension (`effects` is optional on Extension), which is the one
    // configuration that keeps the unchecked pre-declaration behavior.
    let extName = ""
    let extEffect: ExtOpEffect<E> | undefined
    let extWroteAcc = false

    const extState = {
        get acc()
        {
            assert.ok(!extEffect || extEffect.readsAcc, `EXT ${extName}: exec reads acc without declaring readsAcc`)
            return acc
        },
        set acc(v: number)
        {
            assert.ok(!extEffect || extEffect.writesAcc, `EXT ${extName}: exec writes acc without declaring writesAcc`)
            extWroteAcc = true
            acc = v >>> 0
        },
        push(value: number) {regs[tos++] = value >>> 0},
        pop(): number {assert.ok(tos > 0, `EXT: pop with empty stack`); return regs[--tos] ?? 0},
        reg(index: number): number {return regs[index] ?? 0},
        setReg(index: number, value: number) {regs[index] = value >>> 0},
        // Mirrors the "CALL" case below exactly — resolve by table index,
        // run to completion in a fresh nested frame, fold its step count
        // into this call's own so MAX_STEPS still bounds total work
        // through a call-shaped extension op.
        callProc(calleeIndex: number, callArgs: readonly number[]): number
        {
            const callee = program.procedures[calleeIndex]
            if(!callee) throw new Error(`EXT callProc: no such procedure ${calleeIndex}`)
            const result = runProc(program, callee, callArgs, extension, maxSteps, depth + 1)
            steps += result.steps
            return result.acc
        },
    }

    function operand(i: RtlInstr<E>): number
    {
        if(!("combo" in i)) return 0
        switch(i.combo)
        {
            case "REG_ACC":
            case "REG_REG":
                assert.ok(i.target < tos, `${i.op} ${i.combo}: register ${i.target} not below current TOS (${tos})`)
                return regs[i.target]!
            case "IMM_ACC":
                return i.imm
            case "PEEK_PEEK":
                assert.ok(tos > 0, `peek with empty stack`)
                return regs[tos - 1] ?? 0
            case "POP_ACC":
                assert.ok(tos > 0, `pop with empty stack`)
                return regs[--tos] ?? 0
        }
    }

    function writeResult(i: RtlInstr<E>, value: number): void
    {
        const v = value >>> 0
        if(!("combo" in i)) { acc = v; accLive = true; return }
        switch(i.combo)
        {
            case "REG_ACC": case "IMM_ACC": case "POP_ACC":
                acc = v; accLive = true; break
            case "REG_REG":
                assert.ok(i.target < tos, `${i.op} ${i.combo}: register ${i.target} not below current TOS (${tos})`)
                regs[i.target] = v; accLive = false; break
            case "PEEK_PEEK":
                regs[tos - 1] = v; accLive = false; break
        }
    }

    for(;;)
    {
        if(++steps > maxSteps) throw new StepLimitExceeded(maxSteps)
        if(pc >= body.length) throw new Error(`fell off the end of the procedure body with no RETURN`)

        const i = body[pc]

        switch(i.op)
        {
            case "LOAD":
                assert.ok(i.target < tos, `LOAD: register ${i.target} not below current TOS (${tos})`)
                acc = regs[i.target]!
                accLive = true
                pc++
                break

            case "STORE":
                assert.ok(i.target < tos, `STORE: register ${i.target} not below current TOS (${tos})`)
                requireAccLive("STORE")
                regs[i.target] = acc
                pc++
                break

            case "PUSH":
                requireAccLive("PUSH")
                regs[tos++] = acc
                pc++
                break

            case "CONST":
                acc = i.imm >>> 0
                accLive = true
                pc++
                break

            case "ADD": case "SUB": case "RSUB": case "MUL":
            case "AND": case "OR": case "XOR": case "SHL": case "SHR": case "ASR":
            case "EQ": case "NE":
            case "LT_S": case "LE_S": case "GT_S": case "GE_S":
            case "LT_U": case "LE_U": case "GT_U": case "GE_U":
                requireAccLive(`${i.op} ${"combo" in i ? i.combo : ""}`)
                writeResult(i, evalBinary(acc, operand(i), i.op))
                pc++
                break

            case "NEG": case "NOT": case "CLZ": case "REVBITS":
            case "SXTB": case "SXTH": case "UXTB": case "UXTH":
                requireAccLive(i.op)
                acc = evalUnary(acc, i.op)
                pc++
                break

            case "RETURN":
                requireAccLive("RETURN")
                return {acc, steps}

            case "TRAP":
                throw new Trap(i.imm, steps, depth)

            case "BR_TABLE": {
                requireAccLive("BR_TABLE")
                const N = i.imm

                // isa-core.md §4.5: N indexed cases plus the default case,
                // so every value of acc selects one of the N+1 blocks.
                const taken = acc >= N ? N : acc

                // A selected case is a split successor, so it starts dead
                // regardless of what was live going into the dispatch.
                accLive = false
                pc = skipBlocks(body, pc + 1, taken) // skip cases before the selected one
                ctrl.push({kind: "case", remaining: N - taken, entryTos: tos})
                break
            }

            case "LOOP":
                ctrl.push({kind: "loopCond", loopPc: pc, entryTos: tos})
                pc++
                break

            case "FALLTHROUGH": {
                const top = ctrl.pop()
                if(!top) throw new Error(`FALLTHROUGH at ${pc}: no open block`)
                if(top.kind !== "case") throw new Error(`FALLTHROUGH at ${pc}: not closing a dispatch case`)
                if(top.remaining === 0) throw new Error(`FALLTHROUGH at ${pc}: no next case to continue into`)

                assert.ok(tos >= top.entryTos, `TOS underflow at FALLTHROUGH ${pc}: below block entry depth`)
                tos = top.entryTos

                // The next case's body starts right here, and it is a split
                // successor like any other case, so it starts dead.
                accLive = false
                ctrl.push({kind: "case", remaining: top.remaining - 1, entryTos: top.entryTos})
                pc++
                break
            }

            case "BLOCK_END": {
                const top = ctrl.pop()
                if(!top) throw new Error(`BLOCK_END at ${pc}: no open block`)

                // §8.1: any TOS surplus above the block's entry depth is
                // implicitly dropped here — the producer never emits its
                // own cleanup pops, this is the "block boundary handles it"
                // the spec promises.
                assert.ok(tos >= top.entryTos, `TOS underflow at BLOCK_END ${pc}: below block entry depth`)
                tos = top.entryTos

                if(top.kind === "case")
                {
                    // acc crosses the merge as this case left it: every
                    // edge in is a case body, so there is no valueless one
                    // to meet against (isa-core.md §8.7).
                    pc = skipBlocks(body, pc + 1, top.remaining) // past any sibling cases
                    break
                }
                if(top.kind === "loopCond")
                {
                    requireAccLive("LOOP condition")
                    // isa-core.md §8.7: both successors of this split — the
                    // exit and the body — start dead, regardless of what
                    // the condition itself left behind.
                    accLive = false
                    if(acc === 0) { pc = skipBlocks(body, pc + 1, 1); break } // exit: skip the body block
                    ctrl.push({kind: "loopBody", loopPc: top.loopPc, entryTos: top.entryTos})
                    pc++
                    break
                }
                // loopBody: unconditional back-edge to the opener, which
                // re-enters the condition block.
                pc = top.loopPc
                break
            }

            case "CALL": {
                const callee = program.procedures[i.calleeIndex]
                if(!callee) throw new Error(`CALL ${i.calleeIndex}: no such procedure`)

                // §4.6: the caller has already pushed the callee's first
                // `stackArgs` arguments, in order — they become r0..r(N-2);
                // the *last* argument (if any) is `acc` itself, becoming
                // r(N-1) directly, no stack involvement. A 0-argument
                // callee touches neither.
                const stackArgs = Math.max(callee.argCount - 1, 0)
                assert.ok(tos >= stackArgs,
                    `CALL ${i.calleeIndex}: only ${tos} value(s) on the stack, need ${stackArgs}`)
                if(callee.argCount > 0) requireAccLive(`CALL ${i.calleeIndex}`)
                tos -= stackArgs
                const callArgs = callee.argCount === 0 ? [] : [...regs.slice(tos, tos + stackArgs), acc]

                const result = runProc(program, callee, callArgs, extension, maxSteps, depth + 1)
                acc = result.acc
                accLive = true
                steps += result.steps
                pc++
                break
            }

            case "EXT":
            {
                if(!extension?.exec) throw new Error(`EXT ${i.ext}: no extension registered to execute it`)

                // The same declarations validate.ts's own EXT case reads,
                // honored here in the same order and for the same reason:
                // an extension op is opaque to the acc-clobbering
                // convention (isa-core.md §8.7) *except* where its effect
                // speaks, and both halves have to believe the same thing
                // about acc or the validator accepts programs the VM then
                // refuses to run. That failed once already: the codec
                // extension's TAG assigns `state.acc` and once didn't say
                // so, so validate.ts had acc live where runProc still
                // believed an upstream `OR REG_REG` had poisoned it.
                //
                // Which is what `extState`'s accessors are for — the
                // declaration is checked against what `exec` actually does,
                // rather than trusted. A missing declaration is not fatal
                // here, unlike in validate.ts: a caller may register an
                // exec-only extension, and that path keeps the unchecked
                // pass-acc-through-unchanged behavior.
                const effect = extension.effects?.[i.ext]
                if(effect?.readsAcc) requireAccLive(`EXT ${i.ext}`)

                extName = i.ext
                extEffect = effect
                extWroteAcc = false
                extension.exec(i, extState)
                extEffect = undefined

                if(effect)
                {
                    const accOut = accOutOf(effect, `EXT ${i.ext}`)
                    if(accOut === "write")
                    {
                        assert.ok(extWroteAcc, `EXT ${i.ext}: declares writesAcc but exec left acc unassigned`)
                        accLive = true
                    }
                    else if(accOut === "kill") accLive = false
                }
                pc++
                break
            }

            default:
                throw new Error(`unhandled opcode ${(i as {op: string}).op} at pc ${pc}`)
        }
    }
}

export interface VmResult
{
    acc: number
    ok: boolean
    trapCode: number | null
    /** How many frames below the entry procedure the trap fired, or null if
     *  the program returned normally. 0 means the entry procedure trapped.
     *  See `Trap.depth` for who this is for. */
    trapDepth: number | null
    steps: number
}

/** `args` seeds the entry procedure's own frame, defaulting to none. It
 *  exists because a real target's entry point does take arguments —
 *  jit-armv6m's `enterProgram*` takes this same vector — so without it
 *  there is no reference result to compare an argument-taking entry
 *  procedure against, and jit-armv6m/fuzz/qemu_exec would have to discard
 *  every program with one. Must match the entry procedure's own argCount,
 *  same as any CALL. */
export function run<E extends { ext: string } = ExtOpPayload>(prog: RtlProgram<E>, extension?: Extension<E>, args: readonly number[] = [], maxSteps: number = MAX_STEPS): VmResult
{
    if(prog.procedures.length === 0) throw new Error(`empty program`)

    try
    {
        const {acc, steps} = runProc(prog, prog.procedures[0], args, extension, maxSteps, 0)
        return {acc, ok: true, trapCode: null, trapDepth: null, steps}
    }
    catch(e)
    {
        if(e instanceof Trap) return {acc: 0, ok: false, trapCode: e.code, trapDepth: e.depth, steps: e.steps}
        throw e
    }
}
