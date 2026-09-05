import { read, write, hasNext, cloneRd, cloneWr, seek, writeSeq, readSeq, readSeqView, writeSeqRaw, tagOf, signExtend, revBits, CodecTrap } from "ppl"
import type { Ctx } from "ppl"


// proc 0: list
function encode_proc0(v0: Int16Array, ctx: Ctx): void {
    let s0, s1, s2, s3, s4;
    let v1;
    let __idx0 = 0;
    s0 = 0;
    s0 = v0.length;
    write(ctx, 0, 1, s0);
    switch (((s0) === (0) ? 1 : 0)) {
        case 0: {
            break
        }
        default: {
            0;
            return;
        }
    }
    v1 = v0[__idx0++];
    s1 = 0;
    s1 = (v1) >>> 0;
    s2 = (-((((s1) & (2147483648)) !== (0) ? 1 : 0))) >>> 0;
    encode_proc1((((s1) << ((1) & 31)) >>> 0) ^ (s2), ctx);
    s0 = ((s0) - (1)) >>> 0;
    s2 = 0;
    s3 = 0;
    for (;;) {
        if (!(((s0) !== (0) ? 1 : 0))) break
        v1 = v0[__idx0++];
        s2 = (v1) >>> 0;
        s3 = ((s2) - (s1)) >>> 0;
        s4 = (-((((s3) & (2147483648)) !== (0) ? 1 : 0))) >>> 0;
        encode_proc1((((s3) << ((1) & 31)) >>> 0) ^ (s4), ctx);
        s1 = s2;
        s0 = ((s0) - (1)) >>> 0;
    }
    0;
    return;
}

// proc 1: GENERIC helper
function encode_proc1(s0: number, ctx: Ctx): number {
    let s1, s2;
    s1 = 1;
    s2 = 0;
    for (;;) {
        if (!((((s0) !== (0) ? 1 : 0)) | (s1))) break
        s1 = 0;
        s2 = (s0) & (127);
        s0 = (s0) >>> ((7) & 31);
        switch (((s0) !== (0) ? 1 : 0)) {
            case 0: {
                break
            }
            default: {
                s2 = (128) | (s2);
                break
            }
        }
        write(ctx, 0, 1, s2);
    }
    return 0;
}

// proc 0: list
function decode_proc0(ctx: Ctx): Int16Array {
    let s0, s1, s2, s3, s4;
    let v1;
    let v0: any = [];
    s0 = 0;
    s0 = read(ctx, 0, 1);
    v0 = [];
    switch (((s0) === (0) ? 1 : 0)) {
        case 0: {
            break
        }
        default: {
            0;
            return (v0 instanceof Int16Array ? v0 : Int16Array.from(v0));
        }
    }
    s1 = 0;
    s2 = 0;
    s3 = 0;
    s1 = decode_proc1(ctx);
    s4 = (-((1) & (s1))) >>> 0;
    s2 = ((s1) >>> ((1) & 31)) ^ (s4);
    v1 = signExtend(16, s2);
    v0.push(v1);
    s0 = ((s0) - (1)) >>> 0;
    for (;;) {
        if (!(((s0) !== (0) ? 1 : 0))) break
        s1 = decode_proc1(ctx);
        s4 = (-((1) & (s1))) >>> 0;
        s3 = ((s1) >>> ((1) & 31)) ^ (s4);
        s2 = ((s3) + (s2)) >>> 0;
        v1 = signExtend(16, s2);
        v0.push(v1);
        s0 = ((s0) - (1)) >>> 0;
    }
    0;
    return (v0 instanceof Int16Array ? v0 : Int16Array.from(v0));
}

// proc 1: GENERIC helper
function decode_proc1(ctx: Ctx): number {
    let s0, s1, s2, s3, s4;
    s0 = 0;
    s1 = 0;
    s2 = 1;
    s3 = 0;
    for (;;) {
        if (!((s3) | (s2))) break
        s2 = 0;
        s4 = 0;
        s4 = read(ctx, 0, 1);
        s0 = ((((s4) & (127)) << ((s1) & 31)) >>> 0) | (s0);
        s1 = ((7) + (s1)) >>> 0;
        s3 = (((s4) & (128)) !== (0) ? 1 : 0);
    }
    return s0;
}

export function encodeSamples(value: Int16Array): Uint8Array {
    const ctx: Ctx = { buffer: new Uint8Array(64), length: 0, iters: [{ pos: 0, capability: "write", overwriteOnly: false }] }
    encode_proc0(value, ctx)
    return ctx.buffer.subarray(0, ctx.length)
}

export function decodeSamples(bytes: Uint8Array): Int16Array {
    const ctx: Ctx = { buffer: bytes, length: bytes.length, iters: [{ pos: 0, capability: "read", overwriteOnly: false }] }
    return decode_proc0(ctx)
}