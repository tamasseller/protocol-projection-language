/**
 * @ppl/machine — Type annotation pass
 *
 * Runs over one expression tree between parsing and tiling. It does two
 * things: stamp `signed` on the operators whose ISA opcode depends on it, 
 * and insert a cast wherever a value lands in a narrow variable.
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
import {mapOver} from "./ast"

/** What a name's declared type is, or `undefined` for one this scope never
 *  declared — a procedure argument, which is `u32` (isa-core.md §2.3). */
export interface TypeEnv
{
    typeOf(name: string): PrimType | undefined
    /** The signature of a name this scope resolves to a procedure, or
     *  `undefined` for a builtin, an extension call, or a scope with no
     *  procedure table at all. */
    signatureOf?(name: string): ProcSignature | undefined
}

/** What a call site needs to know about its callee: what to narrow each
 *  argument to, and what the call is worth. `"void"` is isa-core.md §8.7's
 *  distinction — such a call has no value to use. */
export interface ProcSignature
{
    argTypes: readonly (PrimType | undefined)[]
    returns: PrimType | "void"
}

const DEFAULT_TYPE: PrimType = "u32"

/** C's integer promotion over this menu: everything narrower than 32 bits
 *  becomes `i32`, and `u32` alone stays unsigned. */
const promote = (t: PrimType): "u32" | "i32" => t === "u32" ? "u32" : "i32"

/** C's usual arithmetic conversions over the promoted pair. */
const usual = (a: PrimType, b: PrimType): PrimType =>
    promote(a) === "u32" || promote(b) === "u32" ? "u32" : "i32"

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

function walk(node: Expression, env: TypeEnv, wantsValue: boolean = true): Typed
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
                : usual(left.type, right.type)

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
            // A callee this scope cannot place is a builtin or an extension
            // call: still a plain word, and its arguments still annotated,
            // each an expression in its own right.
            const sig = env.signatureOf?.(node.callee.name)
            if(sig === undefined) return {expr: mapOver(node, a => walk(a, env).expr), type: DEFAULT_TYPE}

            if(sig.returns === "void" && wantsValue)
                throw new Error(`Call to '${node.callee.name}' is used as a value, but the procedure returns none`)

            // Each argument narrows to its parameter's own type, the same
            // coercion a declaration applies to its initializer.
            const args = node.arguments.map((a, i) =>
            {
                const t = sig.argTypes[i]
                const v = walk(a, env)
                return t !== undefined ? coerce(v, t) : v.expr
            })

            return {expr: {...node, arguments: args}, type: sig.returns === "void" ? DEFAULT_TYPE : sig.returns}
        }

        // Reached only through `typeOfExpr`: lower.ts hoists every ternary
        // into a branch of its own before annotating what is left, so no
        // `annotate` walk ever meets one. Its type is still C's — the two
        // arms' usual arithmetic conversions — because that is what types
        // the slot the branch writes into.
        case "ConditionalExpression":
        {
            const cons = walk(node.consequent, env)
            const alt = walk(node.alternate, env)
            return {
                expr: {...node, test: walk(node.test, env).expr, consequent: cons.expr, alternate: alt.expr},
                type: usual(cons.type, alt.type),
            }
        }

        // Parsed but not lowered by anything (ROADMAP: logical operators,
        // ++/--). Walked so their children are still annotated if one of
        // them ever grows a lowering.
        case "LogicalExpression":
            return {expr: mapOver(node, c => walk(c, env).expr), type: "i32"}

        case "UpdateExpression":
            return {expr: node, type: env.typeOf((node.argument as Identifier).name ?? "") ?? DEFAULT_TYPE}
    }
}

/** Annotate one expression tree in place of itself. */
export function annotate(expr: Expression, env: TypeEnv, wantsValue: boolean = true): Expression
{
    return walk(expr, env, wantsValue).expr
}

/** The type an expression has, without rewriting it — for a caller that
 *  needs the type of a tree it is about to take apart rather than lower. */
export function typeOfExpr(expr: Expression, env: TypeEnv): PrimType
{
    return walk(expr, env).type
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
