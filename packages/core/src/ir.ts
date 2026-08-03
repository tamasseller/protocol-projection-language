/**
 * @ppl/core — `ir\`...\`` tagged template literal
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

import { parse, SyntaxError as PegSyntaxError } from "./machine/parser"
import type { Statement } from "./machine/ast"

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
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a C-subset source string into an {@link IrFragment}.
 *
 * @throws {@link PegSyntaxError} if the source is not valid C-subset.
 *    The error carries source-location info via `grammarSource`.
 */
export function ir(
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
): IrFragment
{
    // Splice interpolated values into the source string.
    // String() coercion handles numbers, identifiers (strings), etc.
    let source = strings[0]!
    for (let i = 0; i < values.length; i++)
    {
        source += String(values[i]) + strings[i + 1]
    }

    const program = parse(source, { grammarSource: "ir`...`" })
    return {
        type: "IrFragment",
        body: program.body,
        source,
    }
}

// Re-export the parser's SyntaxError so callers can `catch (e) { if (e
// instanceof SyntaxError) … }` without importing from the machine submodule.
export { PegSyntaxError as SyntaxError }
