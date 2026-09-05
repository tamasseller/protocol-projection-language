import { read, write, hasNext, cloneRd, cloneWr, seek, writeSeq, readSeq, readSeqView, writeSeqRaw, tagOf, signExtend, revBits, CodecTrap } from "ppl"
import type { Ctx } from "ppl"

export interface Wide {
  readonly n: bigint;
}

// proc 0: struct
function encode_proc0(v0: Wide, ctx: Ctx): void {
    encode_proc1(v0.n, ctx);
    return;
}

// proc 1: integer
function encode_proc1(v0: bigint, ctx: Ctx): void {
    write(ctx, 0, 8, Number(v0) >>> 0);
    return;
}

// proc 0: struct
function decode_proc0(ctx: Ctx): Wide {
    let v0: any = {};
    const __tmp0 = decode_proc1(ctx);
    v0.n = __tmp0;
    return v0;
}

// proc 1: integer
function decode_proc1(ctx: Ctx): bigint {
    let v0: any;
    v0 = BigInt(read(ctx, 0, 8));
    return v0;
}

export function encodeWide(value: Wide): Uint8Array {
    const ctx: Ctx = { buffer: new Uint8Array(64), length: 0, iters: [{ pos: 0, capability: "write", overwriteOnly: false }] }
    encode_proc0(value, ctx)
    return ctx.buffer.subarray(0, ctx.length)
}

export function decodeWide(bytes: Uint8Array): Wide {
    const ctx: Ctx = { buffer: bytes, length: bytes.length, iters: [{ pos: 0, capability: "read", overwriteOnly: false }] }
    return decode_proc0(ctx)
}