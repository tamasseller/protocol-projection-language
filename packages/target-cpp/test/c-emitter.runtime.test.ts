/**
 * Runtime tests for the bare-metal C emitter (c-emitter.ts).
 *
 * Validates the generic no-STL C projection in isolation, independent
 * of any specific schema. The example package exercises the full
 * composition; these tests guard the package's own contract.
 */
import {test} from "node:test"
import * as assert from "node:assert/strict"

import {integer, list, struct, union, unit, named} from "@ppl/core"
import {buildTypeGraph} from "@ppl/core"
import {
    cTypeRules,
    projectCTypes,
    emitCHeader,
    cIntType,
    cRefOf,
    CTypeDecl,
} from "../src/c-emitter"

////////////////////////////////////////////////////////////////////////////////////////////////
// cIntType — smallest fitting fixed-width C type
////////////////////////////////////////////////////////////////////////////////////////////////

test("c-emitter: cIntType picks smallest unsigned/signed width", () => {
    const cases: Array<[number, number, string]> = [
        [0, 255, "uint8_t"],
        [0, 65535, "uint16_t"],
        [0, 4294967295, "uint32_t"],
        [-128, 127, "int8_t"],
        [-32768, 32767, "int16_t"],
        [-2147483648, 2147483647, "int32_t"],
    ]
    for (const [min, max, expected] of cases)
    {
        assert.equal(cIntType(integer(min, max)), expected)
    }
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Integer node → fixed-width ref, no decl
////////////////////////////////////////////////////////////////////////////////////////////////

test("c-emitter: integer projects to fixed-width ref with no decl", () => {
    const g = buildTypeGraph(integer(0, 255))
    const r = projectCTypes(g)
    assert.equal(r.get(0)?.ref, "uint8_t")
    assert.equal(r.get(0)?.decl, undefined)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Struct → typedef struct, NO STL anywhere
////////////////////////////////////////////////////////////////////////////////////////////////

test("c-emitter: struct emits typedef struct with no STL", () => {
    const T = named("Point", struct({x: integer(0, 255), y: integer(0, 65535)}))
    const g = buildTypeGraph(T)
    const r = projectCTypes(g)

    const decl = r.get(0)!
    assert.equal(decl.ref, "Point")
    assert.equal(decl.forward, "typedef struct Point Point;")
    assert.ok(decl.decl?.includes("typedef struct Point {"))
    assert.ok(decl.decl?.includes("uint8_t x;"))
    assert.ok(decl.decl?.includes("uint16_t y;"))
})

test("c-emitter: emitCHeader never contains STL", () => {
    const T = named("Point", struct({x: integer(0, 255), y: integer(-32768, 32767)}))
    const g = buildTypeGraph(T)
    const header = emitCHeader(projectCTypes(g))

    assert.ok(header.includes("#include <stdint.h>"))
    assert.ok(!header.includes("std::"))
    assert.ok(!header.includes("vector"))
    assert.ok(!header.includes("variant"))
})

////////////////////////////////////////////////////////////////////////////////////////////////
// List → fixed array + count field (inlined by enclosing struct)
////////////////////////////////////////////////////////////////////////////////////////////////

test("c-emitter: list becomes fixed array + count in enclosing struct", () => {
    const T = named("Buf", struct({items: list(integer(0, 255), 8)}))
    const g = buildTypeGraph(T)
    const r = projectCTypes(g)

    const decl = r.get(0)!.decl!
    assert.ok(decl.includes("uint8_t items[8];"))
    assert.ok(decl.includes("uint8_t items_count;"))
})

////////////////////////////////////////////////////////////////////////////////////////////////
// All-unit union → tag byte only, no data union
////////////////////////////////////////////////////////////////////////////////////////////////

test("c-emitter: all-unit union emits tag byte with no data union", () => {
    const T = named("Mode", union({a: unit, b: unit}))
    const g = buildTypeGraph(T)
    const r = projectCTypes(g)

    const decl = r.get(0)!.decl!
    assert.ok(decl.includes("uint8_t tag;"))
    assert.ok(!decl.includes("union {"))
})
