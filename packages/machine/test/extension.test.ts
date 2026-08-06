/**
 * @ppl/machine/test — Generic extension hook (ROADMAP.md item 6)
 *
 * Exercises the `Extension` object threaded through every core stage using
 * a toy opcode, `double(x)` → `EXT DOUBLE_REG [regIndex]`: doubles a local
 * variable's value into `acc`. Not a real extension (that's the codec
 * extension, ROADMAP.md item 7, docs/codec-extension.md) — just
 * enough to prove the hook itself works end to end, and that every stage
 * still behaves exactly as before when no extension is registered.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { ir, proc } from "../src/ir"
import { lowerProgram } from "../src/lower"
import { validateProgram } from "../src/validate"
import { run } from "../src/vm"
import { encodeInstr, encodeBody, decodeBody, encodeLeb128, decodeLeb128 } from "../src/bytecode"
import { rule, leafNode } from "../src/rules"
import { pBuiltinCall, pIdentifier } from "../src/matcher"
import { extInstr, bare } from "../src/rtl"
import type { RtlProgram } from "../src/rtl"
import type { Extension } from "../src/extension"

function doubleExtension(): Extension
{
    return {
        rules: resolveLocal => [
            rule("ext:double", pBuiltinCall("double", pIdentifier()), m =>
                leafNode(["acc"], [extInstr("DOUBLE_REG", [resolveLocal(m.argumentMatch.name)])], [], 0, 0)),
        ],
        effects: { DOUBLE_REG: { tosDelta: 0, maxTransient: 0 } },
        exec: (instr, state) => { state.acc = (state.reg(instr.operands[0]!) * 2) >>> 0 },
        codec: {
            encode: instr => [128, ...encodeLeb128(instr.operands[0]!)],
            decode: (bytes, offset) =>
            {
                const r = decodeLeb128(bytes, offset + 1)
                return { instr: extInstr("DOUBLE_REG", [r.value]), next: r.next }
            },
        },
    }
}

describe("extension hook — end to end via a toy `double(x)` opcode", () =>
{
    test("lowers through the DSL, validates, and executes", () =>
    {
        const ext = doubleExtension()
        const entry = proc([], ir`u32 x = 21; return double(x);`)

        const program = lowerProgram(entry, ext)
        const stats = validateProgram(program, ext)
        assert.equal(stats.procedures.length, 1)

        const result = run(program, ext)
        assert.equal(result.ok, true)
        assert.equal(result.acc, 42)
    })

    test("round-trips through the wire codec", () =>
    {
        const ext = doubleExtension()
        const instr = extInstr("DOUBLE_REG", [3])

        const bytes = encodeBody([instr], ext)
        assert.deepEqual([...bytes], [128, 3])
        assert.deepEqual(decodeBody(bytes, ext), [instr])
    })
})

describe("extension hook — absent extension leaves every stage unaffected", () =>
{
    test("an EXT instruction with no matching effect declaration is rejected by the validator", () =>
    {
        const program: RtlProgram = { procedures: [{ argCount: 0, body: [extInstr("UNKNOWN", []), bare("RETURN")] }] }
        assert.throws(() => validateProgram(program), /no effect declaration registered/)
    })

    test("an EXT instruction with no registered exec throws at VM runtime", () =>
    {
        const program: RtlProgram = { procedures: [{ argCount: 0, body: [extInstr("DOUBLE_REG", [0]), bare("RETURN")] }] }
        assert.throws(() => run(program), /no extension registered to execute it/)
    })

    test("encoding an EXT instruction with no registered codec throws", () =>
    {
        assert.throws(() => encodeInstr(extInstr("DOUBLE_REG", [0])), /no registered extension codec/)
    })

    test("decoding an extension opcode byte with no registered codec throws", () =>
    {
        assert.throws(() => decodeBody(Uint8Array.from([128, 3])), /no extension mechanism registered/)
    })
})

describe("Procedure/RtlProc header — opaque data, untouched by the core", () =>
{
    test("carried through lowering unchanged", () =>
    {
        const header = { abiKind: "CODEC_ENCODER" }
        const entry = proc([], ir`return 1;`, header)

        const program = lowerProgram(entry)
        assert.equal(program.procedures[0]!.header, header)
    })
})
