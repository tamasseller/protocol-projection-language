/**
 * @ppl/core/machine — Minimal Core VM
 *
 * Interprets a ResolvedProgram with structured control flow. Uses a two-pass
 * pre-scan to resolve all jump targets so the main interpreter loop is a
 * simple switch with direct PC assignments.
 *
 * Designed as an oracle for testing — correctness over performance.
 */

import assert from "assert"
import type {RtlProgram as ResolvedProgram, RtlInstr as ResolvedInstr} from "./rtl"

// NOTE: this VM has not yet been updated for the two-block `LOOP` construct
// (isa-core.md §14.2 — a LOOP now opens a condition sub-block and a body
// sub-block, each with its own BLOCK_END, rather than testing `acc` at the
// opener) or for CALL's name-based callee (RtlInstr's `callee` is a
// procedure name, not a resolved table index). Both are known-stale;
// fixing them is tracked as separate follow-up work, not done here.

const MAX_STEPS = 10_000_000

interface BlockMap
{
    loopEnds: Map<number, number>
    brEnds: Map<number, number>
    blockOwners: Map<number, {kind: "loop" | "br"; openerPc: number}>
}

function buildBlockMap(body: ResolvedInstr[]): BlockMap
{
    const bm: BlockMap = {
        loopEnds: new Map(),
        brEnds: new Map(),
        blockOwners: new Map(),
    }

    type SE = {kind: "loop"; openerPc: number} | {kind: "br"; openerPc: number; remaining: number}
    const stack: SE[] = []

    for(let pc = 0; pc < body.length; pc++)
    {
        const i = body[pc]
        if(i.op === "LOOP") {stack.push({kind: "loop", openerPc: pc})}
        else if(i.op === "BR_TABLE")
        {
            const N = (i as {imm: number}).imm
            stack.push({kind: "br", openerPc: pc, remaining: N})
        }
        else if(i.op === "BLOCK_END")
        {
            if(stack.length === 0) throw new Error(`BLOCK_END at ${pc}: empty stack`)
            const top = stack[stack.length - 1]
            if(top.kind === "br")
            {
                bm.blockOwners.set(pc, {kind: "br", openerPc: top.openerPc})
                top.remaining--
                if(top.remaining === 0) stack.pop()
            }
            else
            {
                bm.blockOwners.set(pc, {kind: "loop", openerPc: top.openerPc})
                bm.loopEnds.set(top.openerPc, pc)
                stack.pop()
            }
        }
        else if(i.op === "RETURN" || i.op === "TRAP")
        {
            // Terminators close the innermost BR_TABLE case (if any).
            if(stack.length > 0 && stack[stack.length - 1]!.kind === "br")
            {
                const top = stack[stack.length - 1]!
                if(top.kind === "br")
                {
                    top.remaining--
                    if(top.remaining === 0) stack.pop()
                }
            }
        }
    }

    // BR_TABLE construct ends
    for(let pc = 0; pc < body.length; pc++)
    {
        if(body[pc].op === "BR_TABLE")
        {
            const N = (body[pc] as {imm: number}).imm
            let endPc = pc + 1, found = 0, nest = 0
            while(found < N && endPc < body.length)
            {
                const i = body[endPc]
                if(i.op === "LOOP" || i.op === "BR_TABLE") nest++
                else if(i.op === "BLOCK_END") {if(nest === 0) found++; else nest--}
                else if(i.op === "RETURN" || i.op === "TRAP")
                {if(nest === 0) found++}
                endPc++
            }
            bm.brEnds.set(pc, endPc)
        }
    }

    return bm
}

// ── VM ──────────────────────────────────────────────────────────────────────

class VmState
{
    prog!: ResolvedProgram
    body!: ResolvedInstr[]
    jumps!: BlockMap

    regs: number[] = [];
    acc = 0;
    tos = 0;
    pc = 0;
    stepCount = 0

    callStack: {retPc: number; retProc: number; savedTos: number; savedRegs: number[]}[] = []

    halted = false;
    trapCode: number | null = null

    ensureRegs(n: number): void 
    {
        while(this.regs.length < n) this.regs.push(0)
    }
}

function oVal(vm: VmState, i: ResolvedInstr): number
{
    if(!("combo" in i)) return 0
    switch(i.combo)
    {
        case "REG_ACC":
        case "REG_REG":
            return vm.regs[i.target] ?? 0
        case "IMM_ACC":
            return i.imm
        case "PEEK_ACC":
        case "PEEK_PEEK":
        case "PEEK_PUSH":
            assert.ok(vm.tos > 0, `PEEK/POP with empty stack`)
            return vm.regs[vm.tos - 1] ?? 0
        case "POP_ACC":
            assert.ok(vm.tos > 0, `POP with empty stack`)
            return vm.regs[--vm.tos] ?? 0
        default: return 0
    }
}

function wRes(vm: VmState, i: ResolvedInstr, value: number): void
{
    const v = value >>> 0
    if(!("combo" in i)) {vm.acc = v; return }
    switch(i.combo)
    {
        case "REG_ACC":
        case "IMM_ACC":
        case "POP_ACC":
        case "PEEK_ACC":
            vm.acc = v; break
        case "REG_REG":
            vm.ensureRegs(i.target + 1); vm.regs[i.target] = v; break
        case "PEEK_PEEK":
            vm.regs[vm.tos - 1] = v; break
        case "PEEK_PUSH":
            vm.ensureRegs(vm.tos + 1); vm.regs[vm.tos++] = v; break
    }
}

function evalBinary(L: number, R: number, op: ResolvedInstr["op"]): number
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
        case "SHL": return (L << (R & 31)) >>> 0
        case "SHR": return L >>> (R & 31)
        case "ASR": return (L >> (R & 31)) >>> 0
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

function evalUnary(V: number, op: ResolvedInstr["op"]): number
{
    switch(op)
    {
        case "NEG": return (-V) >>> 0
        case "NOT": return (~V) >>> 0
        case "CLZ": return Math.clz32(V)
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

function step(vm: VmState): boolean
{
    if(vm.pc >= vm.body.length) 
    {
        vm.trapCode = -1; return false
    }

    const i = vm.body[vm.pc]

    if(MAX_STEPS < ++vm.stepCount)
    {
        vm.trapCode = -2
        return false
    }

    switch(i.op)
    {
        case "MOVE": {
            const rd = i.combo === "REG_ACC" || i.combo === "IMM_ACC" || i.combo === "PEEK_ACC" || i.combo === "POP_ACC"
            wRes(vm, i, rd ? oVal(vm, i) : vm.acc)
            vm.pc++
            return true
        }
        case "ADD":
        case "SUB":
        case "RSUB":
        case "MUL":
        case "AND":
        case "OR":
        case "XOR":
        case "SHL":
        case "SHR":
        case "ASR":
        case "EQ":
        case "NE":
        case "LT_S":
        case "LE_S":
        case "GT_S":
        case "GE_S":
        case "LT_U":
        case "LE_U":
        case "GT_U":
        case "GE_U": {
            wRes(vm, i, evalBinary(vm.acc, oVal(vm, i), i.op))
            vm.pc++
            return true
        }
        case "NEG":
            vm.acc = evalUnary(vm.acc, i.op)
            vm.pc++
            return true
        case "NOT":
            vm.acc = evalUnary(vm.acc, i.op)
            vm.pc++
            return true
        case "CLZ":
            vm.acc = evalUnary(vm.acc, i.op)
            vm.pc++
            return true
        case "REVBITS":
            vm.acc = evalUnary(vm.acc, i.op)
            vm.pc++
            return true
        case "RETURN":
            if(vm.callStack.length === 0)
            {
                vm.halted = true
                return false
            }

            const f = vm.callStack.pop()!
            vm.pc = f.retPc
            vm.tos = f.savedTos
            vm.regs = f.savedRegs
            vm.body = vm.prog.procedures[f.retProc].body
            vm.jumps = buildBlockMap(vm.body)
            return true

        case "TRAP": vm.trapCode = i.imm
            return false
        case "LOOP":
            if(vm.acc === 0) 
            {
                vm.pc = vm.jumps.loopEnds.get(vm.pc)! + 1
                return true
            } vm.pc++

            return true
        case "BLOCK_END": {
            const o = vm.jumps.blockOwners.get(vm.pc)
            if(!o)
            {
                vm.trapCode = -5
                return false
            }
            if(o.kind === "loop")
            {
                vm.pc = o.openerPc
                return true
            }
            const ep = vm.jumps.brEnds.get(o.openerPc)
            if(ep === undefined) 
            {
                vm.trapCode = -10
                return false
            }
            vm.pc = ep
            return true
        }
        case "BR_TABLE": {
            const N = i.imm
            const ep = vm.jumps.brEnds.get(vm.pc)
            if(ep === undefined) 
            {
                vm.trapCode = -6
                return false
            }

            if(vm.acc >= N)
            {
                vm.pc = ep; return true
            }

            let t = vm.pc + 1, nd = 0, ix = 0

            while(t < vm.body.length && ix < vm.acc) 
            {
                const bi = vm.body[t]
                if(bi.op === "LOOP" || bi.op === "BR_TABLE") nd++
                else if(bi.op === "BLOCK_END")
                {
                    if(nd === 0)
                        ix++
                    else
                        nd--
                }
                else if(bi.op === "RETURN" || bi.op === "TRAP")
                {
                    if(nd === 0) ix++
                } t++
            }

            vm.pc = t
            return true
        }
        case "CALL": {
            // `i.callee` is a procedure *name* (RtlInstr, rtl.ts), and there
            // is no name→index resolution step yet (see file-level note
            // above) — trap rather than comparing a string against
            // `procedures.length` as if it were an already-resolved index.
            vm.trapCode = -8
            return false
        }
        default:
            vm.trapCode = -3
            return false
    }
}

export interface VmResult 
{
    acc: number
    ok: boolean
    trapCode: number | null
    steps: number
}

export function run(prog: ResolvedProgram): VmResult
{
    if(prog.procedures.length === 0) 
    {
        return {acc: 0, ok: false, trapCode: -9, steps: 0}
    }

    const e = prog.procedures[0]
    const vm = new VmState()

    vm.prog = prog
    vm.body = e.body
    vm.jumps = buildBlockMap(vm.body)

    // Locals are no longer pre-sized: single-pass allocation (lower.ts)
    // pushes each local's initializer onto TOS as its declaration executes,
    // growing the register file lazily via `ensureRegs` — there is no
    // upfront local count to reserve.
    vm.ensureRegs(e.argCount)
    vm.tos = e.argCount

    while(step(vm)) {}

    return {acc: vm.acc, ok: vm.halted, trapCode: vm.trapCode, steps: vm.stepCount}
}
