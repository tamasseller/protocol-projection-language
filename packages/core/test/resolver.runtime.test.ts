/**
 * Runtime tests for Layer 1's *other* primitive: `createResolver` — the
 * on-demand, memoized, cycle-safe resolver `@ppl/codecs`/`@ppl/target-js`
 * each adapt (see `projection.ts`'s own header). `runRuleset` already has
 * its own coverage tests (`projection.runtime.test.ts`); this file is
 * specifically about what `createResolver` adds on top: the reserve-
 * then-fill cycle-safety split, and the `claims`-based guarantee that an
 * absorbed multi-node match never gets silently re-matched from scratch.
 *
 * Run via: npm test
 */
import {test} from "node:test"
import * as assert from "node:assert/strict"

import {integer, struct, list, u8} from "../src/metamodel"
import type {TypeNode} from "../src/type-graph"
import {createResolver, resolverRule} from "../src/projection"
import {pInteger, pStructFields, pList, pStar} from "../src/matcher"

/** Every test rule below produces this same, deliberately minimal
 *  capability — a mutable `{text}` record, standing in for whatever real
 *  artifact a real `ResolverRule<C>` mints (`Procedure`, `TSTypeDecl`,
 *  ...); only the reserve-then-mutate shape matters here. */
interface Cap { text: string }
const mint = (_node: TypeNode): Cap => ({text: ""})

test("createResolver: an absorbed node with no claims() throws if something independently resolves it", () =>
{
    // `pList(pInteger(...))` witnesses both the list and its integer
    // element in one match (a concrete sub-pattern, not a `pStar()`
    // hole) — mirrors binary-rules.ts's own `listOfIntegerEncodeRule`.
    // Supplies no claims, matching that real rule's own behavior (nothing
    // there ever independently resolves the absorbed element either).
    const listOfInt = resolverRule(
        pList(pInteger(-Infinity, Infinity)),
        (placeholder: Cap) => { placeholder.text = "list-of-int" },
    )
    const genericInt = resolverRule(pInteger(-Infinity, Infinity), (placeholder: Cap) => { placeholder.text = "generic-int" })
    const genericStruct = resolverRule(pStructFields(pStar()), (placeholder: Cap, match, _node, _ctx, resolve) =>
    {
        // Left-to-right, matching field declaration order — "items"
        // resolves (and absorbs `sharedInt`) before "count" tries to
        // resolve that exact same object independently.
        placeholder.text = `struct(${match.fieldMatches.map(f => resolve(f.type, undefined).text).join(",")})`
    })

    const sharedInt = integer(0, 100)
    const root = struct({items: list(sharedInt), count: sharedInt})

    const {resolve} = createResolver<Cap, void>([listOfInt, genericStruct, genericInt], mint)
    assert.throws(
        () => resolve(root, undefined),
        /node .* was absorbed into an enclosing rule's own multi-node match, but that rule's fill\(\) supplied no claims\(\) entry for it/,
    )
})

test("createResolver: claims() is consulted instead of re-matching an absorbed node from scratch", () =>
{
    const listOfInt = resolverRule(
        pList(pInteger(-Infinity, Infinity)),
        (placeholder: Cap, match) =>
        {
            placeholder.text = "list-of-int"
            // Deliberately distinguishable from what `genericInt` (below)
            // would otherwise produce for the exact same node, so a test
            // assertion can tell "claims was used" apart from "coverage
            // let an independent re-match through and it happened to work
            // anyway" (they'd look identical if this returned the same
            // text `genericInt` does).
            return {claims: new Map([[match.elementType, {text: "claimed-int"} as Cap]])}
        },
    )
    const genericInt = resolverRule(pInteger(-Infinity, Infinity), (placeholder: Cap) => { placeholder.text = "generic-int" })
    const genericStruct = resolverRule(pStructFields(pStar()), (placeholder: Cap, match, _node, _ctx, resolve) =>
    {
        placeholder.text = `struct(${match.fieldMatches.map(f => resolve(f.type, undefined).text).join(",")})`
    })

    const sharedInt = integer(0, 100)
    const root = struct({items: list(sharedInt), count: sharedInt})

    const {resolve} = createResolver<Cap, void>([listOfInt, genericStruct, genericInt], mint)
    const result = resolve(root, undefined)

    assert.equal(result.text, "struct(list-of-int,claimed-int)")
})

test("createResolver: a self-referential type resolves without looping forever (reserve-before-recurse)", () =>
{
    // A genuine self-reference — `self`'s field value patched in *after*
    // construction to be the very same `StructType` object, not a
    // `() => SemanticType` thunk pointing at an equal-but-distinct one
    // (`@ppl/codecs/test/resolver.test.ts` uses the exact same technique,
    // for the exact same reason: `buildTypeGraph`'s cycle-breaking keys
    // on object identity, and only patching the field directly makes
    // `fieldMatches[1].type` the *same* object as the root itself).
    const recType = struct({depth: u8, self: u8})
    recType.fields.set("self", recType)

    const structRule = resolverRule(pStructFields(pStar()), (placeholder: Cap, match, _node, _ctx, resolve) =>
    {
        placeholder.text = `struct[${match.fieldMatches.length}]`
        for(const f of match.fieldMatches) resolve(f.type, undefined) // must not loop forever
    })
    const genericInt = resolverRule(pInteger(-Infinity, Infinity), (placeholder: Cap) => { placeholder.text = "int" })

    const {resolve} = createResolver<Cap, void>([structRule, genericInt], mint)
    const result = resolve(recType, undefined)
    assert.equal(result.text, "struct[2]")
})
