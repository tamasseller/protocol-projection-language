/**
 * @ppl/core — IR Grammar AST type definitions
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
    | BlockStatement
    | IfStatement
    | WhileStatement
    | ForStatement
    | SwitchStatement
    | VariableDeclaration
    | ReturnStatement
    | BreakStatement
    | ContinueStatement
    | ExpressionStatement

export interface BlockStatement
{
    type: "BlockStatement"
    body: Statement[]
}

export interface IfStatement
{
    type: "IfStatement"
    test: Expression
    consequent: Statement
    alternate: Statement | null
}

export interface WhileStatement
{
    type: "WhileStatement"
    test: Expression
    body: Statement
}

export interface ForStatement
{
    type: "ForStatement"
    init: Expression | VariableDeclaration | null
    test: Expression | null
    update: Expression | null
    body: Statement
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

export interface BreakStatement
{
    type: "BreakStatement"
}

export interface ContinueStatement
{
    type: "ContinueStatement"
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