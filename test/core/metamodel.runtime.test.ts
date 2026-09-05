/**
 * Runtime tests for declared default values (ROADMAP item 9,
 * docs/codec-image.md §4): `IntegerType.default`, `UnionType.defaultVariant`,
 * and `defaultValueOf`.
 *
 * Run via: npm test
 */
import {test} from "node:test"
import * as assert from "node:assert/strict"

import {defaultValueOf, i8, integer, list, named, nameOf, optional, struct, u8, union, unit} from "../../src/core/metamodel"
import {buildTypeGraph, child} from "../../src/core/type-graph"

////////////////////////////////////////////////////////////////////////////////////////////////
// integer: default defaults to 0, third argument overrides it
////////////////////////////////////////////////////////////////////////////////////////////////

test("integer: default is 0 when omitted", () => {
    assert.equal(integer(0, 255).default, 0)
})

test("integer: third argument sets an explicit default", () => {
    assert.equal(integer(0, 255, 7).default, 7)
})

test("integer: shared range constants (u8/i8) default to 0", () => {
    assert.equal(u8.default, 0)
    assert.equal(i8.default, 0)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// union: defaultVariant is opt-in and restricted to a unit-valued variant
////////////////////////////////////////////////////////////////////////////////////////////////

test("union: no defaultVariant by default", () => {
    assert.equal(union({ok: integer(0, 1), err: unit}).defaultVariant, undefined)
})

test("union: defaultVariant naming a unit variant is accepted", () => {
    const T = union({ok: integer(0, 1), unrecognized: unit}, "unrecognized")
    assert.equal(T.defaultVariant, "unrecognized")
})

test("union: defaultVariant naming a non-existent variant throws", () => {
    assert.throws(() => union({ok: integer(0, 1), err: unit}, "missing"))
})

test("union: defaultVariant naming a non-unit variant throws", () => {
    assert.throws(() => union({ok: integer(0, 1), err: unit}, "ok"))
})

////////////////////////////////////////////////////////////////////////////////////////////////
// optional: sugar for union({value: T, empty: unit}, "empty")
////////////////////////////////////////////////////////////////////////////////////////////////

test("optional: exposes exactly the value/empty variants target rules match on", () => {
    const T = optional(u8)
    assert.deepEqual([...T.variants.keys()], ["value", "empty"])
    assert.equal(T.variants.get("value"), u8)
    assert.equal(T.variants.get("empty"), unit)
})

test("optional: \"empty\" is the declared defaultVariant, for free", () => {
    assert.equal(optional(u8).defaultVariant, "empty")
})

test("defaultValueOf: optional falls back to \"empty\" absent a real value", () => {
    assert.deepEqual(defaultValueOf(optional(u8)), {variant: "empty", value: undefined})
})

////////////////////////////////////////////////////////////////////////////////////////////////
// defaultValueOf: per-kind defaults
////////////////////////////////////////////////////////////////////////////////////////////////

test("defaultValueOf: unit is undefined", () => {
    assert.equal(defaultValueOf(unit), undefined)
})

test("defaultValueOf: integer is its own declared default", () => {
    assert.equal(defaultValueOf(integer(0, 255)), 0)
    assert.equal(defaultValueOf(integer(0, 255, 42)), 42)
})

test("defaultValueOf: list is always empty, regardless of element type", () => {
    assert.deepEqual(defaultValueOf(list(integer(0, 255))), [])
    assert.deepEqual(defaultValueOf(list(struct({a: integer(0, 255, 5)}))), [])
})

test("defaultValueOf: struct composes its own fields' defaults recursively", () => {
    const T = struct({
        id: u8,
        quality: integer(0, 255, 7),
        nested: struct({flag: unit, count: integer(0, 100, 3)}),
    })
    assert.deepEqual(defaultValueOf(T), {
        id: 0,
        quality: 7,
        nested: {flag: undefined, count: 3},
    })
})

test("defaultValueOf: union with a declared defaultVariant", () => {
    const T = union({temperature: integer(-40, 125), unrecognized: unit}, "unrecognized")
    assert.deepEqual(defaultValueOf(T), {variant: "unrecognized", value: undefined})
})

test("defaultValueOf: union with no declared defaultVariant throws", () => {
    const T = union({temperature: integer(-40, 125), humidity: integer(0, 100)})
    assert.throws(() => defaultValueOf(T))
})

test("defaultValueOf: struct field of a union type with no default composes to a throw", () => {
    const NoDefault = union({temperature: integer(-40, 125), humidity: integer(0, 100)})
    const T = struct({id: u8, kind: NoDefault})
    assert.throws(() => defaultValueOf(T))
})

test("defaultValueOf: struct field of a union type WITH a default composes cleanly", () => {
    const WithDefault = union({temperature: integer(-40, 125), unrecognized: unit}, "unrecognized")
    const T = struct({id: u8, kind: WithDefault})
    assert.deepEqual(defaultValueOf(T), {id: 0, kind: {variant: "unrecognized", value: undefined}})
})

test("defaultValueOf: follows reference thunks", () => {
    const T = () => integer(0, 255, 9)
    assert.equal(defaultValueOf(T), 9)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// named() / nameOf()
////////////////////////////////////////////////////////////////////////////////////////////////

test("named() attaches a name readable via nameOf()", () => {
    const Ts = named("Timestamp", struct({secs: integer(0, 4294967295), nanos: integer(0, 999999999)}))
    assert.equal(nameOf(Ts), "Timestamp")
})

test("unnamed types have no name", () => {
    assert.equal(nameOf(struct({a: integer(0, 1)})), undefined)
})

test("a named thunk (recursive type) carries its name on the thunk itself", () => {
    const T = named("Tree", (): any => union({
        internal: struct({a: T, b: T}),
        leaf: integer(0, 1),
    }))

    assert.equal(nameOf(T), "Tree")
    // The struct/integer bodies reached through the thunk have no names.
    const g = buildTypeGraph(T)
    assert.equal(nameOf(child(g.root, {variant: "internal"})!.type), undefined)
    assert.equal(nameOf(child(g.root, {variant: "leaf"})!.type), undefined)
})
