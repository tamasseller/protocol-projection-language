/**
 * @ppl/core/machine — Extended AST (EAST) node types
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

export type OutputLocation = "acc" | "tos" | "reg"
export type Resource = "acc" | "tos"

/** Symbolic combo names — `<INPUT_MODE>_<OUTPUT_MODE>` per isa-core.md §6.3. */
export type ComboName =
    | "REG_ACC"    // register  → acc       (acc = acc OP rN)
    | "REG_REG"    // register  → register  (rN  = acc OP rN, write-back)
    | "PEEK_ACC"   // peek      → acc       (acc = acc OP [tos-1])
    | "PEEK_PEEK"  // peek      → peek      ([tos-1] = acc OP [tos-1], write-back)
    | "POP_ACC"    // pop       → acc       (acc = acc OP pop)
    | "PEEK_PUSH"  // peek      → push      ([tos++] = acc OP [tos-1], RPN)
    | "IMM_ACC"    // immediate → acc       (acc = acc OP #imm)

export interface RtlInstr
{
    op: string
    combo?: ComboName
    target?: string
    imm?: number
    writeback?: boolean
    callee?: string
}

export interface RtlNode
{
    type: "RtlNode"
    /** Output locations — always an array. Singleton `[loc]` for ordinary rules;
     *  multi-element for the assignment rule (`[acc, reg(target)]`). Downstream
     *  consumers match by `.includes(demand)` uniformly. */
    output: OutputLocation[]
    fragment: RtlInstr[]
    clobbers: Resource[]
    /** Net TOS depth change from executing this fragment. Set once at build. */
    tosDelta: number
    /** Max TOS depth reached during execution, relative to entry. Set once at build. */
    maxStack: number
}

// EAST variants of internal AST nodes — children widened to EastExpression.
// Leaf nodes (Literal, Identifier) are reused from the AST.

export interface EastBinary
{
    type: "BinaryExpression"
    operator: BinaryOperator
    left: EastExpression
    right: EastExpression
}

export interface EastUnary
{
    type: "UnaryExpression"
    operator: UnaryOperator
    argument: EastExpression
    prefix: true
}

export interface EastAssign
{
    type: "AssignmentExpression"
    operator: AssignmentOperator
    left: Identifier
    right: EastExpression
}

export interface EastCall
{
    type: "CallExpression"
    callee: Identifier
    arguments: EastExpression[]
}

export type EastExpression =
    | Literal
    | Identifier
    | EastBinary
    | EastUnary
    | EastAssign
    | EastCall
    | RtlNode

export const isRtlNode = (N: EastExpression): N is RtlNode =>
    N.type === "RtlNode"

export const isLiteral = (N: EastExpression): N is Literal =>
    N.type === "Literal"

export const isIdentifier = (N: EastExpression): N is Identifier =>
    N.type === "Identifier"

export const isEastBinary = (N: EastExpression): N is EastBinary =>
    N.type === "BinaryExpression"

export const isEastUnary = (N: EastExpression): N is EastUnary =>
    N.type === "UnaryExpression"

export const isEastAssign = (N: EastExpression): N is EastAssign =>
    N.type === "AssignmentExpression"

export const isEastCall = (N: EastExpression): N is EastCall =>
    N.type === "CallExpression"

export type { AssignmentOperator, BinaryOperator, UnaryOperator } from "./ast"
