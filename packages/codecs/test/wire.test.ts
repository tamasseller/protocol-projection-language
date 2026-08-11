/**
 * @ppl/codecs/test — Wire-level encoding for the codec extension's opcodes
 * (engine/wire.ts, docs/codec-extension.md §6, ROADMAP.md item 7)
 *
 * Mirrors `@ppl/machine/test/bytecode.test.ts`'s own two-pronged approach:
 * a literal table of representative bytes (one row per band variant —
 * compact and extended, at each variant's own boundary), plus an
 * end-to-end round trip through a real, lowered codec program's
 * `encodeBody`/`decodeBody`.
 */

import { describe, test } from "node:test"
import assert from "node:assert/strict"

import { extInstr, encodeInstr, decodeInstr, encodeBody, decodeBody } from "@ppl/machine"
import type { ExtInstr, Extension } from "@ppl/machine"
import { struct, union, unit, u8, list } from "@ppl/core"

import { codecWireCodec } from "../src/engine/wire"
import { buildCodec } from "../src/engine/resolver"
import { binaryEncodeRules } from "../src/components/binary-rules"

const ext: Extension = { codec: codecWireCodec }

interface Row { byte: number; instr: ExtInstr }

const rows: Row[] = [
    // ENTER dst, src, ref — compact: src*4+ref, base 128
    { byte: 128, instr: extInstr("ENTER", [1, 0, 0]) },       // src=0 ref=0 dst=1
    { byte: 143, instr: extInstr("ENTER", [4, 3, 3]) },       // src=3 ref=3 dst=4
    { byte: 144, instr: extInstr("ENTER", [5, 0, 0]) },       // dst != src+1 -> extended
    { byte: 144, instr: extInstr("ENTER", [5, 4, 0]) },       // src >= SMALL -> extended

    // ENTER_NEXT dst, src — base 145
    { byte: 145, instr: extInstr("ENTER_NEXT", [1, 0]) },
    { byte: 148, instr: extInstr("ENTER_NEXT", [4, 3]) },
    { byte: 149, instr: extInstr("ENTER_NEXT", [5, 0]) },     // dst != src+1

    // LOAD_VAL src — base 150
    { byte: 150, instr: extInstr("LOAD_VAL", [0]) },
    { byte: 153, instr: extInstr("LOAD_VAL", [3]) },
    { byte: 154, instr: extInstr("LOAD_VAL", [4]) },

    // STORE_VAL src — base 155
    { byte: 155, instr: extInstr("STORE_VAL", [0]) },
    { byte: 159, instr: extInstr("STORE_VAL", [4]) },

    // COUNT src — base 160
    { byte: 160, instr: extInstr("COUNT", [0]) },
    { byte: 164, instr: extInstr("COUNT", [4]) },

    // TAG src — base 165
    { byte: 165, instr: extInstr("TAG", [0]) },
    { byte: 169, instr: extInstr("TAG", [4]) },

    // OPEN_LIST src — base 170
    { byte: 170, instr: extInstr("OPEN_LIST", [0]) },
    { byte: 174, instr: extInstr("OPEN_LIST", [4]) },

    // READ iter, width — base 175, compact = iter*3+widthIdx
    { byte: 175, instr: extInstr("READ", [0, 1]) },
    { byte: 186, instr: extInstr("READ", [3, 4]) },
    { byte: 187, instr: extInstr("READ", [4, 1]) },
    { byte: 189, instr: extInstr("READ", [4, 4]) },

    // WRITE iter, width — base 190
    { byte: 190, instr: extInstr("WRITE", [0, 1]) },
    { byte: 201, instr: extInstr("WRITE", [3, 4]) },
    { byte: 202, instr: extInstr("WRITE", [4, 1]) },
    { byte: 204, instr: extInstr("WRITE", [4, 4]) },

    // HAS_NEXT iter — base 205
    { byte: 205, instr: extInstr("HAS_NEXT", [0]) },
    { byte: 209, instr: extInstr("HAS_NEXT", [4]) },

    // CLONE_RD src, dst — base 210
    { byte: 210, instr: extInstr("CLONE_RD", [0, 1]) },
    { byte: 213, instr: extInstr("CLONE_RD", [3, 4]) },
    { byte: 214, instr: extInstr("CLONE_RD", [0, 5]) },       // dst != src+1

    // CLONE_WR src, dst — base 215
    { byte: 215, instr: extInstr("CLONE_WR", [0, 1]) },
    { byte: 219, instr: extInstr("CLONE_WR", [0, 5]) },

    // SEEK iter, delta — base 220
    { byte: 220, instr: extInstr("SEEK", [0, 5]) },
    { byte: 223, instr: extInstr("SEEK", [3, -1]) },
    { byte: 224, instr: extInstr("SEEK", [4, 0]) },

    // CALL_CODEC codec_idx, src, ref — base 225, compact = src*4+ref
    { byte: 225, instr: extInstr("CALL_CODEC", [7, 0, 0]) },
    { byte: 240, instr: extInstr("CALL_CODEC", [0, 3, 3]) },
    { byte: 241, instr: extInstr("CALL_CODEC", [7, 4, 0]) },

    // CALL_CODEC_NEXT codec_idx, src — base 242
    { byte: 242, instr: extInstr("CALL_CODEC_NEXT", [9, 0]) },
    { byte: 245, instr: extInstr("CALL_CODEC_NEXT", [9, 3]) },
    { byte: 246, instr: extInstr("CALL_CODEC_NEXT", [9, 4]) },

    // WRITE_SEQ iter, handle, width — base 247, one code per width
    // (ROADMAP.md item 11): iter/handle always LEB128'd, never a compact
    // index form (this file's own header explains why). No `count`
    // operand — it's a trailing pRtl("acc") DSL demand, read from `acc`
    // at runtime, never part of the instruction itself.
    { byte: 247, instr: extInstr("WRITE_SEQ", [0, 1, 1]) },
    { byte: 248, instr: extInstr("WRITE_SEQ", [0, 1, 2]) },
    { byte: 249, instr: extInstr("WRITE_SEQ", [0, 1, 4]) },

    // READ_SEQ iter, handle, width, signed — base 250, one code per
    // (width, signed) pair. Same no-`count`-operand reasoning as WRITE_SEQ.
    { byte: 250, instr: extInstr("READ_SEQ", [0, 1, 1, 0]) },
    { byte: 251, instr: extInstr("READ_SEQ", [0, 1, 1, 1]) },
    { byte: 252, instr: extInstr("READ_SEQ", [0, 1, 2, 0]) },
    { byte: 253, instr: extInstr("READ_SEQ", [0, 1, 2, 1]) },
    { byte: 254, instr: extInstr("READ_SEQ", [0, 1, 4, 0]) },
    { byte: 255, instr: extInstr("READ_SEQ", [0, 1, 4, 1]) },
]

describe("wire.ts — representative byte table", () =>
{
    test("every row's first encoded byte matches its assigned opcode", () =>
    {
        for (const { byte, instr } of rows)
        {
            const encoded = encodeInstr(instr, ext)
            assert.equal(encoded[0], byte,
                `${JSON.stringify(instr)}: expected first byte ${byte}, got ${encoded[0]}`)
        }
    })

    test("every row round-trips through decode", () =>
    {
        for (const { byte, instr } of rows)
        {
            const encoded = encodeInstr(instr, ext)
            const { instr: decoded, next } = decodeInstr(Uint8Array.from(encoded), 0, ext)
            assert.deepEqual(decoded, instr, `byte ${byte}: decode(encode(x)) !== x`)
            assert.equal(next, encoded.length, `byte ${byte}: decode didn't consume the whole instruction`)
        }
    })
})

describe("wire.ts — opcode-space budget", () =>
{
    test("all 128 codes assigned (bytes 128..255) — WRITE_SEQ/READ_SEQ (item 11) fill the budget exactly", () =>
    {
        for (let b = 128; b <= 255; b++)
            assert.doesNotThrow(() => decodeInstr(Uint8Array.of(b, 0, 0, 0, 0, 0), 0, ext), `byte ${b} should decode`)
    })
})

describe("wire.ts — SEEK's signed delta", () =>
{
    test("round-trips across zero, small positive, and small negative", () =>
    {
        for (const delta of [0, 1, -1, 127, -127, 1000, -1000])
        {
            const encoded = encodeInstr(extInstr("SEEK", [0, delta]), ext)
            const { instr } = decodeInstr(Uint8Array.from(encoded), 0, ext)
            assert.deepEqual(instr, extInstr("SEEK", [0, delta]), `delta=${delta}`)
        }
    })
})

describe("wire.ts — end-to-end: a real lowered codec program round-trips", () =>
{
    test("struct + list + union body encodes and decodes back to the same instructions", () =>
    {
        // Exercises ENTER (hoisted union tag gather), TAG, CALL_CODEC (per
        // field), CALL_CODEC_NEXT (list elements), WRITE/LOAD_VAL (the
        // shared integer leaf codec) — everything binary-rules.ts's default
        // encode path actually emits.
        const flag = union({ on: unit, off: unit })
        const elem = struct({ flag, value: u8 })
        const root = struct({ id: u8, items: list(elem) })

        const program = buildCodec(root, binaryEncodeRules, undefined)
        // Confirm this program actually reaches every opcode family this
        // test exists to cover — a program that happened to skip one would
        // make the round-trip below vacuously pass for it.
        const allOps = new Set(program.procedures.flatMap(p => p.body.filter(i => i.op === "EXT").map(i => (i as ExtInstr).ext)))
        for (const op of ["ENTER", "TAG", "CALL_CODEC", "CALL_CODEC_NEXT", "WRITE", "LOAD_VAL"])
            assert.ok(allOps.has(op), `expected the test schema to exercise ${op}`)

        for (const proc of program.procedures)
        {
            const bytes = encodeBody(proc.body, ext)
            const decoded = decodeBody(bytes, ext)
            assert.deepEqual(decoded, proc.body)
        }
    })
})
