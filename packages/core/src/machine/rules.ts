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

import type { BinaryOperator, UnaryOperator } from "./ast"
import type { EastPattern, MatchOf } from "./matcher"
import { pLiteral, pIdentifier, pRtl, pBinary, pUnary, pAssign, pCall } from "./matcher"
import type { ComboName, OutputLocation, Resource, RtlInstr, RtlNode } from "./east"
import { nodeInvariants, pickBinaryOrder } from "./builders"

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
    return { pattern, build: build as Rule["build"] }
}

// ── Operator classification ─────────────────────────────────────────────────

type OpClass = "strict" | "commutative" | "paired"
interface OpEntry { ast: BinaryOperator; isa: string; class: OpClass; swap?: string }

const OP_TABLE: readonly OpEntry[] = [
    { ast: "+",  isa: "ADD",  class: "commutative" },
    { ast: "-",  isa: "SUB",  class: "paired", swap: "RSUB" },
    { ast: "*",  isa: "MUL",  class: "commutative" },
    { ast: "|",  isa: "OR",   class: "commutative" },
    { ast: "^",  isa: "XOR",  class: "commutative" },
    { ast: "&",  isa: "AND",  class: "commutative" },
    { ast: "<<", isa: "SHL",  class: "strict" },
    { ast: ">>", isa: "SHR",  class: "strict" },
    { ast: "==", isa: "EQ",   class: "commutative" },
    { ast: "!=", isa: "NE",   class: "commutative" },
    { ast: "<",  isa: "LT_U", class: "strict" },
    { ast: "<=", isa: "LE_U", class: "strict" },
    { ast: ">",  isa: "GT_U", class: "strict" },
    { ast: ">=", isa: "GE_U", class: "strict" },
] as const

const UNARY_OPS: readonly { ast: UnaryOperator; isa: string }[] = [
    { ast: "-", isa: "NEG" },
    { ast: "~", isa: "NOT" },
] as const

// ── RtlNode construction helpers ────────────────────────────────────────────

function leafNode(output: OutputLocation[], fragment: RtlInstr[], clobbers: Resource[], tosDelta: number, maxStack: number): RtlNode
{
    return { type: "RtlNode", output, fragment, clobbers, tosDelta, maxStack }
}

function unaryNode(child: RtlNode, output: OutputLocation[], fragment: RtlInstr[]): RtlNode
{
    return { type: "RtlNode", output, fragment, clobbers: [...child.clobbers], tosDelta: child.tosDelta, maxStack: child.maxStack }
}

// ── Leaf rules ──────────────────────────────────────────────────────────────

function leafRules(): Rule[]
{
    return [
        rule(pLiteral(), m =>
            leafNode(["acc"], [{ op: "LOAD_IMM", imm: m.value }], [], 0, 0)),
        rule(pLiteral(), m =>
            leafNode(["tos"], [{ op: "LOAD_IMM", imm: m.value }, { op: "MOVE", combo: "PEEK_PUSH" }], ["acc"], 1, 1)),
        rule(pIdentifier(), m =>
            leafNode(["acc"], [{ op: "MOVE", combo: "REG_ACC", target: m.name }], [], 0, 0)),
        rule(pIdentifier(), m =>
            leafNode(["tos"], [{ op: "MOVE", combo: "REG_ACC", target: m.name }, { op: "MOVE", combo: "PEEK_PUSH" }], ["acc"], 1, 1)),
    ]
}

// ── Unary rules ─────────────────────────────────────────────────────────────

function unaryRules(): Rule[]
{
    return UNARY_OPS.map(({ ast, isa }) =>
        rule(pUnary(ast, pRtl("acc")), m =>
            unaryNode(m.argumentMatch.node, ["acc"],
                [...m.argumentMatch.node.fragment, { op: isa }])),
    )
}

// ── Binary rule generators ──────────────────────────────────────────────────

/** REG_ACC: operand is an Identifier consumed via two-level pattern. */
function regOperandRules(astOp: BinaryOperator, isaOp: string, flipped: boolean): Rule[]
{
    const pattern = flipped
        ? pBinary(astOp, pIdentifier(), pRtl("acc"))
        : pBinary(astOp, pRtl("acc"), pIdentifier())
    return [rule(pattern, m => {
        const acc = (flipped ? m.rightMatch : m.leftMatch) as { node: RtlNode }
        const id  = (flipped ? m.leftMatch  : m.rightMatch) as { name: string }
        return nodeInvariants({
            children: [acc.node], combo: "REG_ACC", output: "acc",
            fragment: [...acc.node.fragment, { op: isaOp, combo: "REG_ACC", target: id.name }],
        })
    })]
}

/** IMM_ACC: operand is a Literal consumed via two-level pattern. Three output variants. */
function immOperandRules(astOp: BinaryOperator, isaOp: string, flipped: boolean): Rule[]
{
    const pattern = flipped
        ? pBinary(astOp, pLiteral(), pRtl("acc"))
        : pBinary(astOp, pRtl("acc"), pLiteral())
    const variants = [
        { loc: "acc" as OutputLocation, extra: [] as RtlInstr[], extraTos: 0, extraMax: 0 },
        { loc: "reg" as OutputLocation, extra: [{ op: "MOVE", combo: "REG_REG", target: "<tmp>", writeback: true }], extraTos: 0, extraMax: 0 },
        { loc: "tos" as OutputLocation, extra: [{ op: "MOVE", combo: "PEEK_PUSH" }], extraTos: 1, extraMax: 1 },
    ]
    return variants.map(({ loc, extra, extraTos, extraMax }) =>
        rule(pattern, m => {
            const acc = (flipped ? m.rightMatch : m.leftMatch) as { node: RtlNode }
            const lit = (flipped ? m.leftMatch  : m.rightMatch) as { value: number }
            return nodeInvariants({
                children: [acc.node], combo: "IMM_ACC", output: loc,
                fragment: [...acc.node.fragment, { op: isaOp, combo: "IMM_ACC", imm: lit.value }, ...extra],
                extraTosDelta: extraTos, extraMaxStack: extraMax,
            })
        }),
    )
}

/** Stack-operand combos: both children are RtlNodes (acc + tos). Four combos. */
function stackOperandRules(astOp: BinaryOperator, isaOp: string, flipped: boolean): Rule[]
{
    const pattern = flipped
        ? pBinary(astOp, pRtl("tos"), pRtl("acc"))
        : pBinary(astOp, pRtl("acc"), pRtl("tos"))
    const combos: { combo: ComboName; output: OutputLocation }[] = [
        { combo: "PEEK_ACC",  output: "acc" },
        { combo: "PEEK_PEEK", output: "tos" },
        { combo: "POP_ACC",   output: "acc" },
        { combo: "PEEK_PUSH", output: "tos" },
    ]
    return combos.map(({ combo, output }) =>
        rule(pattern, m => {
            const accChild = (flipped ? m.rightMatch : m.leftMatch).node
            const tosChild = (flipped ? m.leftMatch  : m.rightMatch).node
            const order = pickBinaryOrder(accChild, tosChild)
            if (!order) return undefined
            const [first, second] = order
            return nodeInvariants({
                children: [first, second], combo, output,
                fragment: [...first.fragment, ...second.fragment, { op: isaOp, combo }],
            })
        }),
    )
}

/** Generate all rules for one operator entry. */
function binaryRulesForOp(entry: OpEntry): Rule[]
{
    const rules: Rule[] = []
    // Direct orientation: L→acc, R→operand
    rules.push(...regOperandRules(entry.ast, entry.isa, false))
    rules.push(...immOperandRules(entry.ast, entry.isa, false))
    rules.push(...stackOperandRules(entry.ast, entry.isa, false))
    // Flipped orientation
    if (entry.class === "commutative")
    {
        rules.push(...regOperandRules(entry.ast, entry.isa, true))
        rules.push(...immOperandRules(entry.ast, entry.isa, true))
        rules.push(...stackOperandRules(entry.ast, entry.isa, true))
    }
    else if (entry.class === "paired" && entry.swap)
    {
        rules.push(...regOperandRules(entry.ast, entry.swap, true))
        rules.push(...immOperandRules(entry.ast, entry.swap, true))
        rules.push(...stackOperandRules(entry.ast, entry.swap, true))
    }
    return rules
}

// ── Assignment + Call ───────────────────────────────────────────────────────

function assignmentRules(): Rule[]
{
    return [
        rule(pAssign("=", pRtl("acc")), m =>
            unaryNode(m.rightMatch.node, ["acc"],
                [...m.rightMatch.node.fragment,
                 { op: "MOVE", combo: "REG_REG", target: m.target, writeback: true }])),
    ]
}

function callRule(): Rule
{
    return rule(pCall(), m => {
        const { argNodes, callee } = m
        const fragment: RtlInstr[] = [...argNodes.flatMap(a => a.fragment), { op: "CALL", callee }]
        const clobbers = new Set<Resource>(argNodes.flatMap(a => a.clobbers))
        const tosDelta = argNodes.reduce((s, a) => s + a.tosDelta, 0) - argNodes.length
        let running = 0, maxStack = 0
        for (const arg of argNodes) { maxStack = Math.max(maxStack, running + arg.maxStack); running += arg.tosDelta }
        return { type: "RtlNode", output: ["acc"], fragment, clobbers: [...clobbers], tosDelta, maxStack }
    })
}

// ── Build complete ruleset ──────────────────────────────────────────────────

export function buildRuleset(): Rule[]
{
    return [
        ...leafRules(),
        ...unaryRules(),
        ...OP_TABLE.flatMap(binaryRulesForOp),
        ...assignmentRules(),
        callRule(),
    ]
}
