/**
 * @ppl/machine — IR Grammar AST type definitions
 *
 * TypeScript types for the AST produced by the PEG.js parser (grammer.pegjs).
 * These types are referenced by the generated parser.d.ts via --return-types.
 */

// ——————————————————————————————————————————————
// 1. Programs & Statements
// ——————————————————————————————————————————————

export interface Program
{
    type: "Program"
    body: Statement[]
}

export type Statement =
    | IfStatement
    | WhileStatement
    | ForStatement
    | SwitchStatement
    | VariableDeclaration
    | ReturnStatement
    | ExpressionStatement

/**
 * The single construct directly governed by if/else/while/for: either a
 * brace-delimited block or one bare statement. `BlockStatement` is reachable
 * only here — it is deliberately not a member of `Statement`, so a bare
 * `{ ... }` cannot appear as a standalone statement. Every `BlockStatement`
 * reached through a `ControlBody` position is the immediate body of a branch
 * or loop, so it always has a real RTL block construct backing it (see
 * grammer.pegjs's `ControlBody` rule and docs/isa-core.md §20.2, §15.1).
 */
export type ControlBody = BlockStatement | Statement

export interface BlockStatement
{
    type: "BlockStatement"
    body: Statement[]
}

export interface IfStatement
{
    type: "IfStatement"
    test: Expression
    consequent: ControlBody
    alternate: ControlBody | null
}

export interface WhileStatement
{
    type: "WhileStatement"
    test: Expression
    body: ControlBody
}

export interface ForStatement
{
    type: "ForStatement"
    init: Expression | VariableDeclaration | null
    test: Expression | null
    update: Expression | null
    body: ControlBody
}

export interface SwitchStatement
{
    type: "SwitchStatement"
    discriminant: Expression
    cases: SwitchCase[]
}

export interface SwitchCase
{
    type: "SwitchCase"
    test: Expression | null
    consequent: Statement[]
}

export interface VariableDeclaration
{
    type: "VariableDeclaration"
    declarations: VariableDeclarator[]
}

export interface VariableDeclarator
{
    type: "VariableDeclarator"
    id: Identifier
    init: Expression | null
}

export interface ReturnStatement
{
    type: "ReturnStatement"
    argument: Expression | null
}



export interface ExpressionStatement
{
    type: "ExpressionStatement"
    expression: Expression
}

// ——————————————————————————————————————————————
// 2. Expressions
// ——————————————————————————————————————————————

export type Expression =
    | AssignmentExpression
    | ConditionalExpression
    | LogicalExpression
    | BinaryExpression
    | UnaryExpression
    | UpdateExpression
    | CallExpression
    | Literal
    | Identifier

export type AssignmentOperator =
    | "=" | "+=" | "-=" | "*=" | "/=" | "%="
    | "<<=" | ">>=" | "&=" | "^=" | "|="

export interface AssignmentExpression
{
    type: "AssignmentExpression"
    operator: AssignmentOperator
    left: Identifier
    right: Expression
}

export interface ConditionalExpression
{
    type: "ConditionalExpression"
    test: Expression
    consequent: Expression
    alternate: Expression
}

export type LogicalOperator = "||" | "&&"

export interface LogicalExpression
{
    type: "LogicalExpression"
    operator: LogicalOperator
    left: Expression
    right: Expression
}

export type BinaryOperator =
    | "|" | "^" | "&"
    | "==" | "!="
    | "<=" | ">=" | "<" | ">"
    | "<<" | ">>"
    | "+" | "-"
    | "*" | "/" | "%"

export interface BinaryExpression
{
    type: "BinaryExpression"
    operator: BinaryOperator
    left: Expression
    right: Expression
}

export type UnaryOperator = "+" | "-" | "~" | "!"

export interface UnaryExpression
{
    type: "UnaryExpression"
    operator: UnaryOperator
    argument: Expression
    prefix: true
}

export type UpdateOperator = "++" | "--"

export interface UpdateExpression
{
    type: "UpdateExpression"
    operator: UpdateOperator
    argument: Expression
    prefix: boolean
}

export interface CallExpression
{
    type: "CallExpression"
    callee: Identifier
    arguments: Expression[]
}

export interface Literal
{
    type: "Literal"
    value: number
    raw: string
}

export interface Identifier
{
    type: "Identifier"
    name: string
}