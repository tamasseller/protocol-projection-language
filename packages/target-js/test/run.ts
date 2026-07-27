import {test} from "node:test"
import * as assert from "node:assert/strict"

import {generateJsTypes, generateJsCodecs} from "../src/index"
import {struct, integer, named} from "@ppl/core"

test("target-js: generateJsTypes returns a non-empty string", () =>
{
    const T = named("Foo", struct({x: integer(0, 255)}))
    const result = generateJsTypes(T, "Foo")
    assert.ok(result.length > 0)
})

test("target-js: generateJsCodecs returns a non-empty string", () =>
{
    const T = named("Foo", struct({x: integer(0, 255)}))
    const result = generateJsCodecs(T, "Foo")
    assert.ok(result.length > 0)
})
