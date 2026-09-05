import { read, write, hasNext, cloneRd, cloneWr, seek, writeSeq, readSeq, readSeqView, writeSeqRaw, tagOf, signExtend, revBits, CodecTrap } from "ppl"
import type { Ctx } from "ppl"

export type Status =
  | { variant: "ok"; value: number }
  | { variant: "extra"; value: number };

// proc 0: union
function encode_proc0(v0: Status, ctx: Ctx): void {
    write(ctx, 0, 1, tagOf(v0.variant, ["ok","err"]));
    switch (tagOf(v0.variant, ["ok","err"])) {
        case 0: {
            encode_proc1((v0 as Extract<Status, { variant: "ok" }>).value, ctx);
            break
        }
        case 1: {
            throw new CodecTrap(-1, "structurally unreachable (docs/codec-image.md §2.4)");
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

// proc 0: union
function decode_proc0(ctx: Ctx): Status {
    let v0: any;
    switch (read(ctx, 0, 1)) {
        case 0: {
            const __tmp0 = decode_proc1(ctx);
            v0 = { variant: "ok", value: __tmp0 };
            break
        }
        case 1: {
            throw new CodecTrap(-1, "variant \"err\" isn't recognized locally and the local union declares no default variant");
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
    v0 = read(ctx, 0, 1);
    return v0;
}

export function encodeStatus(value: Status): Uint8Array {
    const ctx: Ctx = { buffer: new Uint8Array(64), length: 0, iters: [{ pos: 0, capability: "write", overwriteOnly: false }] }
    encode_proc0(value, ctx)
    return ctx.buffer.subarray(0, ctx.length)
}

export function decodeStatus(bytes: Uint8Array): Status {
    const ctx: Ctx = { buffer: bytes, length: bytes.length, iters: [{ pos: 0, capability: "read", overwriteOnly: false }] }
    return decode_proc0(ctx)
}