/**
 * src/target-js/test — the two control-flow shapes the codec rules never
 * produce, so nothing else here would reach them.
 *
 * `LOOP_POST` is the one thing `translateStmt`'s `StmtKind.Loop` case
 * branches on (a raised loop carries `pre`, isa-core.md §4.5), and a
 * `DEFAULT`-closed dispatch case is the one `raise.ts` folds the *last*
 * arm into rather than the next. Both are checked the way every other
 * codegen test here is: against `mog-core`'s own VM running the same
 * program.
 *
 * `generateProcedure` with no `entryNode` emits the GENERIC helper form —
 * plain numeric parameters and slot locals, no handle/Accessor machinery —
 * which is what makes a hand-built `RtlProgram` testable at all.
 */
import {test} from "node:test"
import * as assert from "node:assert/strict"

import type {RtlProgram, RtlInstr} from "mog-core"
import {raiseProgram, run, validateProgram} from "mog-core"
import {generateProcedure} from "../../src/target-js/engine/codec-codegen"
import {loadGenerated} from "./load-generated"

/** Lower nothing — these are hand-written instruction streams, because the
 *  point is the raised shape, not how a DSL source reaches it. */
function generated(body: RtlInstr[]): (arg: number) => number
{
    const program = {procedures: [{argCount: 1, body}]} as RtlProgram
    validateProgram(program)

    const raised = raiseProgram(program as never)[0]!
    const source = "export " + generateProcedure(0, raised, undefined, "encode", new Map())
        .replace(/, ctx: Ctx\)/, ")")

    return loadGenerated(source).encode_proc0
}

/** The VM's own answer for the same program and argument. */
function interpreted(body: RtlInstr[], arg: number): number
{
    const program = {procedures: [{argCount: 1, body}]} as RtlProgram
    const result = run(program, undefined, [arg])
    assert.ok(result.ok, `expected a normal return, got trap ${result.trapCode}`)
    return result.acc >>> 0
}

function agrees(body: RtlInstr[], args: readonly number[]): void
{
    const fn = generated(body)
    for(const arg of args)
        assert.equal(fn(arg) >>> 0, interpreted(body, arg), `argument ${arg}`)
}

// `while (i < n) { iterations += 1; i += 1 }` and its do-while twin.
// Counting *up* to the bound rather than down from it matters: a body that
// decrements past zero would wrap and spin 2^32 times before terminating,
// which is a correct answer arrived at far too slowly to assert on.
const countingLoop = (opener: "LOOP_PRE" | "LOOP_POST"): RtlInstr[] => [
    {op: "CONST", imm: 0}, {op: "PUSH"},                                    // k1 = iterations
    {op: "CONST", imm: 0}, {op: "PUSH"},                                    // k2 = i
    {op: opener},
        {op: "LOAD", target: 1}, {op: "ADD", combo: "IMM_ACC", imm: 1}, {op: "STORE", target: 1},
        {op: "LOAD", target: 2}, {op: "ADD", combo: "IMM_ACC", imm: 1}, {op: "STORE", target: 2},
        {op: "BLOCK_END"},
        {op: "LOAD", target: 2}, {op: "LT_U", combo: "REG_ACC", target: 0},
        {op: "BLOCK_END"},
    {op: "LOAD", target: 1}, {op: "RETURN"},
]

test("a pre-test loop's generated JS agrees with the VM", () =>
    agrees(countingLoop("LOOP_PRE"), [0, 1, 2, 5]))

test("a post-test loop's generated JS agrees with the VM", () =>
    agrees(countingLoop("LOOP_POST"), [0, 1, 2, 5]))

test("the two openers differ exactly where isa-core.md §4.5 says they do", () =>
{
    // n = 0: the pre-test form never enters, the post-test form runs once.
    assert.equal(generated(countingLoop("LOOP_PRE"))(0) >>> 0, 0)
    assert.equal(generated(countingLoop("LOOP_POST"))(0) >>> 0, 1)
})

// A gap filler (case[1]) that is nothing but DEFAULT, and a case[2] that
// runs its own body and then continues into case[N] as well.
const defaultDispatch: RtlInstr[] = [
    {op: "CONST", imm: 0}, {op: "PUSH"},                                    // k1 = result
    {op: "LOAD", target: 0},
    {op: "BR_TABLE", imm: 3},
        {op: "CONST", imm: 100}, {op: "STORE", target: 1}, {op: "BLOCK_END"},
        {op: "DEFAULT"},
        {op: "CONST", imm: 200}, {op: "STORE", target: 1}, {op: "DEFAULT"},
        {op: "LOAD", target: 1}, {op: "ADD", combo: "IMM_ACC", imm: 7}, {op: "STORE", target: 1},
        {op: "BLOCK_END"},
    {op: "LOAD", target: 1}, {op: "RETURN"},
]

test("a DEFAULT-closed case generates the default clause's own statements", () =>
    agrees(defaultDispatch, [0, 1, 2, 3, 99]))

test("...and lands on the values the fold implies", () =>
{
    const fn = generated(defaultDispatch)

    assert.equal(fn(0) >>> 0, 100) // its own body, then out
    assert.equal(fn(1) >>> 0, 7)   // gap filler: straight to case[N]
    assert.equal(fn(2) >>> 0, 207) // its own body, then case[N] too
    assert.equal(fn(3) >>> 0, 7)   // case[N] directly
})
