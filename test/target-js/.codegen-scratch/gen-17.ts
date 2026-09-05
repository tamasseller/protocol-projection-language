import { read, write, hasNext, cloneRd, cloneWr, seek, writeSeq, readSeq, readSeqView, writeSeqRaw, tagOf, signExtend, revBits, CodecTrap } from "ppl"
import type { Ctx } from "ppl"

export interface T1 {
  readonly v: number;
}

// proc 0: list
function encode_proc0(v0: T1[], ctx: Ctx): void {
    let s0;
    let __idx0 = 0;
    s0 = 0;
    s0 = v0.length;
    write(ctx, 0, 1, s0);
    for (;;) {
        if (!(((s0) !== (0) ? 1 : 0))) break
        encode_proc1(v0[__idx0++], ctx);
        s0 = ((s0) - (1)) >>> 0;
    }
    0;
    return;
}

// proc 1: struct
function encode_proc1(v0: T1, ctx: Ctx): void {
    encode_proc2(v0.v, ctx);
    return;
}

// proc 2: integer
function encode_proc2(v0: number, ctx: Ctx): void {
    write(ctx, 0, 1, (v0) >>> 0);
    return;
}

// proc 0: list
function decode_proc0(ctx: Ctx): T1[] {
    let s0;
    let v0: any = [];
    s0 = 0;
    s0 = read(ctx, 0, 1);
    v0 = [];
    for (;;) {
        if (!(((s0) !== (0) ? 1 : 0))) break
        const __tmp0 = decode_proc1(ctx);
        (v0.some((x: any) => JSON.stringify(x) === JSON.stringify(__tmp0)) ? (() => { throw new Error("duplicate element") })() : v0.push(__tmp0));
        s0 = ((s0) - (1)) >>> 0;
    }
    0;
    return v0;
}

// proc 1: struct
function decode_proc1(ctx: Ctx): T1 {
    let v0: any = {};
    const __tmp0 = decode_proc2(ctx);
    v0.v = __tmp0;
    return v0;
}

// proc 2: integer
function decode_proc2(ctx: Ctx): number {
    let v0: any;
    v0 = read(ctx, 0, 1);
    return v0;
}

export function encodeBag(value: T1[]): Uint8Array {
    const ctx: Ctx = { buffer: new Uint8Array(64), length: 0, iters: [{ pos: 0, capability: "write", overwriteOnly: false }] }
    encode_proc0(value, ctx)
    return ctx.buffer.subarray(0, ctx.length)
}

export function decodeBag(bytes: Uint8Array): T1[] {
    const ctx: Ctx = { buffer: bytes, length: bytes.length, iters: [{ pos: 0, capability: "read", overwriteOnly: false }] }
    return decode_proc0(ctx)
}