/**
 * @ppl/core/machine — Lowering ruleset
 *
 * Rule table for the EAST pattern-rewrite lowerer. Each rule is a
 * (pattern, build) pair. The orchestrator tries every rule at every match
 * site; build returns undefined to prune unviable variants.
 *
 * Binary op classes (swap via rule-table multiplication):
 *   strict:       AST order only
 *   commutative:  direct + child-flip (same opcode)
 *   paired:       direct + child-flip (opcode swapped SUB→RSUB)
 *
 * Register/literal operands use two-level patterns matching Identifier /
 * Literal as a direct child of Binary — no intermediate reg-output RtlNode.
 */

import type {BinaryOperator, UnaryOperator} from "./ast"
import type {EastPattern, MatchOf} from "./matcher"
import {pLiteral, pIdentifier, pRtl, pBinary, pUnary, pAssign, pCall} from "./matcher"
import type {ComboName, OutputLocation, Resource, RtlInstr, BinaryOpcode, UnaryOpcode, StackCombo} from "./rtl"
import {CONST, PUSH, LOAD, STORE, opReg, opImm, opStack, bare, call} from "./rtl"
import type {RtlNode} from "./east"
import {nodeInvariants, pickBinaryOrder} from "./builders"

// ── Rule type + constructor ─────────────────────────────────────────────────

export interface Rule
{
    pattern: EastPattern
    build: (match: MatchOf<any>) => RtlNode | undefined
}

export function rule<P extends EastPattern>(
    pattern: P,
    build: (match: MatchOf<P>) => RtlNode | undefined,
): Rule
{
    return {pattern, build: build as Rule["build"]}
}

// ── Operator classification ─────────────────────────────────────────────────

type OpClass = "strict" | "commutative" | "paired"
interface OpEntry {ast: BinaryOperator; isa: BinaryOpcode; class: OpClass; swap?: BinaryOpcode}

const OP_TABLE: readonly OpEntry[] = [
    {ast: "+", isa: "ADD", class: "commutative"},
    {ast: "-", isa: "SUB", class: "paired", swap: "RSUB"},
    {ast: "*", isa: "MUL", class: "commutative"},
    {ast: "|", isa: "OR", class: "commutative"},
    {ast: "^", isa: "XOR", class: "commutative"},
    {ast: "&", isa: "AND", class: "commutative"},
    {ast: "<<", isa: "SHL", class: "strict"},
    {ast: ">>", isa: "SHR", class: "strict"},
    {ast: "==", isa: "EQ", class: "commutative"},
    {ast: "!=", isa: "NE", class: "commutative"},
    {ast: "<", isa: "LT_U", class: "strict"},
    {ast: "<=", isa: "LE_U", class: "strict"},
    {ast: ">", isa: "GT_U", class: "strict"},
    {ast: ">=", isa: "GE_U", class: "strict"},
] as const

const UNARY_OPS: readonly {ast: UnaryOperator; isa: UnaryOpcode}[] = [
    {ast: "-", isa: "NEG"},
    {ast: "~", isa: "NOT"},
] as const

// ── RtlNode construction helpers ────────────────────────────────────────────

function leafNode(output: OutputLocation[], fragment: RtlInstr[], clobbers: Resource[], tosDelta: number, maxStack: number): RtlNode
{
    return {type: "RtlNode", output, fragment, clobbers, tosDelta, maxStack}
}

function unaryNode(child: RtlNode, output: OutputLocation[], fragment: RtlInstr[]): RtlNode
{
    return {type: "RtlNode", output, fragment, clobbers: [...child.clobbers], tosDelta: child.tosDelta, maxStack: child.maxStack}
}

// ── Leaf rules ──────────────────────────────────────────────────────────────

function leafRules(resolveLocal: (name: string) => number): Rule[]
{
    return [
        rule(pLiteral(), m =>
            leafNode(["acc"], [CONST(m.value)], [], 0, 0)),
        rule(pLiteral(), m =>
            leafNode(["tos"], [CONST(m.value), PUSH()], ["acc"], 1, 1)),
        rule(pIdentifier(), m =>
            leafNode(["acc"], [LOAD(resolveLocal(m.name))], [], 0, 0)),
        rule(pIdentifier(), m =>
            leafNode(["tos"], [LOAD(resolveLocal(m.name)), PUSH()], ["acc"], 1, 1)),
    ]
}

// ── Unary rules ─────────────────────────────────────────────────────────────

function unaryRules(): Rule[]
{
    return UNARY_OPS.map(({ast, isa}) =>
        rule(pUnary(ast, pRtl("acc")), m =>
            unaryNode(m.argumentMatch.node, ["acc"],
                [...m.argumentMatch.node.fragment, bare(isa)])),
    )
}

// ── Binary rule generators ──────────────────────────────────────────────────

/** REG_ACC: operand is an Identifier consumed via two-level pattern. */
function regOperandRules(astOp: BinaryOperator, isaOp: BinaryOpcode, flipped: boolean, resolveLocal: (name: string) => number): Rule[]
{
    const pattern = flipped
        ? pBinary(astOp, pIdentifier(), pRtl("acc"))
        : pBinary(astOp, pRtl("acc"), pIdentifier())

    return [rule(pattern, m =>
    {
        const acc = (flipped ? m.rightMatch : m.leftMatch) as {node: RtlNode}
        const id = (flipped ? m.leftMatch : m.rightMatch) as {name: string}

        return nodeInvariants({
            children: [acc.node], combo: "REG_ACC", output: "acc",
            fragment: [...acc.node.fragment, opReg(isaOp, resolveLocal(id.name))],
        })
    })]
}

/** IMM_ACC: operand is a Literal consumed via two-level pattern. Three output variants. */
function immOperandRules(astOp: BinaryOperator, isaOp: BinaryOpcode, flipped: boolean, reg?: number): Rule[]
{
    const pattern = flipped
        ? pBinary(astOp, pLiteral(), pRtl("acc"))
        : pBinary(astOp, pRtl("acc"), pLiteral())

    const variants: {loc: OutputLocation; extra: RtlInstr[]; extraTos: number; extraMax: number}[] = [
        {loc: "acc", extra: [], extraTos: 0, extraMax: 0},
        {loc: "tos", extra: [PUSH()], extraTos: 1, extraMax: 1},
        ...(reg ? [{loc: {"reg": reg}, extra: [STORE(reg)], extraTos: 0, extraMax: 0}] : []),
    ]

    return variants.map(({loc, extra, extraTos, extraMax}) =>
        rule(pattern, m =>
        {
            const acc = (flipped ? m.rightMatch : m.leftMatch) as {node: RtlNode}
            const lit = (flipped ? m.leftMatch : m.rightMatch) as {value: number}
            return nodeInvariants({
                children: [acc.node], combo: "IMM_ACC", output: loc,
                fragment: [...acc.node.fragment, opImm(isaOp, lit.value), ...extra],
                extraTosDelta: extraTos, extraMaxStack: extraMax,
            })
        }),
    )
}

/** Stack-operand combos: both children are RtlNodes (acc + tos). Four combos. */
function stackOperandRules(astOp: BinaryOperator, isaOp: BinaryOpcode, flipped: boolean): Rule[]
{
    const pattern = flipped
        ? pBinary(astOp, pRtl("tos"), pRtl("acc"))
        : pBinary(astOp, pRtl("acc"), pRtl("tos"))
    const combos: {combo: StackCombo; output: OutputLocation}[] = [
        {combo: "PEEK_ACC", output: "acc"},
        {combo: "PEEK_PEEK", output: "tos"},
        {combo: "POP_ACC", output: "acc"},
        {combo: "PEEK_PUSH", output: "tos"},
    ]
    return combos.map(({combo, output}) =>
        rule(pattern, m =>
        {
            const accChild = (flipped ? m.rightMatch : m.leftMatch).node
            const tosChild = (flipped ? m.leftMatch : m.rightMatch).node
            const order = pickBinaryOrder(accChild, tosChild)
            if(!order) return undefined
            const [first, second] = order
            return nodeInvariants({
                children: [first, second], combo, output,
                fragment: [...first.fragment, ...second.fragment, opStack(isaOp, combo)],
            })
        }),
    )
}

/** Generate all rules for one operator entry. */
function binaryRulesForOp(entry: OpEntry, resolveLocal: (name: string) => number, reg?: number): Rule[]
{
    const rules: Rule[] = []
    // Direct orientation: L→acc, R→operand
    rules.push(...regOperandRules(entry.ast, entry.isa, false, resolveLocal))
    rules.push(...immOperandRules(entry.ast, entry.isa, false, reg))
    rules.push(...stackOperandRules(entry.ast, entry.isa, false))
    // Flipped orientation
    if(entry.class === "commutative")
    {
        rules.push(...regOperandRules(entry.ast, entry.isa, true, resolveLocal))
        rules.push(...immOperandRules(entry.ast, entry.isa, true, reg))
        rules.push(...stackOperandRules(entry.ast, entry.isa, true))
    }
    else if(entry.class === "paired" && entry.swap)
    {
        rules.push(...regOperandRules(entry.ast, entry.swap, true, resolveLocal))
        rules.push(...immOperandRules(entry.ast, entry.swap, true, reg))
        rules.push(...stackOperandRules(entry.ast, entry.swap, true))
    }
    return rules
}

// ── Assignment + Call ───────────────────────────────────────────────────────

function assignmentRules(resolveLocal: (name: string) => number): Rule[]
{
    return [
        rule(pAssign("=", pRtl("acc")), m =>
        {
            const reg = resolveLocal(m.target)
            return unaryNode(m.rightMatch.node, ["acc", {"reg": reg}],
            [
                ...m.rightMatch.node.fragment,
                STORE(reg)
            ])
        }),
    ]
}

function callRule(): Rule
{
    return rule(pCall(), m =>
    {
        const {argNodes, callee} = m
        const fragment: RtlInstr[] = [...argNodes.flatMap(a => a.fragment), call(callee)]
        const clobbers = new Set<Resource>(argNodes.flatMap(a => a.clobbers))
        const tosDelta = argNodes.reduce((s, a) => s + a.tosDelta, 0) - argNodes.length
        let running = 0, maxStack = 0
        for(const arg of argNodes) {maxStack = Math.max(maxStack, running + arg.maxStack); running += arg.tosDelta}
        return {type: "RtlNode", output: ["acc"], fragment, clobbers: [...clobbers], tosDelta, maxStack}
    })
}

export const ruleset = (resolveLocal: (name: string) => number, reg?: number) => [
    ...leafRules(resolveLocal),
    ...unaryRules(),
    ...OP_TABLE.flatMap(entry => binaryRulesForOp(entry, resolveLocal, reg)),
    ...assignmentRules(resolveLocal),
    callRule(),
]

/**
 * Test/debug ruleset: resolves an identifier to its own name rather than a
 * real register index, so formatted fragments read as `LOAD x` instead of
 * `LOAD 0` — readable without wiring up a real per-scope allocator. Not for
 * lowering actual procedures; see `ProgramLowerer`/`lowerProc` (lower.ts)
 * for the allocator used by the real pipeline.
 */
export const DEFAULT_RULESET: Rule[] = ruleset(name => name as unknown as number)