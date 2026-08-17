/**
 * @ppl/core/test — Reconciliation (../src/reconcile.ts, docs/codec-
 * image.md §2/§3/§2.4, ROADMAP.md item 11)
 *
 * Covers `reconcile()`'s structural walk (matched/image-only/local-only,
 * kind-mismatch rejection, cycle safety on either side, and the sibling-
 * sharing case that proves names live on the edge, not the node) and
 * `resolve()`'s direction-aware interpretation of it — all eight §3 rule
 * cells from §2.4's table, including the two "unreachable" ones a union's
 * own selection mechanism rules out structurally.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import type { TypeNode } from "../src/type-graph"
import { buildTypeGraph } from "../src/type-graph"
import { struct, union, unit, u8, u16, integer, list, named, defaultValueOf } from "../src/metamodel"

import { reconcile, resolve } from "../src/reconcile"
import type { Correspondence, CorrespondenceEdge } from "../src/reconcile"

const root = (t: Parameters<typeof buildTypeGraph>[0]): TypeNode => buildTypeGraph(t).root

function edgeOf(c: Correspondence, name: string): CorrespondenceEdge
{
    const e = c.children?.find(ch => ch.name === name)
    if(!e) throw new Error(`no child named "${name}"`)
    return e
}

describe("reconcile(): matched trees", () =>
{
    test("identical struct — every field matched", () =>
    {
        const image = root(struct({ a: u8, b: unit }))
        const local = root(struct({ a: u8, b: unit }))
        const c = reconcile(image, local)

        assert.equal(c.outcome, "matched")
        assert.equal(edgeOf(c, "a").correspondence.outcome, "matched")
        assert.equal(edgeOf(c, "b").correspondence.outcome, "matched")
    })

    test("matched list recurses into its one element edge", () =>
    {
        const image = root(list(u8))
        const local = root(list(u8))
        const c = reconcile(image, local)

        assert.equal(c.outcome, "matched")
        assert.equal(c.element?.outcome, "matched")
    })

    test("matched union — every variant matched", () =>
    {
        const image = root(union({ on: unit, off: unit }))
        const local = root(union({ on: unit, off: unit }))
        const c = reconcile(image, local)

        assert.equal(edgeOf(c, "on").correspondence.outcome, "matched")
        assert.equal(edgeOf(c, "off").correspondence.outcome, "matched")
    })
})

describe("reconcile(): kind mismatch is rejected (§2.2)", () =>
{
    test("an integer field becoming a struct throws", () =>
    {
        const image = root(struct({ a: u8 }))
        const local = root(struct({ a: struct({ x: u8 }) }))
        assert.throws(() => reconcile(image, local), /kind mismatch/)
    })

    test("root kind mismatch throws", () =>
    {
        assert.throws(() => reconcile(root(u8), root(unit)), /kind mismatch/)
    })
})

describe("reconcile(): struct field divergence", () =>
{
    test("a field only in the image is image-only", () =>
    {
        const image = root(struct({ a: u8, extra: u8 }))
        const local = root(struct({ a: u8 }))
        const c = reconcile(image, local)

        assert.equal(edgeOf(c, "a").correspondence.outcome, "matched")
        const extra = edgeOf(c, "extra").correspondence
        assert.equal(extra.outcome, "image-only")
        assert.equal(extra.localNode, undefined)
        assert.ok(extra.imageNode)
    })

    test("a field only in the local tree is local-only", () =>
    {
        const image = root(struct({ a: u8 }))
        const local = root(struct({ a: u8, extra: u8 }))
        const c = reconcile(image, local)

        const extra = edgeOf(c, "extra").correspondence
        assert.equal(extra.outcome, "local-only")
        assert.equal(extra.imageNode, undefined)
        assert.ok(extra.localNode)
    })

    test("an image-only subtree recurses entirely as image-only, not just its own top node", () =>
    {
        const image = root(struct({ nested: struct({ deep: u8 }) }))
        const local = root(struct({}))
        const c = reconcile(image, local)

        const nested = edgeOf(c, "nested").correspondence
        assert.equal(nested.outcome, "image-only")
        assert.equal(edgeOf(nested, "deep").correspondence.outcome, "image-only")
    })
})

describe("reconcile(): sibling positions sharing the same underlying type object", () =>
{
    test("two fields, both missing locally, both typed as the same shared constant, get distinct edges but the same shared node", () =>
    {
        // Names live on the edge, not the node (this file's own header) —
        // so sharing the target Correspondence across two positions is
        // correct, not a bug, as long as each position's own edge.name
        // is right.
        const image = root(struct({ first: u16, second: u16 }))
        const local = root(struct({}))
        const c = reconcile(image, local)

        const first = edgeOf(c, "first")
        const second = edgeOf(c, "second")
        assert.equal(first.name, "first")
        assert.equal(second.name, "second")
        assert.equal(first.correspondence, second.correspondence) // same shared Correspondence...
        assert.equal(first.correspondence.imageNode, second.correspondence.imageNode) // ...same shared TypeNode
    })
})

describe("reconcile(): cycle safety", () =>
{
    test("a local-only self-referential struct terminates, closing the loop back onto its own ancestor", () =>
    {
        const LocalNode: any = named("LocalNode", (): any => struct({ next: LocalNode, val: u8 }))
        const image = root(struct({}))
        const local = root(struct({ head: LocalNode }))
        const c = reconcile(image, local)

        const head = edgeOf(c, "head").correspondence
        assert.equal(head.outcome, "local-only")
        // `next` is the exact same (image=absent, local=LocalNode) pair as
        // `head` itself — a genuine cycle, so it's the same object, not an
        // infinite recursion.
        assert.equal(edgeOf(head, "next").correspondence, head)
        // A sibling, non-recursive field still gets its own, ordinary leaf.
        const val = edgeOf(head, "val").correspondence
        assert.equal(val.outcome, "local-only")
        assert.notEqual(val, head)
    })

    test("mutually-recursive image and local trees of the same shape reconcile without looping", () =>
    {
        const ImageNode: any = named("Node", (): any => union({ leaf: u8, branch: struct({ l: ImageNode, r: ImageNode }) }))
        const LocalNode: any = named("Node", (): any => union({ leaf: u8, branch: struct({ l: LocalNode, r: LocalNode }) }))
        const c = reconcile(root(ImageNode), root(LocalNode))

        assert.equal(c.outcome, "matched")
        const branch = edgeOf(c, "branch").correspondence
        assert.equal(branch.outcome, "matched")
        // `l`/`r` are the exact same (ImageNode, LocalNode) pair as the
        // root itself — the cycle closes back onto the root Correspondence
        // rather than recursing forever.
        assert.equal(edgeOf(branch, "l").correspondence, c)
        assert.equal(edgeOf(branch, "r").correspondence, c)
    })
})

describe("resolve(): struct field — all four cells are real (§2.4 table)", () =>
{
    test("image-only field, decode → drop (§3.2)", () =>
    {
        const c = reconcile(root(struct({ extra: u8 })), root(struct({})))
        assert.deepEqual(resolve(c, edgeOf(c, "extra"), "decode"), { action: "drop" })
    })

    test("image-only field, encode → default from the image (§3.3)", () =>
    {
        const c = reconcile(root(struct({ extra: integer(0, 255, 7) })), root(struct({})))
        assert.deepEqual(resolve(c, edgeOf(c, "extra"), "encode"), { action: "default", value: 7 })
    })

    test("local-only field, decode → default from local (§3.1)", () =>
    {
        const c = reconcile(root(struct({})), root(struct({ extra: integer(0, 255, 9) })))
        assert.deepEqual(resolve(c, edgeOf(c, "extra"), "decode"), { action: "default", value: 9 })
    })

    test("local-only field, encode → drop (§3.4, additive)", () =>
    {
        const c = reconcile(root(struct({})), root(struct({ extra: u8 })))
        assert.deepEqual(resolve(c, edgeOf(c, "extra"), "encode"), { action: "drop" })
    })

    test("matched field → bridge, both directions", () =>
    {
        const c = reconcile(root(struct({ a: u8 })), root(struct({ a: u8 })))
        assert.deepEqual(resolve(c, edgeOf(c, "a"), "encode"), { action: "bridge" })
        assert.deepEqual(resolve(c, edgeOf(c, "a"), "decode"), { action: "bridge" })
    })

    test("resolve throws if parent isn't matched", () =>
    {
        const image = root(struct({ nested: struct({ deep: u8 }) }))
        const local = root(struct({}))
        const c = reconcile(image, local)
        const nested = edgeOf(c, "nested").correspondence // itself image-only
        assert.throws(() => resolve(nested, edgeOf(nested, "deep"), "decode"), /parent must be a matched correspondence/)
    })
})

describe("resolve(): union variant — only two of four cells are reachable (§2.4 table)", () =>
{
    test("image-only variant, decode, local declares a default variant → default (§3.2)", () =>
    {
        const image = root(struct({ tag: union({ known: unit, extra: unit }) }))
        const local = root(struct({ tag: union({ known: unit, unrecognized: unit }, "unrecognized") }))
        const tag = edgeOf(reconcile(image, local), "tag").correspondence

        assert.equal(edgeOf(tag, "extra").correspondence.outcome, "image-only")
        assert.deepEqual(resolve(tag, edgeOf(tag, "extra"), "decode"), { action: "default", value: defaultValueOf(tag.localNode!.type) })
    })

    test("image-only variant, decode, local declares NO default variant → trap (§3.2)", () =>
    {
        const image = root(struct({ tag: union({ known: unit, extra: unit }) }))
        const local = root(struct({ tag: union({ known: unit }) }))
        const tag = edgeOf(reconcile(image, local), "tag").correspondence

        const r = resolve(tag, edgeOf(tag, "extra"), "decode")
        assert.equal(r.action, "trap")
    })

    test("image-only variant, encode → unreachable (encode can never produce a variant local doesn't have)", () =>
    {
        const image = root(struct({ tag: union({ known: unit, extra: unit }) }))
        const local = root(struct({ tag: union({ known: unit }) }))
        const tag = edgeOf(reconcile(image, local), "tag").correspondence

        assert.deepEqual(resolve(tag, edgeOf(tag, "extra"), "encode"), { action: "unreachable" })
    })

    test("local-only variant, encode → trap, no wire representation (§3.4)", () =>
    {
        const image = root(struct({ tag: union({ known: unit }) }))
        const local = root(struct({ tag: union({ known: unit, extra: unit }) }))
        const tag = edgeOf(reconcile(image, local), "tag").correspondence

        const r = resolve(tag, edgeOf(tag, "extra"), "encode")
        assert.equal(r.action, "trap")
    })

    test("local-only variant, decode → unreachable (the wire tag space never selects it)", () =>
    {
        const image = root(struct({ tag: union({ known: unit }) }))
        const local = root(struct({ tag: union({ known: unit, extra: unit }) }))
        const tag = edgeOf(reconcile(image, local), "tag").correspondence

        assert.deepEqual(resolve(tag, edgeOf(tag, "extra"), "decode"), { action: "unreachable" })
    })

    test("matched variant → bridge, both directions", () =>
    {
        const tag = edgeOf(reconcile(root(struct({ tag: union({ a: unit }) })), root(struct({ tag: union({ a: unit }) }))), "tag").correspondence
        assert.deepEqual(resolve(tag, edgeOf(tag, "a"), "encode"), { action: "bridge" })
        assert.deepEqual(resolve(tag, edgeOf(tag, "a"), "decode"), { action: "bridge" })
    })
})
