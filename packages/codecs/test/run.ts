/**
 * Test entry point for @ppl/codecs.
 * Run via: npm test (from this package) or npm test (from root)
 */
import "./wire-format.runtime.test"

import {test} from "node:test"
import * as assert from "node:assert/strict"

test("codecs: package loads without error", () =>
{
    // Verify the package is importable
    const {ir} = require("../src/ir-builder")
    assert.ok(typeof ir === "function")
})

test("codecs: TaggedUnionCodec exists", () =>
{
    const {TaggedUnionCodec} = require("../src/codecs")
    assert.ok(typeof TaggedUnionCodec.canHandle === "function")
    assert.ok(typeof TaggedUnionCodec.decode === "function")
})
