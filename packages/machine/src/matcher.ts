/**
 * @ppl/machine — EAST pattern matcher
 *
 * Tree-shaped pattern matching for the Extended AST, mirroring the
 * semantic-type matcher in `../matcher.ts`. A pattern is itself a tree;
 * matching is parallel recursive descent of (pattern tree, EAST subtree),
 * recording the pairing into a match object that mirrors the pattern.
 */

import type {
    AssignmentOperator,
    BinaryOperator,
    UnaryOperator,
} from "./ast"
import {
    EastExpression,
    isEastAssign,
    isEastBinary,
    isEastCall,
    isEastUnary,
    isIdentifier,
    isLiteral,
    isRtlNode,
    RtlNode,
} from "./east"
import { outputHas } from "./rtl"
import type { OutputLocation } from "./rtl"

// 1. Pattern interfaces

export interface LiteralPattern { kind: "Literal" }
export interface IdentifierPattern { kind: "Identifier" }

export interface RtlPattern
{
    kind: "Rtl"
    output?: OutputLocation
}

export interface BinaryPattern<
    L extends EastPattern = EastPattern,
    R extends EastPattern = EastPattern,
>
{
    kind: "Binary"
    operator: BinaryOperator
    left: L
    right: R
}

export interface UnaryPattern<A extends EastPattern = EastPattern>
{
    kind: "Unary"
    operator: UnaryOperator
    argument: A
}

export interface AssignPattern<V extends EastPattern = EastPattern>
{
    kind: "Assign"
    operator: AssignmentOperator
    right: V
}

/**
 * Call pattern. The planned-only call rule requires every argument but the
 * last to already be tiled to `tos` output (pushed, in order); the *last*
 * argument (if any) is tiled to `acc` instead — the calling convention
 * passes it there rather than through the stack, since `acc` is clobbered
 * by the call regardless (isa-core.md §4.6). A zero-argument call has no
 * "last" argument, so this doesn't apply to it. The pattern carries no
 * per-arg sub-patterns; the match just verifies the shape, and the builder
 * receives the RtlNode[] array.
 */
export interface CallPattern { kind: "Call" }

/**
 * Builtin-call pattern: `name(arg0, arg1, ...)` — the DSL's function-call-
 * like syntax for a fixed-lowering built-in (isa-core.md §10.5, e.g.
 * `clz(x)`, `revbits(x)`, `trap(code)`), distinct from `CallPattern`'s
 * real-procedure-call shape. `arguments` matches each position against its
 * own sub-pattern (like `UnaryPattern`'s `argument`) rather than always
 * tiled to a fixed tag the way `CallPattern`'s arguments always go to
 * `"tos"` — `clz`/`revbits` want `pRtl("acc")` (tile the argument, demand it
 * land in `acc`), `trap` wants `pLiteral()` (the argument must itself be a
 * compile-time literal, since it's encoded directly into `TRAP #code`'s
 * immediate, not computed at runtime).
 *
 * `variadicTail`, when set, lets a builtin take a fixed literal-operand
 * prefix (the positional `arguments` above) plus a variable number of real
 * runtime-value arguments after it — an extension's call-shaped op (e.g.
 * the codec extension's `CALL_CODEC`, docs/codec-extension.md §3.3, §4)
 * needs exactly this shape: literal operands selecting *what* to call,
 * followed by the ordinary value arguments being passed to it. The tail is
 * tiled exactly like `CallPattern`'s own arguments (all but the last to
 * `"tos"`, the last to `"acc"`) rather than against a sub-pattern of its
 * own, since there's no fixed count of them to have individual patterns for.
 */
export interface BuiltinCallPattern<A extends readonly EastPattern[] = readonly EastPattern[]>
{
    kind: "BuiltinCall"
    name: string
    arguments: A
    variadicTail?: boolean
}

// 2. Match interfaces

export interface LiteralMatch { kind: "Literal"; value: number }
export interface IdentifierMatch { kind: "Identifier"; name: string }
export interface RtlMatch { kind: "Rtl"; node: RtlNode }

export interface BinaryMatch<
    LM extends EastMatch = EastMatch,
    RM extends EastMatch = EastMatch,
>
{
    kind: "Binary"
    operator: BinaryOperator
    leftMatch: LM
    rightMatch: RM
}

export interface UnaryMatch<AM extends EastMatch = EastMatch>
{
    kind: "Unary"
    operator: UnaryOperator
    argumentMatch: AM
}

export interface AssignMatch<V extends EastMatch = EastMatch>
{
    kind: "Assign"
    operator: AssignmentOperator
    target: string
    rightMatch: V
}

export interface CallMatch
{
    kind: "Call"
    callee: string
    argNodes: RtlNode[]
}

export interface BuiltinCallMatch<AM extends readonly EastMatch[] = readonly EastMatch[]>
{
    kind: "BuiltinCall"
    argumentMatches: AM
    /** Present (possibly empty) exactly when the pattern set `variadicTail`
     *  — one already-tiled `RtlNode` per trailing runtime argument, in the
     *  same last-arg-in-acc/rest-in-tos shape `CallMatch.argNodes` uses. */
    tailNodes?: readonly RtlNode[]
}

// 3. Union types

export type EastPattern =
    | LiteralPattern
    | IdentifierPattern
    | RtlPattern
    | BinaryPattern
    | UnaryPattern
    | AssignPattern
    | CallPattern
    | BuiltinCallPattern

export type EastMatch =
    | LiteralMatch
    | IdentifierMatch
    | RtlMatch
    | BinaryMatch
    | UnaryMatch
    | AssignMatch
    | CallMatch
    | BuiltinCallMatch

// 4. MatchOf<P> — pattern → match mapping (recursively maps child sub-patterns)

export type MatchOf<P extends EastPattern> =
    P extends LiteralPattern        ? LiteralMatch
  : P extends IdentifierPattern    ? IdentifierMatch
  : P extends RtlPattern           ? RtlMatch
  : P extends BinaryPattern<infer L, infer R>
      ? BinaryMatch<MatchOf<L>, MatchOf<R>>
  : P extends UnaryPattern<infer A>
      ? UnaryMatch<MatchOf<A>>
  : P extends AssignPattern<infer V>
      ? AssignMatch<MatchOf<V>>
  : P extends CallPattern          ? CallMatch
  : P extends BuiltinCallPattern<infer A>
      ? BuiltinCallMatch<MatchOfTuple<A>>
  : never

/** Maps each pattern in a fixed-length tuple to its `MatchOf`, preserving
 *  tuple position — what lets e.g. `pBuiltinCall(name, pLiteral())`'s match
 *  type `argumentMatches[0]` narrow to a `LiteralMatch` directly, the same
 *  way a single `argument: A` field used to. */
type MatchOfTuple<T extends readonly EastPattern[]> =
    { readonly [K in keyof T]: T[K] extends EastPattern ? MatchOf<T[K]> : never }

// 5. matchAllEast — single dispatcher, inlines all per-kind matching
//
// Returns every way `P` can match `N`, not just the first. A pattern's `Rtl`
// leaf can be satisfied by more than one candidate tiling of the subtree
// underneath it (e.g. a stack combo needs `"acc"` specifically, but that
// subtree might also have a `"tos"` and a register-writeback candidate) —
// each is a distinct match, and a `Binary`/`Unary`/`Assign`/`Call` pattern
// combines its children's match sets via cross product, since any pairing
// of a viable left match with a viable right match is itself viable.
//
// `tile` resolves a `Rtl` leaf on demand: rather than requiring the tree to
// already contain a pre-rewritten `RtlNode` at that position (the old
// worklist model's assumption), it recursively tiles whatever raw AST
// subtree sits there right now. This is what lets a pattern reach two or
// more AST levels deep — nesting e.g. `pUnary(op, pUnary(op, ...))` — since
// intermediate levels are matched directly against their still-raw shape
// (operator/kind equality only) and only a pattern's own `Rtl` leaves ever
// trigger tiling. A naive "fully tile children, then match the parent
// against the finished result" scheme would have already collapsed an
// intermediate node before the parent's pattern ever got to see its raw
// shape — see docs/ir-engine.md for why this matters.
export function matchAllEast<P extends EastPattern>(
    N: EastExpression,
    P: P,
    tile: (node: EastExpression) => readonly RtlNode[],
): MatchOf<P>[]
{
    switch (P.kind)
    {
        case "Literal":
            return isLiteral(N)
                ? [{ kind: "Literal", value: N.value } as MatchOf<P>]
                : []

        case "Identifier":
            return isIdentifier(N)
                ? [{ kind: "Identifier", name: N.name } as MatchOf<P>]
                : []

        case "Rtl":
        {
            const candidates = tile(N)
            const filtered = P.output === undefined
                ? candidates
                : candidates.filter(c => outputHas(c.output, P.output!))
            return filtered.map(node => ({ kind: "Rtl", node } as MatchOf<P>))
        }

        case "Binary":
        {
            if (!isEastBinary(N)) return []
            if (N.operator !== P.operator) return []
            const leftMatches = matchAllEast(N.left, P.left, tile)
            if (leftMatches.length === 0) return []
            const rightMatches = matchAllEast(N.right, P.right, tile)
            if (rightMatches.length === 0) return []
            const out: MatchOf<P>[] = []
            for (const leftMatch of leftMatches)
                for (const rightMatch of rightMatches)
                    out.push({ kind: "Binary", operator: N.operator, leftMatch, rightMatch } as MatchOf<P>)
            return out
        }

        case "Unary":
        {
            if (!isEastUnary(N)) return []
            if (N.operator !== P.operator) return []
            return matchAllEast(N.argument, P.argument, tile)
                .map(argumentMatch => ({ kind: "Unary", operator: N.operator, argumentMatch } as MatchOf<P>))
        }

        case "Assign":
        {
            if (!isEastAssign(N)) return []
            if (N.operator !== P.operator) return []
            // left is always an Identifier per the EAST type
            if (N.left.type !== "Identifier") return []
            return matchAllEast(N.right, P.right, tile)
                .map(rightMatch => ({ kind: "Assign", operator: N.operator, target: N.left.name, rightMatch } as MatchOf<P>))
        }

        case "Call":
        {
            if (!isEastCall(N)) return []
            // callee is always an Identifier per the EAST type
            if (N.callee.type !== "Identifier") return []
            // Every argument but the last must tile to a `"tos"` candidate
            // (pushed, in order); the last tiles to `"acc"` instead (the
            // calling convention's last-arg-in-acc rule — CallPattern's doc
            // comment). The match set is the cross product across all slots.
            const last = N.arguments.length - 1
            const perArg = N.arguments.map((arg, i) =>
                tile(arg).filter(c => outputHas(c.output, i === last ? "acc" : "tos")))
            if (perArg.some(cands => cands.length === 0)) return []
            let combos: RtlNode[][] = [[]]
            for (const cands of perArg)
                combos = combos.flatMap(prefix => cands.map(c => [...prefix, c]))
            return combos.map(argNodes => ({ kind: "Call", callee: N.callee.name, argNodes } as MatchOf<P>))
        }

        case "BuiltinCall":
        {
            if (!isEastCall(N)) return []
            if (N.callee.type !== "Identifier" || N.callee.name !== P.name) return []
            const fixedCount = P.arguments.length
            if (P.variadicTail ? N.arguments.length < fixedCount : N.arguments.length !== fixedCount)
                return []

            // Fixed positional prefix, matched by sub-pattern (cross product
            // across positions) — mirrors "Binary"'s left/right combination.
            const perFixed = P.arguments.map((pat, i) => matchAllEast(N.arguments[i]!, pat, tile))
            if (perFixed.some(cands => cands.length === 0)) return []
            let fixedCombos: EastMatch[][] = [[]]
            for (const cands of perFixed)
                fixedCombos = fixedCombos.flatMap(prefix => cands.map(c => [...prefix, c]))

            if (!P.variadicTail)
                return fixedCombos.map(argumentMatches =>
                    ({ kind: "BuiltinCall", argumentMatches } as unknown as MatchOf<P>))

            // Variadic tail: remaining arguments tile exactly like a real
            // call's own calling convention ("Call", above) — all but the
            // last to "tos", the last to "acc".
            const tailArgs = N.arguments.slice(fixedCount)
            const lastTail = tailArgs.length - 1
            const perTail = tailArgs.map((arg, i) =>
                tile(arg).filter(c => outputHas(c.output, i === lastTail ? "acc" : "tos")))
            if (perTail.some(cands => cands.length === 0)) return []
            let tailCombos: RtlNode[][] = [[]]
            for (const cands of perTail)
                tailCombos = tailCombos.flatMap(prefix => cands.map(c => [...prefix, c]))

            const out: MatchOf<P>[] = []
            for (const argumentMatches of fixedCombos)
                for (const tailNodes of tailCombos)
                    out.push({ kind: "BuiltinCall", argumentMatches, tailNodes } as unknown as MatchOf<P>)
            return out
        }
    }
}

// 6. Pattern constructors

export const pLiteral = (): LiteralPattern => ({ kind: "Literal" })
export const pIdentifier = (): IdentifierPattern => ({ kind: "Identifier" })

export const pRtl = (output?: OutputLocation): RtlPattern =>
    ({ kind: "Rtl", output })

export const pBinary = <L extends EastPattern, R extends EastPattern>(
    operator: BinaryOperator,
    left: L,
    right: R,
): BinaryPattern<L, R> =>
    ({ kind: "Binary", operator, left, right })

export const pUnary = <A extends EastPattern>(
    operator: UnaryOperator,
    argument: A,
): UnaryPattern<A> =>
    ({ kind: "Unary", operator, argument })

export const pAssign = <V extends EastPattern>(
    operator: AssignmentOperator,
    right: V,
): AssignPattern<V> =>
    ({ kind: "Assign", operator, right })

export const pCall = (): CallPattern => ({ kind: "Call" })

/** The 1-ary case — `clz(x)`/`revbits(x)`/`trap(code)`'s own shape. */
export const pBuiltinCall = <A extends EastPattern>(name: string, argument: A): BuiltinCallPattern<readonly [A]> =>
    ({ kind: "BuiltinCall", name, arguments: [argument] })

/** The general N-ary case, with an optional variadic runtime-value tail —
 *  what a call-shaped extension op (e.g. `CALL_CODEC`) needs: a fixed
 *  literal-operand prefix, matched positionally, plus zero or more real
 *  arguments tiled by the ordinary calling convention. */
export const pBuiltinCallN = <A extends readonly EastPattern[]>(
    name: string,
    args: A,
    opts?: { variadicTail?: boolean },
): BuiltinCallPattern<A> =>
    ({ kind: "BuiltinCall", name, arguments: args, variadicTail: opts?.variadicTail })
