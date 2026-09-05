import { read, write, hasNext, cloneRd, cloneWr, seek, writeSeq, readSeq, readSeqView, writeSeqRaw, tagOf, signExtend, revBits, CodecTrap } from "ppl"
import type { Ctx } from "ppl"

export interface Reading {
  readonly kind: T1;
  readonly value: number;
}

export type T1 =
  | { variant: "a"; value: number }
  | { variant: "b"; value: number };

// proc 0: struct
function encode_proc0(v0: Reading, ctx: Ctx): void {
    let s0;
    let v1;
    s0 = 0;
    v1 = v0.kind;
    s0 = (((tagOf(v1.variant, ["a","b"])) << ((0) & 31)) >>> 0) | (s0);
    write(ctx, 0, 1, s0);
    v1 = v0.kind;
    switch (tagOf(v1.variant, ["a","b"])) {
        case 0: {
            encode_proc1((v1 as Extract<T1, { variant: "a" }>).value, ctx);
            break
        }
        case 1: {
            encode_proc1((v1 as Extract<T1, { variant: "b" }>).value, ctx);
            break
        }
        default: {
            break
        }
    }
    encode_proc1(v0.value, ctx);
    return;
}

// proc 1: integer
function encode_proc1(v0: number, ctx: Ctx): void {
    write(ctx, 0, 1, (v0) >>> 0);
    return;
}

// proc 0: struct
function decode_proc0(ctx: Ctx): Reading {
    let s0;
    let v1;
    let v0: any = {};
    s0 = 0;
    s0 = read(ctx, 0, 1);
    switch (((s0) >>> ((0) & 31)) & (1)) {
        case 0: {
            const __tmp0 = decode_proc1(ctx);
            v1 = { variant: "a", value: __tmp0 };
            v0.kind = v1;
            break
        }
        case 1: {
            const __tmp1 = decode_proc1(ctx);
            v1 = { variant: "b", value: __tmp1 };
            v0.kind = v1;
            break
        }
        default: {
            break
        }
    }
    const __tmp2 = decode_proc1(ctx);
    v0.value = __tmp2;
    return v0;
}

// proc 1: integer
function decode_proc1(ctx: Ctx): number {
    let v0: any;
    v0 = read(ctx, 0, 1);
    return v0;
}

export function encodeReading(value: Reading): Uint8Array {
    const ctx: Ctx = { buffer: new Uint8Array(64), length: 0, iters: [{ pos: 0, capability: "write", overwriteOnly: false }] }
    encode_proc0(value, ctx)
    return ctx.buffer.subarray(0, ctx.length)
}

export function decodeReading(bytes: Uint8Array): Reading {
    const ctx: Ctx = { buffer: bytes, length: bytes.length, iters: [{ pos: 0, capability: "read", overwriteOnly: false }] }
    return decode_proc0(ctx)
}