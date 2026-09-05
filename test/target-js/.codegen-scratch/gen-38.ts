import { read, write, hasNext, cloneRd, cloneWr, seek, writeSeq, readSeq, readSeqView, writeSeqRaw, tagOf, signExtend, revBits, CodecTrap } from "ppl"
import type { Ctx } from "ppl"

export interface Nested {
  readonly a: number;
  readonly pos: Pos;
}

export interface Pos {
  readonly x: number;
  readonly y: number;
}

// proc 0: struct
function encode_proc0(v0: Nested, ctx: Ctx): void {
    encode_proc1(v0.a, ctx);
    return;
}

// proc 1: integer
function encode_proc1(v0: number, ctx: Ctx): void {
    write(ctx, 0, 1, (v0) >>> 0);
    return;
}

// proc 0: struct
function decode_proc0(ctx: Ctx): Nested {
    let v0: any = {};
    let __def0: any = {};
    __def0.x = 1;
    __def0.y = 2;
    v0.pos = __def0;
    const __tmp1 = decode_proc1(ctx);
    v0.a = __tmp1;
    return v0;
}

// proc 1: integer
function decode_proc1(ctx: Ctx): number {
    let v0: any;
    v0 = read(ctx, 0, 1);
    return v0;
}

export function encodeNested(value: Nested): Uint8Array {
    const ctx: Ctx = { buffer: new Uint8Array(64), length: 0, iters: [{ pos: 0, capability: "write", overwriteOnly: false }] }
    encode_proc0(value, ctx)
    return ctx.buffer.subarray(0, ctx.length)
}

export function decodeNested(bytes: Uint8Array): Nested {
    const ctx: Ctx = { buffer: bytes, length: bytes.length, iters: [{ pos: 0, capability: "read", overwriteOnly: false }] }
    return decode_proc0(ctx)
}