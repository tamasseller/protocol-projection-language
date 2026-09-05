import { read, write, hasNext, cloneRd, cloneWr, seek, writeSeq, readSeq, readSeqView, writeSeqRaw, tagOf, signExtend, revBits, CodecTrap } from "ppl"
import type { Ctx } from "ppl"

export interface Outer {
  readonly inner: Inner;
  readonly b: number;
}

export interface Inner {
  readonly a: number;
}

// proc 0: struct
function encode_proc0(v0: Outer, ctx: Ctx): void {
    encode_proc1(v0.inner, ctx);
    encode_proc2(v0.b, ctx);
    return;
}

// proc 1: struct
function encode_proc1(v0: Inner, ctx: Ctx): void {
    encode_proc2(v0.a, ctx);
    return;
}

// proc 2: integer
function encode_proc2(v0: number, ctx: Ctx): void {
    write(ctx, 0, 1, (v0) >>> 0);
    return;
}

// proc 0: struct
function decode_proc0(ctx: Ctx): Outer {
    let v0: any = {};
    const __tmp0 = decode_proc1(ctx);
    v0.inner = __tmp0;
    const __tmp1 = decode_proc2(ctx);
    v0.b = __tmp1;
    return v0;
}

// proc 1: struct
function decode_proc1(ctx: Ctx): Inner {
    let v0: any = {};
    const __tmp0 = decode_proc2(ctx);
    v0.a = __tmp0;
    return v0;
}

// proc 2: integer
function decode_proc2(ctx: Ctx): number {
    let v0: any;
    v0 = read(ctx, 0, 1);
    return v0;
}

export function encodeOuter(value: Outer): Uint8Array {
    const ctx: Ctx = { buffer: new Uint8Array(64), length: 0, iters: [{ pos: 0, capability: "write", overwriteOnly: false }] }
    encode_proc0(value, ctx)
    return ctx.buffer.subarray(0, ctx.length)
}

export function decodeOuter(bytes: Uint8Array): Outer {
    const ctx: Ctx = { buffer: bytes, length: bytes.length, iters: [{ pos: 0, capability: "read", overwriteOnly: false }] }
    return decode_proc0(ctx)
}