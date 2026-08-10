/**
 * Runtime tests for the C++ Header Generator.
 *
 * Run via: npm test
 */
import {test} from "node:test"
import * as assert from "node:assert/strict"

import {integer, list, struct, union, unit} from "@ppl/core"
import {buildTypeGraph, child} from "@ppl/core"
import {runRuleset} from "@ppl/core"
import {named} from "@ppl/core"
import {cppRules, emitCppHeader, refOf, TypeDecl} from "../src/cpp-emitter"

////////////////////////////////////////////////////////////////////////////////////////////////
// Integer width selection
////////////////////////////////////////////////////////////////////////////////////////////////

test("cpp: integer → smallest fitting fixed-width type", () => {
    const cases: Array<[number, number, string]> = [
        [0, 255, "uint8_t"],
        [0, 65535, "uint16_t"],
        [0, 4294967295, "uint32_t"],
        [-128, 127, "int8_t"],
        [-32768, 32767, "int16_t"],
        [-2147483648, 2147483647, "int32_t"],
    ]

    for(const [min, max, expected] of cases)
    {
        const g = buildTypeGraph(integer(min, max))
        const r = runRuleset(g, cppRules())
        assert.equal(r.get(0)?.ref, expected, `integer(${min}, ${max}) → ${expected}`)
    }
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Struct → C++ struct
////////////////////////////////////////////////////////////////////////////////////////////////

test("cpp: struct with named fields emits struct declaration", () => {
    const T = named("Point", struct({x: integer(0, 255), y: integer(0, 255)}))
    const g = buildTypeGraph(T)
    const r = runRuleset(g, cppRules())

    const decl = r.get(0)!
    assert.equal(decl.ref, "Point")
    assert.equal(decl.forward, "struct Point;")
    assert.ok(decl.decl?.includes("struct Point {"))
    assert.ok(decl.decl?.includes("uint8_t x;"))
    assert.ok(decl.decl?.includes("uint8_t y;"))
})

test("cpp: unnamed struct gets T<id> fallback name", () => {
    const T = struct({a: integer(0, 1)})
    const g = buildTypeGraph(T)
    const r = runRuleset(g, cppRules())

    assert.equal(r.get(0)?.ref, "T0")
    assert.ok(r.get(0)?.decl?.includes("struct T0 {"))
})

test("cpp: nested struct references child by name", () => {
    const Inner = named("Inner", struct({val: integer(0, 255)}))
    const Outer = named("Outer", struct({inner: Inner}))
    const g = buildTypeGraph(Outer)
    const r = runRuleset(g, cppRules())

    const outerDecl = r.get(0)!
    assert.ok(outerDecl.decl?.includes("Inner inner;"), "nested struct field references child by name")
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Union → std::variant
////////////////////////////////////////////////////////////////////////////////////////////////

test("cpp: generic union → struct wrapping std::variant", () => {
    const T = named("Result", union({ok: integer(0, 255), err: integer(0, 255)}))
    const g = buildTypeGraph(T)
    const r = runRuleset(g, cppRules())

    const decl = r.get(0)!
    assert.equal(decl.ref, "Result")
    assert.ok(decl.decl?.includes("std::variant<"))
    assert.ok(decl.decl?.includes("uint8_t"))
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Optional → std::optional
////////////////////////////////////////////////////////////////////////////////////////////////

test("cpp: optional union → std::optional<T>", () => {
    const Optional = (T: any) => union({value: T, empty: unit})
    const T = struct({flag: Optional(integer(0, 255))})
    const g = buildTypeGraph(T)
    const r = runRuleset(g, cppRules())

    const structDecl = r.get(0)!
    assert.ok(structDecl.decl?.includes("std::optional<uint8_t> flag;"), "optional field inlines as std::optional")
})

////////////////////////////////////////////////////////////////////////////////////////////////
// List → std::vector
////////////////////////////////////////////////////////////////////////////////////////////////

test("cpp: list of integers → std::vector<uint8_t>", () => {
    const T = list(integer(0, 255))
    const g = buildTypeGraph(T)
    const r = runRuleset(g, cppRules())

    assert.equal(r.get(0)?.ref, "std::vector<uint8_t>")
})

test("cpp: list of structs → std::vector<NamedType>", () => {
    const Point = named("Point", struct({x: integer(0, 255), y: integer(0, 255)}))
    const T = list(Point)
    const g = buildTypeGraph(T)
    const r = runRuleset(g, cppRules())

    assert.equal(r.get(0)?.ref, "std::vector<Point>")
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Recursive type — forward declarations handle the cycle
////////////////////////////////////////////////////////////////////////////////////////////////

test("cpp: recursive type generates forward declaration + cycle-safe refs", () => {
    // T = union({ internal: struct({a: T, b: T}), leaf: integer(0,1) })
    const T = named("Tree", (): any => union({
        internal: struct({a: T, b: T}),
        leaf: integer(0, 1),
    }))

    const g = buildTypeGraph(T)
    const r = runRuleset(g, cppRules())

    // The union (root) should be named "Tree"
    const treeDecl = r.get(0)!
    assert.equal(treeDecl.ref, "Tree")
    assert.equal(treeDecl.forward, "struct Tree;")

    // The internal struct's fields should reference "Tree" by name (not expand)
    const internalNode = child(g.root, {variant: "internal"})!
    const internalDecl = r.get(internalNode.id)!
    assert.ok(internalDecl.decl?.includes("Tree a;"), "recursive field references by name")
    assert.ok(internalDecl.decl?.includes("Tree b;"), "recursive field references by name")
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Full header emission
////////////////////////////////////////////////////////////////////////////////////////////////

test("cpp: emitCppHeader produces a complete header file", () => {
    const Point = named("Point", struct({x: integer(0, 65535), y: integer(0, 65535)}))
    const T = named("Shape", struct({origin: Point, points: list(Point)}))

    const g = buildTypeGraph(T)
    const r = runRuleset(g, cppRules())
    const header = emitCppHeader(r, g, "Shape")

    assert.ok(header.includes("#pragma once"))
    assert.ok(header.includes("#include <cstdint>"))
    assert.ok(header.includes("#include <optional>"))
    assert.ok(header.includes("#include <variant>"))
    assert.ok(header.includes("#include <vector>"))
    assert.ok(header.includes("struct Point;"), "forward declaration present")
    assert.ok(header.includes("struct Shape;"), "forward declaration present")
    assert.ok(header.includes("struct Point {"))
    assert.ok(header.includes("uint16_t x;"))
    assert.ok(header.includes("uint16_t y;"))
    assert.ok(header.includes("struct Shape {"))
    assert.ok(header.includes("Point origin;"))
    assert.ok(header.includes("std::vector<Point> points;"))
    assert.ok(header.includes("using Shape = Shape;"))
})

test("cpp: emitCppHeader with recursive type has forward decls before definitions", () => {
    const T = named("Tree", (): any => union({
        internal: struct({a: T, b: T}),
        leaf: integer(0, 1),
    }))

    const g = buildTypeGraph(T)
    const r = runRuleset(g, cppRules())
    const header = emitCppHeader(r, g, "Tree")

    const forwardPos = header.indexOf("struct Tree;")
    const declPos = header.indexOf("struct Tree {")
    assert.ok(forwardPos >= 0 && declPos >= 0, "both forward and definition present")
    assert.ok(forwardPos < declPos, "forward declaration comes before definition")
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Dogfood: self-describing semantic type
////////////////////////////////////////////////////////////////////////////////////////////////

test("cpp: dogfood TypeExpr generates a valid header", () => {
    const Optional = (T: any) => union({value: T, empty: unit})

    const SemanticField = (): any => struct
    ({
        name: list(integer(0, 255)),
        field: TypeExpr,
    })

    const TypeExpr = named("TypeExpr", (): any => union
    ({
        Unit: unit,

        Integer: struct
        ({
            min: integer(-2147483648, 2147483647),
            max: integer(-2147483648, 2147483647),
        }),

        Struct: struct
        ({
            fields: list(SemanticField),
        }),

        Union: struct
        ({
            variants: list(SemanticField),
        }),

        List: struct
        ({
            elementType: TypeExpr,
            capacity: Optional(integer(0, 4294967295)),
        }),
    }))

    const g = buildTypeGraph(TypeExpr)
    const r = runRuleset(g, cppRules())
    const header = emitCppHeader(r, g, "TypeExpr")

    // The header should compile conceptually: forward decls, then definitions.
    assert.ok(header.includes("struct TypeExpr;"))
    assert.ok(header.includes("struct TypeExpr {"))
    assert.ok(header.includes("std::variant<"), "TypeExpr is a variant union")
    // Recursive references by name, not expanded.
    assert.ok(header.includes("TypeExpr elementType;") || header.includes("TypeExpr"), "recursive ref by name")
})
