/**
 * @ppl/codecs — Codec image container (docs/codec-image.md §7, ROADMAP.md
 * item 10)
 *
 * Three sections, concatenated with no framing between them at all — none
 * is needed, because each already knows its own length as it's produced:
 * the type tree (§6, self-framing via `END`), the encoder program, and the
 * decoder program (both via `@ppl/machine`'s item-8 program envelope,
 * self-framing via its own header table). Decode reads the three in order,
 * each consuming exactly its own bytes and handing back the next offset.
 *
 * Reconciliation (docs/codec-image.md §2/§3) — matching a received image's
 * type tree against a consumer's own, independently-built one — is not
 * implemented here; this module only round-trips the container itself.
 */

import type { SemanticType } from "@ppl/core"
import type { RtlProgram } from "@ppl/machine"
import { decodeProgram, encodeProgram } from "@ppl/machine"
import { codecWireCodec } from "./wire"
import { decodeTypeTree, encodeTypeTree } from "./type-tree-wire"
import type { CodecExtInstr } from "./codec-ext-instr"

export interface CodecImage
{
    readonly typeTree: SemanticType
    readonly encoderProgram: RtlProgram<CodecExtInstr>
    readonly decoderProgram: RtlProgram<CodecExtInstr>
}

const EXTENSION = { codec: codecWireCodec }

/** Encode a codec image (§7): type tree, then encoder program, then
 *  decoder program, concatenated. */
export function encodeCodecImage(image: CodecImage): Uint8Array
{
    return Uint8Array.from([
        ...encodeTypeTree(image.typeTree),
        ...encodeProgram(image.encoderProgram, EXTENSION),
        ...encodeProgram(image.decoderProgram, EXTENSION),
    ])
}

/** Decode a codec image (§7) — the mirror of `encodeCodecImage`, reading
 *  the three sections in order off each other's reported `next` offset. */
export function decodeCodecImage(bytes: Uint8Array): CodecImage
{
    const tree = decodeTypeTree(bytes, 0)
    const encoder = decodeProgram(bytes, tree.next, EXTENSION)
    const decoder = decodeProgram(bytes, encoder.next, EXTENSION)

    return { typeTree: tree.type, encoderProgram: encoder.program, decoderProgram: decoder.program }
}
