/**
 * Runtime tests for the opt-in alternative TS representations
 * (components/ts-alternative-rules.ts) — each is independently composable
 * ahead of tsTypeRules, and these tests exercise them exactly that way,
 * including the ordering-sensitive ones. Every case that produces a real
 * declaration also gets run through the real TypeScript compiler
 * (ts-check.ts) — substrings pin the exact shape, the compiler proves that
 * shape is actually valid, self-consistent TypeScript.
 */
import {test} from "node:test"
import * as assert from "node:assert/strict"

import {integer, list, named, optional, struct, union, unit} from "@ppl/core"
import {projectTSTypes, emitTSDeclarations} from "../src/engine/resolver"
import {tsTypeRules} from "../src/components/ts-emitter"
import {
    unitAsUndefinedRule,
    bigIntEscalationRules,
    byteListAsUint8ArrayRule,
    capacityOneListAsOptionalRule,
    optionalUnionRule,
    unionAsClassHierarchyRule,
    structAsClassRule,
} from "../src/components/ts-alternative-rules"
import {assertCompiles} from "./ts-check"

////////////////////////////////////////////////////////////////////////////////////////////////
// Unit → undefined
////////////////////////////////////////////////////////////////////////////////////////////////

test("ts-alternative-rules: unitAsUndefinedRule maps unit to undefined", () => {
    const r = projectTSTypes(unit, [unitAsUndefinedRule, ...tsTypeRules])
    assert.equal(r.get(0)?.ref, "undefined")
    // No top-level decl for a bare unit — nothing for ts-check to compile.
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Integer → bigint past Number's safe range
////////////////////////////////////////////////////////////////////////////////////////////////

test("ts-alternative-rules: bigIntEscalationRules keeps safe-range integers as number", () => {
    const T = struct({count: integer(0, 255)})
    const r = projectTSTypes(T, [...bigIntEscalationRules, ...tsTypeRules])
    assert.ok(r.get(0)!.decl!.includes("count: number;"))
    assertCompiles(emitTSDeclarations(r))
})

test("ts-alternative-rules: bigIntEscalationRules escalates out-of-safe-range integers to bigint", () => {
    const T = struct({count: integer(0, Number.MAX_SAFE_INTEGER + 1)})
    const r = projectTSTypes(T, [...bigIntEscalationRules, ...tsTypeRules])
    assert.ok(r.get(0)!.decl!.includes("count: bigint;"))
    assertCompiles(emitTSDeclarations(r))
})

////////////////////////////////////////////////////////////////////////////////////////////////
// List<byte> → Uint8Array
////////////////////////////////////////////////////////////////////////////////////////////////

test("ts-alternative-rules: byteListAsUint8ArrayRule maps a byte list to Uint8Array", () => {
    const T = struct({payload: list(integer(0, 255))})
    const r = projectTSTypes(T, [byteListAsUint8ArrayRule, ...tsTypeRules])
    assert.ok(r.get(0)!.decl!.includes("payload: Uint8Array;"))
    assertCompiles(emitTSDeclarations(r))
})

test("ts-alternative-rules: byteListAsUint8ArrayRule doesn't claim a wider-range list", () => {
    const T = struct({payload: list(integer(0, 65535))})
    const r = projectTSTypes(T, [byteListAsUint8ArrayRule, ...tsTypeRules])
    assert.ok(r.get(0)!.decl!.includes("payload: number[];"))
    assertCompiles(emitTSDeclarations(r))
})

////////////////////////////////////////////////////////////////////////////////////////////////
// List capacity ≤1 → optional field
////////////////////////////////////////////////////////////////////////////////////////////////

test("ts-alternative-rules: capacityOneListAsOptionalRule collapses a capacity-1 list to T | null", () => {
    const T = struct({maybe: list(integer(0, 255), 1)})
    const r = projectTSTypes(T, [capacityOneListAsOptionalRule, ...tsTypeRules])
    assert.ok(r.get(0)!.decl!.includes("maybe: number | null;"))
    assertCompiles(emitTSDeclarations(r))
})

test("ts-alternative-rules: capacityOneListAsOptionalRule doesn't claim a wider-capacity list", () => {
    const T = struct({items: list(integer(0, 255), 8)})
    const r = projectTSTypes(T, [capacityOneListAsOptionalRule, ...tsTypeRules])
    assert.ok(r.get(0)!.decl!.includes("items: number[];"))
    assertCompiles(emitTSDeclarations(r))
})

////////////////////////////////////////////////////////////////////////////////////////////////
// optional(T) → T | null
////////////////////////////////////////////////////////////////////////////////////////////////

test("ts-alternative-rules: optionalUnionRule maps optional(T) to T | null", () => {
    const T = struct({name: optional(integer(0, 255))})
    const r = projectTSTypes(T, [optionalUnionRule, ...tsTypeRules])
    assert.ok(r.get(0)!.decl!.includes("name: number | null;"))
    assertCompiles(emitTSDeclarations(r))
})

test("ts-alternative-rules: optionalUnionRule doesn't claim a general union, even a 2-variant one", () => {
    const T = named("Result", union({ok: integer(0, 255), err: integer(0, 1)}))
    const r = projectTSTypes(T, [optionalUnionRule, ...tsTypeRules])
    assert.ok(r.get(0)!.decl!.includes("type Result ="))
    assertCompiles(emitTSDeclarations(r))
})

////////////////////////////////////////////////////////////////////////////////////////////////
// General union → class hierarchy
////////////////////////////////////////////////////////////////////////////////////////////////

test("ts-alternative-rules: unionAsClassHierarchyRule emits an abstract base and one subclass per variant", () => {
    const T = named("Shape", union({circle: integer(0, 255), square: integer(0, 255)}))
    const r = projectTSTypes(T, [unionAsClassHierarchyRule, ...tsTypeRules])
    const decl = r.get(0)!.decl!
    assert.ok(decl.includes("abstract class Shape {}"))
    assert.ok(decl.includes("class Shape_Circle extends Shape"))
    assert.ok(decl.includes("class Shape_Square extends Shape"))
    assertCompiles(emitTSDeclarations(r))
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Struct → class
////////////////////////////////////////////////////////////////////////////////////////////////

test("ts-alternative-rules: structAsClassRule emits a constructor-based class instead of an interface", () => {
    const T = named("Point", struct({x: integer(0, 255), y: integer(0, 255)}))
    const r = projectTSTypes(T, [structAsClassRule, ...tsTypeRules])
    const decl = r.get(0)!.decl!
    assert.ok(decl.includes("class Point {"))
    assert.ok(decl.includes("constructor(readonly x: number, readonly y: number)"))
    assertCompiles(emitTSDeclarations(r))
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Composability: multiple alternatives together
////////////////////////////////////////////////////////////////////////////////////////////////

test("ts-alternative-rules: several alternatives compose together in one projection", () => {
    const T = named("Reading", struct({
        raw: list(integer(0, 255)),
        calibration: optional(integer(-100, 100)),
    }))
    const r = projectTSTypes(T, [byteListAsUint8ArrayRule, optionalUnionRule, ...tsTypeRules])
    const decl = r.get(0)!.decl!
    assert.ok(decl.includes("raw: Uint8Array;"))
    assert.ok(decl.includes("calibration: number | null;"))
    assertCompiles(emitTSDeclarations(r))
})
