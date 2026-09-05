import { read, write, hasNext, cloneRd, cloneWr, seek, writeSeq, readSeq, readSeqView, writeSeqRaw, tagOf, signExtend, revBits, CodecTrap } from "ppl"
import type { Ctx } from "ppl"

export interface Container {
  readonly items: Item[];
}

export interface Item {
  readonly a: number;
}

// proc 0: struct
function encode_proc0(v0: Container, ctx: Ctx): void {
    encode_proc1(v0.items, ctx);
    return;
}

// proc 1: list
function encode_proc1(v0: Item[], ctx: Ctx): void {
    let s0;
    let __idx0 = 0;
    s0 = 0;
    s0 = v0.length;
    write(ctx, 0, 1, s0);
    for (;;) {
        if (!(((s0) !== (0) ? 1 : 0))) break
        encode_proc2(v0[__idx0++], ctx);
        s0 = ((s0) - (1)) >>> 0;
    }
    0;
    return;
}

// proc 2: struct
function encode_proc2(v0: Item, ctx: Ctx): void {
    encode_proc3(v0.a, ctx);
    encode_proc4(9, ctx);
    return;
}

// proc 3: integer
function encode_proc3(v0: number, ctx: Ctx): void {
    write(ctx, 0, 1, (v0) >>> 0);
    return;
}

// proc 4: integer
function encode_proc4(v0: any, ctx: Ctx): void {
    write(ctx, 0, 1, v0);
    return;
}

// proc 0: struct
function decode_proc0(ctx: Ctx): Container {
    let v0: any = {};
    const __tmp0 = decode_proc1(ctx);
    v0.items = __tmp0;
    return v0;
}

// proc 1: list
function decode_proc1(ctx: Ctx): Item[] {
    let s0;
    let v0: any = [];
    s0 = 0;
    s0 = read(ctx, 0, 1);
    v0 = [];
    for (;;) {
        if (!(((s0) !== (0) ? 1 : 0))) break
        const __tmp0 = decode_proc2(ctx);
        v0.push(__tmp0);
        s0 = ((s0) - (1)) >>> 0;
    }
    0;
    return v0;
}

// proc 2: struct
function decode_proc2(ctx: Ctx): Item {
    let v0: any = {};
    const __tmp0 = decode_proc3(ctx);
    v0.a = __tmp0;
    const __tmp1 = decode_proc4(ctx);
    return v0;
}

// proc 3: integer
function decode_proc3(ctx: Ctx): number {
    let v0: any;
    v0 = read(ctx, 0, 1);
    return v0;
}

// proc 4: integer
function decode_proc4(ctx: Ctx): any {
    let v0: any;
    v0 = read(ctx, 0, 1);
    return v0;
}

export function encodeContainer(value: Container): Uint8Array {
    const ctx: Ctx = { buffer: new Uint8Array(64), length: 0, iters: [{ pos: 0, capability: "write", overwriteOnly: false }] }
    encode_proc0(value, ctx)
    return ctx.buffer.subarray(0, ctx.length)
}

export function decodeContainer(bytes: Uint8Array): Container {
    const ctx: Ctx = { buffer: bytes, length: bytes.length, iters: [{ pos: 0, capability: "read", overwriteOnly: false }] }
    return decode_proc0(ctx)
}