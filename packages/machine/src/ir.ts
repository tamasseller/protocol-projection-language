/**
 * @ppl/machine — `ir\`...\`` tagged template literal
 *
 * The authoring entry point. Parses a C-subset source string (per
 * isa-core.md Part VI) into an {@link IrFragment} — a sequence of parsed
 * AST statements that later layers (stitching, lowering) consume.
 *
 * Interpolated values (`${…}`) are stringified and spliced into the source
 * before parsing, handling the common metaprogramming cases: numbers,
 * identifiers, small expressions. For example:
 *
 * ```ts
 * const n = 3
 * const frag = ir`u32 count = ${n};`
 * //   parses "u32 count = 3;" → IrFragment { body: [VariableDeclaration...] }
 * ```
 *
 * Per the Golden Rule (copilot-instructions.md §4): the `ir` tag must NOT
 * evaluate to a single concatenated string. It parses the spliced source
 * into an in-memory AST tree. The raw `source` is retained only for
 * debugging and error messages.
 */

import { parse, SyntaxError as PegSyntaxError } from "./parser"
import type { Statement } from "./ast"

// ─────────────────────────────────────────────────────────────────────────────

/**
 * The output of an `ir\`...\`` block. Wraps a parsed statement sequence
 * (the fragment's contribution to a procedure body) that will be stitched
 * with other fragments and lowered to IR bytecode.
 */
export interface IrFragment
{
    readonly type: "IrFragment"
    /** Parsed statements — the fragment body. */
    readonly body: readonly Statement[]
    /** The reconstructed source string (chunks + interpolated values).
     *  Retained for error messages and debugging only. */
    readonly source: string
    /** Maps each synthetic callee name this fragment's source was spliced
     *  with (see {@link ir}'s handling of {@link Procedure} values) back to
     *  the `Procedure` it refers to. Empty for fragments that reference no
     *  other procedure. */
    readonly calls: ReadonlyMap<string, Procedure>
}

/**
 * A named, argument-bound procedure: an {@link IrFragment} given the
 * identity it needs to be called from another fragment. Identity is the
 * object itself (via `id`) — two `Procedure`s are never compared by name,
 * so callers never need to keep a name string in sync between a
 * procedure's definition and its call sites. `name` is minted once, at
 * creation, precisely so that splicing the *same* `Procedure` into many
 * fragments (or concatenating fragments that each reference it) always
 * yields the same callee text — no per-splice renumbering, no collision
 * risk when fragments built independently are later combined via
 * {@link concat}.
 */
export interface Procedure
{
    readonly type: "Procedure"
    readonly id: symbol
    /** Synthetic callee name spliced in place of this `Procedure` by
     *  {@link ir}. Unique for the lifetime of the process. */
    readonly name: string
    /** Parameter names, in order — become `r0..r(argCount-1)` in the
     *  callee's frame (isa-core.md §2.5). */
    readonly args: readonly string[]
    readonly fragment: IrFragment
    /** Extension-owned header data (isa-core.md §2.3's extension fields —
     *  e.g. the codec extension's ABI-kind selector), carried through
     *  `lowerProgram` into the resulting `RtlProc.header` untouched. Opaque
     *  to the generic core — see machine/extension.ts (ROADMAP.md item 6). */
    readonly header?: unknown
}

let procCounter = 0

/** Give an `IrFragment` the identity needed to be referenced (via
 *  `${...}`) as a call target from another `ir\`...\`` fragment. */
export function proc(args: readonly string[], fragment: IrFragment, header?: unknown): Procedure
{
    return { type: "Procedure", id: Symbol(), name: `__proc${procCounter++}`, args, fragment, header }
}

const isProcedure = (v: unknown): v is Procedure =>
    typeof v === "object" && v !== null && (v as { type?: unknown }).type === "Procedure"

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a C-subset source string into an {@link IrFragment}.
 *
 * An interpolated {@link Procedure} (`${otherProc}`) is not stringified —
 * it is spliced as its pre-minted `name` (parsed as an ordinary
 * `CallExpression` callee when followed by `(...)`, per grammer.pegjs's
 * existing `Identifier "(" ArgumentList? ")"` rule) and recorded in the
 * returned fragment's `calls` map, so the reference is resolved by object
 * identity rather than by a name the author must keep in sync by hand.
 * Every other interpolated value keeps the plain `String()` splice used for
 * numbers, identifiers, and raw source snippets.
 *
 * @throws {@link PegSyntaxError} if the source is not valid C-subset.
 *    The error carries source-location info via `grammarSource`.
 */
export function ir(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
): IrFragment
{
    const calls = new Map<string, Procedure>()

    let source = strings[0]!
    for (let i = 0; i < values.length; i++)
    {
        const value = values[i]
        let text: string
        if (isProcedure(value))
        {
            text = value.name
            calls.set(text, value)
        }
        else
        {
            text = String(value)
        }
        source += text + strings[i + 1]
    }

    const program = parse(source, { grammarSource: "ir`...`" })
    return {
        type: "IrFragment",
        body: program.body,
        source,
        calls,
    }
}

/**
 * Concatenate `IrFragment`s built independently — e.g. one per element of
 * a compile-time-computed (TS-execution-time) collection, where the count
 * of statements or procedure references isn't known until that collection
 * is walked and so can't be expressed as a single `ir\`...\`` template
 * with a fixed number of `${…}` holes. Bodies concatenate in argument
 * order; `calls` union safely because {@link proc} mints each
 * `Procedure`'s `name` once, at creation — the same `Procedure` referenced
 * by several of the fragments being concatenated always maps to the same
 * name, and distinct `Procedure`s never collide.
 */
export function concat(...fragments: readonly IrFragment[]): IrFragment
{
    const body: Statement[] = []
    const calls = new Map<string, Procedure>()
    let source = ""

    for (const fragment of fragments)
    {
        body.push(...fragment.body)
        for (const [name, referenced] of fragment.calls) calls.set(name, referenced)
        source += fragment.source
    }

    return { type: "IrFragment", body, source, calls }
}

// Re-export the parser's SyntaxError so callers can `catch (e) { if (e
// instanceof SyntaxError) … }` without importing from the machine submodule.
export { PegSyntaxError as SyntaxError }
