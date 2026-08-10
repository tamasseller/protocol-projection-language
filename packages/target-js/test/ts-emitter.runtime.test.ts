/**
 * Runtime tests for the TypeScript target emitter (ts-emitter.ts).
 *
 * Validates the generic TS projection in isolation. The example package
 * exercises the full composition; these tests guard the package's own
 * contract.
 */
import {test} from "node:test"
import * as assert from "node:assert/strict"

import {integer, list, struct, union, unit, named} from "@ppl/core"
import {buildTypeGraph, child} from "@ppl/core"
import {
    tsTypeRules,
    projectTSTypes,
    emitTSDeclarations,
    tsRefOf,
    TSTypeDecl,
} from "../src/ts-emitter"

////////////////////////////////////////////////////////////////////////////////////////////////
// Integer → "number"
////////////////////////////////////////////////////////////////////////////////////////////////

test("ts-emitter: integer projects to number", () => {
    const g = buildTypeGraph(integer(0, 255))
    const r = projectTSTypes(g)
    assert.equal(r.get(0)?.ref, "number")
    assert.equal(r.get(0)?.decl, undefined)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Struct → interface
////////////////////////////////////////////////////////////////////////////////////////////////

test("ts-emitter: struct projects to interface with readonly fields", () => {
    const T = named("Point", struct({x: integer(0, 255), y: integer(0, 65535)}))
    const g = buildTypeGraph(T)
    const r = projectTSTypes(g)

    const decl = r.get(0)!
    assert.equal(decl.ref, "Point")
    assert.ok(decl.decl?.includes("interface Point {"))
    assert.ok(decl.decl?.includes("readonly x: number;"))
    assert.ok(decl.decl?.includes("readonly y: number;"))
})

////////////////////////////////////////////////////////////////////////////////////////////////
// List → T[]
////////////////////////////////////////////////////////////////////////////////////////////////

test("ts-emitter: list projects to T[] inline", () => {
    const T = struct({items: list(integer(0, 255), 8)})
    const g = buildTypeGraph(T)
    const r = projectTSTypes(g)

    const decl = r.get(0)!.decl!
    assert.ok(decl.includes("items: number[];"))
})

////////////////////////////////////////////////////////////////////////////////////////////////
// All-unit union → string literal union
////////////////////////////////////////////////////////////////////////////////////////////////

test("ts-emitter: all-unit union projects to string literal union", () => {
    const T = named("Mode", union({a: unit, b: unit}))
    const g = buildTypeGraph(T)
    const r = projectTSTypes(g)

    const decl = r.get(0)!.decl!
    assert.ok(decl.includes("type Mode ="))
    assert.ok(decl.includes('"a"'))
    assert.ok(decl.includes('"b"'))
})

////////////////////////////////////////////////////////////////////////////////////////////////
// emitTSDeclarations
////////////////////////////////////////////////////////////////////////////////////////////////

test("ts-emitter: emitTSDeclarations emits all decls", () => {
    const T = named("Point", struct({x: integer(0, 255)}))
    const g = buildTypeGraph(T)
    const out = emitTSDeclarations(projectTSTypes(g))
    assert.ok(out.includes("interface Point {"))
})
