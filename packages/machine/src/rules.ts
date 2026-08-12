/**
 * @ppl/machine — Lowering ruleset
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
 *
 * Every rule builder below (`leafRules`, `foldRules`, `unaryRules`,
 * `builtinCallRules`, `regOperandRules`, `immOperandRules`,
 * `stackOperandRules`, `binaryRulesForOp`, `assignmentRules`, `callRules`)
 * is deliberately *not* parameterized by `E` — none of them ever construct
 * or inspect an `E`-shaped instruction, only core, non-`EXT` ones
 * (`rtl.ts`'s `BaseRtlInstr`), so each returns a plain `Rule[]` (the
 * default `E = ExtOpPayload`). `ruleset()` splices those together with
 * whatever `Rule<E>[]` an extension's own `rules()` contributes
 * (`Extension.rules`, extension.ts) into one `Rule<E>[]` for its own
 * caller-supplied `E`, and that widening is free — `Rule.build` is
 * declared with method syntax specifically so TS checks it *bivariantly*,
 * letting a `Rule<ExtOpPayload>` stand in for a `Rule<E>` for any `E`
 * without a cast. (Everywhere else in this codebase, a callback-shaped
 * field is deliberately declared as an arrow-typed property instead, for
 * strict — sound — contravariant checking; this is the one spot that
 * specifically wants the looser, unsound-in-general check, because every
 * value actually flowing through it is already known safe: nothing here
 * ever reads an `E`-shaped field.)
 */

import type {BinaryOperator, Literal, UnaryOperator} from "./ast"
import type {EastPattern, MatchOf, CallPattern} from "./matcher"
import {pLiteral, pConst, pIdentifier, pRtl, pBinary, pUnary, pAssign, pCall, pBuiltinCall} from "./matcher"
import type {ComboName, OutputLocation, Resource, RtlInstr, BinaryOpcode, UnaryOpcode, StackCombo, ExtOpPayload} from "./rtl"
import {CONST, PUSH, LOAD, STORE, opReg, opRegWriteback, opImm, opStack, bare, call, trap, outputHas} from "./rtl"
import type {EastExpression, RtlNode} from "./east"
import {nodeInvariants, pickBinaryOrder} from "./builders"
import type {Extension} from "./extension"

// ── Rule type + constructor ─────────────────────────────────────────────────

export interface Rule<E extends { ext: string } = ExtOpPayload>
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
    /** Usually builds an `RtlNode` (real code); a `fold:*` rule (below)
     *  builds a plain `Literal` instead — both are `EastExpression`s, and
     *  the orchestrator's `tileNode` treats them uniformly as tile
     *  candidates for the same node. Method syntax (not an arrow-typed
     *  property) — see this file's own header for why. */
    build(match: MatchOf<any, E>): EastExpression<E> | undefined
}

/** Genuinely `<E>`-generic (unlike this file's own internal builders below,
 *  which stay at the default `E` and cast once at their own return
 *  boundary) — an extension author calling this directly (as
 *  `Extension.rules`, e.g. `@ppl/codecs`'s `codecRules()`) needs `E` to
 *  actually propagate from a real `leafNode<E>`/`unaryNode<E>` call inside
 *  `build`, not be squashed to the default by a non-generic signature
 *  here. */
export function rule<P extends EastPattern, E extends { ext: string } = ExtOpPayload>(
    name: string,
    pattern: P,
    build: (match: MatchOf<P, E>) => EastExpression<E> | undefined,
): Rule<E>
{
    return {name, pattern, build: build as Rule<E>["build"]}
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

/** Exported for extensions (extension.ts's `Extension.rules`) — building a
 *  leaf `RtlNode` for a domain-specific opcode is exactly this same shape,
 *  not something the extension mechanism needs to reinvent. */
export function leafNode<E extends { ext: string } = ExtOpPayload>(output: OutputLocation[], fragment: RtlInstr<E>[], clobbers: Resource[], tosDelta: number, maxStack: number): RtlNode<E>
{
    return {type: "RtlNode", output, fragment, clobbers, tosDelta, maxStack}
}

/** Exported for extensions (extension.ts's `Extension.rules`) — same reason
 *  as `leafNode` above: a domain-specific opcode that consumes a real,
 *  tiled sub-expression's value (rather than only literal operands) needs
 *  to splice that child's own fragment in ahead of its instruction and
 *  inherit its `clobbers`/`tosDelta`/`maxStack`, exactly this shape. */
export function unaryNode<E extends { ext: string } = ExtOpPayload>(child: RtlNode<E>, output: OutputLocation[], fragment: RtlInstr<E>[]): RtlNode<E>
{
    return {type: "RtlNode", output, fragment, clobbers: [...child.clobbers], tosDelta: child.tosDelta, maxStack: child.maxStack}
}

// ── Leaf rules ──────────────────────────────────────────────────────────────

/**
 * `identifier:acc`/`identifier:tos` are tried opportunistically against
 * *every* bare identifier `tileNode` ever reaches — including one a
 * call-shaped node's own argument-tiling attempts eagerly, before anyone
 * has checked whether that identifier was ever meant to be a local at all
 * (`matchAllEast`'s `"Call"` case, matcher.ts:283-300, tiles every argument
 * of *any* call-shaped node unconditionally, since it has no way to know in
 * advance that a sibling `BuiltinCallPattern` rule — e.g. a codec
 * extension's `call_codec(${proc}, ...)`, where the first argument is a
 * callee-reference identifier, never a value — is the one that will
 * actually win). `resolveLocal` throwing hard on an unresolvable name is
 * correct and valuable everywhere else it's called directly against a
 * *fixed* pattern position the author explicitly wrote as "this names a
 * local" (`regOperandRules`/`assignmentRules`/etc.) — but here, reachable
 * from unconstrained tiling, the same throw would abort matching for the
 * *whole* enclosing expression over an identifier this rule was only ever
 * opportunistically trying. Catching it and declining (no candidate) is
 * this pair's own, narrowly-scoped exception to "resolveLocal throws" —
 * everywhere else keeps the hard failure.
 */
function leafRules(resolveLocal: (name: string) => number): Rule[]
{
    const tryResolveLocal = (name: string): number | undefined =>
    {
        try { return resolveLocal(name) } catch { return undefined }
    }

    return [
        rule("literal:acc", pLiteral(), m =>
            leafNode(["acc"], [CONST(m.value)], [], 0, 0)),
        rule("literal:tos", pLiteral(), m =>
            leafNode(["tos"], [CONST(m.value), PUSH()], ["acc"], 1, 1)),
        rule("identifier:acc", pIdentifier(), m =>
        {
            const idx = tryResolveLocal(m.name)
            return idx === undefined ? undefined : leafNode(["acc"], [LOAD(idx)], [], 0, 0)
        }),
        rule("identifier:tos", pIdentifier(), m =>
        {
            const idx = tryResolveLocal(m.name)
            return idx === undefined ? undefined : leafNode(["tos"], [LOAD(idx), PUSH()], ["acc"], 1, 1)
        }),
    ]
}

// ── Constant folding ─────────────────────────────────────────────────────────
//
// Expressed as ordinary Rules producing a `Literal` instead of an
// `RtlNode` — matcher.ts's `"Const"` pattern case (`pConst()`) resolves a
// non-literal shape through the same memoized `tile()` search used for real
// code, so e.g. a codec builtin's `pConst()`-typed argument sees through
// `-4` (`UnaryExpression("-", Literal(4))`) for free, with no separate
// pre-pass. `pLiteral()` itself stays a plain structural check — see
// `ConstPattern`'s doc comment (matcher.ts) for why the two can't be the
// same pattern kind.
//
// Binary folding is derived straight from `OP_TABLE` (below) rather than a
// second hand-written list — one `fold:binary:${ast}` rule per entry,
// keyed by AST operator (not `isa`/`swap`: a fold doesn't care which
// instruction *would* compute it, only the value). A fold rule only ever
// *adds* a `Literal`-kind candidate alongside a node's existing `RtlNode`
// candidates at that same node (orchestrator.ts's `pruneToFrontier` keeps
// the two separate) — it never removes or replaces them. But that node's
// *parent* does see a new option once this fires: a literal-op-literal
// subtree that previously forced a stack combo (no raw literal/identifier
// at that exact child position for reg/imm rules to match) is now also a
// `pConst()` match, so the parent can dispatch through `IMM_ACC` instead.
// This genuinely broke `test/coverage-sweep.test.ts`'s old `(8 + 9)`-shaped
// flip tie-break probes (folding made `(8 + 9)` cheap enough to stop
// forcing the stack-combo route they meant to exercise) — fixed by
// switching those probes to `(x + 100)`, which keeps the same acc/tos cost
// delta but can't fold (`x` isn't a compile-time constant). Verified
// against the full suite, not just reasoned about — see
// test/fold-sweep.test.ts and coverage-sweep.test.ts's own comment.
//
// Deliberately not "~"/"+"/"!" on the unary side: nothing needs them
// folded yet, and test/rule-coverage.test.ts's gate requires every
// declared rule to actually fire somewhere in the suite — an unused fold
// rule would just be dead code the gate catches immediately. Also no
// folding for "/"/"%" (`BinaryOperator` has them but `OP_TABLE` doesn't —
// there's no lowering for either yet at all, a separate, bigger gap).

const literalOf = (value: number): Literal => ({type: "Literal", value, raw: String(value)})

/** Mirrors vm.ts's own ALU-op semantics exactly (u32-wrapped inputs and,
 *  for arithmetic/shift ops, output) so a folded constant is bit-identical
 *  to what running the equivalent instruction would have produced. Only
 *  ever called with an `op` that's actually a key of `OP_TABLE` (below),
 *  so the two operators `BinaryOperator` has but `OP_TABLE` doesn't
 *  ("/", "%") never reach here. */
function foldBinaryOp(op: BinaryOperator, a: number, b: number): number
{
    const L = a >>> 0, R = b >>> 0
    switch(op)
    {
        case "+": return (L + R) >>> 0
        case "-": return (L - R) >>> 0
        case "*": return Math.imul(L, R) >>> 0
        case "&": return L & R
        case "|": return L | R
        case "^": return L ^ R
        case "<<": return (L << (R & 31)) >>> 0
        case ">>": return L >>> (R & 31)
        case "==": return L === R ? 1 : 0
        case "!=": return L !== R ? 1 : 0
        case "<": return L < R ? 1 : 0
        case "<=": return L <= R ? 1 : 0
        case ">": return L > R ? 1 : 0
        case ">=": return L >= R ? 1 : 0
        default: throw new Error(`fold: no lowering for "${op}" (OP_TABLE)`)
    }
}

function foldRules(): Rule[]
{
    return [
        rule("fold:unary:-", pUnary("-", pConst()), m => literalOf(-m.argumentMatch.value)),
        ...OP_TABLE.map(({ast}) =>
            rule(`fold:binary:${ast}`, pBinary(ast, pConst(), pConst()), m =>
                literalOf(foldBinaryOp(ast, m.leftMatch.value, m.rightMatch.value)))),
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
 * `name(arg)` call-like syntax but aren't real procedure calls. Matching is
 * purely by callee name and arity; nothing reserves these names as
 * keywords (per §10.5, they're functions, not keywords), so a same-named
 * user procedure of the same arity would be shadowed by these rules rather
 * than ever reaching `callRule` — an accepted consequence of "built-in by
 * convention, not by reserved word."
 *
 * `clz`/`revbits` are each exactly one bare unary op, so their argument is
 * demanded at `"acc"` (`pRtl("acc")`, like `unaryRules`' operand) rather
 * than pushed to `"tos"` the way a real call's arguments are.
 */
const BUILTIN_UNARY_CALLS: readonly {name: string; isa: UnaryOpcode}[] = [
    {name: "clz", isa: "CLZ"},
    {name: "revbits", isa: "REVBITS"},
] as const

/**
 * `trap(code)` → `TRAP #code`. Unlike the unary built-ins, `code` isn't a
 * general expression tiled to a register location — it's encoded straight
 * into the instruction's own immediate, so the pattern demands the
 * argument be a compile-time constant (`pConst()`, so e.g. `trap(-1)`
 * still works) rather than tiling it to any output tag at all. There's no
 * addressing-mode choice to make (one literal, one fixed encoding), so
 * unlike every other rule here this one never competes against an
 * alternative — it's the only match for `trap(<const>)` shape, full stop.
 * `trap` is also, uniquely among these
 * three, a terminator (isa-core.md §4.5): `alwaysTerminates` (lower.ts)
 * special-cases a `trap(...)` statement the same way it does `return`, so
 * a block ending in one doesn't get a spurious `BLOCK_END` appended after
 * its `TRAP`.
 */
function builtinCallRules(): Rule[]
{
    return [
        ...BUILTIN_UNARY_CALLS.map(({name, isa}) =>
            rule(`builtin:${name}`, pBuiltinCall(name, pRtl("acc")), m =>
                unaryNode(m.argumentMatches[0].node, ["acc"],
                    [...m.argumentMatches[0].node.fragment, bare(isa)]))),

        rule("builtin:trap", pBuiltinCall("trap", pConst()), m =>
            leafNode(["acc"], [trap(m.argumentMatches[0].value)], [], 0, 0)),
    ]
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
 * IMM_ACC: operand is a compile-time constant consumed via two-level
 * pattern (`pConst()`, so e.g. `x + -4` still folds the operand). Two
 * output variants (acc, tos). There is deliberately no register-writeback
 * variant here: the immediate addressing mode always forces its result to
 * acc (isa-core.md §3) — there is no combo that both applies an immediate
 * and writes back to a register in one instruction. `x += 1`-shaped
 * expressions get their one-instruction form a different way: reformulated
 * via commutativity as `1 + x` (an already-tiled acc value combined with a
 * *register* operand), which is regOperandRules' REG_REG variant, above.
 */
function immOperandRules(astOp: BinaryOperator, isaOp: BinaryOpcode, flipped: boolean): Rule[]
{
    const pattern = flipped
        ? pBinary(astOp, pConst(), pRtl("acc"))
        : pBinary(astOp, pRtl("acc"), pConst())

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
 *
 * `PEEK_PEEK` is `alu`-only: isa-core.md §4.2 gives comparisons exactly
 * four addressing combos (register/pop/immediate-small/immediate-ext, all
 * → acc), with no peek mode at all — only arithmetic's five-combo table
 * (§4.1) has one. A comparison needing `"tos"` output for two compound
 * operands still has a valid route, just a two-instruction one: `POP_ACC`
 * (→ acc, always available) followed by an explicit `PUSH`, the same
 * shape `immOperandRules`' own `"tos"` variant already uses. `POP_ACC`
 * itself has no such restriction — mode 2 (pop → acc) is valid for both
 * classes — so only `PEEK_PEEK` is gated here.
 */
function stackOperandRules(astOp: BinaryOperator, isaOp: BinaryOpcode, flipped: boolean, hasPeek: boolean): Rule[]
{
    const pattern = flipped
        ? pBinary(astOp, pRtl("tos"), pRtl("acc"))
        : pBinary(astOp, pRtl("acc"), pRtl("tos"))
    // Every variant is built from the same POP_ACC-addressed instruction;
    // only the name/output/trailing-PUSH differ. `hasPeek` swaps the
    // single-instruction PEEK_PEEK route for a two-instruction POP_ACC+PUSH
    // one to reach `"tos"` — comparisons must still be able to reach it,
    // just not via a combo their addressing table doesn't have.
    const variants: {name: string; combo: StackCombo; output: OutputLocation; extra: RtlInstr[]; extraTosDelta: number; extraMaxStack: number}[] = [
        {name: "POP_ACC", combo: "POP_ACC", output: "acc", extra: [], extraTosDelta: 0, extraMaxStack: 0},
        hasPeek
            ? {name: "PEEK_PEEK", combo: "PEEK_PEEK", output: "tos", extra: [], extraTosDelta: 0, extraMaxStack: 0}
            : {name: "POP_ACC:tos", combo: "POP_ACC", output: "tos", extra: [PUSH()], extraTosDelta: 1, extraMaxStack: 1},
    ]
    return variants.map(({name, combo, output, extra, extraTosDelta, extraMaxStack}) =>
    {
        const ruleName = `${astOp}->${isaOp}:${name}${flipped ? ":flip" : ""}`
        return rule(ruleName, pattern, m =>
        {
            const accChild = (flipped ? m.rightMatch : m.leftMatch).node
            const tosChild = (flipped ? m.leftMatch : m.rightMatch).node
            const order = pickBinaryOrder(accChild, tosChild)
            if(!order) return undefined
            const [first, second] = order
            return nodeInvariants({
                children: [first, second], combo, output,
                fragment: [...first.fragment, ...second.fragment, opStack(isaOp, combo), ...extra],
                extraTosDelta, extraMaxStack,
            })
        })
    })
}

/** Generate all rules for one operator entry. */
function binaryRulesForOp(entry: OpEntry, resolveLocal: (name: string) => number): Rule[]
{
    // Both gate on the same spec fact (isa-core.md §4.2): comparisons have
    // no register-write-back combo *and* no peek combo — only arithmetic's
    // addressing table (§4.1) has either.
    const writeback = entry.kind === "alu"
    const hasPeek = entry.kind === "alu"
    const rules: Rule[] = []
    // Direct orientation: L→acc, R→operand
    rules.push(...regOperandRules(entry.ast, entry.isa, false, writeback, resolveLocal))
    rules.push(...immOperandRules(entry.ast, entry.isa, false))
    rules.push(...stackOperandRules(entry.ast, entry.isa, false, hasPeek))
    // Flipped orientation
    if(entry.class === "commutative")
    {
        rules.push(...regOperandRules(entry.ast, entry.isa, true, writeback, resolveLocal))
        rules.push(...immOperandRules(entry.ast, entry.isa, true))
        rules.push(...stackOperandRules(entry.ast, entry.isa, true, hasPeek))
    }
    else if(entry.class === "paired" && entry.swap)
    {
        rules.push(...regOperandRules(entry.ast, entry.swap, true, writeback, resolveLocal))
        rules.push(...immOperandRules(entry.ast, entry.swap, true))
        rules.push(...stackOperandRules(entry.ast, entry.swap, true, hasPeek))
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

/** Common shape shared by `call:acc`/`call:tos` below — the call itself,
 *  landing in `acc`, before either rule decides whether to leave it there
 *  or push it on to `tos`.
 *
 *  `stackArgs` is how many of `argNodes` actually get pushed: all but the
 *  last (matcher.ts's `CallPattern` already tiled the last one to `"acc"`
 *  instead — the calling convention's last-arg-in-acc rule). `CALL` itself
 *  only ever consumes `stackArgs` values off the stack, never the full
 *  `argNodes.length`. */
function callNode(m: MatchOf<CallPattern>, resolveCallee: (name: string) => number | undefined):
    Omit<RtlNode, "type" | "output"> | undefined
{
    const {argNodes, callee} = m
    // A callee this pass can't resolve (e.g. a builtin name like `clz`)
    // isn't an error here — it just means this rule isn't viable for this
    // call site; a builtin-specific rule handles it instead.
    const calleeIndex = resolveCallee(callee)
    if(calleeIndex === undefined) return undefined
    const stackArgs = Math.max(argNodes.length - 1, 0)
    const fragment: RtlInstr[] = [...argNodes.flatMap(a => a.fragment), call(calleeIndex)]
    const clobbers = new Set<Resource>(argNodes.flatMap(a => a.clobbers))
    const tosDelta = argNodes.reduce((s, a) => s + a.tosDelta, 0) - stackArgs
    let running = 0, maxStack = 0
    for(const arg of argNodes) {maxStack = Math.max(maxStack, running + arg.maxStack); running += arg.tosDelta}
    return {fragment, clobbers: [...clobbers], tosDelta, maxStack}
}

/**
 * Two output variants of the same call, mirroring `leafRules`' `:acc`/
 * `:tos` pair and `immOperandRules`'/`stackOperandRules`' own `"tos"`
 * variant (a trailing `PUSH`, cost +1 instruction, +1 tosDelta/maxStack).
 * Without `call:tos`, a call's result could only ever be read from `acc`
 * — which rules out using one as a `u32 x = ...` initializer
 * (`lowerVarDecl` demands `"tos"` unconditionally), as a binary operand
 * needing a stack bridge, or nested as a non-last argument of another call
 * (matcher.ts's per-argument tiling demands `"tos"` for every argument but
 * the last — `call:acc` still directly satisfies a call nested as the
 * *last* argument, e.g. `f(g(x))`, with no bridge needed at all).
 */
function callRules(resolveCallee: (name: string) => number | undefined): Rule[]
{
    return [
        rule("call:acc", pCall(), m =>
        {
            const built = callNode(m, resolveCallee)
            return built && {type: "RtlNode", output: ["acc"], ...built}
        }),
        rule("call:tos", pCall(), m =>
        {
            const built = callNode(m, resolveCallee)
            if(!built) return undefined
            return {
                type: "RtlNode",
                output: ["tos"],
                fragment: [...built.fragment, PUSH()],
                clobbers: [...built.clobbers, "acc"],
                tosDelta: built.tosDelta + 1,
                maxStack: Math.max(built.maxStack, built.tosDelta + 1),
            }
        }),
    ]
}

export const ruleset = <E extends { ext: string } = ExtOpPayload>(
    resolveLocal: (name: string) => number,
    resolveCallee: (name: string) => number | undefined,
    extension?: Extension<E>,
): Rule<E>[] => [
    ...foldRules(),
    ...leafRules(resolveLocal),
    ...unaryRules(),
    ...builtinCallRules(),
    ...(extension?.rules?.(resolveLocal, resolveCallee) ?? []),
    ...OP_TABLE.flatMap(entry => binaryRulesForOp(entry, resolveLocal)),
    ...assignmentRules(resolveLocal),
    ...callRules(resolveCallee),
]

/**
 * Test/debug ruleset: resolves an identifier (local or callee) to its own
 * name rather than a real register/procedure-table index, so formatted
 * fragments read as `LOAD x`/`CALL foo` instead of `LOAD 0`/`CALL 0` —
 * readable without wiring up a real per-scope allocator or procedure
 * table. Not for lowering actual procedures; see `lowerProc`/`lowerProgram`
 * (lower.ts) for the pipeline used for real.
 */
export const DEFAULT_RULESET: Rule[] = ruleset(
    name => name as unknown as number,
    name => name as unknown as number,
)
