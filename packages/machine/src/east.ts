/**
 * @ppl/machine — Extended AST (EAST) node types
 *
 * The EAST extends the parser's AST with **RTL-AST nodes** — architecture-aware
 * leaves produced by rule application. Internal nodes are EAST variants of the
 * AST nodes, where every `Expression`-typed child is widened to `EastExpression`
 * (so an `RtlNode` can occupy any child slot once rewritten). Leaf nodes
 * (`Literal`, `Identifier`) are reused from the AST as-is.
 */

import type {
    AssignmentOperator,
    BinaryOperator,
    Identifier,
    Literal,
    UnaryOperator,
} from "./ast"

import type { OutputLocation, Resource, RtlInstr, ExtOpPayload } from "./rtl"

export type { OutputLocation, Resource, ComboName } from "./rtl"

export interface RtlNode<E extends { ext: string } = ExtOpPayload>
{
    type: "RtlNode"
    /** Output locations — always an array. Singleton `[loc]` for ordinary rules;
     *  multi-element for the assignment rule (`[acc, reg(target)]`). Downstream
     *  consumers match by `.includes(demand)` uniformly. */
    output: OutputLocation[]
    fragment: RtlInstr<E>[]
    clobbers: Resource[]
    /** Net TOS depth change from executing this fragment. Set once at build. */
    tosDelta: number
    /** Max TOS depth reached during execution, relative to entry. Set once at build. */
    maxStack: number
}

// EAST variants of internal AST nodes — children widened to EastExpression.
// Leaf nodes (Literal, Identifier) are reused from the AST.

export interface EastBinary<E extends { ext: string } = ExtOpPayload>
{
    type: "BinaryExpression"
    operator: BinaryOperator
    left: EastExpression<E>
    right: EastExpression<E>
}

export interface EastUnary<E extends { ext: string } = ExtOpPayload>
{
    type: "UnaryExpression"
    operator: UnaryOperator
    argument: EastExpression<E>
    prefix: true
}

export interface EastAssign<E extends { ext: string } = ExtOpPayload>
{
    type: "AssignmentExpression"
    operator: AssignmentOperator
    left: Identifier
    right: EastExpression<E>
}

export interface EastCall<E extends { ext: string } = ExtOpPayload>
{
    type: "CallExpression"
    callee: Identifier
    arguments: EastExpression<E>[]
}

export type EastExpression<E extends { ext: string } = ExtOpPayload> =
    | Literal
    | Identifier
    | EastBinary<E>
    | EastUnary<E>
    | EastAssign<E>
    | EastCall<E>
    | RtlNode<E>

export const isRtlNode = <E extends { ext: string } = ExtOpPayload>(N: EastExpression<E>): N is RtlNode<E> =>
    N.type === "RtlNode"

export const isLiteral = <E extends { ext: string } = ExtOpPayload>(N: EastExpression<E>): N is Literal =>
    N.type === "Literal"

export const isIdentifier = <E extends { ext: string } = ExtOpPayload>(N: EastExpression<E>): N is Identifier =>
    N.type === "Identifier"

export const isEastBinary = <E extends { ext: string } = ExtOpPayload>(N: EastExpression<E>): N is EastBinary<E> =>
    N.type === "BinaryExpression"

export const isEastUnary = <E extends { ext: string } = ExtOpPayload>(N: EastExpression<E>): N is EastUnary<E> =>
    N.type === "UnaryExpression"

export const isEastAssign = <E extends { ext: string } = ExtOpPayload>(N: EastExpression<E>): N is EastAssign<E> =>
    N.type === "AssignmentExpression"

export const isEastCall = <E extends { ext: string } = ExtOpPayload>(N: EastExpression<E>): N is EastCall<E> =>
    N.type === "CallExpression"

export type { AssignmentOperator, BinaryOperator, UnaryOperator } from "./ast"
