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
import {pLiteral, pIdentifier, pRtl, pBinary, pUnary, pAssign, pCall, pBuiltinCall} from "./matcher"
import type {ComboName, OutputLocation, Resource, RtlInstr, BinaryOpcode, UnaryOpcode, StackCombo} from "./rtl"
import {CONST, PUSH, LOAD, STORE, opReg, opRegWriteback, opImm, opStack, bare, call, outputHas} from "./rtl"
import type {RtlNode} from "./east"
import {nodeInvariants, pickBinaryOrder} from "./builders"

// ── Rule type + constructor ─────────────────────────────────────────────────

export interface Rule
{
    /**
     * Stable, human-readable rule identity — e.g. `"+->ADD:REG_ACC"`. Used
     * only for coverage/provenance tracking (orchestrator.ts); has no
     * effect on matching or lowering. Must stay stable across separate
     * `ruleset()` calls (each call builds fresh `Rule` objects with new
     * closures, so object identity can't be used for that purpose — see
     * `nodeRuleNames`/`touchedRuleNames` in orchestrator.ts) — so it's
     * derived only from the rule's shape (operator, combo, orientation),
     * never from `resolveLocal`/`reg`.
     */
    name: string
    pattern: EastPattern
    build: (match: MatchOf<any>) => RtlNode | undefined
}

export function rule<P extends EastPattern>(
    name: string,
    pattern: P,
    build: (match: MatchOf<P>) => RtlNode | undefined,
): Rule
{
    return {name, pattern, build: build as Rule["build"]}
}

// ── Operator classification ─────────────────────────────────────────────────

type OpClass = "strict" | "commutative" | "paired"
/**
 * "alu" ops have a register write-back combo (isa-core.md §3, combo 2);
 * "cmp" ops don't — comparisons are restricted to four combos, all → acc,
 * with no write-back variant at all (§4.2). This gates regOperandRules'
 * REG_REG variant below: without it, a comparison would get an ISA-invalid
 * "write the boolean back into a register" instruction generated for it.
 */
interface OpEntry {ast: BinaryOperator; isa: BinaryOpcode; class: OpClass; kind: "alu" | "cmp"; swap?: BinaryOpcode}

const OP_TABLE: readonly OpEntry[] = [
    {ast: "+", isa: "ADD", class: "commutative", kind: "alu"},
    {ast: "-", isa: "SUB", class: "paired", swap: "RSUB", kind: "alu"},
    {ast: "*", isa: "MUL", class: "commutative", kind: "alu"},
    {ast: "|", isa: "OR", class: "commutative", kind: "alu"},
    {ast: "^", isa: "XOR", class: "commutative", kind: "alu"},
    {ast: "&", isa: "AND", class: "commutative", kind: "alu"},
    {ast: "<<", isa: "SHL", class: "strict", kind: "alu"},
    {ast: ">>", isa: "SHR", class: "strict", kind: "alu"},
    {ast: "==", isa: "EQ", class: "commutative", kind: "cmp"},
    {ast: "!=", isa: "NE", class: "commutative", kind: "cmp"},
    {ast: "<", isa: "LT_U", class: "strict", kind: "cmp"},
    {ast: "<=", isa: "LE_U", class: "strict", kind: "cmp"},
    {ast: ">", isa: "GT_U", class: "strict", kind: "cmp"},
    {ast: ">=", isa: "GE_U", class: "strict", kind: "cmp"},
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
        rule("literal:acc", pLiteral(), m =>
            leafNode(["acc"], [CONST(m.value)], [], 0, 0)),
        rule("literal:tos", pLiteral(), m =>
            leafNode(["tos"], [CONST(m.value), PUSH()], ["acc"], 1, 1)),
        rule("identifier:acc", pIdentifier(), m =>
            leafNode(["acc"], [LOAD(resolveLocal(m.name))], [], 0, 0)),
        rule("identifier:tos", pIdentifier(), m =>
            leafNode(["tos"], [LOAD(resolveLocal(m.name)), PUSH()], ["acc"], 1, 1)),
    ]
}

// ── Unary rules ─────────────────────────────────────────────────────────────

function unaryRules(): Rule[]
{
    return [
        ...UNARY_OPS.map(({ast, isa}) =>
            rule(`unary:${ast}`, pUnary(ast, pRtl("acc")), m =>
                unaryNode(m.argumentMatch.node, ["acc"],
                    [...m.argumentMatch.node.fragment, bare(isa)]))),

        // Multi-level pattern: an involution (NEG or NOT) applied twice
        // cancels, so the inner value can be used as-is with neither
        // instruction emitted. This spans three AST levels — outer unary,
        // inner unary, and whatever the inner unary's own argument tiles
        // to — reaching past the inner UnaryExpression's own raw shape
        // rather than its (also-viable) one-level-reduced RtlNode. It
        // competes directly against applying `unary:${ast}` twice, which
        // costs two extra instructions this always beats on bytes.
        ...UNARY_OPS.map(({ast}) =>
            rule(`unary:${ast}${ast}:cancel`, pUnary(ast, pUnary(ast, pRtl("acc"))), m =>
                m.argumentMatch.argumentMatch.node)),
    ]
}

// ── Builtin-call rules ──────────────────────────────────────────────────────

/**
 * DSL-level built-ins with fixed lowering (isa-core.md §10.5) that take the
 * `name(arg)` call-like syntax but aren't real procedure calls — each is
 * exactly one bare unary op, so its single argument is demanded at `"acc"`
 * (like `unaryRules`' operand) rather than pushed to `"tos"` the way a real
 * call's arguments are (rules.ts's `callRule`). Matching is purely by
 * callee name and arity; nothing reserves these names as keywords (per
 * §10.5, `trap`/etc. are functions, not keywords), so a same-named,
 * one-argument user procedure would be shadowed by these rules rather than
 * ever reaching `callRule` — an accepted consequence of "built-in by
 * convention, not by reserved word."
 */
const BUILTIN_UNARY_CALLS: readonly {name: string; isa: UnaryOpcode}[] = [
    {name: "clz", isa: "CLZ"},
    {name: "revbits", isa: "REVBITS"},
] as const

function builtinCallRules(): Rule[]
{
    return BUILTIN_UNARY_CALLS.map(({name, isa}) =>
        rule(`builtin:${name}`, pBuiltinCall(name, "acc"), m =>
            unaryNode(m.argNode, ["acc"], [...m.argNode.fragment, bare(isa)])))
}

// ── Binary rule generators ──────────────────────────────────────────────────

/**
 * Operand is an Identifier consumed via two-level pattern.
 *
 * - REG_ACC: result → acc (the general case; always generated).
 * - REG_REG: result written back directly into the *operand identifier's
 *   own register* (combo 2, "rN = acc OP rN") — not an arbitrary
 *   externally-chosen target. This is what makes `x = x op e` (or its
 *   `x op= e` sugar) collapse to one instruction beyond the operand load:
 *   e.g. `x += 1` reformulated as the commutative `1 + x` folds to
 *   `CONST #1; ADD x → x`, no separate STORE. assignmentRules (below)
 *   picks this variant up when it already targets its own assignment's
 *   register; every other consumer simply never demands `{reg: N}` for an
 *   unrelated N, so it's otherwise inert. Only generated for `alu` ops —
 *   comparisons have no write-back combo at all (isa-core.md §4.2), so
 *   gating on `writeback` here keeps an ISA-invalid instruction from ever
 *   being constructed for e.g. `x = y < 10`.
 */
function regOperandRules(astOp: BinaryOperator, isaOp: BinaryOpcode, flipped: boolean, writeback: boolean, resolveLocal: (name: string) => number): Rule[]
{
    const pattern = flipped
        ? pBinary(astOp, pIdentifier(), pRtl("acc"))
        : pBinary(astOp, pRtl("acc"), pIdentifier())
    const flipSuffix = flipped ? ":flip" : ""

    const accChild = (m: any) => (flipped ? m.rightMatch : m.leftMatch) as {node: RtlNode}
    const ident = (m: any) => (flipped ? m.leftMatch : m.rightMatch) as {name: string}

    const rules = [
        rule(`${astOp}->${isaOp}:REG_ACC${flipSuffix}`, pattern, m =>
            nodeInvariants({
                children: [accChild(m).node], combo: "REG_ACC", output: "acc",
                fragment: [...accChild(m).node.fragment, opReg(isaOp, resolveLocal(ident(m).name))],
            })),
    ]

    if(writeback)
    {
        rules.push(rule(`${astOp}->${isaOp}:REG_REG${flipSuffix}`, pattern, m =>
        {
            const target = resolveLocal(ident(m).name)
            return nodeInvariants({
                children: [accChild(m).node], combo: "REG_REG", output: {"reg": target},
                fragment: [...accChild(m).node.fragment, opRegWriteback(isaOp, target)],
            })
        }))
    }

    return rules
}

/**
 * IMM_ACC: operand is a Literal consumed via two-level pattern. Two output
 * variants (acc, tos). There is deliberately no register-writeback variant
 * here: the immediate addressing mode always forces its result to acc
 * (isa-core.md §3) — there is no combo that both applies an immediate and
 * writes back to a register in one instruction. `x += 1`-shaped expressions
 * get their one-instruction form a different way: reformulated via
 * commutativity as `1 + x` (an already-tiled acc value combined with a
 * *register* operand), which is regOperandRules' REG_REG variant, above.
 */
function immOperandRules(astOp: BinaryOperator, isaOp: BinaryOpcode, flipped: boolean): Rule[]
{
    const pattern = flipped
        ? pBinary(astOp, pLiteral(), pRtl("acc"))
        : pBinary(astOp, pRtl("acc"), pLiteral())

    const variants: {loc: OutputLocation; extra: RtlInstr[]; extraTos: number; extraMax: number}[] = [
        {loc: "acc", extra: [], extraTos: 0, extraMax: 0},
        {loc: "tos", extra: [PUSH()], extraTos: 1, extraMax: 1},
    ]

    return variants.map(({loc, extra, extraTos, extraMax}) =>
    {
        const name = `${astOp}->${isaOp}:IMM_ACC:${loc}${flipped ? ":flip" : ""}`
        return rule(name, pattern, m =>
        {
            const acc = (flipped ? m.rightMatch : m.leftMatch) as {node: RtlNode}
            const lit = (flipped ? m.leftMatch : m.rightMatch) as {value: number}
            return nodeInvariants({
                children: [acc.node], combo: "IMM_ACC", output: loc,
                fragment: [...acc.node.fragment, opImm(isaOp, lit.value), ...extra],
                extraTosDelta: extraTos, extraMaxStack: extraMax,
            })
        })
    })
}

/**
 * Stack-operand combos: both children are RtlNodes (acc + tos). Two combos
 * — peek-and-write-back-in-place, and pop — the only two that reclaim what
 * they read; see ir-engine.md, "Every stack-read combo also reclaims its
 * operand" for why there is no third or fourth variant here.
 */
function stackOperandRules(astOp: BinaryOperator, isaOp: BinaryOpcode, flipped: boolean): Rule[]
{
    const pattern = flipped
        ? pBinary(astOp, pRtl("tos"), pRtl("acc"))
        : pBinary(astOp, pRtl("acc"), pRtl("tos"))
    const combos: {combo: StackCombo; output: OutputLocation}[] = [
        {combo: "PEEK_PEEK", output: "tos"},
        {combo: "POP_ACC", output: "acc"},
    ]
    return combos.map(({combo, output}) =>
    {
        const name = `${astOp}->${isaOp}:${combo}${flipped ? ":flip" : ""}`
        return rule(name, pattern, m =>
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
        })
    })
}

/** Generate all rules for one operator entry. */
function binaryRulesForOp(entry: OpEntry, resolveLocal: (name: string) => number): Rule[]
{
    const writeback = entry.kind === "alu"
    const rules: Rule[] = []
    // Direct orientation: L→acc, R→operand
    rules.push(...regOperandRules(entry.ast, entry.isa, false, writeback, resolveLocal))
    rules.push(...immOperandRules(entry.ast, entry.isa, false))
    rules.push(...stackOperandRules(entry.ast, entry.isa, false))
    // Flipped orientation
    if(entry.class === "commutative")
    {
        rules.push(...regOperandRules(entry.ast, entry.isa, true, writeback, resolveLocal))
        rules.push(...immOperandRules(entry.ast, entry.isa, true))
        rules.push(...stackOperandRules(entry.ast, entry.isa, true))
    }
    else if(entry.class === "paired" && entry.swap)
    {
        rules.push(...regOperandRules(entry.ast, entry.swap, true, writeback, resolveLocal))
        rules.push(...immOperandRules(entry.ast, entry.swap, true))
        rules.push(...stackOperandRules(entry.ast, entry.swap, true))
    }
    return rules
}

// ── Assignment + Call ───────────────────────────────────────────────────────

function assignmentRules(resolveLocal: (name: string) => number): Rule[]
{
    return [
        rule("assign:=", pAssign("=", pRtl()), m =>
        {
            const reg = resolveLocal(m.target)
            const rhs = m.rightMatch.node

            // The RHS may already have written its result directly into
            // this assignment's own target register — regOperandRules'
            // REG_REG write-back variant, reached when the assignment is
            // (or reduces to) `x = x op e`/`x op= e`. When that happens
            // there's nothing left to do: the fragment already *is* the
            // whole assignment, with no separate STORE.
            if (outputHas(rhs.output, {"reg": reg}))
                return rhs

            // Otherwise the RHS must already be in acc; append the STORE.
            if (!outputHas(rhs.output, "acc")) return undefined

            return unaryNode(rhs, ["acc", {"reg": reg}], [...rhs.fragment, STORE(reg)])
        }),
    ]
}

function callRule(): Rule
{
    return rule("call", pCall(), m =>
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

export const ruleset = (resolveLocal: (name: string) => number) => [
    ...leafRules(resolveLocal),
    ...unaryRules(),
    ...builtinCallRules(),
    ...OP_TABLE.flatMap(entry => binaryRulesForOp(entry, resolveLocal)),
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