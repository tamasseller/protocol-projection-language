/**
 * codecs — The codec extension's structured `EXT` instruction shape
 *
 * `RtlInstr<E>`'s (`mog-core`'s rtl.ts) `EXT` arm is parameterized by
 * `E` precisely so a concrete extension can replace the generic
 * `{ext, operands: readonly number[]}` payload with named fields — this is
 * that payload for the codec extension: one variant per `CodecOpcode`
 * (`opcodes.ts`), discriminated on `ext` exactly like `CodecOpcode` itself,
 * with each opcode's operands given real names instead of positional
 * indices into a flat array.
 *
 * Every consumer reads a named field type-checked against this one
 * declaration, so a typo or a reordered field is a compile error at the
 * read site rather than a silent mismatch with the construction site.
 *
 * `READ_SEQ`'s `signed` is a real `boolean` here (the wire/DSL level still
 * only ever has a `0`/`1` literal, per `codecRules()`'s `pConst()` — the
 * `readSeqInstr` constructor below does the one coercion, once, instead of
 * every consumer independently re-deriving it via `!!operands[3]`).
 */

import type { ExtInstrOf } from "mog-core"

export type CodecExtInstr =
    | { ext: "ENTER"; dst: number; src: number; ref: number }
    | { ext: "ENTER_NEXT"; dst: number; src: number }
    | { ext: "LOAD_VAL"; src: number }
    | { ext: "STORE_VAL"; src: number }
    | { ext: "COUNT"; src: number }
    | { ext: "TAG"; src: number }
    | { ext: "OPEN_LIST"; src: number }
    | { ext: "READ"; iter: number; width: number }
    | { ext: "WRITE"; iter: number; width: number }
    | { ext: "HAS_NEXT"; iter: number }
    | { ext: "CLONE_RD"; src: number; dst: number }
    | { ext: "CLONE_WR"; src: number; dst: number }
    | { ext: "SEEK"; iter: number; delta: number }
    | { ext: "CALL_CODEC"; calleeIndex: number; src: number; ref: number }
    | { ext: "CALL_CODEC_NEXT"; calleeIndex: number; src: number }
    | { ext: "WRITE_SEQ"; iter: number; handle: number; width: number }
    | { ext: "READ_SEQ"; iter: number; handle: number; width: number; signed: boolean }

export const enterInstr = (dst: number, src: number, ref: number): ExtInstrOf<CodecExtInstr> =>
    ({ op: "EXT", ext: "ENTER", dst, src, ref })

export const enterNextInstr = (dst: number, src: number): ExtInstrOf<CodecExtInstr> =>
    ({ op: "EXT", ext: "ENTER_NEXT", dst, src })

export const loadValInstr = (src: number): ExtInstrOf<CodecExtInstr> =>
    ({ op: "EXT", ext: "LOAD_VAL", src })

export const storeValInstr = (src: number): ExtInstrOf<CodecExtInstr> =>
    ({ op: "EXT", ext: "STORE_VAL", src })

export const countInstr = (src: number): ExtInstrOf<CodecExtInstr> =>
    ({ op: "EXT", ext: "COUNT", src })

export const tagInstr = (src: number): ExtInstrOf<CodecExtInstr> =>
    ({ op: "EXT", ext: "TAG", src })

export const openListInstr = (src: number): ExtInstrOf<CodecExtInstr> =>
    ({ op: "EXT", ext: "OPEN_LIST", src })

export const readInstr = (iter: number, width: number): ExtInstrOf<CodecExtInstr> =>
    ({ op: "EXT", ext: "READ", iter, width })

export const writeInstr = (iter: number, width: number): ExtInstrOf<CodecExtInstr> =>
    ({ op: "EXT", ext: "WRITE", iter, width })

export const hasNextInstr = (iter: number): ExtInstrOf<CodecExtInstr> =>
    ({ op: "EXT", ext: "HAS_NEXT", iter })

export const cloneRdInstr = (src: number, dst: number): ExtInstrOf<CodecExtInstr> =>
    ({ op: "EXT", ext: "CLONE_RD", src, dst })

export const cloneWrInstr = (src: number, dst: number): ExtInstrOf<CodecExtInstr> =>
    ({ op: "EXT", ext: "CLONE_WR", src, dst })

export const seekInstr = (iter: number, delta: number): ExtInstrOf<CodecExtInstr> =>
    ({ op: "EXT", ext: "SEEK", iter, delta })

export const callCodecInstr = (calleeIndex: number, src: number, ref: number): ExtInstrOf<CodecExtInstr> =>
    ({ op: "EXT", ext: "CALL_CODEC", calleeIndex, src, ref })

export const callCodecNextInstr = (calleeIndex: number, src: number): ExtInstrOf<CodecExtInstr> =>
    ({ op: "EXT", ext: "CALL_CODEC_NEXT", calleeIndex, src })

export const writeSeqInstr = (iter: number, handle: number, width: number): ExtInstrOf<CodecExtInstr> =>
    ({ op: "EXT", ext: "WRITE_SEQ", iter, handle, width })

export const readSeqInstr = (iter: number, handle: number, width: number, signed: number | boolean): ExtInstrOf<CodecExtInstr> =>
    ({ op: "EXT", ext: "READ_SEQ", iter, handle, width, signed: !!signed })
