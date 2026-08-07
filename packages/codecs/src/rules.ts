/**
 * @ppl/codecs — The one generic codec resolver
 *
 * Every codec family this package has (the binary family, builders.ts; the
 * JSON family, json.ts) is "walk a `TypeNode`, dispatch by pattern, resolve
 * children on demand, memoize, survive cycles." That's one primitive, not
 * two independently hand-rolled ones — `createCodecResolver` is it, and
 * both families are built directly on top of it, differing only in which
 * rule list and which context type (`Direction` vs. a JSON depth) they
 * close over.
 *
 * `TypePattern`/`matchType` (`@ppl/core/matcher.ts`) — the pure structural
 * matching vocabulary already used by `target-cpp`/`target-js`'s own
 * `Rule<C>`/`runRuleset` (`@ppl/core/projection.ts`) — is reused as-is here.
 * `runRuleset` itself is not: it fills `Map<nodeId, C>` in one eager
 * top-down pass via absorption/coverage, with no way to hand a not-yet-
 * finished child a reserved slot number before a sibling embeds it into its
 * own instruction stream. Codec generation needs on-demand, indexed,
 * self-reference-safe resolution instead — a different execution model,
 * not a superset `runRuleset` can be stretched to cover — so this file
 * provides its own small driver rather than routing through `runRuleset`.
 *
 * A rule set that mixes conventions (e.g. an ASCII-text override sitting
 * inside an otherwise-binary rule list) is not a special case this driver
 * needs to know about: `CodecRule.produce` never inspects what family it's
 * emitting, so nothing here enforces — or even notices — that distinction.
 */

import type { TypePattern, TypeMatch, TypeNode } from "@ppl/core"
import { matchType, kindOf } from "@ppl/core"
import type { IrFragment, Procedure } from "@ppl/machine"
import { ir, declareProc, defineProc } from "@ppl/machine"

/**
 * One codec rule: a structural filter (`pattern`) and a producer
 * (`produce`) that builds the matching `TypeNode`'s `ir\`...\`` fragment —
 * "codecs are standalone metaprograms, including the pattern their match
 * comes from," not a closed per-kind switch. `resolve` is threaded in as a
 * plain extra argument (mirroring `cpp-emitter.ts`'s own `refOf` helper,
 * called directly by its rules rather than smuggled into the match's
 * witness) — it recursively resolves a *child* `TypeNode` to its own
 * `Procedure`, under the same or a different `ctx`.
 */
export interface CodecRule<Ctx>
{
    readonly pattern: TypePattern
    readonly produce: (
        match: TypeMatch,
        node: TypeNode,
        ctx: Ctx,
        resolve: (child: TypeNode, ctx: Ctx) => Procedure,
    ) => IrFragment
}

/**
 * Build an on-demand, memoized, cycle-safe `TypeNode → Procedure` resolver
 * from an ordered rule list (first match wins — a caller's own rules go
 * first so they can preempt a default). `keyOf` controls memoization: the
 * default (`node.id` alone) is right for a resolver whose only context is a
 * fixed direction closed over by the caller (builders.ts); a resolver whose
 * `Ctx` actually varies per call (json.ts's nesting depth) supplies its own,
 * keying on `(node, ctx)` together.
 *
 * Cycle safety mirrors `lowerProgram`'s own (`@ppl/machine/lower.ts:141-173`,
 * itself mirrored by the previous, now-superseded hand-rolled `resolve()` in
 * builders.ts): mint the `Procedure`'s identity via `declareProc` and cache
 * it *before* recursing into `produce`, so a self- or mutually-recursive
 * `TypeNode` resolves to the reserved identity instead of looping forever.
 */
export function createCodecResolver<Ctx>(
    rules: readonly CodecRule<Ctx>[],
    keyOf: (node: TypeNode, ctx: Ctx) => string = node => String(node.id),
): (node: TypeNode, ctx: Ctx) => Procedure
{
    const cache = new Map<string, Procedure>()

    function resolve(node: TypeNode, ctx: Ctx): Procedure
    {
        const key = keyOf(node, ctx)
        const cached = cache.get(key)
        if(cached) return cached

        const handle = declareProc([]) // mint identity now — reserved, before recursing
        cache.set(key, handle)

        const rule = rules.find(r => matchType(node.type, r.pattern) !== undefined)
        if(!rule) throw new Error(`no codec rule matches type kind "${kindOf(node.type)}"`)

        const match = matchType(node.type, rule.pattern)!
        defineProc(handle, rule.produce(match, node, ctx, resolve))
        return handle
    }

    return resolve
}

/**
 * Build one `ir\`...\`` fragment from a mix of plain source text and
 * `Procedure` references, for the dynamic-arity shapes a fixed tagged
 * template can't express (an N-case `switch`, one case per union variant or
 * per hoisted struct field — `builders.ts`). `ir\`...\``'s own
 * `Procedure`-splicing (ir.ts's `ir` function) only triggers for a genuine
 * tagged-template interpolation slot, not for a name read off `Procedure`
 * and pasted into a hand-built string — that would silently skip
 * registering it in the resulting fragment's `calls` map, leaving
 * `resolveCallee` unable to find it later. Consecutive string parts
 * collapse into one source chunk; each `Procedure` part becomes its own
 * interpolation slot, exactly mirroring what `ir\`${a}${b}\`` would produce
 * for a fixed, compile-time-known arity.
 */
export function irSeq(parts: readonly (string | Procedure)[]): IrFragment
{
    const chunks: string[] = [""]
    const values: Procedure[] = []

    for(const part of parts)
    {
        if(typeof part === "string") chunks[chunks.length - 1] += part
        else { values.push(part); chunks.push("") }
    }

    const strings = chunks as unknown as TemplateStringsArray
    ;(strings as unknown as { raw: readonly string[] }).raw = chunks
    return ir(strings, ...values)
}
