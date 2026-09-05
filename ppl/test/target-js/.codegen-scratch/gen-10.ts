import { read, write, hasNext, cloneRd, cloneWr, seek, writeSeq, readSeq, readSeqView, writeSeqRaw, tagOf, signExtend, revBits, CodecTrap } from "ppl"
import type { Ctx } from "ppl"

export type Tree =
  | { variant: "leaf"; value: number }
  | { variant: "node"; value: T2 };

export interface T2 {
  readonly left: Tree;
  readonly right: Tree;
}

// proc 0: union
function encode_proc0(v0: Tree, ctx: Ctx): void {
    write(ctx, 0, 1, tagOf(v0.variant, ["leaf","node"]));
    switch (tagOf(v0.variant, ["leaf","node"])) {
        case 0: {
            encode_proc1((v0 as Extract<Tree, { variant: "leaf" }>).value, ctx);
            break
        }
        case 1: {
            encode_proc2((v0 as Extract<Tree, { variant: "node" }>).value, ctx);
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

// proc 2: struct
function encode_proc2(v0: T2, ctx: Ctx): void {
    let s0;
    let v1;
    s0 = 0;
    v1 = v0.left;
    s0 = (((tagOf(v1.variant, ["leaf","node"])) << ((0) & 31)) >>> 0) | (s0);
    v1 = v0.right;
    s0 = (((tagOf(v1.variant, ["leaf","node"])) << ((1) & 31)) >>> 0) | (s0);
    write(ctx, 0, 1, s0);
    v1 = v0.left;
    switch (tagOf(v1.variant, ["leaf","node"])) {
        case 0: {
            encode_proc1((v1 as Extract<Tree, { variant: "leaf" }>).value, ctx);
            break
        }
        case 1: {
            encode_proc2((v1 as Extract<Tree, { variant: "node" }>).value, ctx);
            break
        }
        default: {
            break
        }
    }
    v1 = v0.right;
    switch (tagOf(v1.variant, ["leaf","node"])) {
        case 0: {
            encode_proc1((v1 as Extract<Tree, { variant: "leaf" }>).value, ctx);
            break
        }
        case 1: {
            encode_proc2((v1 as Extract<Tree, { variant: "node" }>).value, ctx);
            break
        }
        default: {
            break
        }
    }
    0;
    return;
}

// proc 0: union
function decode_proc0(ctx: Ctx): Tree {
    let v0: any;
    switch (read(ctx, 0, 1)) {
        case 0: {
            const __tmp0 = decode_proc1(ctx);
            v0 = { variant: "leaf", value: __tmp0 };
            break
        }
        case 1: {
            const __tmp1 = decode_proc2(ctx);
            v0 = { variant: "node", value: __tmp1 };
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

// proc 2: struct
function decode_proc2(ctx: Ctx): T2 {
    let s0;
    let v1;
    let v0: any = {};
    s0 = 0;
    s0 = read(ctx, 0, 1);
    switch (((s0) >>> ((0) & 31)) & (1)) {
        case 0: {
            const __tmp0 = decode_proc1(ctx);
            v1 = { variant: "leaf", value: __tmp0 };
            v0.left = v1;
            break
        }
        case 1: {
            const __tmp1 = decode_proc2(ctx);
            v1 = { variant: "node", value: __tmp1 };
            v0.left = v1;
            break
        }
        default: {
            break
        }
    }
    switch (((s0) >>> ((1) & 31)) & (1)) {
        case 0: {
            const __tmp2 = decode_proc1(ctx);
            v1 = { variant: "leaf", value: __tmp2 };
            v0.right = v1;
            break
        }
        case 1: {
            const __tmp3 = decode_proc2(ctx);
            v1 = { variant: "node", value: __tmp3 };
            v0.right = v1;
            break
        }
        default: {
            break
        }
    }
    0;
    return v0;
}

export function encodeTree(value: Tree): Uint8Array {
    const ctx: Ctx = { buffer: new Uint8Array(64), length: 0, iters: [{ pos: 0, capability: "write", overwriteOnly: false }] }
    encode_proc0(value, ctx)
    return ctx.buffer.subarray(0, ctx.length)
}

export function decodeTree(bytes: Uint8Array): Tree {
    const ctx: Ctx = { buffer: bytes, length: bytes.length, iters: [{ pos: 0, capability: "read", overwriteOnly: false }] }
    return decode_proc0(ctx)
}