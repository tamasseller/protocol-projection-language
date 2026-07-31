/**
 * @ppl/core/machine — EAST pattern matcher
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
    OutputLocation,
    RtlNode,
} from "./east"

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
 * Call pattern. The planned-only call rule requires all args to be already-
 * tiled RtlNodes with `tos` output; the pattern carries no per-arg sub-patterns.
 * The match just verifies the shape; the builder receives the RtlNode[] array.
 */
export interface CallPattern { kind: "Call" }

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

// 3. Union types

export type EastPattern =
    | LiteralPattern
    | IdentifierPattern
    | RtlPattern
    | BinaryPattern
    | UnaryPattern
    | AssignPattern
    | CallPattern

export type EastMatch =
    | LiteralMatch
    | IdentifierMatch
    | RtlMatch
    | BinaryMatch
    | UnaryMatch
    | AssignMatch
    | CallMatch

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
  : never

// 5. matchEast — single dispatcher, inlines all per-kind matching

export function matchEast<P extends EastPattern>(
    N: EastExpression,
    P: P,
): MatchOf<P> | undefined
{
    switch (P.kind)
    {
        case "Literal":
            return (isLiteral(N)
                ? { kind: "Literal", value: N.value } as MatchOf<P>
                : undefined)

        case "Identifier":
            return (isIdentifier(N)
                ? { kind: "Identifier", name: N.name } as MatchOf<P>
                : undefined)

        case "Rtl":
            if (!isRtlNode(N)) return undefined
            // Output is always an array; demand check is `.includes` uniformly.
            if (P.output !== undefined && !N.output.includes(P.output)) return undefined
            return { kind: "Rtl", node: N } as MatchOf<P>

        case "Binary":
        {
            if (!isEastBinary(N)) return undefined
            if (N.operator !== P.operator) return undefined
            const leftMatch = matchEast(N.left, P.left)
            if (leftMatch === undefined) return undefined
            const rightMatch = matchEast(N.right, P.right)
            if (rightMatch === undefined) return undefined
            return {
                kind: "Binary",
                operator: N.operator,
                leftMatch,
                rightMatch,
            } as MatchOf<P>
        }

        case "Unary":
        {
            if (!isEastUnary(N)) return undefined
            if (N.operator !== P.operator) return undefined
            const argumentMatch = matchEast(N.argument, P.argument)
            if (argumentMatch === undefined) return undefined
            return {
                kind: "Unary",
                operator: N.operator,
                argumentMatch,
            } as MatchOf<P>
        }

        case "Assign":
        {
            if (!isEastAssign(N)) return undefined
            if (N.operator !== P.operator) return undefined
            // left is always an Identifier per the EAST type
            if (N.left.type !== "Identifier") return undefined
            const rightMatch = matchEast(N.right, P.right)
            if (rightMatch === undefined) return undefined
            return {
                kind: "Assign",
                operator: N.operator,
                target: N.left.name,
                rightMatch,
            } as MatchOf<P>
        }

        case "Call":
        {
            if (!isEastCall(N)) return undefined
            // callee is always an Identifier per the EAST type
            if (N.callee.type !== "Identifier") return undefined
            // All args must be RtlNodes whose output includes "tos" (the only
            // planned call shape — arg expressions pre-tiled, each pushed).
            const argNodes: RtlNode[] = []
            for (const arg of N.arguments)
            {
                if (!isRtlNode(arg) || !arg.output.includes("tos")) return undefined
                argNodes.push(arg)
            }
            return {
                kind: "Call",
                callee: N.callee.name,
                argNodes,
            } as MatchOf<P>
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
