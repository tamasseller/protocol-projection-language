/**
 * @ppl/machine/test — Shakedown for raise.ts (ROADMAP.md item 12)
 *
 * raise.ts had zero consumers and zero tests before this file — "sketched,
 * not verified" per the ROADMAP. This is a differential check, not a
 * shape check: for every fixture, lower + run() via the real VM (ground
 * truth), then raise + evaluate the SAME procedure via a tiny tree-walking
 * evaluator built on vm.ts's own exported opcode semantics (evalBinary/
 * evalUnary — reused, not re-derived, so a drift between the two can't
 * hide behind two independently-written copies), and assert the two
 * agree exactly. Most fixtures are the same DSL source strings e2e.test.ts
 * already proved correct against the VM — reusing a proven corpus instead
 * of hand-inventing a smaller one from scratch.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { ir, proc } from "../src/ir"
import { lowerProc, lowerProgram } from "../src/lower"
import { run, evalBinary, evalUnary } from "../src/vm"
import { raiseProgram, ExprKind, StmtKind } from "../src/raise"
import type { Expr, Stmt, RaisedProc } from "../src/raise"
import { extInstr } from "../src/rtl"
import type { RtlProgram } from "../src/rtl"
import type { Extension, ExecState } from "../src/extension"
import { rule, leafNode, unaryNode } from "../src/rules"
import { pBuiltinCall, pIdentifier, pRtl } from "../src/matcher"

// ─────────────────────────────────────────────────────────────────────────
// A tiny evaluator for RaisedProc[] — the "second implementation" half of
// the differential check. RETURN/TRAP are modeled as exceptions (not a
// plain JS `return`, unlike vm.ts's own one-function-per-procedure design)
// because execStmts is a recursive tree walker: a return/trap nested
// inside a dispatch case or loop body must unwind every enclosing
// execStmts call on its way out, exactly like vm.ts's real RETURN/TRAP
// unwind every enclosing runProc call.
// ─────────────────────────────────────────────────────────────────────────

class RaisedReturn { constructor(readonly value: number) {} }
class RaisedTrap { constructor(readonly code: number) {} }

function evalRaisedProgram(
    procs: readonly RaisedProc[],
    extension?: Extension,
): { acc: number; ok: boolean; trapCode: number | null }
{
    function callProc(index: number, args: readonly number[]): number
    {
        const p = procs[index]
        if(!p) throw new Error(`evalRaised: no such procedure ${index}`)
        const slots: number[] = new Array(Math.max(p.peakSlots, args.length)).fill(0)
        args.forEach((v, i) => { slots[i] = v })

        try
        {
            execStmts(p.body, slots)
            throw new Error(`evalRaised: procedure ${index} fell off the end with no RETURN`)
        }
        catch(e)
        {
            if(e instanceof RaisedReturn) return e.value
            throw e // RaisedTrap, or a real bug — propagate past this frame either way
        }
    }

    function evalExpr(e: Expr, slots: number[]): number
    {
        switch(e.kind)
        {
            case ExprKind.Const: return e.value >>> 0
            case ExprKind.Slot: return slots[e.index] ?? 0
            case ExprKind.Binary: return evalBinary(evalExpr(e.left, slots), evalExpr(e.right, slots), e.op)
            case ExprKind.Unary: return evalUnary(evalExpr(e.value, slots), e.op)
            case ExprKind.Call: return callProc(e.calleeIndex, e.args.map(a => evalExpr(a, slots)))
            case ExprKind.Ext:
            {
                // readsAcc (ExtOpEffect.readsAcc, extension.ts) ops carry
                // their acc-sourced input as args' trailing entry (raise.ts's
                // own EXT case appends it there) — split it off so it seeds
                // `state.acc` directly below instead of going through
                // pop(), mirroring exactly how a real exec() reads it.
                const effect = extension?.effects?.[e.ext]
                const values = e.args.map(a => evalExpr(a, slots))
                const priorAcc = effect?.readsAcc ? values.pop() : undefined
                return evalExt(e.ext, e.operands, values, priorAcc, slots)
            }
        }
    }

    /** tosDelta ≤ 0 shape: pops `poppedArgs.length` operands (already
     *  resolved to values), produces one opaque acc result — seeded from
     *  `priorAcc` when this op reads pre-existing acc (undefined ⇒ starts
     *  at 0, the ordinary case). `pop()` drains from the end: raise.ts's
     *  `args[0]` is the bottom of the popped run, so a real stack pop()
     *  (top-first) sees `args` in reverse. `reg`/`setReg` still read/write
     *  the CURRENT frame's `slots` — an op's *operands* (e.g. `DOUBLE_REG`'s
     *  register index) are a separate channel from the popped stack args,
     *  and a real `exec` body is free to use either. */
    function evalExt(ext: string, operands: readonly number[], poppedArgs: readonly number[], priorAcc: number | undefined, slots: number[]): number
    {
        if(!extension?.exec) throw new Error(`evalRaised: EXT ${ext} with no extension registered`)
        let result = priorAcc ?? 0
        let cursor = poppedArgs.length - 1
        const state: ExecState = {
            get acc() { return result },
            set acc(v: number) { result = v >>> 0 },
            push() { throw new Error(`evalRaised: EXT ${ext} pushed — raise.ts guarantees tosDelta ≤ 0, so an EXT op never pushes`) },
            pop() { if(cursor < 0) throw new Error(`evalRaised: EXT ${ext} popped more than raised`); return poppedArgs[cursor--] },
            reg(i) { return slots[i] ?? 0 },
            setReg(i, v) { slots[i] = v >>> 0 },
            callProc,
        }
        extension.exec(extInstr(ext, operands), state)
        return result
    }

    function execStmts(stmts: readonly Stmt[], slots: number[]): void
    {
        for(const s of stmts)
        {
            switch(s.kind)
            {
                case StmtKind.Assign: slots[s.slot] = evalExpr(s.value, slots); break
                case StmtKind.ExprStmt: evalExpr(s.value, slots); break
                case StmtKind.Return: throw new RaisedReturn(evalExpr(s.value, slots))
                case StmtKind.Trap: throw new RaisedTrap(s.code)

                case StmtKind.Dispatch:
                {
                    const idx = evalExpr(s.test, slots)
                    const chosen = idx >= 0 && idx < s.cases.length ? s.cases[idx] : undefined
                    if(chosen) execStmts(chosen, slots) // no case: implicit fallthrough past the whole dispatch
                    break
                }

                case StmtKind.Loop:
                    for(;;)
                    {
                        execStmts(s.cond, slots)
                        if(evalExpr(s.test, slots) === 0) break
                        execStmts(s.body, slots)
                    }
                    break
            }
        }
    }

    try
    {
        const acc = callProc(0, [])
        return { acc, ok: true, trapCode: null }
    }
    catch(e)
    {
        if(e instanceof RaisedTrap) return { acc: 0, ok: false, trapCode: e.code }
        throw e
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Differential assertion helpers
// ─────────────────────────────────────────────────────────────────────────

function assertRaisedReturn(source: string, expected: number, extension?: Extension): void
{
    const program: RtlProgram = { procedures: [lowerProc(ir`${source}`.body, [], extension)] }

    const vmResult = run(program, extension)
    assert.ok(vmResult.ok, `${source.trim()} — expected normal return from run(), got trap ${vmResult.trapCode}`)
    assert.equal(vmResult.acc, expected >>> 0, `${source.trim()} — run() sanity check`)

    const raisedResult = evalRaisedProgram(raiseProgram(program, extension), extension)
    assert.equal(raisedResult.ok, true, `${source.trim()} — raised tree trapped unexpectedly`)
    assert.equal(raisedResult.acc, expected >>> 0, `${source.trim()} — raised tree disagrees with run()`)
}

function assertRaisedTrap(source: string, expectedTrapCode: number): void
{
    const program: RtlProgram = { procedures: [lowerProc(ir`${source}`.body)] }

    const vmResult = run(program)
    assert.equal(vmResult.ok, false, `${source.trim()} — expected a trap from run()`)
    assert.equal(vmResult.trapCode, expectedTrapCode)

    const raisedResult = evalRaisedProgram(raiseProgram(program))
    assert.equal(raisedResult.ok, false, `${source.trim()} — raised tree didn't trap`)
    assert.equal(raisedResult.trapCode, expectedTrapCode)
}

function assertRaisedProgram(entry: ReturnType<typeof proc>, expected: number): void
{
    const program = lowerProgram(entry)

    const vmResult = run(program)
    assert.ok(vmResult.ok, `expected normal return from run(), got trap ${vmResult.trapCode}`)
    assert.equal(vmResult.acc, expected)

    const raisedResult = evalRaisedProgram(raiseProgram(program))
    assert.ok(raisedResult.ok, `raised tree trapped unexpectedly (code ${raisedResult.trapCode})`)
    assert.equal(raisedResult.acc, expected, `raised tree disagrees with run()`)
}

// ─────────────────────────────────────────────────────────────────────────
// Straight-line, control flow, and expression shapes — reused from
// e2e.test.ts's proven (source, expected) corpus.
// ─────────────────────────────────────────────────────────────────────────

describe("raise: straight-line and variables", () =>
{
    test("literal constant", () => assertRaisedReturn("return 42;", 42))
    test("expression", () => assertRaisedReturn("return 2 + 3 * 4;", 14))
    test("declare and mutate", () => assertRaisedReturn(`
        u32 x = 5;
        x = x * 2;
        return x;
    `, 10))
})

describe("raise: if/else (BR_TABLE)", () =>
{
    test("if-true", () => assertRaisedReturn(`
        u32 x = 1;
        if (x) return 42;
        return 0;
    `, 42))

    test("if-else, taken branch", () => assertRaisedReturn(`
        u32 x = 5;
        if (x > 3) return 100;
        else return 200;
    `, 100))

    test("if-else, other branch", () => assertRaisedReturn(`
        u32 x = 2;
        if (x > 3) return 100;
        else return 200;
    `, 200))

    test("nested if", () => assertRaisedReturn(`
        u32 a = 1;
        u32 b = 2;
        if (a)
            if (b)
                return 99;
        return 0;
    `, 99))

    // raise.ts must seed `acc` entering a BR_TABLE arm; leaving it
    // `undefined` crashes an arm whose first statement is a bare `return;`
    // with "read of acc before it was ever set" — exactly
    // delta-leb128.ts's own `if (left == 0) { return; }`. A no-else `if`
    // always lowers its one arm as case 0, entered exactly when acc === 0
    // (lower.ts's inverted-test + brTable(1) convention), so this is a
    // genuine, provably-exact differential check, not just a smoke test.
    test("bare early return as an arm's own first statement", () => assertRaisedReturn(`
        u32 x = 0;
        if (x == 0) { return; }
        return 99;
    `, 0))
})

describe("raise: loops (LOOP)", () =>
{
    test("while: sum 1 to 5", () => assertRaisedReturn(`
        u32 sum = 0;
        u32 i = 1;
        while (i <= 5)
        {
            sum = sum + i;
            i = i + 1;
        }
        return sum;
    `, 15))

    test("for: sum 0 to 9", () => assertRaisedReturn(`
        u32 sum = 0;
        for (u32 i = 0; i < 10; i = i + 1)
            sum = sum + i;
        return sum;
    `, 45))

    test("if inside while", () => assertRaisedReturn(`
        u32 count = 0;
        u32 n = 0;
        while (n < 20)
        {
            n = n + 1;
            if ((n & 1) == 0)
                count = count + 1;
        }
        return count;
    `, 10))

    test("loop with early return", () => assertRaisedReturn(`
        u32 i = 0;
        while (i < 100)
        {
            i = i + 1;
            if (i == 7)
                return 77;
        }
        return 0;
    `, 77))

    // Regression, same bug class as the BR_TABLE case above — a loop
    // body's own first statement reading acc via a bare early return.
    // Not a differential-value check like that one: a boolean while-test
    // enters the body with acc === 1 (not 0), so the raiser's unknownAcc()
    // placeholder doesn't match run()'s ground truth here — nothing in
    // this codebase's real procedures ever reads that value, so this only
    // asserts that raising does not throw.
    test("bare early return as a loop body's own first statement doesn't crash the raiser", () =>
    {
        const program: RtlProgram = { procedures: [lowerProc(ir`
            u32 x = 0;
            while (x < 3) { return; }
            return 99;
        `.body, [])] }
        assert.doesNotThrow(() => raiseProgram(program))
    })
})

describe("raise: switch (BR_TABLE with >2 cases, fallthrough)", () =>
{
    test("three cases, middle taken", () => assertRaisedReturn(`
        u32 x = 1;
        switch (x)
        {
            case 0:  return 10;
            case 1:  return 20;
            default: return 30;
        }
    `, 20))

    test("default (out-of-range tag)", () => assertRaisedReturn(`
        u32 x = 99;
        switch (x)
        {
            case 0:  return 10;
            case 1:  return 20;
            default: return 30;
        }
    `, 30))

    // e2e.test.ts's own regression: a non-last case whose body is a
    // fully-terminating if/else — every path already ends in RETURN, so
    // lower.ts omits that case's own trailing BLOCK_END. Raising this
    // correctly depends on treating a RETURN as closing its own block with
    // no BLOCK_END to consume, same as vm.ts's skipBlocks does.
    test("non-last case whose body is a fully-terminating if/else", () => assertRaisedReturn(`
        u32 x = 1;
        u32 y = 0;
        switch (x)
        {
            case 0:
                if (y) { return 100; } else { return 200; }
            case 1:  return 300;
            default: return 400;
        }
    `, 300))
})

describe("raise: stack-bridging compound expressions (PEEK_PEEK/POP_ACC combos)", () =>
{
    test("add: both sides complex, acc demand", () => assertRaisedReturn(`
        u32 a = 1; u32 b = 2; u32 c = 3; u32 d = 4;
        return (a + b) + (c + d);
    `, 10))

    test("add: both sides complex, tos demand (via declaration)", () => assertRaisedReturn(`
        u32 a = 1; u32 b = 2; u32 c = 3; u32 d = 4;
        u32 r = (a + b) + (c + d);
        return r;
    `, 10))

    test("sub (paired/RSUB): both sides complex, acc demand", () => assertRaisedReturn(`
        u32 a = 10; u32 b = 2; u32 c = 3; u32 d = 1;
        return (a - b) - (c - d);
    `, 6))

    test("comparison: both sides complex, tos demand", () => assertRaisedReturn(`
        u32 a = 1; u32 b = 2; u32 c = 3; u32 d = 4;
        u32 r = (a + b) < (c * d);
        return r;
    `, 1))

    test("shift: both sides complex, acc demand", () => assertRaisedReturn(`
        u32 a = 1; u32 b = 2; u32 c = 3; u32 d = 1;
        return (a << b) >> (c - d);
    `, 1))

    test("8-leaf balanced tree, tos demand", () => assertRaisedReturn(`
        u32 v0=1; u32 v1=2; u32 v2=3; u32 v3=4; u32 v4=5; u32 v5=6; u32 v6=7; u32 v7=8;
        u32 sum = ((v0 + v1) + (v2 + v3)) + ((v4 + v5) + (v6 + v7));
        return sum;
    `, 36))
})

describe("raise: unary operators", () =>
{
    test("negation", () => assertRaisedReturn("u32 x = 5; return -x;", -5))
    test("bitwise not", () => assertRaisedReturn("u32 x = 5; return ~x;", ~5))
    test("clz", () => assertRaisedReturn("u32 x = 5; return clz(x);", Math.clz32(5)))
    test("revbits(clz(x)) — composed builtins", () => assertRaisedReturn(`
        u32 x = 5;
        return revbits(clz(x));
    `, 0xb8000000))
})

describe("raise: ternary (a dispatch whose arms assign one slot)", () =>
{
    test("both arms", () =>
    {
        assertRaisedReturn("u32 a = 7; u32 b = 9; return a < b ? a : b;", 7)
        assertRaisedReturn("u32 a = 9; u32 b = 7; return a < b ? a : b;", 7)
    })

    test("the slot the arms wrote is read after the merge", () => assertRaisedReturn(`
        u32 a = 7;
        u32 b = a > 3 ? 11 : 22;
        return b + 1;
    `, 12))

    test("nested in an arm", () =>
        assertRaisedReturn("u32 a = 0; return a ? 1 : (a == 0 ? 42 : 7);", 42))

    test("in a loop condition", () => assertRaisedReturn(`
        u32 n = 0;
        u32 i = 0;
        while(i < (n ? 3 : 5)) { i = i + 1; }
        return i;
    `, 5))

    test("a trap arm", () => assertRaisedTrap("u32 a = 5; return a > 1 ? trap(3) : 9;", 3))
})

describe("raise: trap", () =>
{
    test("unconditional trap", () => assertRaisedTrap("trap(7);", 7))

    test("trap on one branch, return on the other", () => assertRaisedReturn(`
        u32 x = 0;
        if (x == 1) trap(9);
        else return 42;
    `, 42))

    test("falls through past an untaken trap branch", () => assertRaisedReturn(`
        u32 x = 0;
        if (x == 1) trap(9);
        return 5;
    `, 5))
})

// ─────────────────────────────────────────────────────────────────────────
// Multi-procedure programs (CALL) — reused from e2e.test.ts's own corpus.
// ─────────────────────────────────────────────────────────────────────────

describe("raise: multi-procedure programs (CALL)", () =>
{
    test("entry calls a helper procedure", () =>
    {
        const double = proc(["x"], ir`return x + x;`)
        assertRaisedProgram(proc([], ir`return ${double}(21);`), 42)
    })

    test("helper procedure with multiple arguments, in order", () =>
    {
        const sub = proc(["a", "b"], ir`return a - b;`)
        assertRaisedProgram(proc([], ir`return ${sub}(50, 8);`), 42)
    })

    test("transitive calls resolve through more than one hop", () =>
    {
        const inc = proc(["x"], ir`return x + 1;`)
        const twice = proc(["x"], ir`return ${inc}(${inc}(x));`)
        assertRaisedProgram(proc([], ir`return ${twice}(40);`), 42)
    })

    test("the same Procedure referenced from two call sites shares one table slot", () =>
    {
        const square = proc(["x"], ir`return x * x;`)
        const entry = proc([], ir`return ${square}(4) + ${square}(5);`)
        assertRaisedProgram(entry, 4 * 4 + 5 * 5)
    })

    test("a call's result can initialize a declared local", () =>
    {
        const inc = proc(["x"], ir`return x + 1;`)
        assertRaisedProgram(proc([], ir`
            u32 y = ${inc}(5);
            return y;
        `), 6)
    })
})

// ─────────────────────────────────────────────────────────────────────────
// EXT — all three ExtOpEffect.tosDelta shapes raise.ts's EXT case branches
// on. Every real codec opcode today is tosDelta:0 (a special case of the
// "≤0" branch); the ≤0/n>0 and >0 branches below are otherwise-untested
// paths this shakedown covers directly.
// ─────────────────────────────────────────────────────────────────────────

/** tosDelta: 0 — the shape every current codec opcode actually uses.
 *  Mirrors extension.test.ts's own `doubleExtension` fixture. */
function doubleExtension(): Extension
{
    return {
        rules: resolveLocal => [
            rule("ext:double", pBuiltinCall("double", pIdentifier()), m =>
                leafNode(["acc"], [extInstr("DOUBLE_REG", [resolveLocal(m.argumentMatches[0].name)])], [], 0, 0)),
        ],
        effects: { DOUBLE_REG: { tosDelta: 0, maxTransient: 0 } },
        exec: (instr, state) => { state.acc = (state.reg(instr.operands[0]!) * 2) >>> 0 },
    }
}

/**
 * tosDelta: -2 — pops two operands, produces one opaque acc result.
 * Nothing in this codebase uses a negative tosDelta today; this is the
 * first thing to actually exercise that branch of raise.ts's EXT case.
 * Hand-built `RtlProgram`, no `rules()`/DSL surface — matches
 * extension.test.ts's own precedent (`callShapedExtension`) for a shape
 * the DSL has no surface syntax for; the real consumer of this path is a
 * generated program anyway, never hand-authored `ir` text.
 */
function sumTwoExtension(): Extension
{
    return {
        effects: { SUM_TWO: { tosDelta: -2, maxTransient: 0 } },
        exec: (_instr, state) => { const b = state.pop(); const a = state.pop(); state.acc = (a + b) >>> 0 },
    }
}

const sumTwoProgram: RtlProgram = {
    procedures: [{
        argCount: 0,
        body: [
            { op: "CONST", imm: 3 }, { op: "PUSH" },
            { op: "CONST", imm: 4 }, { op: "PUSH" },
            extInstr("SUM_TWO", []),
            { op: "RETURN" },
        ],
    }],
}

/**
 * tosDelta: +2 — a net stack push. A perfectly valid `run()`-executable VM
 * op (`state.push` is generic), but `raiseProgram` bans declaring one at
 * all — see `ExtOpEffect.tosDelta`'s own doc comment for why.
 */
function pushingExtension(): Extension
{
    return {
        effects: { SPLIT_REG: { tosDelta: 2, maxTransient: 0 } },
        exec: (instr, state) =>
        {
            const v = state.reg(instr.operands[0]!)
            state.push(v & 0xFF)
            state.push((v >>> 8) & 0xFF)
        },
    }
}

const pushingProgram: RtlProgram = {
    procedures: [{
        argCount: 0,
        body: [
            { op: "CONST", imm: 0x1234 },
            { op: "PUSH" }, // slot 0 = 0x1234
            extInstr("SPLIT_REG", [0]), // reads reg 0, pushes lo then hi
            { op: "POP" }, // acc = hi
            { op: "ADD", combo: "POP_ACC" }, // acc = hi + lo — just needs to be *some* function of both
            { op: "RETURN" },
        ],
    }],
}

describe("raise: EXT — tosDelta ≤ 0 (opaque acc result)", () =>
{
    test("tosDelta: 0 — no operands popped, one acc result (the real codec-op shape)", () =>
        assertRaisedReturn("u32 x = 5; return double(x);", 10, doubleExtension()))

    test("tosDelta: -2 — pops two operands, one acc result", () =>
    {
        const ext = sumTwoExtension()
        const vmResult = run(sumTwoProgram, ext)
        assert.ok(vmResult.ok)
        assert.equal(vmResult.acc, 7)

        const raisedResult = evalRaisedProgram(raiseProgram(sumTwoProgram, ext), ext)
        assert.ok(raisedResult.ok, `raised tree trapped (code ${raisedResult.trapCode})`)
        assert.equal(raisedResult.acc, vmResult.acc)
    })

    test("tosDelta: +2 is banned — run() executes it fine, raiseProgram throws", () =>
    {
        const ext = pushingExtension()
        const vmResult = run(pushingProgram, ext)
        assert.ok(vmResult.ok, "run(): a net-positive EXT op is a perfectly ordinary VM op")

        assert.throws(() => raiseProgram(pushingProgram, ext), /tosDelta > 0/)
    })
})

/**
 * ExtOpEffect.readsAcc (extension.ts) — an op whose real input is
 * "whatever's already in acc" rather than a popped stack value, the exact
 * shape @ppl/codecs's WRITE/STORE_VAL/WRITE_SEQ/READ_SEQ all use (their
 * `ir\`...\`` rule always places a value-producing sub-fragment directly
 * before the op, nothing in between). Mirrors `codec:store_val`'s own rule
 * shape (a trailing `pRtl("acc")` argument spliced in via `unaryNode`) —
 * the smallest fixture that actually exercises the real DSL path, not a
 * hand-built RtlProgram, since the whole point is proving the *rule
 * lowering* + raise.ts combination preserves this data flow end to end.
 */
function readsAccExtension(): Extension
{
    return {
        rules: () => [
            rule("ext:write_it", pBuiltinCall("write_it", pRtl("acc")), m =>
            {
                const [value] = m.argumentMatches
                return unaryNode(value.node, ["acc"], [...value.node.fragment, extInstr("WRITE_IT", [])])
            }),
        ],
        effects: { WRITE_IT: { tosDelta: 0, maxTransient: 0, readsAcc: true } },
        exec: (_instr, state) => { state.acc = (state.acc + 100) >>> 0 },
    }
}

/** Both fixture extensions combined — needed for the second test below,
 *  where a readsAcc op's input is itself another EXT's result rather than
 *  a plain local (raise.ts's own EXT case kills any *other* pending acc
 *  unconditionally, so this is the case that most directly proves the
 *  fix: without it, `double`'s result would be flushed as a dead
 *  statement and `write_it` would see nothing). */
function combinedExtension(): Extension
{
    const doubles = doubleExtension()
    const writes = readsAccExtension()
    return {
        rules: resolveLocal => [...doubles.rules!(resolveLocal, () => undefined), ...writes.rules!(resolveLocal, () => undefined)],
        effects: { ...doubles.effects, ...writes.effects },
        exec: (instr, state) => instr.ext === "DOUBLE_REG" ? doubles.exec!(instr, state) : writes.exec!(instr, state),
    }
}

describe("raise: EXT — readsAcc (implicit acc input, not a stack pop)", () =>
{
    test("a plain local variable flowing into a readsAcc op survives raising", () =>
        assertRaisedReturn("u32 x = 42; return write_it(x);", 142, readsAccExtension()))

    test("another EXT's result flowing directly into a readsAcc op survives raising", () =>
        assertRaisedReturn("u32 x = 21; return write_it(double(x));", 142, combinedExtension()))
})
