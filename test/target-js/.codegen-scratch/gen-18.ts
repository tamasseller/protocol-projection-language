import { read, write, hasNext, cloneRd, cloneWr, seek, writeSeq, readSeq, readSeqView, writeSeqRaw, tagOf, signExtend, revBits, CodecTrap } from "ppl"
import type { Ctx } from "ppl"

export interface Padded {
  readonly pad: number;
  readonly samples: Int16Array;
}

// proc 0: struct
function encode_proc0(v0: Padded, ctx: Ctx): void {
    encode_proc1(v0.pad, ctx);
    encode_proc2(v0.samples, ctx);
    return;
}

// proc 1: integer
function encode_proc1(v0: number, ctx: Ctx): void {
    write(ctx, 0, 1, (v0) >>> 0);
    return;
}

// proc 2: list
function encode_proc2(v0: Int16Array, ctx: Ctx): void {
    let s0;
    s0 = 0;
    s0 = v0.length;
    write(ctx, 0, 1, s0);
    writeSeqRaw(ctx, 0, v0);
    return;
}

// proc 0: struct
function decode_proc0(ctx: Ctx): Padded {
    let v0: any = {};
    const __tmp0 = decode_proc1(ctx);
    v0.pad = __tmp0;
    const __tmp1 = decode_proc2(ctx);
    v0.samples = __tmp1;
    return v0;
}

// proc 1: integer
function decode_proc1(ctx: Ctx): number {
    let v0: any;
    v0 = read(ctx, 0, 1);
    return v0;
}

// proc 2: list
function decode_proc2(ctx: Ctx): Int16Array {
    let s0;
    let v0: any = [];
    s0 = 0;
    s0 = read(ctx, 0, 1);
    v0 = [];
    v0 = readSeqView(ctx, 0, Int16Array, s0);
    return (v0 instanceof Int16Array ? v0 : Int16Array.from(v0));
}

export function encodePadded(value: Padded): Uint8Array {
    const ctx: Ctx = { buffer: new Uint8Array(64), length: 0, iters: [{ pos: 0, capability: "write", overwriteOnly: false }] }
    encode_proc0(value, ctx)
    return ctx.buffer.subarray(0, ctx.length)
}

export function decodePadded(bytes: Uint8Array): Padded {
    const ctx: Ctx = { buffer: bytes, length: bytes.length, iters: [{ pos: 0, capability: "read", overwriteOnly: false }] }
    return decode_proc0(ctx)
}