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
    | BlockStatement
    | IfStatement
    | WhileStatement
    | DoWhileStatement
    | ForStatement
    | SwitchStatement
    | VariableDeclaration
    | BreakStatement
    | ReturnStatement
    | ExpressionStatement

/**
 * The single construct directly governed by if/else/while/for: either a
 * brace-delimited block or one bare statement. In a `ControlBody` position
 * a `BlockStatement` *is* the branch's or loop's own RTL block, so its
 * locals are reclaimed by that block's `BLOCK_END`; standalone (where it is
 * an ordinary `Statement`) nothing closes it and the lowering ends the
 * scope with a `DROP` instead (isa-core.md §4.4, §10.2).
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

/** `do B while (c);` — `LOOP_POST` (isa-core.md §4.5, §7.2). */
export interface DoWhileStatement
{
    type: "DoWhileStatement"
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
    /** The declared type, which decides both the variable's stored
     *  representation and the signedness of every operation reading it
     *  (isa-core.md §4.3; the rule is in types.ts). */
    varType: PrimType
    id: Identifier
    init: Expression | null
}

/** `break;` — legal only as a `switch` case's own closer, where it is that
 *  case block's `BLOCK_END` and nothing irregular (isa-core.md §10.3). */
export interface BreakStatement
{
    type: "BreakStatement"
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

/** The primitive type menu. `u32` is the machine word itself; the other
 *  five are that word constrained to a range, held already-extended. */
export type PrimType = "u32" | "u16" | "u8" | "i32" | "i16" | "i8"

export type Expression =
    | CastExpression
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
    /** Set by types.ts for the five operators whose ISA opcode depends on
     *  signedness (`>>`, `<`, `<=`, `>`, `>=`). Absent means unsigned, so an
     *  un-annotated tree keeps its old lowering. */
    signed?: boolean
}

/** `i16(x)` — an explicit narrowing, and the node types.ts also inserts for
 *  every implicit one (assignment into a narrow variable). */
export interface CastExpression
{
    type: "CastExpression"
    varType: PrimType
    argument: Expression
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

export function recurseOver<T, U>(e: Expression, map: (e: Expression) => T, reduce: (...v: T[]) => U, def: U): U
{
    switch(e.type)
    {
        case "CastExpression": return reduce(map(e.argument))
        case "AssignmentExpression": return reduce(map(e.right))
        case "ConditionalExpression": return reduce(map(e.test), map(e.consequent), map(e.alternate))
        case "LogicalExpression": return reduce(map(e.left), map(e.right))
        case "BinaryExpression": return reduce(map(e.left), map(e.right))
        case "UnaryExpression": return reduce(map(e.argument))
        case "UpdateExpression": return reduce(map(e.argument))
        case "CallExpression": return reduce(...e.arguments.map(map))
        default: return def
    }
}

/** `recurseOver`'s rewriting half: rebuild `e` with each child replaced by
 *  `map`'s result, every other field carried over. */
export function mapOver(e: Expression, map: (e: Expression) => Expression): Expression
{
    switch(e.type)
    {
        case "CastExpression": return {...e, argument: map(e.argument)}
        case "AssignmentExpression": return {...e, right: map(e.right)}
        case "ConditionalExpression": return {...e, test: map(e.test), consequent: map(e.consequent), alternate: map(e.alternate)}
        case "LogicalExpression": return {...e, left: map(e.left), right: map(e.right)}
        case "BinaryExpression": return {...e, left: map(e.left), right: map(e.right)}
        case "UnaryExpression": return {...e, argument: map(e.argument)}
        case "UpdateExpression": return {...e, argument: map(e.argument)}
        case "CallExpression": return {...e, arguments: e.arguments.map(map)}
        default: return e
    }
}
