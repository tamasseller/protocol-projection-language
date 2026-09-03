/**
 * @ppl/machine — `ir\`...\`` tagged template literal
 *
 * The authoring entry point. Builds an {@link IrFragment} from a C-subset
 * source string (per isa-core.md Part VI) plus interpolated values, for
 * later layers (stitching, lowering) to consume as parsed AST statements.
 *
 * Interpolated values (`${…}`) are handled by kind, not uniformly
 * stringified:
 * - A {@link Procedure} splices as its pre-minted synthetic name (see
 *   below) and is recorded in `calls`.
 * - An {@link IrFragment} splices as its own `source` text directly —
 *   recursively, since that source may itself contain further splices —
 *   and its `calls` are merged in. This is what lets a metaprogram build
 *   sub-fragments that are *not* independently valid Program text on their
 *   own (e.g. a bare `case N: ...` clause, only meaningful once embedded in
 *   a `switch`) and combine them before anything ever tries to parse them
 *   standalone — see `body`'s laziness below.
 * - An array of `IrFragment`s splices each one's `source` in sequence
 *   (newline-joined), `calls` merged across all of them — the dynamic-arity
 *   case (`${node.edges.map(e => ir\`...\`)}`) that a fixed-arity tagged
 *   template can't otherwise express.
 * - Everything else is stringified with plain `String()` (numbers,
 *   identifiers, small expressions).
 *
 * ```ts
 * const n = 3
 * const frag = ir`u32 count = ${n};`
 * //   → IrFragment; frag.body (parsed on access) is [VariableDeclaration...]
 * ```
 *
 * Per the Golden Rule (copilot-instructions.md §4): `ir` must never leave a
 * flat string as the thing a real consumer (lowering, the C++ generator)
 * ends up working against — `body` is always genuine parsed AST by the time
 * anything downstream reads it. What's deliberately relaxed is *when* that
 * parse happens: `body` is computed lazily, on first access, rather than
 * eagerly at every `ir\`...\`` call — which is exactly what makes splicing
 * non-standalone sub-fragments (the `case N: ...` example above) possible,
 * since nothing tries to parse them until they're embedded somewhere valid.
 * The cost is that a syntax error surfaces at the point `body` is finally
 * read (against the fully-assembled source), not at the specific `ir` call
 * that introduced it — `source` is kept in full for exactly this case, so
 * the error message still shows real, if less locally-pinpointed, context.
 */

import { parse, SyntaxError as PegSyntaxError } from "./parser"
import type { PrimType, Statement } from "./ast"

// ─────────────────────────────────────────────────────────────────────────────

/**
 * The output of an `ir\`...\`` block. Wraps a statement sequence (the
 * fragment's contribution to a procedure body) that will be stitched with
 * other fragments and lowered to IR bytecode.
 */
export interface IrFragment
{
    readonly type: "IrFragment"
    /** Parsed statements — the fragment body. Computed lazily, on first
     *  access, and memoized: `ir\`...\`` does not parse eagerly, so a
     *  fragment that's only valid once spliced into a larger one (e.g. a
     *  bare `case N: ...` clause) can exist and be combined with others
     *  before anything tries to parse it standalone. Throws the underlying
     *  {@link SyntaxError} if `source` was never actually valid once
     *  assembled. */
    readonly body: readonly Statement[]
    /** The reconstructed source string (chunks + interpolated values) —
     *  not just for error messages: this *is* the fragment's real content
     *  until `body` is first read, and what a splice of this fragment into
     *  another `ir\`...\`` template actually inlines. */
    readonly source: string
    /** Maps each synthetic callee name this fragment's source was spliced
     *  with (see {@link ir}'s handling of {@link Procedure} values) back to
     *  the `Procedure` it refers to. Empty for fragments that reference no
     *  other procedure. Merged in from any spliced sub-fragment's own
     *  `calls`, so nesting never loses a reference. */
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
     *  callee's frame (isa-core.md §2.5). An entry may carry a type,
     *  `"u32 n"`, which narrows the argument at every call site and gives
     *  the name that type inside the body; a bare `"n"` is `u32`, as every
     *  parameter was before types existed here. */
    readonly args: readonly string[]
    /** `args`' declared types, positionally — `undefined` where the entry
     *  named no type. */
    readonly argTypes: readonly (PrimType | undefined)[]
    /** Declared return type, or `undefined` to deduce it from the body's
     *  own `return`s (signature.ts). `"void"` says the procedure returns
     *  nothing, which isa-core.md §8.7 makes a real distinction. */
    readonly returns?: PrimType | "void"
    fragment: IrFragment
    /** Extension-owned header data (isa-core.md §2.3's extension fields —
     *  e.g. the codec extension's ABI-kind selector), carried through
     *  `lowerProgram` into the resulting `RtlProc.header` untouched. Opaque
     *  to the generic core — see machine/extension.ts (ROADMAP.md item 6). */
    readonly header?: unknown
}

let procCounter = 0

/** Give an `IrFragment` the identity needed to be referenced (via
 *  `${...}`) as a call target from another `ir\`...\`` fragment. */
/** What a `Procedure` may declare beyond its parameter list. `header` moved
 *  here from its own positional slot when `returns` needed one too. */
export interface ProcOptions
{
    returns?: PrimType | "void"
    header?: unknown
}

const TYPE_NAMES: ReadonlySet<string> = new Set(["u32", "u16", "u8", "i32", "i16", "i8"])

/** `"u32 n"` → `["n", "u32"]`, `"n"` → `["n", undefined]`. The type menu is
 *  grammer.pegjs's own `TypeName`; anything else is a name, so a malformed
 *  entry fails later as an unknown one rather than silently as a type. */
function parseParam(entry: string): [string, PrimType | undefined]
{
    const parts = entry.trim().split(/\s+/)
    return parts.length === 2 && TYPE_NAMES.has(parts[0]!)
        ? [parts[1]!, parts[0] as PrimType]
        : [entry, undefined]
}

function signature(args: readonly string[]): {names: string[]; argTypes: (PrimType | undefined)[]}
{
    const parsed = args.map(parseParam)
    return { names: parsed.map(p => p[0]), argTypes: parsed.map(p => p[1]) }
}

export function proc(args: readonly string[], fragment: IrFragment, opts: ProcOptions = {}): Procedure
{
    const {names, argTypes} = signature(args)
    return { type: "Procedure", id: Symbol(), name: `__proc${procCounter++}`, args: names, argTypes, fragment, header: opts.header, returns: opts.returns }
}

const UNDEFINED_FRAGMENT: IrFragment = undefined as unknown as IrFragment

/**
 * Two-phase construction: mint a `Procedure`'s identity (`id`/`name`) without
 * its `fragment` yet. Needed for a self- or mutually-recursive reference —
 * `ir\`...\`` splices an interpolated `Procedure`'s `.name` into source text
 * immediately (so it can be parsed *now*), but a cyclic pair A/B can't each
 * have a fully-parsed `fragment` before the other's `name` exists to
 * interpolate. `declareProc` breaks the cycle: mint both identities first,
 * build each fragment (referencing the other's already-minted name), then
 * {@link defineProc} each once. `proc()` remains the right choice for every
 * non-recursive fragment — the common case — where the eager one-call form
 * is simpler.
 */
export function declareProc(args: readonly string[], opts: ProcOptions = {}): Procedure
{
    const {names, argTypes} = signature(args)
    return { type: "Procedure", id: Symbol(), name: `__proc${procCounter++}`, args: names, argTypes, fragment: UNDEFINED_FRAGMENT, header: opts.header, returns: opts.returns }
}

/** Attach the parsed fragment to a `Procedure` minted via {@link declareProc}.
 *  Exactly once — a second call (or a call on a `proc()`-built, already-
 *  complete `Procedure`) is a bug in the caller, not a case to accommodate. */
export function defineProc(target: Procedure, fragment: IrFragment): void
{
    if(target.fragment !== UNDEFINED_FRAGMENT)
        throw new Error(`defineProc: "${target.name}" already has a fragment`)
    target.fragment = fragment
}

const isProcedure = (v: unknown): v is Procedure =>
    typeof v === "object" && v !== null && (v as { type?: unknown }).type === "Procedure"

const isIrFragment = (v: unknown): v is IrFragment =>
    typeof v === "object" && v !== null && (v as { type?: unknown }).type === "IrFragment"

/** Merge `from`'s `calls` into `into`, in place. Safe to call repeatedly
 *  across several sources: {@link proc} mints each `Procedure`'s `name`
 *  once, at creation, so the same `Procedure` reached via several spliced
 *  fragments always merges to one entry, and distinct `Procedure`s never
 *  collide. */
function mergeCalls(into: Map<string, Procedure>, from: ReadonlyMap<string, Procedure>): void
{
    for (const [name, referenced] of from) into.set(name, referenced)
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an {@link IrFragment} from a C-subset source template (see the file
 * header for how each kind of interpolated value is handled). Parsing is
 * deferred to `body`'s first access — this call itself never throws on bad
 * syntax, only assembles `source`/`calls`.
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
        else if (isIrFragment(value))
        {
            text = value.source
            mergeCalls(calls, value.calls)
        }
        else if (Array.isArray(value) && value.every(isIrFragment))
        {
            text = (value as IrFragment[]).map(f => f.source).join("\n")
            for (const f of value as IrFragment[]) mergeCalls(calls, f.calls)
        }
        else
        {
            text = String(value)
        }
        source += text + strings[i + 1]
    }

    let cachedBody: readonly Statement[] | undefined
    return {
        type: "IrFragment",
        source,
        calls,
        get body(): readonly Statement[]
        {
            return cachedBody ??= parse(source, { grammarSource: "ir`...`" }).body
        },
    }
}

// Re-export the parser's SyntaxError so callers can `catch (e) { if (e
// instanceof SyntaxError) … }` without importing from the machine submodule.
export { PegSyntaxError as SyntaxError }
