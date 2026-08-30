/**
 * @ppl/machine — the jit-armv6m target's own wire wrapper.
 *
 * A bare-metal JIT target needs two whole-program stats — `max_call_depth`,
 * `total_depth` — before it can compile a single instruction, to size its
 * static stack reservation (jit-armv6m/docs/design.md §2): unlike anything
 * else the core spec covers, it can't discover a stack-overflow risk at
 * runtime and recover from it, so the bound has to be known up front. That is
 * the extension point isa-core.md §5.5/§11.4 already describes for a
 * procedure header's own fields ("added when a real need appears") — except
 * whole-program, so it prepends the plain `encodeProgram` blob rather than
 * threading through each procedure's own header.
 *
 * On top of that the target adds a two-byte frame, binding a program to the
 * validator that produced it (design.md §1.1). Everything here is specific to
 * that target; isa-core.md §5.5's own format carries none of it.
 */
import { encodeLeb128, decodeLeb128, encodeProgram, decodeProgram } from "./bytecode"
import { validateProgram } from "./validate"
import type { RtlProgram, ExtOpPayload } from "./rtl"
import type { Extension } from "./extension"

/** Bump when the wire contract changes: an older producer's programs then
 *  stop verifying instead of being misread. Mirrors
 *  jit-armv6m/src/runtime/program_frame.h. */
export const PROGRAM_CONTRACT_VERSION = 1

export const PROGRAM_FRAME_BYTES = 2

const FRAME_SEED = (0x811c9dc5 ^ PROGRAM_CONTRACT_VERSION) >>> 0

/** FNV-1a folded rather than truncated: the prime is odd, so bit 0 survives
 *  every multiply and the raw low half is little more than a parity. */
export function programFrameHash(bytes: Uint8Array, len: number = bytes.length): number
{
    let h = FRAME_SEED
    for(let i = 0; i < len; i++)
    {
        // Math.imul, not `*`: the product leaves float precision behind.
        h = Math.imul(h ^ bytes[i], 0x01000193) >>> 0
    }
    return ((h >>> 16) ^ (h & 0xffff)) & 0xffff
}

/** Prepend `max_call_depth`/`total_depth` (`validateProgram`) to an ordinary
 *  `encodeProgram` blob. Unframed — the fuzz corpus is raw mutation fodder and
 *  the oracle's own length gates are stated against this shape. */
export function encodeJitEnvelope<E extends { ext: string } = ExtOpPayload>(program: RtlProgram<E>, extension?: Extension<E>): Uint8Array
{
    const { maxCallDepth, totalDepth } = validateProgram(program, extension)
    return Uint8Array.from([
        ...encodeLeb128(maxCallDepth),
        ...encodeLeb128(totalDepth),
        ...encodeProgram(program, extension),
    ])
}

/** Inverse of `encodeJitEnvelope`. jit-armv6m's own C++ side has its own
 *  decoder for this (it never runs TS); this exists for round-tripping on this
 *  side, mirroring `decodeProgram`'s own `next`-reporting convention. */
export function decodeJitEnvelope<E extends { ext: string } = ExtOpPayload>(bytes: Uint8Array, offset: number = 0, extension?: Extension<E>):
    { maxCallDepth: number; totalDepth: number; program: RtlProgram<E>; next: number }
{
    const maxCallDepthR = decodeLeb128(bytes, offset)
    const totalDepthR = decodeLeb128(bytes, maxCallDepthR.next)
    const { program, next } = decodeProgram(bytes, totalDepthR.next, extension)
    return { maxCallDepth: maxCallDepthR.value, totalDepth: totalDepthR.value, program, next }
}

/** The envelope plus its frame — the one real production path for a flashable
 *  jit-armv6m image, and the only shape `Executor::run` accepts. */
export function encodeJitProgram<E extends { ext: string } = ExtOpPayload>(program: RtlProgram<E>, extension?: Extension<E>): Uint8Array
{
    const payload = encodeJitEnvelope(program, extension)
    const framed = new Uint8Array(payload.length + PROGRAM_FRAME_BYTES)
    framed.set(payload)

    const frame = programFrameHash(payload)
    framed[payload.length] = frame & 0xff
    framed[payload.length + 1] = (frame >>> 8) & 0xff

    return framed
}

/** Inverse of `encodeJitProgram`. Throws on a frame that does not verify —
 *  truncation, corruption and a producer built against another contract
 *  version are one outcome, matching the target's own single
 *  `RESOURCE_PROGRAM_FRAME`. */
export function decodeJitProgram<E extends { ext: string } = ExtOpPayload>(bytes: Uint8Array, offset: number = 0, extension?: Extension<E>):
    { maxCallDepth: number; totalDepth: number; program: RtlProgram<E>; next: number }
{
    const payloadEnd = bytes.length - PROGRAM_FRAME_BYTES
    if(payloadEnd <= offset)
    {
        throw new Error(`program frame: ${bytes.length - offset} bytes cannot hold a frame`)
    }

    const stored = bytes[payloadEnd] | (bytes[payloadEnd + 1] << 8)
    const computed = programFrameHash(bytes, payloadEnd)
    if(stored !== computed)
    {
        throw new Error(`program frame mismatch: stored 0x${stored.toString(16)}, computed 0x${computed.toString(16)}`)
    }

    const decoded = decodeJitEnvelope<E>(bytes, offset, extension)
    return { ...decoded, next: decoded.next + PROGRAM_FRAME_BYTES }
}
