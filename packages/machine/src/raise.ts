/**
 * @ppl/machine — Structured-form reconstruction ("raise")
 *
 * The inverse of lower.ts: turns a flat RtlProc.body back into a nested
 * statement/expression tree, so an AOT source backend (target-cpp,
 * target-js, ...) walks a real tree once instead of every target re-deriving
 * block structure from the flat instruction stream itself. Total over any
 * validated program, for the same reason lower.ts's own output is
 * well-formed to begin with: the ISA forbids goto/arbitrary jumps
 * (isa-rationale.md), so every BR_TABLE/LOOP shape corresponds to exactly one
 * dispatch/loop shape here, never an ambiguous one.
 *
 * What a target backend still owns, that this module has no notion of:
 * syntax (how a Stmt/Expr node renders as source text), integer semantics
 * (signedness, wraparound), procedure signatures/ABI, and buffer/extension
 * integration.
 *
 * Every stack write (a PUSH, or the write side of a register combo) is
 * materialized into its slot immediately rather than forwarded/inlined at
 * its eventual use — see isa-rationale.md-adjacent reasoning: a deferred textual
 * substitution is only sound if nothing between the write and its use
 * mutates a slot the deferred expression reads, and proving that is a real
 * interference analysis this module doesn't attempt. Materializing every
 * write uniformly (this module's only real "decision") is trivially
 * correct — it's exactly the array-of-slots machine's own snapshot
 * semantics, just with named locals instead of an indexed array — and it
 * costs nothing a target compiler's own copy propagation won't fold back
 * away where it's actually safe to.
 *
 * `<E>` (defaulted to `ExtOpPayload`, rtl.ts) mirrors `RtlInstr<E>`'s own
 * type parameter: `Expr`'s `Ext` arm carries `E`'s own fields directly
 * (spread in alongside `kind`/`args`) rather than a flat `{ext, operands}`
 * pair, so a concrete extension with named-field operands (e.g.
 * `@ppl/codecs`'s `CodecExtInstr`) gets those same names on the raised
 * tree — a target backend consuming `Expr<CodecExtInstr>` reads `e.dst`/
 * `e.src`/`e.ref` directly, never a positional `operands[N]`.
 */

import type {RtlInstr, RtlProc, RtlProgram, BinaryOpcode, UnaryOpcode, RegCombo, StackCombo, ExtOpPayload} from "./rtl"
import type {Extension} from "./extension"

// ─────────────────────────────────────────────────────────────────────────────
// Output tree
// ─────────────────────────────────────────────────────────────────────────────

export const enum ExprKind
{
    /** A literal numeric constant — a raised CONST, or the fixed pure-zero
     *  value `Raiser.unknownAcc()` seeds/resets acc with. */
    Const = "const",
    /** A read of a local variable slot (`s<index>`) — the raised
     *  counterpart of a LOAD, or of a POP materializing the popped slot. */
    Slot = "slot",
    /** A two-operand ALU/compare op (rtl.ts's `BinaryOpcode`) — every
     *  IMM_ACC/REG_ACC/POP_ACC/PEEK_PEEK combo `Raiser.binary()` collapses
     *  into this one shape. */
    Binary = "binary",
    /** A one-operand op: NEG/NOT/CLZ/REVBITS. */
    Unary = "unary",
    /** A direct CALL to another procedure by index — `args` already
     *  includes the callee's last argument (acc at call time), per
     *  isa-core.md §4.6's calling convention. */
    Call = "call",
    /** Opaque extension result — see the EXT case in Raiser for why this
     *  can't be decomposed further than "some inputs, one opaque shape" from
     *  a generic ExtOpEffect alone. */
    Ext = "ext",
}

export type Expr<E extends { ext: string } = ExtOpPayload> =
    | {kind: ExprKind.Const; value: number}
    | {kind: ExprKind.Slot; index: number}
    | {kind: ExprKind.Binary; op: BinaryOpcode; left: Expr<E>; right: Expr<E>}
    | {kind: ExprKind.Unary; op: UnaryOpcode; value: Expr<E>}
    | {kind: ExprKind.Call; calleeIndex: number; args: Expr<E>[]}
    | ({kind: ExprKind.Ext} & E & {args: Expr<E>[]})

export const enum StmtKind
{
    /** Write to an existing slot — a STORE, a PUSH's materialization into a
     *  fresh one, or a binary op's REG_REG/PEEK_PEEK combo clobbering a
     *  register in place. */
    Assign = "assign",
    /** Evaluate an expression purely for a side effect, discarding the
     *  result — an unread CALL/EXT result, or an impure pending acc value
     *  flushed by `killAcc()` before it would otherwise be silently
     *  dropped. */
    ExprStmt = "exprStmt",
    /** One BR_TABLE, raised whole: `cases.length - 1` arms selected by
     *  `test === i`, and a final arm — `cases[cases.length - 1]` — taken by
     *  every other value, exactly C's `default:` (isa-core.md §4.5). The
     *  dispatch is total, so there is no un-gated code after it.
     *  if/if-else/ternary/switch are all this same shape at the RTL level
     *  (isa-rationale.md), and nothing here recovers which DSL surface form
     *  produced it (nor does a target backend need to know). */
    Dispatch = "dispatch",
    /** One LOOP: `cond` statements compute `test`, evaluated before every
     *  iteration (including the first); `body` runs while `test` is
     *  non-zero. */
    Loop = "loop",
    /** A procedure RETURN. */
    Return = "return",
    /** A procedure TRAP. */
    Trap = "trap",
}

export type Stmt<E extends { ext: string } = ExtOpPayload> =
    | {kind: StmtKind.Assign; slot: number; value: Expr<E>}
    | {kind: StmtKind.ExprStmt; value: Expr<E>}
    | {kind: StmtKind.Dispatch; test: Expr<E>; cases: Stmt<E>[][]}
    | {kind: StmtKind.Loop; cond: Stmt<E>[]; test: Expr<E>; body: Stmt<E>[]}
    | {kind: StmtKind.Return; value: Expr<E>}
    | {kind: StmtKind.Trap; code: number}

export interface RaisedProc<E extends { ext: string } = ExtOpPayload>
{
    argCount: number
    /** High-water mark of live slot indices — the frame size a target
     *  backend needs if it wants a fixed-size local array instead of
     *  individually named locals (mirrors isa-core.md §8.3's per-procedure
     *  figure; recomputed here rather than threaded in from validate.ts so
     *  this module has no dependency on it). */
    peakSlots: number
    body: Stmt<E>[]
}

const slotExpr = <E extends { ext: string } = ExtOpPayload>(index: number): Expr<E> => ({kind: ExprKind.Slot, index})

// ─────────────────────────────────────────────────────────────────────────────
// Entry points
// ─────────────────────────────────────────────────────────────────────────────

export function raiseProgram<E extends { ext: string } = ExtOpPayload>(program: RtlProgram<E>, extension?: Extension<E>): RaisedProc<E>[]
{
    return program.procedures.map(proc => raiseProc(proc, program, extension))
}

/** Raise one procedure. `program` is needed even for a single procedure
 *  because CALL's own argument count depends on the *callee's* argCount
 *  (isa-core.md §4.6's last-arg-in-acc convention) — mirrors vm.ts's CALL
 *  case reaching into `program.procedures[calleeIndex]` for the same
 *  reason. */
export function raiseProc<E extends { ext: string } = ExtOpPayload>(proc: RtlProc<E>, program: RtlProgram<E>, extension?: Extension<E>): RaisedProc<E>
{
    const raiser = new Raiser<E>(proc.body, proc.argCount, program, extension)
    const body = raiser.top()
    return {argCount: proc.argCount, peakSlots: raiser.peakSlots, body}
}

// ─────────────────────────────────────────────────────────────────────────────
// Raiser — one procedure body's worth of cursor + symbolic acc/stack state
// ─────────────────────────────────────────────────────────────────────────────

type PendingAcc<E extends { ext: string } = ExtOpPayload> = {expr: Expr<E>; pure: boolean}

/** One raised block and how it left: `"end"` reaches the enclosing
 *  construct's merge, `"fall"` runs into the next case (isa-core.md §4.5),
 *  `"terminated"` reaches nothing. `trailing` is the acc value it left, on
 *  the two closes that leave one. */
type Arm<E extends { ext: string } = ExtOpPayload> =
    {stmts: Stmt<E>[]; trailing?: PendingAcc<E>; close: "end" | "fall" | "terminated"}

class Raiser<E extends { ext: string } = ExtOpPayload>
{
    private pc = 0
    private tos: number
    private peak: number
    // vm.ts's runProc seeds the real register `let acc = 0` at the start
    // of every call (vm.ts:152) and never resets it at a block/dispatch/
    // loop boundary — BLOCK_END only ever restores `tos` (§8.1), so acc
    // simply persists as whatever the machine last wrote, branch-dependent
    // as that may be. A bare `return;`/`trap(...)` right after a
    // dispatch/loop closes, with nothing in between setting a fresh value,
    // is therefore legal and well-defined at the VM level — and a real
    // shape: `resolver.ts`'s `ensureTerminated` appends exactly this after
    // a `unionEncodeRule`/`unionDecodeRule`/`listEncodeRule`/... body,
    // none of which end in their own `return`. Modeling "acc's value here
    // isn't tracked by this raiser instance" as `undefined` and having
    // readAcc() throw on it was wrong for this whole class of case.
    //
    // What raise.ts genuinely *can't* track is which specific expression
    // is in acc when it depends on which of several branches ran (a real
    // phi/merge) — but every such site in this codebase is exactly the
    // "meaningless trailing return" case above, so `unknownAcc()` picks a
    // safe, always-valid stand-in (pure CONST 0, never flushed as a
    // statement) rather than building merge-slot machinery nothing here
    // needs yet.
    private acc: PendingAcc<E> | undefined = this.unknownAcc()

    // Instance method (not static) purely so it can be typed against this
    // Raiser instance's own `E` — a static member has no access to a
    // generic class's instance type parameter, but the field initializer
    // above (and `closedBlock()` below) both need one. Available on the
    // prototype before any field initializer runs, regardless of its
    // position in the class body, so referencing it from `acc`'s own
    // initializer above is safe.
    private unknownAcc(): PendingAcc<E>
    {
        return {expr: {kind: ExprKind.Const, value: 0}, pure: true}
    }

    // A merge slot has to be one nothing else in this body can name. TOS
    // only ever grows by PUSH, and every register operand is a literal
    // index, so both bounds are readable straight off the instruction
    // stream — no interference analysis needed.
    private mergeNext: number

    constructor(
        private readonly body: readonly RtlInstr<E>[],
        argCount: number,
        private readonly program: RtlProgram<E>,
        private readonly extension?: Extension<E>,
    )
    {
        this.tos = argCount
        this.peak = argCount

        let named = 0
        let pushes = 0
        for(const i of body)
        {
            if(i.op === "PUSH") pushes++
            if("target" in i) named = Math.max(named, i.target + 1)
        }
        this.mergeNext = Math.max(argCount + pushes, named)
    }

    /** A fresh slot for a value that depends on which arm of a dispatch ran
     *  — the phi the ISA spells as "every arm leaves it in acc", which
     *  nothing in `Stmt` can express directly. */
    private mergeSlot(): number
    {
        const slot = this.mergeNext++
        this.peak = Math.max(this.peak, slot + 1)
        return slot
    }

    /** Whether anything after a dispatch's merge can still read the value
     *  its arms left in acc — asked of the one instruction sitting at the
     *  merge, since acc is either read or overwritten there. A body that
     *  simply ends reads nothing; a `BLOCK_END`/`FALLTHROUGH` hands the
     *  value outward, which counts as a read. Conservative in the right
     *  direction: a wrong "yes" costs a dead store the target compiler
     *  folds away, a wrong "no" would lose a value. */
    private mergeValueIsRead(): boolean
    {
        const next = this.body[this.pc]
        if(next === undefined) return false

        switch(next.op)
        {
            case "CONST": case "LOAD": case "TRAP": return false
            case "CALL": return (this.program.procedures[next.calleeIndex]?.argCount ?? 0) > 0
            case "EXT": return this.extension?.effects?.[next.ext]?.readsAcc === true
            default: return true
        }
    }

    get peakSlots(): number {return this.peak}

    /** The top-level procedure body: never wrapped by its own BR_TABLE case
     *  or LOOP sub-block, so it has no entryTos of its own to restore — it
     *  simply runs to its own RETURN/TRAP. */
    top(): Stmt<E>[]
    {
        return this.closedBlock()
    }

    private bumpPeak(): void
    {
        if(this.tos > this.peak) this.peak = this.tos
    }

    private readAcc(): Expr<E>
    {
        if(!this.acc) throw new Error(`raise: read of acc before it was ever set at pc ${this.pc}`)
        return this.acc.expr
    }

    private setAcc(expr: Expr<E>, pure: boolean): void
    {
        this.acc = {expr, pure}
    }

    /** About to overwrite acc with a value that doesn't itself read the old
     *  one (CONST/LOAD/POP) — flush the old one first if silently dropping
     *  it would lose an unobserved side effect (a CALL/EXT result nothing
     *  ever consumed, e.g. a bare `foo();` statement immediately followed by
     *  code that reloads acc from scratch). */
    private killAcc(stmts: Stmt<E>[]): void
    {
        if(this.acc && !this.acc.pure) stmts.push({kind: StmtKind.ExprStmt, value: this.acc.expr})
        this.acc = undefined
    }

    /** Write the current acc into slot `index` (a fresh PUSH, or an
     *  existing register being overwritten), emit the assignment, and point
     *  acc at a pure reference to that slot — matching real hardware, where
     *  STORE/PUSH leave acc's bits untouched, so a later read of "the same
     *  value" reads back through the slot rather than re-embedding (and
     *  re-evaluating) whatever produced it. */
    private materialize(stmts: Stmt<E>[], index: number): void
    {
        stmts.push({kind: StmtKind.Assign, slot: index, value: this.readAcc()})
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
     *  dropping — flushing if impure) whatever trailing acc value it left.
     *  What the *outer* continuation sees afterward is `unknownAcc()`, not
     *  `undefined` — see its own doc comment for why that's the correct
     *  model here, not just a crash-avoidance workaround. */
    private closedBlock(): Stmt<E>[]
    {
        const {stmts, trailing} = this.blockBody()
        if(trailing && !trailing.pure) stmts.push({kind: StmtKind.ExprStmt, value: trailing.expr})
        this.acc = this.unknownAcc()
        return stmts
    }

    /** A case that fell through runs the next one's statements too — the
     *  arms of a `Dispatch` are independent, so the only way to say that
     *  here is to say it twice. Afterwards every arm's `stmts` is the array
     *  the `Dispatch` node itself carries, so appending to one still lands
     *  in that arm and only that arm. */
    private foldFallthrough(arms: Arm<E>[]): Stmt<E>[][]
    {
        for(let k = arms.length - 2; k >= 0; k--)
            if(arms[k]!.close === "fall") arms[k]!.stmts = [...arms[k]!.stmts, ...arms[k + 1]!.stmts]

        return arms.map(a => a.stmts)
    }

    /**
     * Raise straight-line + nested-construct statements until this block's
     * own close: an explicit BLOCK_END (consumed, not itself emitted — it's
     * pure structure), a direct RETURN/TRAP, or the true end of the
     * procedure body. A terminator closes its own block with no following
     * BLOCK_END (isa-core.md §4.5/§7.2; lower.ts's closeBlock never emits
     * one for a statement list ending that way), so this loop recognizes
     * the same three closing conditions vm.ts's skipBlocks does — plus a
     * fourth this module alone needs to recognize: running off the true
     * end of `this.body` with no BLOCK_END. That's only reachable for the
     * *outermost* call (`top()`): every nested block (a BR_TABLE case, a
     * LOOP sub-block) is always properly closed by lower.ts, either with a
     * real BLOCK_END or because its own last statement is directly a
     * RETURN/TRAP — confirmed structurally, not merely assumed. The
     * top-level procedure body has no enclosing BLOCK_END of its own, so
     * when every path through it already terminates (e.g. a bare
     * `if(c) return a; else return b;` with nothing following), there is
     * genuinely nothing left to read once both branches are raised.
     * `close` says which of the three it was, and the trailing acc value
     * comes back with the two that leave one — a RETURN/TRAP or true-end
     * close reaches nothing and carries nothing.
     */
    private blockBody(): Arm<E>
    {
        const stmts: Stmt<E>[] = []
        for(;;)
        {
            const i = this.body[this.pc]
            if(i === undefined) return {stmts, close: "terminated"}

            switch(i.op)
            {
                case "CONST":
                    this.killAcc(stmts)
                    this.setAcc({kind: ExprKind.Const, value: i.imm}, true)
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

                case "ADD": case "SUB": case "RSUB": case "MUL":
                case "AND": case "OR": case "XOR": case "SHL": case "SHR": case "ASR":
                case "EQ": case "NE":
                case "LT_S": case "LE_S": case "GT_S": case "GE_S":
                case "LT_U": case "LE_U": case "GT_U": case "GE_U":
                    this.binary(stmts, i)
                    continue

                case "NEG": case "NOT": case "CLZ": case "REVBITS":
                case "SXTB": case "SXTH": case "UXTB": case "UXTH":
                {
                    const prev = this.acc
                    if(!prev) throw new Error(`raise: ${i.op} with no acc value at pc ${this.pc}`)
                    this.setAcc({kind: ExprKind.Unary, op: i.op, value: prev.expr}, prev.pure)
                    this.pc++
                    continue
                }

                case "RETURN":
                {
                    stmts.push({kind: StmtKind.Return, value: this.readAcc()})
                    this.acc = undefined
                    this.pc++
                    return {stmts, close: "terminated"}
                }

                case "TRAP":
                    this.killAcc(stmts)
                    stmts.push({kind: StmtKind.Trap, code: i.imm})
                    this.pc++
                    return {stmts, close: "terminated"}

                case "BLOCK_END":
                {
                    const trailing = this.acc
                    this.pc++
                    return {stmts, trailing, close: "end"}
                }

                case "FALLTHROUGH":
                {
                    const trailing = this.acc
                    this.pc++
                    return {stmts, trailing, close: "fall"}
                }

                case "BR_TABLE":
                {
                    const prev = this.acc
                    if(!prev) throw new Error(`raise: BR_TABLE with no acc value at pc ${this.pc}`)
                    this.pc++

                    const arms: Arm<E>[] = []
                    for(let k = 0; k <= i.imm; k++)
                    {
                        // unknownAcc(), not undefined: an arm's own body may
                        // open with a bare RETURN/TRAP reading whatever's "in
                        // acc" with nothing else setting it first (e.g.
                        // delta-leb128.ts's `if (left == 0) { return; }`) — the
                        // same "can't track across a branch, but known
                        // meaningless" case unknownAcc()'s own doc comment
                        // describes, not a real crash-worthy state.
                        this.acc = this.unknownAcc()
                        arms.push(this.withBlock(() => this.blockBody()))
                    }

                    // A case that fell through ends where the case it ran
                    // into ends, so that one's close and value are what
                    // reach the merge from it. Its own trailing value is
                    // dropped where it stands (§4.5: the next case starts
                    // with acc dead), which for an impure one still means
                    // keeping the side effect.
                    const reaching = arms.map(a => a)
                    for(let k = arms.length - 2; k >= 0; k--)
                        if(reaching[k]!.close === "fall")
                            reaching[k] = {stmts: reaching[k]!.stmts, close: reaching[k + 1]!.close, trailing: reaching[k + 1]!.trailing}

                    for(const a of arms)
                        if(a.close === "fall" && a.trailing && !a.trailing.pure)
                            a.stmts.push({kind: StmtKind.ExprStmt, value: a.trailing.expr})

                    const cases = this.foldFallthrough(arms)
                    stmts.push({kind: StmtKind.Dispatch, test: prev.expr, cases})

                    const merging = reaching.filter(a => a.close === "end")
                    if(merging.length > 0 && merging.every(a => a.trailing) && this.mergeValueIsRead())
                    {
                        // isa-core.md §8.7: every arm reaching the merge
                        // leaves acc live, so the merge carries a value —
                        // a phi, spelled here as one slot every arm writes.
                        const slot = this.mergeSlot()
                        reaching.forEach((a, k) =>
                        {
                            if(a.close === "end") cases[k]!.push({kind: StmtKind.Assign, slot, value: a.trailing!.expr})
                        })
                        this.setAcc(slotExpr(slot), true)
                    }
                    else
                    {
                        reaching.forEach((a, k) =>
                        {
                            if(a.close === "end" && a.trailing && !a.trailing.pure)
                                cases[k]!.push({kind: StmtKind.ExprStmt, value: a.trailing.expr})
                        })
                        this.acc = this.unknownAcc()
                    }
                    continue
                }

                case "LOOP":
                {
                    this.pc++
                    // Not a raw reset: whatever's pending here is whatever
                    // ran immediately before this LOOP (e.g. listEncodeRule's
                    // own `write(0, W, left);` right before its `while`) —
                    // whose side effect must still land in `stmts`, exactly
                    // like every other "acc's about to become untrustworthy"
                    // point in this file (killAcc's own doc comment). A bare
                    // `this.acc = undefined` here silently dropped it — the
                    // bug this comment is now here to stop reintroducing.
                    this.killAcc(stmts)

                    const {stmts: condStmts, trailing} = this.withBlock(() => this.blockBody())
                    if(!trailing) throw new Error(`raise: LOOP condition block left no test value at pc ${this.pc}`)
                    // Same reasoning as BR_TABLE's own case above: the loop
                    // body may open with a bare RETURN/TRAP.
                    this.acc = this.unknownAcc()

                    const body = this.withBlock(() => this.closedBlock())

                    stmts.push({kind: StmtKind.Loop, cond: condStmts, test: trailing.expr, body})
                    continue
                }

                case "CALL":
                {
                    const callee = this.program.procedures[i.calleeIndex]
                    if(!callee) throw new Error(`raise: CALL ${i.calleeIndex}: no such procedure`)
                    const stackArgs = Math.max(callee.argCount - 1, 0)
                    if(this.tos < stackArgs)
                        throw new Error(`raise: CALL ${i.calleeIndex} at pc ${this.pc}: only ${this.tos} value(s) on the stack, need ${stackArgs}`)

                    const args: Expr<E>[] = []
                    if(callee.argCount > 0)
                    {
                        const prev = this.acc
                        if(!prev) throw new Error(`raise: CALL ${i.calleeIndex} with no acc value for its last argument at pc ${this.pc}`)
                        this.tos -= stackArgs
                        for(let k = 0; k < stackArgs; k++) args.push(slotExpr(this.tos + k))
                        args.push(prev.expr)
                    }
                    else this.killAcc(stmts)

                    this.setAcc({kind: ExprKind.Call, calleeIndex: i.calleeIndex, args}, false)
                    this.pc++
                    continue
                }

                case "EXT":
                {
                    const effect = this.extension?.effects?.[i.ext]
                    if(!effect) throw new Error(`raise: EXT ${i.ext}: no effect declared — pass the matching Extension to raiseProgram`)

                    // tosDelta > 0 (a net stack push) is never reachable
                    // through the DSL: every rule that can build a call-like
                    // node (rules.ts's leafNode/unaryNode, and every
                    // extension's own `rules()`) hands back exactly one
                    // RtlNode with one `output` location — there's no DSL
                    // surface for "this call names two new locals at once."
                    // The only way to get one is to hand-build an RtlInstr[]
                    // directly, which no real codec/extension does — so
                    // rather than carry a second `Stmt` shape (`extMulti`)
                    // solely to represent a case nothing can construct, this
                    // is asserted here instead.
                    if(effect.tosDelta > 0)
                        throw new Error(`raise: EXT ${i.ext} at pc ${this.pc}: tosDelta > 0 (a net stack push) isn't supported — no DSL rule can construct one`)

                    // `readsAcc` capture: *this* acc value (whatever produced
                    // it — a slot read, a CONST, another ext's result)
                    // becomes this op's own trailing arg instead of being
                    // killed — see ExtOpEffect.readsAcc's doc comment for why
                    // this can't just fall out of the tosDelta accounting
                    // below.
                    const priorAcc = effect.readsAcc ? this.acc : undefined
                    if(effect.readsAcc && !priorAcc)
                        throw new Error(`raise: EXT ${i.ext} at pc ${this.pc}: reads acc but none is set`)
                    if(!effect.readsAcc) this.killAcc(stmts)
                    else this.acc = undefined // consumed below, not flushed

                    const n = -effect.tosDelta
                    if(this.tos < n) throw new Error(`raise: EXT ${i.ext} at pc ${this.pc}: only ${this.tos} value(s) on the stack, need ${n}`)
                    this.tos -= n
                    const args = Array.from({length: n}, (_, k) => slotExpr<E>(this.tos + k))
                    if(priorAcc) args.push(priorAcc.expr)
                    // Spread `i`'s own payload fields (everything E declares
                    // — e.g. CodecExtInstr's `dst`/`src`/`ref` for ENTER —
                    // minus the RTL-only `op` tag, which the raised tree has
                    // no use for; `kind` is the tree's own discriminant) so
                    // a concrete extension's named fields survive onto the
                    // raised `Expr` node unchanged, alongside the popped/
                    // acc-sourced `args`.
                    const {op: _op, ...payload} = i
                    const node = {kind: ExprKind.Ext, ...payload, args} as Expr<E>

                    // A kill op leaves nothing readable behind (isa-core.md
                    // §11.2), so its node can't be acc's new value the way a
                    // preserving/writing op's is — it is the statement it
                    // was, and acc stays whatever the kill made it: nothing.
                    if(effect.killsAcc)
                    {
                        stmts.push({kind: StmtKind.ExprStmt, value: node})
                        this.acc = undefined
                    }
                    else this.setAcc(node, false)

                    this.pc++
                    continue
                }

                default:
                    throw new Error(`raise: unhandled opcode ${(i as {op: string}).op} at pc ${this.pc}`)
            }
        }
    }

    private binary(stmts: Stmt<E>[], i: { op: BinaryOpcode; combo: RegCombo; target: number } | { op: BinaryOpcode; combo: "IMM_ACC"; imm: number } | { op: BinaryOpcode; combo: StackCombo }): void
    {
        const prev = this.acc
        if(!prev) throw new Error(`raise: ${i.op} with no acc value at pc ${this.pc}`)

        switch(i.combo)
        {
            case "IMM_ACC":
                this.setAcc({kind: ExprKind.Binary, op: i.op, left: prev.expr, right: {kind: ExprKind.Const, value: i.imm}}, prev.pure)
                break

            case "REG_ACC":
                this.setAcc({kind: ExprKind.Binary, op: i.op, left: prev.expr, right: slotExpr(i.target)}, prev.pure)
                break

            case "REG_REG":
                stmts.push({kind: StmtKind.Assign, slot: i.target, value: {kind: ExprKind.Binary, op: i.op, left: prev.expr, right: slotExpr(i.target)}})
                this.acc = undefined // clobbered (rtl.ts's COMBO.REG_REG)
                break

            case "POP_ACC":
                if(this.tos <= 0) throw new Error(`raise: ${i.op} POP_ACC with empty stack at pc ${this.pc}`)
                this.tos--
                this.setAcc({kind: ExprKind.Binary, op: i.op, left: prev.expr, right: slotExpr(this.tos)}, prev.pure)
                break

            case "PEEK_PEEK":
            {
                if(this.tos <= 0) throw new Error(`raise: ${i.op} PEEK_PEEK with empty stack at pc ${this.pc}`)
                const top = this.tos - 1
                stmts.push({kind: StmtKind.Assign, slot: top, value: {kind: ExprKind.Binary, op: i.op, left: prev.expr, right: slotExpr(top)}})
                this.acc = undefined // clobbered (rtl.ts's COMBO.PEEK_PEEK)
                break
            }
        }
        this.pc++
    }
}
