/**
 * @ppl/machine — Type annotation pass
 *
 * Runs over one expression tree between parsing and tiling. It does two
 * things and no more: stamp `signed` on the operators whose ISA opcode
 * depends on it, and insert a cast wherever a value lands in a narrow
 * variable.
 *
 * The signedness rule is C's, which for this type menu collapses to one
 * line. C promotes everything narrower than `int` to `int`, so of the six
 * types only `u32` survives promotion as unsigned:
 *
 *   an operation is unsigned iff an operand promotes to u32; else signed.
 *
 * `u8 < u8` is therefore a signed compare. That is correct C, and it gives
 * the same answer as an unsigned one because a narrow variable's stored
 * word is always already extended — which is exactly what the casts below
 * maintain. Shifts are the one asymmetry: C's usual arithmetic conversions
 * do not apply to `<<`/`>>`, so only the left operand's type decides.
 *
 * A narrowing cast becomes an ordinary builtin call node (`u8(x)`), so
 * rules.ts matches it with the same `pBuiltinCall` shape `clz`/`revbits`
 * already use and no new pattern kind exists.
 */

import type {
    Expression, PrimType, BinaryOperator, Identifier, CallExpression,
} from "./ast"

/** What a name's declared type is, or `undefined` for one this scope never
 *  declared — a procedure argument, which is `u32` (isa-core.md §2.3). */
export interface TypeEnv
{
    typeOf(name: string): PrimType | undefined
}

const DEFAULT_TYPE: PrimType = "u32"

/** C's integer promotion over this menu: everything narrower than 32 bits
 *  becomes `i32`, and `u32` alone stays unsigned. */
const promote = (t: PrimType): "u32" | "i32" => t === "u32" ? "u32" : "i32"

/** The five operators with a signed ISA opcode of their own (isa-core.md
 *  §4.1/§4.2). `<<` has none: a left shift is bit-identical either way. */
const SIGN_SENSITIVE: ReadonlySet<string> = new Set([">>", "<", "<=", ">", ">="])

const COMPARISONS: ReadonlySet<string> = new Set(["==", "!=", "<", "<=", ">", ">="])

/** Narrow types only: `u32`/`i32` are the word itself, so a cast to one is
 *  the identity and is dropped rather than lowered. */
const NARROWING: ReadonlySet<PrimType> = new Set<PrimType>(["u16", "u8", "i16", "i8"])

interface Typed
{
    expr: Expression
    type: PrimType
}

const castTo = (varType: PrimType, argument: Expression): CallExpression => ({
    type: "CallExpression",
    callee: {type: "Identifier", name: varType},
    arguments: [argument],
})

/** Wrap in a narrowing cast unless the target is a full word. */
function coerce(value: Typed, target: PrimType): Expression
{
    return NARROWING.has(target) ? castTo(target, value.expr) : value.expr
}

function walk(node: Expression, env: TypeEnv): Typed
{
    switch(node.type)
    {
        case "Literal":
            // C's rule for an unsuffixed literal, with `int`/`unsigned int`
            // as the only candidates. The grammar has no negative literal —
            // unary minus is its own node — so this is total.
            return {expr: node, type: node.value <= 0x7fffffff ? "i32" : "u32"}

        case "Identifier":
            return {expr: node, type: env.typeOf(node.name) ?? DEFAULT_TYPE}

        case "CastExpression":
        {
            const inner = walk(node.argument, env)
            // A widening cast is the identity here: every value is stored
            // in a 32-bit word already, and the narrow types are kept
            // extended, so only the type it carries upward changes.
            return {expr: coerce(inner, node.varType), type: node.varType}
        }

        case "BinaryExpression":
        {
            const left = walk(node.left, env)
            const right = walk(node.right, env)

            // Shifts take their type from the left operand alone; every
            // other binary op takes the usual arithmetic conversions.
            const result: PrimType = (node.operator === "<<" || node.operator === ">>")
                ? promote(left.type)
                : (promote(left.type) === "u32" || promote(right.type) === "u32" ? "u32" : "i32")

            const signed = (node.operator === "<<" || node.operator === ">>")
                ? promote(left.type) === "i32"
                : promote(left.type) === "i32" && promote(right.type) === "i32"

            const rebuilt: Expression = {...node, left: left.expr, right: right.expr}
            if(SIGN_SENSITIVE.has(node.operator) && signed)
                (rebuilt as {signed?: boolean}).signed = true

            // A comparison's value is a boolean, which is an `int`.
            return {expr: rebuilt, type: COMPARISONS.has(node.operator) ? "i32" : result}
        }

        case "UnaryExpression":
        {
            const arg = walk(node.argument, env)
            return {
                expr: {...node, argument: arg.expr},
                type: node.operator === "!" ? "i32" : promote(arg.type),
            }
        }

        case "AssignmentExpression":
        {
            // The variable's own type is the target: `u8 x; x = 300;`
            // stores 44, the way C does.
            const target = env.typeOf(node.left.name) ?? DEFAULT_TYPE
            const value = walk(node.right, env)
            return {expr: {...node, right: coerce(value, target)}, type: target}
        }

        case "CallExpression":
        {
            // Procedure signatures are untyped for now, so a call's value
            // is a plain word. Arguments are still annotated: each is an
            // expression in its own right.
            const args = node.arguments.map(a => walk(a, env).expr)
            return {expr: {...node, arguments: args}, type: DEFAULT_TYPE}
        }

        // Parsed but not lowered by anything (ROADMAP: ternary, logical
        // operators, ++/--). Walked so their children are still annotated
        // if one of them ever grows a lowering.
        case "ConditionalExpression":
            return {
                expr: {
                    ...node,
                    test: walk(node.test, env).expr,
                    consequent: walk(node.consequent, env).expr,
                    alternate: walk(node.alternate, env).expr,
                },
                type: DEFAULT_TYPE,
            }

        case "LogicalExpression":
            return {
                expr: {...node, left: walk(node.left, env).expr, right: walk(node.right, env).expr},
                type: "i32",
            }

        case "UpdateExpression":
            return {expr: node, type: env.typeOf((node.argument as Identifier).name ?? "") ?? DEFAULT_TYPE}
    }
}

/** Annotate one expression tree in place of itself. */
export function annotate(expr: Expression, env: TypeEnv): Expression
{
    return walk(expr, env).expr
}

/** Annotate, then narrow to `target` — a declaration's initializer, where
 *  the destination type is known to the caller rather than to the tree. */
export function annotateInto(expr: Expression, env: TypeEnv, target: PrimType): Expression
{
    return coerce(walk(expr, env), target)
}

/** The ISA opcode each narrowing cast lowers to, for rules.ts. */
export const CAST_OPS: readonly {name: PrimType; isa: "SXTB" | "SXTH" | "UXTB" | "UXTH"}[] = [
    {name: "i8", isa: "SXTB"},
    {name: "i16", isa: "SXTH"},
    {name: "u8", isa: "UXTB"},
    {name: "u16", isa: "UXTH"},
] as const

/** True for the operators whose lowering rules come in signed/unsigned
 *  pairs — shared with rules.ts so the two lists cannot drift. */
export const isSignSensitive = (op: BinaryOperator): boolean => SIGN_SENSITIVE.has(op)
