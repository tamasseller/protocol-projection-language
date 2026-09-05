/**
 * Runtime tests for Layer 1's *other* primitive: `createResolver` — the
 * on-demand, memoized, cycle-safe resolver `codecs`/`target-js`
 * each adapt (see `projection.ts`'s own header): rule ordering, the
 * reserve-then-fill cycle-safety split, and the `claims`-based guarantee
 * that an absorbed multi-node match never gets silently re-matched from
 * scratch.
 *
 * Run via: npm test
 */
import {test} from "node:test"
import * as assert from "node:assert/strict"

import {integer, named, nameOf, struct, list, u8, u16, union, unit} from "../../src/core/metamodel"
import type {TypeNode} from "../../src/core/type-graph"
import type {SemanticType, UnionType} from "../../src/core/metamodel"
import {createResolver, resolverRule} from "../../src/core/projection"
import {pAnyOf, pInteger, pNamed, pStruct, pStructFields, pList, pStar, pUnion, pUnit} from "../../src/core/matcher"
import type {AnyOfMatch} from "../../src/core/matcher"

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
    // (`src/codecs/test/resolver.test.ts` uses the exact same technique,
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

test("createResolver: rules are tried in order — an earlier rule preempts a later one", () =>
{
    // The motivating case for `pNamed`: an application author preempts the
    // generic struct rule for one declared type name, without spelling out
    // its shape as a pattern.
    const Timestamp = named("Timestamp", struct({secs: u8, nanos: u8}))
    const Other = named("Other", struct({x: u8}))

    const rules = [
        resolverRule(pNamed("Timestamp"), (placeholder: Cap) => { placeholder.text = "custom-timestamp" }),
        resolverRule(pStructFields(pStar()), (placeholder: Cap) => { placeholder.text = "generic-struct" }),
    ]

    assert.equal(createResolver<Cap, void>(rules, mint).resolve(Timestamp, undefined).text, "custom-timestamp")
    assert.equal(createResolver<Cap, void>(rules, mint).resolve(Other, undefined).text, "generic-struct")
})

test("createResolver: a rule reads its node's own declared name, no registry needed", () =>
{
    const Ts = named("Timestamp", struct({secs: u8}))

    const byName = resolverRule(pStructFields(pStar()), (placeholder: Cap, _match, node) =>
    {
        // `node.source` is the pre-deref object `named()` was called on.
        placeholder.text = nameOf(node.source as SemanticType) ?? `T${node.id}`
    })

    assert.equal(createResolver<Cap, void>([byName], mint).resolve(Ts, undefined).text, "Timestamp")
})

test("createResolver: no rule matching a reachable type is a loud error", () =>
{
    const onlyStructs = resolverRule(pStructFields(pStar()), (placeholder: Cap, match, _node, _ctx, resolve) =>
    {
        placeholder.text = `struct(${match.fieldMatches.map(f => resolve(f.type, undefined).text).join(",")})`
    })

    assert.throws(
        () => createResolver<Cap, void>([onlyStructs], mint).resolve(struct({a: u8}), undefined),
        /no rule matches type kind/,
    )
})

test("createResolver: a pAnyOf branch's pStar hole re-dispatches, its concrete sibling is absorbed", () =>
{
    // The presence-bitmap shape: a struct rule that absorbs each optional
    // union whole (and its `empty` unit with it) while re-dispatching the
    // `value` variant, so the bitmap owns the framing and the value type
    // still picks its own codec.
    const Optional = (T: SemanticType) => union({value: T, empty: unit})
    const root = struct({flag: Optional(u8), count: u16})

    const bitmap = resolverRule(
        pStructFields(pAnyOf(() => [
            pUnion({value: pStar(), empty: pUnit()}), // optional — absorbed, value re-dispatched
            pStar(),                                  // plain — re-dispatched whole
        ])),
        (placeholder: Cap, match, _node, _ctx, resolve) =>
        {
            const parts = match.fieldMatches.map(f =>
            {
                // Branch 0 is the optional union: reach past it to `value`.
                const inner = (f.match as AnyOfMatch).branch === 0
                    ? ((f.type as UnionType).variants.get("value") as SemanticType)
                    : f.type
                return resolve(inner, undefined).text
            })
            placeholder.text = `bitmap(${parts.join(",")})`
        },
    )
    const int = resolverRule(pInteger(-Infinity, Infinity), (placeholder: Cap, match) =>
    {
        placeholder.text = `int${match.max > 255 ? 16 : 8}`
    })

    const {resolve, cache} = createResolver<Cap, void>([bitmap, int], mint)
    assert.equal(resolve(root, undefined).text, "bitmap(int8,int16)")

    // The absorbed union and its `empty` unit never got a capability of
    // their own — only the struct and the two re-dispatched integers did.
    assert.equal(cache.size, 3)
})

test("createResolver: a fully-absorbing rule leaves nothing for its descendants", () =>
{
    const root = struct({a: struct({x: u8})})

    const outer = resolverRule(
        pStruct({a: pStruct({x: pInteger(-Infinity, Infinity)})}),
        (placeholder: Cap) => { placeholder.text = "outer" },
    )
    const int = resolverRule(pInteger(-Infinity, Infinity), (placeholder: Cap) => { placeholder.text = "int" })

    const {resolve, cache} = createResolver<Cap, void>([outer, int], mint)
    assert.equal(resolve(root, undefined).text, "outer")
    assert.equal(cache.size, 1) // inner struct and its integer are both absorbed
})
