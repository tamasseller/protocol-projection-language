import { read, write, hasNext, cloneRd, cloneWr, seek, writeSeq, readSeq, readSeqView, writeSeqRaw, tagOf, signExtend, revBits, CodecTrap } from "ppl"
import type { Ctx } from "ppl"


// proc 0: list
function encode_proc0(v0: Uint8Array, ctx: Ctx): void {
    let s0;
    s0 = 0;
    s0 = v0.length;
    write(ctx, 0, 1, s0);
    writeSeq(ctx, 0, v0, 1, s0);
    return;
}

// proc 0: list
function decode_proc0(ctx: Ctx): Uint8Array {
    let s0;
    let v0: any = [];
    s0 = 0;
    s0 = read(ctx, 0, 1);
    v0 = [];
    readSeq(ctx, 0, v0, 1, false, s0);
    return Uint8Array.from(v0);
}

export function encodeBytes(value: Uint8Array): Uint8Array {
    const ctx: Ctx = { buffer: new Uint8Array(64), length: 0, iters: [{ pos: 0, capability: "write", overwriteOnly: false }] }
    encode_proc0(value, ctx)
    return ctx.buffer.subarray(0, ctx.length)
}

export function decodeBytes(bytes: Uint8Array): Uint8Array {
    const ctx: Ctx = { buffer: bytes, length: bytes.length, iters: [{ pos: 0, capability: "read", overwriteOnly: false }] }
    return decode_proc0(ctx)
}