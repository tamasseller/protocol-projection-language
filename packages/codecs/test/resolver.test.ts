/**
 * @ppl/codecs/test — createCodecResolver(): the one generic on-demand
 * SemanticType -> Procedure resolver both `buildCodec` (this same file,
 * engine/resolver.ts) and `buildJsonEncoder` (components/json.ts) are
 * built on top of.
 *
 * Deliberately independent of the codec extension's own opcodes — these
 * rules just return plain `ir` fragments computing ordinary values via
 * ordinary `CALL`s, proving the *driver* (pattern dispatch, on-demand
 * child resolution, memoization, cycle safety) on its own before either
 * real codec family depends on it.
 */
import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { u8, struct, list } from "@ppl/core"
import type { IntegerPattern } from "@ppl/core"
import { pInteger, pList, pStructFields, pStar } from "@ppl/core"
import { ir, lowerProgram, run, isCallInstr } from "@ppl/machine"

import { createCodecResolver, codecRule } from "../src/engine/resolver"

const integerRule = codecRule<IntegerPattern, undefined>(pInteger(-Infinity, Infinity), () => ir`return 1;`)

describe("createCodecResolver", () =>
{
    test("dispatches by pattern and resolves a child on demand", () =>
    {
        const listRule = codecRule(pList(pStar()), (match, ctx: undefined, resolve) =>
        {
            const elem = resolve(match.elementType, ctx)
            return ir`return ${elem}() + 10;`
        })

        const resolve = createCodecResolver([listRule, integerRule])
        const entry = resolve(list(u8), undefined)

        const result = run(lowerProgram(entry))
        assert.equal(result.ok, true)
        assert.equal(result.acc, 11) // element rule's 1 + list rule's +10
    })

    test("a type shared by two fields resolves to one Procedure, not two", () =>
    {
        const structRule = codecRule(pStructFields(pStar()), (match, ctx: undefined, resolve) =>
        {
            const a = resolve(match.fieldMatches[0]!.type, ctx)
            const b = resolve(match.fieldMatches[1]!.type, ctx)
            return ir`return ${a}() + ${b}();`
        })

        const resolve = createCodecResolver([structRule, integerRule])
        const entry = resolve(struct({ a: u8, b: u8 }), undefined) // `u8` is the same shared singleton

        const program = lowerProgram(entry)
        assert.equal(program.procedures.length, 2) // struct + one shared integer codec, not two
        assert.equal(run(program).acc, 2)
    })

    test("caller-supplied rules are tried before the defaults — a custom rule can win", () =>
    {
        const customRule = codecRule<IntegerPattern, undefined>(pInteger(-Infinity, Infinity), () => ir`return 99;`)

        const resolve = createCodecResolver([customRule, integerRule])
        const entry = resolve(u8, undefined)

        assert.equal(run(lowerProgram(entry)).acc, 99)
    })

    test("no matching rule throws a clear error instead of silently doing nothing", () =>
    {
        const resolve = createCodecResolver([integerRule])
        assert.throws(() => resolve(struct({ a: u8 }), undefined), /no rule matches/)
    })

    test("a self-referential recursive type resolves without looping forever", () =>
    {
        // A genuine self-reference — `self`'s field value patched in
        // *after* construction to be the very same `StructType` object,
        // not a `() => SemanticType` thunk pointing at an equal-but-distinct
        // one. buildTypeGraph's cycle-breaking (type-graph.ts:86-99) keys
        // on the exact object identity it's given at each position — a
        // thunk here would register under the *thunk's own* identity and
        // get a fresh TypeNode the first time through, only closing the
        // cycle one level down; patching the field directly makes
        // `fieldMatches[1].type` the *same* object as the root itself.
        const recType = struct({ depth: u8, self: u8 })
        recType.fields.set("self", recType)

        const structRule = codecRule(pStructFields(pStar()), (match, ctx: undefined, resolve) =>
        {
            const depth = resolve(match.fieldMatches[0]!.type, ctx)
            const self = resolve(match.fieldMatches[1]!.type, ctx) // resolves to `entry` itself, mid-construction
            return ir`return ${depth}() + ${self}();`
        })

        const resolve = createCodecResolver([structRule, integerRule])

        // Resolution itself (not execution — the resulting program calls
        // itself unconditionally, so running it would spin forever) must
        // terminate and produce a well-formed two-procedure program whose
        // struct procedure calls back into its own table index.
        const entry = resolve(recType, undefined)
        assert.equal(resolve(recType, undefined), entry) // memoized, even for the cyclic node

        const program = lowerProgram(entry)
        assert.equal(program.procedures.length, 2)
        const calleeIndices = program.procedures[0]!.body
            .filter(isCallInstr)
            .map(i => i.calleeIndex)
        assert.ok(calleeIndices.includes(0)) // one of the two calls is back into its own (entry's) table slot
    })
})
