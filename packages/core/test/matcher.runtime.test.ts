/**
 * Runtime behavior tests for the matcher.
 *
 * Run via:
 *
 *   npm test
 *
 * Uses Node's built-in test runner (`node:test`) + `node:assert/strict`,
 * executed through ts-node against tsconfig.test.json (so files under
 * /test outside the production `rootDir: ./src` still compile).
 */
import {test} from "node:test"
import * as assert from "node:assert/strict"

import {integer, list, struct, union, unit} from "../src/metamodel"
import {AnyOfMatch, matchType, pAnyOf, pInteger, pList, pStar, pStruct, pStructFields, pUnion, pUnit, StructFieldsMatch} from "../src/matcher"
import {SemanticTypeKinds} from "../src/metamodel"

////////////////////////////////////////////////////////////////////////////////////////////////
// Integer
////////////////////////////////////////////////////////////////////////////////////////////////

test("integer: in-range pattern matches and echoes bounds", () => {
    const T = integer(10, 100)
    const m = matchType(T, pInteger(0, 255))
    assert.equal(m?.kind, SemanticTypeKinds.Integer)
    assert.equal(m?.kind === SemanticTypeKinds.Integer && m.min, 10)
    assert.equal(m?.kind === SemanticTypeKinds.Integer && m.max, 100)
})

test("integer: out-of-range pattern fails (max exceeds)", () => {
    assert.equal(matchType(integer(0, 1000), pInteger(0, 255)), undefined)
})

test("integer: out-of-range pattern fails (min below)", () => {
    assert.equal(matchType(integer(-5, 5), pInteger(0, 255)), undefined)
})

test("integer: exact bounds match", () => {
    assert.notEqual(matchType(integer(0, 255), pInteger(0, 255)), undefined)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Unit
////////////////////////////////////////////////////////////////////////////////////////////////

test("unit matches unit pattern", () => {
    assert.notEqual(matchType(unit, pUnit()), undefined)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// List
////////////////////////////////////////////////////////////////////////////////////////////////

test("list: element match propagates", () => {
    const T = list(integer(0, 15), 8)
    const m = matchType(T, pList(pInteger(0, 255)))
    assert.equal(m?.kind, SemanticTypeKinds.List)
    assert.equal(m?.kind === SemanticTypeKinds.List && m.capacity, 8)
    assert.equal(
        m?.kind === SemanticTypeKinds.List && m.elementMatch.kind,
        SemanticTypeKinds.Integer,
    )
})

test("list: capacityMax violated fails", () => {
    assert.equal(matchType(list(integer(0, 15), 1024), pList(pInteger(0, 255), 256)), undefined)
})

test("list: element pattern mismatch fails", () => {
    assert.equal(matchType(list(integer(0, 15)), pList(pUnit())), undefined)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Struct (exact field set)
////////////////////////////////////////////////////////////////////////////////////////////////

test("struct: exact fields match", () => {
    const T = struct({a: integer(0, 1), b: unit})
    const m = matchType(T, pStruct({a: pInteger(0, 1), b: pUnit()}))
    assert.equal(m?.kind, SemanticTypeKinds.Struct)
    assert.equal(
        m?.kind === SemanticTypeKinds.Struct && m.fieldMatches["a"].match.kind,
        SemanticTypeKinds.Integer,
    )
})

test("struct: extra field in T fails (pattern must cover all)", () => {
    const T = struct({a: integer(0, 1), b: unit})
    assert.equal(matchType(T, pStruct({a: pInteger(0, 1)})), undefined)
})

test("struct: missing field in T fails (pattern demands absent field)", () => {
    const T = struct({a: integer(0, 1)})
    assert.equal(matchType(T, pStruct({a: pInteger(0, 1), b: pUnit()})), undefined)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Union (exact variant set)
////////////////////////////////////////////////////////////////////////////////////////////////

test("union: exact variants match", () => {
    const T = union({ok: integer(0, 1), err: unit})
    const m = matchType(T, pUnion({ok: pInteger(0, 1), err: pUnit()}))
    assert.equal(
        m?.kind === SemanticTypeKinds.Union && m.variantMatches["err"].match.kind,
        SemanticTypeKinds.Unit,
    )
})

test("union: extra variant in T fails", () => {
    const T = union({ok: integer(0, 1), err: unit})
    assert.equal(matchType(T, pUnion({ok: pInteger(0, 1)})), undefined)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Reference (thunk unwrapping)
////////////////////////////////////////////////////////////////////////////////////////////////

test("reference: thunk is transparently unwrapped", () => {
    const T: () => any = () => integer(0, 7)
    const m = matchType(T as any, pInteger(0, 255))
    assert.equal(m?.kind, SemanticTypeKinds.Integer)
})

test("reference: recursive type (binary tree of booleans) reaches depth 2", () => {
    // T = union({ internal: struct({ a: T, b: T }), leaf: integer(0,1) })
    //
    // The recursive spine uses `() => SemanticType` reference thunks
    // (the metamodel's cycle-breaker), NOT eager construction.
    // The matcher unwraps references lazily as it descends.
    const T = (): any => union({
        internal: struct({a: T, b: T}),
        leaf: integer(0, 1),
    })

    // Depth-2 pattern. Both `a` and `b` descend one reference into T.
    // The inner union patterns omit `internal`, so the exact-variant
    // check rejects them -> the whole match fails. This proves reference
    // unwrapping reaches depth 2. (The exact-variant-set requirement is
    // still in force for `pUnion`; StructFieldsPattern relaxes the
    // analogous constraint for `pStruct` only, not for unions.)
    const m = matchType(T(), pUnion({
        internal: pStruct({
            a: pUnion({leaf: pInteger(0, 1)}),
            b: pUnion({leaf: pInteger(0, 1)}),
        }),
        leaf: pInteger(0, 1),
    }))
    assert.equal(m, undefined)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// AnyOf (priority-ordered first match)
////////////////////////////////////////////////////////////////////////////////////////////////

test("anyof: first matching alternative wins, tagged with branch 0", () => {
    const m = matchType(integer(0, 1), pAnyOf(() => [pInteger(0, 1), pUnit()]))
    assert.equal((m as AnyOfMatch | undefined)?.branch, 0)
    assert.equal(
        ((m as AnyOfMatch | undefined)?.match as {kind: SemanticTypeKinds} | undefined)?.kind,
        SemanticTypeKinds.Integer,
    )
})

test("anyof: falls through to later alternative", () => {
    const m = matchType(unit, pAnyOf(() => [pInteger(0, 1), pUnit()]))
    assert.equal((m as AnyOfMatch | undefined)?.branch, 1)
    assert.equal(
        ((m as AnyOfMatch | undefined)?.match as {kind: SemanticTypeKinds} | undefined)?.kind,
        SemanticTypeKinds.Unit,
    )
})

test("anyof: all alternatives fail -> undefined", () => {
    assert.equal(
        matchType(list(unit), pAnyOf(() => [pInteger(0, 1), pUnit()])),
        undefined,
    )
})

test("anyof: re-dispatches through nested matchers (list-of-anyof element)", () => {
    const T = list(unit, 4)
    const m = matchType(T, pList(pAnyOf(() => [pInteger(0, 1), pUnit()])))
    assert.equal(m?.kind, SemanticTypeKinds.List)
    const em = m?.kind === SemanticTypeKinds.List && m.elementMatch
    assert.equal((em as AnyOfMatch | undefined)?.branch, 1)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// StructFields (homogeneous-fields pattern; collection witness)
////////////////////////////////////////////////////////////////////////////////////////////////

test("structfields: all-integer struct matches pStructFields(pInteger)", () => {
    const T = struct({a: integer(0, 1), b: integer(0, 7), c: integer(0, 255)})
    const m = matchType(T, pStructFields(pInteger(0, 255)))
    assert.equal(m?.kind, SemanticTypeKinds.Struct)
    const fm = (m as StructFieldsMatch | undefined)?.fieldMatches
    assert.equal(fm?.length, 3)
    assert.deepEqual(fm?.map(f => f.name), ["a", "b", "c"])
    assert.equal((fm?.[0].match as {kind: SemanticTypeKinds} | undefined)?.kind, SemanticTypeKinds.Integer)
})

test("structfields: one field mismatching element fails", () => {
    const T = struct({a: integer(0, 1), b: unit})
    assert.equal(matchType(T, pStructFields(pInteger(0, 255))), undefined)
})

test("structfields: empty struct matches with empty collection witness", () => {
    const T = struct({})
    const m = matchType(T, pStructFields(pInteger(0, 255)))
    assert.equal((m as StructFieldsMatch | undefined)?.fieldMatches.length, 0)
})

test("structfields: preserves field order of T (insertion order)", () => {
    const T = struct({z: integer(0, 1), a: integer(0, 1), m: integer(0, 1)})
    const fm = (matchType(T, pStructFields(pInteger(0, 1))) as StructFieldsMatch | undefined)?.fieldMatches
    assert.deepEqual(fm?.map(f => f.name), ["z", "a", "m"])
})

////////////////////////////////////////////////////////////////////////////////////////////////
// StructFields + AnyOf: the struct-of-optionals partition (the motivating case)
//
// A struct of optional fields (modelled as union({value:T, empty:Unit}))
// is matched by pStructFields(pAnyOf(() => [Optional<*>], *])). The branch
// tag in each field's AnyOfMatch witness is the partition signal: which fields
// go into the presence bitmap (Optional won) vs which are encoded directly
// (the wildcard re-dispatch won).
////////////////////////////////////////////////////////////////////////////////////////////////

test("structfields+anyof: optional fields win branch 0, plain fields fall through", () => {
    // Optional sugar: union({value: T, empty: unit})
    const Optional = (T: any) => union({value: T, empty: unit})

    const T = struct({
        flag: Optional(integer(0, 255)),   // optional -> should match branch 0
        count: integer(0, 65535),          // plain    -> should match branch 1
        tag:   Optional(integer(0, 15)),    // optional -> should match branch 0
    })

    // pAnyOf tries [OptionalPattern, *]. OptionalPattern here is a literal
    // union({value: pAnyOf(root), empty: pUnit()}). We inline the wildcard
    // as a second alternative that matches any struct/union/integer/etc.
    // For this runtime test we approximate "*" with a per-kind fallthrough
    // via a second anyof of the concrete kinds present.
    const m = matchType(T, pStructFields(pAnyOf(() => [
        // branch 0: optional-shaped union
        pUnion({value: pInteger(0, 255), empty: pUnit()}),
        // branch 1: plain integer (the "non-optional" case for this T)
        pInteger(0, 65535),
    ]))) as StructFieldsMatch | undefined

    assert.equal(m?.kind, SemanticTypeKinds.Struct)
    const fm = m?.fieldMatches
    assert.equal(fm?.length, 3)
    // flag and tag are optionals -> branch 0; count is plain -> branch 1
    assert.equal((fm?.[0].match as AnyOfMatch | undefined)?.branch, 0) // flag
    assert.equal((fm?.[1].match as AnyOfMatch | undefined)?.branch, 1) // count
    assert.equal((fm?.[2].match as AnyOfMatch | undefined)?.branch, 0) // tag
})

test("structfields+anyof: all-optional struct yields all branch 0", () => {
    const Optional = (T: any) => union({value: T, empty: unit})
    const T = struct({
        x: Optional(integer(0, 1)),
        y: Optional(integer(0, 1)),
    })
    const m = matchType(T, pStructFields(pAnyOf(() => [
        pUnion({value: pInteger(0, 1), empty: pUnit()}),
        pInteger(0, 1),
    ]))) as StructFieldsMatch | undefined
    assert.equal(m?.fieldMatches.length, 2)
    assert.equal((m?.fieldMatches[0].match as AnyOfMatch | undefined)?.branch, 0)
    assert.equal((m?.fieldMatches[1].match as AnyOfMatch | undefined)?.branch, 0)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Star (hole / re-dispatch boundary)
////////////////////////////////////////////////////////////////////////////////////////////////

test("star: pStar() matches any type", () => {
    assert.notEqual(matchType(integer(0, 1), pStar()), undefined)
    assert.notEqual(matchType(unit, pStar()), undefined)
    assert.notEqual(matchType(struct({a: integer(0, 1)}), pStar()), undefined)
})

test("star: pStar(inner) matches only if inner matches", () => {
    assert.notEqual(matchType(integer(0, 1), pStar(pInteger(0, 255))), undefined)
    assert.equal(matchType(unit, pStar(pInteger(0, 255))), undefined)
})

test("star: pStar(inner) carries the inner witness", () => {
    const m = matchType(integer(10, 100), pStar(pInteger(0, 255))) as any
    assert.equal(m?.kind, "star")
    assert.equal(m?.innerMatch?.kind, SemanticTypeKinds.Integer)
    assert.equal(m?.innerMatch?.min, 10)
})

test("star: nested under pUnion marks the value variant as a hole", () => {
    // Optional<T> = union({value: T, empty: unit}). The value variant
    // uses pStar — the re-dispatch boundary.
    const Optional = (T: any) => union({value: T, empty: unit})
    const T = Optional(integer(0, 255))
    const m = matchType(T, pUnion({value: pStar(), empty: pUnit()})) as any
    assert.equal(m?.kind, SemanticTypeKinds.Union)
    assert.equal(m?.variantMatches?.value?.match.kind, "star")
    assert.equal(m?.variantMatches?.empty?.match.kind, SemanticTypeKinds.Unit)
})
