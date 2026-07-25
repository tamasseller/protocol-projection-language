/**
 * Runtime tests for Layer 0: the TypeGraph finitizer.
 *
 * Run via: npm test
 */
import {test} from "node:test"
import * as assert from "node:assert/strict"

import {integer, list, struct, union, unit} from "../src/metamodel"
import {buildTypeGraph, child, stepEquals, TypeNode} from "../src/type-graph"

////////////////////////////////////////////////////////////////////////////////////////////////
// Acyclic
////////////////////////////////////////////////////////////////////////////////////////////////

test("acyclic: struct of int+unit materializes as a 3-node tree", () => {
    const T = struct({a: integer(0, 1), b: unit})
    const g = buildTypeGraph(T)

    assert.equal(g.nodes.size, 3)
    assert.equal(g.root.id, 0)
    assert.equal(g.root.type.kind, "struct")

    const a = child(g.root, {field: "a"})
    const b = child(g.root, {field: "b"})
    assert.equal(a?.type.kind, "integer")
    assert.equal(b?.type.kind, "unit")
    // leaves have no edges
    assert.equal(a?.edges.length, 0)
    assert.equal(b?.edges.length, 0)
})

test("acyclic: list of int materializes root + 1 element node", () => {
    const T = list(integer(0, 255))
    const g = buildTypeGraph(T)

    assert.equal(g.nodes.size, 2)
    const el = child(g.root, {element: true})
    assert.equal(el?.type.kind, "integer")
})

test("acyclic: union materializes with variant edges", () => {
    const T = union({ok: integer(0, 1), err: unit})
    const g = buildTypeGraph(T)

    assert.equal(g.nodes.size, 3)
    assert.equal(child(g.root, {variant: "ok"})?.type.kind, "integer")
    assert.equal(child(g.root, {variant: "err"})?.type.kind, "unit")
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Simple loop (binary tree of booleans)
////////////////////////////////////////////////////////////////////////////////////////////////

test("simple loop: recursive T back-edges to root, finite node count", () => {
    // T = union({ internal: struct({ a: T, b: T }), leaf: integer(0,1) })
    //
    // Pass the THUNK itself (not T()) to buildTypeGraph: the thunk object
    // is the identity key, so all references to T within the tree back-edge
    // to the same TypeNode. Calling T() instead would mint a fresh body
    // object each deref, breaking sharing.
    const T = (): any => union({
        internal: struct({a: T, b: T}),
        leaf: integer(0, 1),
    })

    const g = buildTypeGraph(T)

    // 3 distinct type objects: T-thunk, the internal struct, the leaf integer.
    // (a and b both reference the SAME T thunk → one TypeNode.)
    assert.equal(g.nodes.size, 3)

    // root is the union (deref'd from T)
    assert.equal(g.root.type.kind, "union")

    const internal = child(g.root, {variant: "internal"})!
    assert.equal(internal.type.kind, "struct")

    const leaf = child(g.root, {variant: "leaf"})!
    assert.equal(leaf.type.kind, "integer")

    // a and b must both back-edge to the ROOT (the union), not new nodes.
    const a = child(internal, {field: "a"})!
    const b = child(internal, {field: "b"})!
    assert.equal(a.id, g.root.id, "a must back-edge to root")
    assert.equal(b.id, g.root.id, "b must back-edge to root")

    // No new nodes were created for a/b.
    assert.equal(g.nodes.size, 3)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Mutual recursion (A ↔ B)
////////////////////////////////////////////////////////////////////////////////////////////////

test("mutual recursion: A↔B finitizes to 2 nodes with back-edges", () => {
    // A = struct({ b: B })
    // B = struct({ a: A })
    // Pass thunks (not deref'd bodies) so the cycle closes cleanly.
    const A = (): any => struct({b: B})
    const B = (): any => struct({a: A})

    const g = buildTypeGraph(A)

    // 2 distinct type objects: A-thunk, B-thunk.
    assert.equal(g.nodes.size, 2)
    assert.equal(g.root.type.kind, "struct") // A (deref'd)

    const aNode = g.root
    const bNode = child(aNode, {field: "b"})!
    assert.equal(bNode.type.kind, "struct") // B (deref'd)
    assert.notEqual(bNode.id, aNode.id)

    // B's `a` field back-edges to A (the root).
    const backToA = child(bNode, {field: "a"})!
    assert.equal(backToA.id, aNode.id, "B.a must back-edge to A")
    assert.equal(g.nodes.size, 2, "no new nodes created for the cycle")
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Library fan-in (same thunk referenced from N sites)
////////////////////////////////////////////////////////////////////////////////////////////////

test("fan-in: shared library thunk referenced twice → one TypeNode", () => {
    // Library exports a shared Timestamp thunk.
    const Timestamp = (): any => struct({secs: integer(0, 4294967295), nanos: integer(0, 999999999)})

    // Two protocol layers both reference the SAME Timestamp thunk.
    const T = struct({
        createdAt: Timestamp,
        updatedAt: Timestamp,
    })

    const g = buildTypeGraph(T)

    // root struct + 2 field ints (secs, nanos) shared, since both Timestamp
    // references are the same thunk → ONE struct TypeNode, ONE secs node,
    // ONE nanos node. Total: 1 (root) + 1 (ts struct) + 2 (ints) = 4.
    assert.equal(g.nodes.size, 4)

    const created = child(g.root, {field: "createdAt"})!
    const updated = child(g.root, {field: "updatedAt"})!
    assert.equal(created.id, updated.id, "both Timestamp references → same TypeNode")
    assert.equal(created.type.kind, "struct")

    // The shared struct's children are shared too.
    const secsA = child(created, {field: "secs"})!
    const secsB = child(updated, {field: "secs"})!
    assert.equal(secsA.id, secsB.id, "shared children")
})

test("fan-in: distinct thunk instances (factory) → distinct TypeNodes", () => {
    // A factory mints fresh thunks each call.
    const makeOptional = (T: any) => (): any => union({value: T, empty: unit})

    const T = struct({
        a: makeOptional(integer(0, 1)),  // distinct thunk
        b: makeOptional(integer(0, 1)),  // distinct thunk (structurally identical)
    })

    const g = buildTypeGraph(T)

    // root (1) + a's optional union (1) + a's value int (1) + a's empty unit (1)
    //           + b's optional union (1) + b's value int (1)
    // b's empty unit → back-edge to a's (shared `unit` constant).
    // = 6. The two optionals are structurally identical but distinct objects
    // → distinct TypeNodes.
    assert.equal(g.nodes.size, 6)

    const aOpt = child(g.root, {field: "a"})!
    const bOpt = child(g.root, {field: "b"})!
    assert.notEqual(aOpt.id, bOpt.id, "distinct thunk instances → distinct TypeNodes")
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Node numbering / iteration order
////////////////////////////////////////////////////////////////////////////////////////////////

test("numbering: parents before children (DFS pre-order)", () => {
    const T = struct({a: struct({x: integer(0, 1)}), b: unit})
    const g = buildTypeGraph(T)

    const ids = [...g.nodes.keys()]
    // root (0) before its children; a (1) before a's child x (2); b (3) last.
    assert.deepEqual(ids, [0, 1, 2, 3])
    assert.equal(g.root.id, 0)
    const a = child(g.root, {field: "a"})!
    const x = child(a, {field: "x"})!
    const b = child(g.root, {field: "b"})!
    assert.equal(a.id, 1)
    assert.equal(x.id, 2)
    assert.equal(b.id, 3)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// stepEquals / child helpers
////////////////////////////////////////////////////////////////////////////////////////////////

test("stepEquals: field, variant, element", () => {
    assert.ok(stepEquals({field: "a"}, {field: "a"}))
    assert.ok(!stepEquals({field: "a"}, {field: "b"}))
    assert.ok(stepEquals({variant: "ok"}, {variant: "ok"}))
    assert.ok(!stepEquals({field: "ok"}, {variant: "ok"}))
    assert.ok(stepEquals({element: true}, {element: true}))
    assert.ok(!stepEquals({element: true}, {field: "x"}))
})

test("child: returns undefined for absent step", () => {
    const g = buildTypeGraph(struct({a: integer(0, 1)}))
    assert.equal(child(g.root, {field: "missing"}), undefined)
    assert.equal(child(g.root, {element: true}), undefined)
})
