/**
 * @ppl/machine — Structured-form reconstruction ("raise")
 *
 * The inverse of lower.ts: turns a flat RtlProc.body back into a nested
 * statement/expression tree, so an AOT source backend (target-cpp,
 * target-js, ...) walks a real tree once instead of every target re-deriving
 * block structure from the flat instruction stream itself. Total over any
 * validated program, for the same reason lower.ts's own output is
 * well-formed to begin with: the ISA forbids goto/arbitrary jumps
 * (ir-engine.md), so every BR_TABLE/LOOP shape corresponds to exactly one
 * dispatch/loop shape here, never an ambiguous one.
 *
 * What a target backend still owns, that this module has no notion of:
 * syntax (how a Stmt/Expr node renders as source text), integer semantics
 * (signedness, wraparound), procedure signatures/ABI, and buffer/extension
 * integration.
 *
 * Every stack write (a PUSH, or the write side of a register combo) is
 * materialized into its slot immediately rather than forwarded/inlined at
 * its eventual use — see ir-engine.md-adjacent reasoning: a deferred textual
 * substitution is only sound if nothing between the write and its use
 * mutates a slot the deferred expression reads, and proving that is a real
 * interference analysis this module doesn't attempt. Materializing every
 * write uniformly (this module's only real "decision") is trivially
 * correct — it's exactly the array-of-slots machine's own snapshot
 * semantics, just with named locals instead of an indexed array — and it
 * costs nothing a target compiler's own copy propagation won't fold back
 * away where it's actually safe to.
 */

import type {RtlInstr, RtlProc, RtlProgram, BinaryOpcode, UnaryOpcode} from "./rtl"
import type {Extension} from "./extension"

// ─────────────────────────────────────────────────────────────────────────────
// Output tree
// ─────────────────────────────────────────────────────────────────────────────

export type Expr =
    | {kind: "const"; value: number}
    | {kind: "slot"; index: number}
    | {kind: "binary"; op: BinaryOpcode; left: Expr; right: Expr}
    | {kind: "unary"; op: UnaryOpcode; value: Expr}
    | {kind: "call"; calleeIndex: number; args: Expr[]}
    /** Opaque extension result — see the EXT case in Raiser for why this
     *  can't be decomposed further than "some inputs, one opaque shape" from
     *  a generic ExtOpEffect alone. */
    | {kind: "ext"; ext: string; operands: readonly number[]; args: Expr[]}

export type Stmt =
    | {kind: "assign"; slot: number; value: Expr}
    | {kind: "exprStmt"; value: Expr}
    /** One BR_TABLE, raised whole: `cases.length` arms, selected by
     *  `test === i`; `test >= cases.length` falls through with none taken —
     *  if/if-else/switch are all this same shape at the RTL level
     *  (ir-engine.md), and nothing here recovers which DSL surface form
     *  produced it (nor does a target backend need to know). A trailing
     *  `default:` clause isn't part of this node: it's un-gated fallthrough
     *  code that already falls out of the enclosing statement list as
     *  whatever comes right after this one — isa-core.md's switch lowering
     *  appends it outside the BR_TABLE entirely, not as a guarded arm. */
    | {kind: "dispatch"; test: Expr; cases: Stmt[][]}
    /** One LOOP: `cond` statements compute `test`, evaluated before every
     *  iteration (including the first); `body` runs while `test` is
     *  non-zero. */
    | {kind: "loop"; cond: Stmt[]; test: Expr; body: Stmt[]}
    | {kind: "return"; value: Expr}
    | {kind: "trap"; code: number}

export interface RaisedProc
{
    argCount: number
    /** High-water mark of live slot indices — the frame size a target
     *  backend needs if it wants a fixed-size local array instead of
     *  individually named locals (mirrors isa-core.md §8.3's per-procedure
     *  figure; recomputed here rather than threaded in from validate.ts so
     *  this module has no dependency on it). */
    peakSlots: number
    body: Stmt[]
}

const slotExpr = (index: number): Expr => ({kind: "slot", index})

// ─────────────────────────────────────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────────────────────────────────────

export function raiseProgram(program: RtlProgram, extension?: Extension): RaisedProc[]
{
    return program.procedures.map(proc => raiseProc(proc, program, extension))
}

/** Raise one procedure. `program` is needed even for a single procedure
 *  because CALL's own argument count depends on the *callee's* argCount
 *  (isa-core.md §4.6's last-arg-in-acc convention) — mirrors vm.ts's CALL
 *  case reaching into `program.procedures[calleeIndex]` for the same
 *  reason. */
export function raiseProc(proc: RtlProc, program: RtlProgram, extension?: Extension): RaisedProc
{
    const raiser = new Raiser(proc.body, proc.argCount, program, extension)
    const body = raiser.top()
    return {argCount: proc.argCount, peakSlots: raiser.peakSlots, body}
}

// ─────────────────────────────────────────────────────────────────────────────
// Raiser — one procedure body's worth of cursor + symbolic acc/stack state
// ─────────────────────────────────────────────────────────────────────────────

type PendingAcc = {expr: Expr; pure: boolean}

class Raiser
{
    private pc = 0
    private tos: number
    private peak: number
    private acc: PendingAcc | undefined

    constructor(
        private readonly body: readonly RtlInstr[],
        argCount: number,
        private readonly program: RtlProgram,
        private readonly extension?: Extension,
    )
    {
        this.tos = argCount
        this.peak = argCount
    }

    get peakSlots(): number {return this.peak}

    /** The top-level procedure body: never wrapped by its own BR_TABLE case
     *  or LOOP sub-block, so it has no entryTos of its own to restore — it
     *  simply runs to its own RETURN/TRAP. */
    top(): Stmt[]
    {
        return this.closedBlock()
    }

    private bumpPeak(): void
    {
        if(this.tos > this.peak) this.peak = this.tos
    }

    private readAcc(): Expr
    {
        if(!this.acc) throw new Error(`raise: read of acc before it was ever set at pc ${this.pc}`)
        return this.acc.expr
    }

    private setAcc(expr: Expr, pure: boolean): void
    {
        this.acc = {expr, pure}
    }

    /** About to overwrite acc with a value that doesn't itself read the old
     *  one (CONST/LOAD/POP) — flush the old one first if silently dropping
     *  it would lose an unobserved side effect (a CALL/EXT result nothing
     *  ever consumed, e.g. a bare `foo();` statement immediately followed by
     *  code that reloads acc from scratch). */
    private killAcc(stmts: Stmt[]): void
    {
        if(this.acc && !this.acc.pure) stmts.push({kind: "exprStmt", value: this.acc.expr})
        this.acc = undefined
    }

    /** Write the current acc into slot `index` (a fresh PUSH, or an
     *  existing register being overwritten), emit the assignment, and point
     *  acc at a pure reference to that slot — matching real hardware, where
     *  STORE/PUSH leave acc's bits untouched, so a later read of "the same
     *  value" reads back through the slot rather than re-embedding (and
     *  re-evaluating) whatever produced it. */
    private materialize(stmts: Stmt[], index: number): void
    {
        stmts.push({kind: "assign", slot: index, value: this.readAcc()})
        this.setAcc(slotExpr(index), true)
    }

    /** Run `fn` with tos restored to its entry value afterward — BLOCK_END's
     *  own §8.1 behavior (vm.ts resets tos to the block's captured
     *  entryTos unconditionally), reproduced here around every nested
     *  BR_TABLE case and LOOP sub-block rather than assumed to already hold. */
    private withBlock<T>(fn: () => T): T
    {
        const entryTos = this.tos
        const result = fn()
        this.tos = entryTos
        return result
    }

    /** Raise one case/loop-body block, discarding (but not silently
     *  dropping — flushing if impure) whatever trailing acc value it left. */
    private closedBlock(): Stmt[]
    {
        const {stmts, trailing} = this.blockBody()
        if(trailing && !trailing.pure) stmts.push({kind: "exprStmt", value: trailing.expr})
        this.acc = undefined
        return stmts
    }

    /**
     * Raise straight-line + nested-construct statements until this block's
     * own close: an explicit BLOCK_END (consumed, not itself emitted — it's
     * pure structure) or a direct RETURN/TRAP. A terminator closes its own
     * block with no following BLOCK_END (isa-core.md §4.5/§7.2; lower.ts's
     * closeBlock never emits one for a statement list ending that way), so
     * this loop recognizes the same three closing conditions vm.ts's
     * skipBlocks does. Returns the trailing acc value on a BLOCK_END close
     * (needed by LOOP's condition sub-block as `test`) — undefined on a
     * RETURN/TRAP close, since both already consumed or discarded it.
     */
    private blockBody(): {stmts: Stmt[]; trailing?: PendingAcc}
    {
        const stmts: Stmt[] = []
        for(;;)
        {
            const i = this.body[this.pc]
            if(i === undefined) throw new Error(`raise: ran off the end of the procedure body`)

            switch(i.op)
            {
                case "CONST":
                    this.killAcc(stmts)
                    this.setAcc({kind: "const", value: i.imm}, true)
                    this.pc++
                    continue

                case "LOAD":
                    this.killAcc(stmts)
                    this.setAcc(slotExpr(i.target), true)
                    this.pc++
                    continue

                case "STORE":
                    this.materialize(stmts, i.target)
                    this.pc++
                    continue

                case "PUSH":
                    this.materialize(stmts, this.tos)
                    this.tos++
                    this.bumpPeak()
                    this.pc++
                    continue

                case "POP":
                {
                    if(this.tos <= 0) throw new Error(`raise: POP with empty stack at pc ${this.pc}`)
                    this.killAcc(stmts)
                    this.tos--
                    this.setAcc(slotExpr(this.tos), true)
                    this.pc++
                    continue
                }

                case "ADD": case "SUB": case "RSUB": case "MUL":
                case "AND": case "OR": case "XOR": case "SHL": case "SHR": case "ASR":
                case "EQ": case "NE":
                case "LT_S": case "LE_S": case "GT_S": case "GE_S":
                case "LT_U": case "LE_U": case "GT_U": case "GE_U":
                    this.binary(stmts, i)
                    continue

                case "NEG": case "NOT": case "CLZ": case "REVBITS":
                {
                    const prev = this.acc
                    if(!prev) throw new Error(`raise: ${i.op} with no acc value at pc ${this.pc}`)
                    this.setAcc({kind: "unary", op: i.op, value: prev.expr}, prev.pure)
                    this.pc++
                    continue
                }

                case "RETURN":
                {
                    stmts.push({kind: "return", value: this.readAcc()})
                    this.acc = undefined
                    this.pc++
                    return {stmts}
                }

                case "TRAP":
                    this.killAcc(stmts)
                    stmts.push({kind: "trap", code: i.imm})
                    this.pc++
                    return {stmts}

                case "BLOCK_END":
                {
                    const trailing = this.acc
                    this.pc++
                    return {stmts, trailing}
                }

                case "BR_TABLE":
                {
                    const n = i.imm
                    const prev = this.acc
                    if(!prev) throw new Error(`raise: BR_TABLE with no acc value at pc ${this.pc}`)
                    this.acc = undefined
                    this.pc++

                    const cases: Stmt[][] = []
                    for(let k = 0; k < n; k++)
                        cases.push(this.withBlock(() => this.closedBlock()))

                    stmts.push({kind: "dispatch", test: prev.expr, cases})
                    continue
                }

                case "LOOP":
                {
                    this.pc++
                    this.acc = undefined

                    const {stmts: condStmts, trailing} = this.withBlock(() => this.blockBody())
                    if(!trailing) throw new Error(`raise: LOOP condition block left no test value at pc ${this.pc}`)
                    this.acc = undefined

                    const body = this.withBlock(() => this.closedBlock())

                    stmts.push({kind: "loop", cond: condStmts, test: trailing.expr, body})
                    continue
                }

                case "CALL":
                {
                    const callee = this.program.procedures[i.calleeIndex]
                    if(!callee) throw new Error(`raise: CALL ${i.calleeIndex}: no such procedure`)
                    const stackArgs = Math.max(callee.argCount - 1, 0)
                    if(this.tos < stackArgs)
                        throw new Error(`raise: CALL ${i.calleeIndex} at pc ${this.pc}: only ${this.tos} value(s) on the stack, need ${stackArgs}`)

                    const args: Expr[] = []
                    if(callee.argCount > 0)
                    {
                        const prev = this.acc
                        if(!prev) throw new Error(`raise: CALL ${i.calleeIndex} with no acc value for its last argument at pc ${this.pc}`)
                        this.tos -= stackArgs
                        for(let k = 0; k < stackArgs; k++) args.push(slotExpr(this.tos + k))
                        args.push(prev.expr)
                    }
                    else this.killAcc(stmts)

                    this.setAcc({kind: "call", calleeIndex: i.calleeIndex, args}, false)
                    this.pc++
                    continue
                }

                case "EXT":
                {
                    const effect = this.extension?.effects?.[i.ext]
                    if(!effect) throw new Error(`raise: EXT ${i.ext}: no effect declared — pass the matching Extension to raiseProgram`)

                    // Only tosDelta is knowable generically here — ExtOpEffect
                    // says nothing about how many discrete inputs vs. outputs
                    // an op has beyond the net, nor whether it reads/writes
                    // acc. A net-negative op is modeled as "pops -tosDelta
                    // operands, produces one opaque acc result"; a
                    // net-non-negative op as "produces tosDelta opaque
                    // results directly on the stack, acc left untouched by
                    // it". Correct for the common shapes (one stream-read
                    // producing one value; one stream-write consuming some),
                    // not a general decomposition — an op with *both*
                    // multiple discrete inputs and outputs at once needs a
                    // richer contract than ExtOpEffect currently declares.
                    this.killAcc(stmts)
                    if(effect.tosDelta <= 0)
                    {
                        const n = -effect.tosDelta
                        if(this.tos < n) throw new Error(`raise: EXT ${i.ext} at pc ${this.pc}: only ${this.tos} value(s) on the stack, need ${n}`)
                        this.tos -= n
                        const args = Array.from({length: n}, (_, k) => slotExpr(this.tos + k))
                        this.setAcc({kind: "ext", ext: i.ext, operands: i.operands, args}, false)
                    }
                    else
                    {
                        for(let k = 0; k < effect.tosDelta; k++)
                        {
                            stmts.push({kind: "assign", slot: this.tos, value: {kind: "ext", ext: i.ext, operands: i.operands, args: []}})
                            this.tos++
                            this.bumpPeak()
                        }
                    }
                    this.pc++
                    continue
                }

                default:
                    throw new Error(`raise: unhandled opcode ${(i as {op: string}).op} at pc ${this.pc}`)
            }
        }
    }

    private binary(stmts: Stmt[], i: Extract<RtlInstr, {op: BinaryOpcode}>): void
    {
        const prev = this.acc
        if(!prev) throw new Error(`raise: ${i.op} with no acc value at pc ${this.pc}`)

        switch(i.combo)
        {
            case "IMM_ACC":
                this.setAcc({kind: "binary", op: i.op, left: prev.expr, right: {kind: "const", value: i.imm}}, prev.pure)
                break

            case "REG_ACC":
                this.setAcc({kind: "binary", op: i.op, left: prev.expr, right: slotExpr(i.target)}, prev.pure)
                break

            case "REG_REG":
                stmts.push({kind: "assign", slot: i.target, value: {kind: "binary", op: i.op, left: prev.expr, right: slotExpr(i.target)}})
                this.acc = undefined // clobbered (rtl.ts's COMBO.REG_REG)
                break

            case "POP_ACC":
                if(this.tos <= 0) throw new Error(`raise: ${i.op} POP_ACC with empty stack at pc ${this.pc}`)
                this.tos--
                this.setAcc({kind: "binary", op: i.op, left: prev.expr, right: slotExpr(this.tos)}, prev.pure)
                break

            case "PEEK_PEEK":
            {
                if(this.tos <= 0) throw new Error(`raise: ${i.op} PEEK_PEEK with empty stack at pc ${this.pc}`)
                const top = this.tos - 1
                stmts.push({kind: "assign", slot: top, value: {kind: "binary", op: i.op, left: prev.expr, right: slotExpr(top)}})
                this.acc = undefined // clobbered (rtl.ts's COMBO.PEEK_PEEK)
                break
            }
        }
        this.pc++
    }
}
