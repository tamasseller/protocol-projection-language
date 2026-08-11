/**
 * Runtime tests for the TypeScript target emitter (ts-emitter.ts).
 *
 * Validates the generic TS projection in isolation. The example package
 * exercises the full composition; these tests guard the package's own
 * contract.
 */
import {test} from "node:test"
import * as assert from "node:assert/strict"

import {integer, list, struct, union, unit, named, pInteger} from "@ppl/core"
import {tsTypeRules} from "../src/components/ts-emitter"
import {projectTSTypes, emitTSDeclarations, tsRule} from "../src/engine/resolver"
import {assertCompiles} from "./ts-check"

////////////////////////////////////////////////////////////////////////////////////////////////
// Integer → "number"
////////////////////////////////////////////////////////////////////////////////////////////////

test("ts-emitter: integer projects to number", () => {
    const T = integer(0, 255)
    const r = projectTSTypes(T, tsTypeRules)
    assert.equal(r.get(0)?.ref, "number")
    assert.equal(r.get(0)?.decl, undefined)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Struct → interface
////////////////////////////////////////////////////////////////////////////////////////////////

test("ts-emitter: struct projects to interface with readonly fields", () => {
    const T = named("Point", struct({x: integer(0, 255), y: integer(0, 65535)}))
    const r = projectTSTypes(T, tsTypeRules)

    const decl = r.get(0)!
    assert.equal(decl.ref, "Point")
    assert.ok(decl.decl?.includes("interface Point {"))
    assert.ok(decl.decl?.includes("readonly x: number;"))
    assert.ok(decl.decl?.includes("readonly y: number;"))
    assertCompiles(emitTSDeclarations(r))
})

////////////////////////////////////////////////////////////////////////////////////////////////
// List → T[]
////////////////////////////////////////////////////////////////////////////////////////////////

test("ts-emitter: list projects to T[] inline", () => {
    const T = struct({items: list(integer(0, 255), 8)})
    const r = projectTSTypes(T, tsTypeRules)

    const decl = r.get(0)!.decl!
    assert.ok(decl.includes("items: number[];"))
    assertCompiles(emitTSDeclarations(r))
})

////////////////////////////////////////////////////////////////////////////////////////////////
// All-unit union → string literal union
////////////////////////////////////////////////////////////////////////////////////////////////

test("ts-emitter: all-unit union projects to string literal union", () => {
    const T = named("Mode", union({a: unit, b: unit}))
    const r = projectTSTypes(T, tsTypeRules)

    const decl = r.get(0)!.decl!
    assert.ok(decl.includes("type Mode ="))
    assert.ok(decl.includes('"a"'))
    assert.ok(decl.includes('"b"'))
    assertCompiles(emitTSDeclarations(r))
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Mixed-payload union → discriminated union
////////////////////////////////////////////////////////////////////////////////////////////////

test("ts-emitter: mixed-payload union projects to a tagged discriminated union", () => {
    const T = named("Result", union({ok: integer(0, 255), err: unit}))
    const r = projectTSTypes(T, tsTypeRules)

    const decl = r.get(0)!.decl!
    assert.ok(decl.includes("type Result ="))
    assert.ok(decl.includes('tag: "ok"'))
    assert.ok(decl.includes("value: number"))
    assert.ok(decl.includes('tag: "err"'))
    assert.ok(decl.includes("value: null"))
    assertCompiles(emitTSDeclarations(r))
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Recursive type — cycle-safe (no infinite loop)
////////////////////////////////////////////////////////////////////////////////////////////////

test("ts-emitter: a self-referential type projects without looping, referencing itself by name", () => {
    const Tree: any = named("Tree", (): any => union({
        internal: struct({a: Tree, b: Tree}),
        leaf: integer(0, 1),
    }))

    const r = projectTSTypes(Tree, tsTypeRules)
    const treeDecl = r.get(0)!
    assert.equal(treeDecl.ref, "Tree")

    // Node 1 = the "internal" variant's struct (DFS pre-order: 0=union,
    // 1=struct, its own "a"/"b" fields back-edge to node 0 rather than
    // minting new ids, 2=the "leaf" variant's integer).
    const internalDecl = r.get(1)!.decl!
    assert.ok(internalDecl.includes("readonly a: Tree;"), "recursive field references by name, not expanded")
    assert.ok(internalDecl.includes("readonly b: Tree;"), "recursive field references by name, not expanded")
    assertCompiles(emitTSDeclarations(r))
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Composability — a custom rule can preempt a default one
////////////////////////////////////////////////////////////////////////////////////////////////

test("ts-emitter: a caller's own rule ahead of tsTypeRules preempts the default for a specific shape", () => {
    const bigIntRule = tsRule(pInteger(0, Number.MAX_SAFE_INTEGER),
        () => "bigint",
        () => ({deps: []}))

    const T = struct({count: integer(0, Number.MAX_SAFE_INTEGER)})
    const withOverride = projectTSTypes(T, [bigIntRule, ...tsTypeRules])
    assert.ok(withOverride.get(0)!.decl!.includes("count: bigint;"))
    assertCompiles(emitTSDeclarations(withOverride))

    const withoutOverride = projectTSTypes(T, tsTypeRules)
    assert.ok(withoutOverride.get(0)!.decl!.includes("count: number;"))
    assertCompiles(emitTSDeclarations(withoutOverride))
})

////////////////////////////////////////////////////////////////////////////////////////////////
// emitTSDeclarations
////////////////////////////////////////////////////////////////////////////////////////////////

test("ts-emitter: emitTSDeclarations emits all decls", () => {
    const T = named("Point", struct({x: integer(0, 255)}))
    const out = emitTSDeclarations(projectTSTypes(T, tsTypeRules))
    assert.ok(out.includes("interface Point {"))
    assertCompiles(out)
})
