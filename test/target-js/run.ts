import {test} from "node:test"
import * as assert from "node:assert/strict"

import "./ts-emitter.runtime.test"
import "./ts-alternative-rules.runtime.test"
import "./codec-codegen.runtime.test"
import "./codec-codegen-alt-rules.runtime.test"
import "./binary-op-codegen.runtime.test"
import "./control-flow-codegen.runtime.test"
import "./bridging-codec.runtime.test"

import {generateJsTypes, generateJsCodecs} from "../../src/target-js/index"
import {struct, integer, named} from "../../src/core/index"

test("target-js: generateJsTypes emits a real interface (one-shot API)", () =>
{
    const T = named("Foo", struct({x: integer(0, 255)}))
    const result = generateJsTypes(T, "Foo")
    assert.ok(result.includes("interface Foo {"))
    assert.ok(result.includes("readonly x: number;"))
})

test("target-js: generateJsCodecs returns a non-empty string", () =>
{
    const T = named("Foo", struct({x: integer(0, 255)}))
    const result = generateJsCodecs(T, "Foo")
    assert.ok(result.length > 0)
})
