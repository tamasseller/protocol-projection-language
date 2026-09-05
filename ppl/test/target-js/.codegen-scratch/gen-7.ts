import { read, write, hasNext, cloneRd, cloneWr, seek, writeSeq, readSeq, readSeqView, writeSeqRaw, tagOf, signExtend, revBits, CodecTrap } from "ppl"
import type { Ctx } from "ppl"

export type Flag = "on" | "off";

// proc 0: union
function encode_proc0(v0: Flag, ctx: Ctx): void {
    write(ctx, 0, 1, tagOf(v0, ["on","off"]));
    switch (tagOf(v0, ["on","off"])) {
        case 0: {
            encode_proc1(undefined as any, ctx);
            break
        }
        case 1: {
            encode_proc1(undefined as any, ctx);
            break
        }
        default: {
            break
        }
    }
    0;
    return;
}

// proc 1: unit
function encode_proc1(v0: null, ctx: Ctx): void {
    0;
    return;
}

// proc 0: union
function decode_proc0(ctx: Ctx): Flag {
    let v0: any;
    switch (read(ctx, 0, 1)) {
        case 0: {
            const __tmp0 = decode_proc1(ctx);
            v0 = "on";
            break
        }
        case 1: {
            const __tmp1 = decode_proc1(ctx);
            v0 = "off";
            break
        }
        default: {
            break
        }
    }
    0;
    return v0;
}

// proc 1: unit
function decode_proc1(ctx: Ctx): null {
    let v0: any;
    0;
    return null;
}

export function encodeFlag(value: Flag): Uint8Array {
    const ctx: Ctx = { buffer: new Uint8Array(64), length: 0, iters: [{ pos: 0, capability: "write", overwriteOnly: false }] }
    encode_proc0(value, ctx)
    return ctx.buffer.subarray(0, ctx.length)
}

export function decodeFlag(bytes: Uint8Array): Flag {
    const ctx: Ctx = { buffer: bytes, length: bytes.length, iters: [{ pos: 0, capability: "read", overwriteOnly: false }] }
    return decode_proc0(ctx)
}