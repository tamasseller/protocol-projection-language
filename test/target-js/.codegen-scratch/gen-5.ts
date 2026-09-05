import { read, write, hasNext, cloneRd, cloneWr, seek, writeSeq, readSeq, readSeqView, writeSeqRaw, tagOf, signExtend, revBits, CodecTrap } from "ppl"
import type { Ctx } from "ppl"

export interface Sample {
  readonly maybe: T1;
}

export type T1 =
  | { variant: "value"; value: number }
  | { variant: "empty"; value: null };

// proc 0: struct
function encode_proc0(v0: Sample, ctx: Ctx): void {
    let s0;
    let v1;
    s0 = 0;
    v1 = v0.maybe;
    s0 = (((tagOf(v1.variant, ["value","empty"])) << ((0) & 31)) >>> 0) | (s0);
    write(ctx, 0, 1, s0);
    v1 = v0.maybe;
    switch (tagOf(v1.variant, ["value","empty"])) {
        case 0: {
            encode_proc1((v1 as Extract<T1, { variant: "value" }>).value, ctx);
            break
        }
        case 1: {
            encode_proc2((v1 as Extract<T1, { variant: "empty" }>).value, ctx);
            break
        }
        default: {
            break
        }
    }
    0;
    return;
}

// proc 1: integer
function encode_proc1(v0: number, ctx: Ctx): void {
    write(ctx, 0, 1, (v0) >>> 0);
    return;
}

// proc 2: unit
function encode_proc2(v0: null, ctx: Ctx): void {
    0;
    return;
}

// proc 0: struct
function decode_proc0(ctx: Ctx): Sample {
    let s0;
    let v1;
    let v0: any = {};
    s0 = 0;
    s0 = read(ctx, 0, 1);
    switch (((s0) >>> ((0) & 31)) & (1)) {
        case 0: {
            const __tmp0 = decode_proc1(ctx);
            v1 = { variant: "value", value: __tmp0 };
            v0.maybe = v1;
            break
        }
        case 1: {
            const __tmp1 = decode_proc2(ctx);
            v1 = { variant: "empty", value: __tmp1 };
            v0.maybe = v1;
            break
        }
        default: {
            break
        }
    }
    0;
    return v0;
}

// proc 1: integer
function decode_proc1(ctx: Ctx): number {
    let v0: any;
    v0 = signExtend(8, read(ctx, 0, 1));
    return v0;
}

// proc 2: unit
function decode_proc2(ctx: Ctx): null {
    let v0: any;
    0;
    return null;
}

export function encodeSample(value: Sample): Uint8Array {
    const ctx: Ctx = { buffer: new Uint8Array(64), length: 0, iters: [{ pos: 0, capability: "write", overwriteOnly: false }] }
    encode_proc0(value, ctx)
    return ctx.buffer.subarray(0, ctx.length)
}

export function decodeSample(bytes: Uint8Array): Sample {
    const ctx: Ctx = { buffer: bytes, length: bytes.length, iters: [{ pos: 0, capability: "read", overwriteOnly: false }] }
    return decode_proc0(ctx)
}