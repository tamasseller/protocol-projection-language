/**
 * @ppl/codecs — delta-encoded `List<Integer>`, LEB128 (codec-extension.md §8.6)
 *
 * A specific, *opt-in* optimization — not one of `builders.ts`'s defaults,
 * since "this list's values are close enough to their neighbors that
 * delta-coding pays for itself" is a judgment call about the *data*, not
 * something a type alone tells you. First element encoded as-is, every
 * subsequent one as the signed delta from the previous, both LEB128.
 * Self-contained: the list-walk plus a shared `leb128_encode`/
 * `leb128_decode` `GENERIC`-ABI helper (§8.3), invoked by plain `CALL` —
 * never `call_codec` — because a delta is a computed register value, not
 * an object handle (§3.3).
 *
 * A real `CodecRule<Direction>` (`deltaLeb128Rule`, matching
 * `List<Integer>`), not a standalone one-off function — it composes with
 * `buildCodec`'s `extraRules` seam exactly like any other rule, so it can
 * preempt the generic list rule for one specific field nested inside a
 * larger struct, not just a standalone root. `buildDeltaLeb128ListCodec`
 * remains as a thin, backward-compatible wrapper over that.
 *
 * Faithful to §8.6 as specified: the delta is fed straight into unsigned
 * LEB128, no zigzag step. That means it's a genuine win only for
 * non-negative (or very mildly negative) deltas — a negative one wraps to
 * its 32-bit two's-complement value first (still round-trips correctly,
 * decode's own `+` unwraps it exactly the same way), which unsigned LEB128
 * then spends up to 5 bytes on instead of 1. Worth knowing before reaching
 * for this on data that isn't monotonic-ish.
 */

import type { IrFragment, Procedure, RtlProgram } from "@ppl/machine"
import { ir, declareProc, defineProc } from "@ppl/machine"
import type { TypeNode } from "@ppl/core"
import { kindOf, SemanticTypeKinds, pList, pInteger } from "@ppl/core"
import type { Direction } from "./codec-extension"
import type { CodecRule } from "./rules"
import { buildCodec } from "./builders"

// ── leb128_encode(value) — §8.3, as an ir` ` fragment ────────────────────

function leb128EncodeBody(): IrFragment
{
    return ir`
        u32 first = 1;
        u32 byte = 0;
        while ((value != 0) | first)
        {
            first = 0;
            byte = value & 0x7F;
            value = value >> 7;
            if (value != 0) { byte = byte | 0x80; }
            byte;
            write(0, 1);
        }
        return;
    `
}

// ── leb128_decode() — the mirror; not in codec-extension.md, but the only
//    reasonable inverse of §8.3's encoder ──────────────────────────────

function leb128DecodeBody(): IrFragment
{
    return ir`
        u32 value = 0;
        u32 shift = 0;
        u32 first = 1;
        u32 cont = 0;
        while (cont | first)
        {
            first = 0;
            u32 byte = 0;
            byte = read(0, 1);
            value = ((byte & 0x7F) << shift) | value;
            shift = shift + 7;
            cont = (byte & 0x80) != 0;
        }
        return value;
    `
}

// ── The list walk — §8.6, adapted to this implementation's explicit-
//    operand convention (no implicit `o0`/`i0` defaults) ────────────────

function deltaEncodeBody(leb128: Procedure): IrFragment
{
    return ir`
        u32 left = 0;
        left = count(0);
        write(0, 1);
        if (left == 0) { return; }
        enter_next(1, 0);
        u32 prev = 0;
        prev = load_val(1);
        ${leb128}(prev);
        left = left - 1;
        while (left != 0)
        {
            enter_next(1, 0);
            u32 cur = 0;
            cur = load_val(1);
            ${leb128}(cur - prev);
            prev = cur;
            left = left - 1;
        }
        return;
    `
}

function deltaDecodeBody(leb128: Procedure): IrFragment
{
    return ir`
        u32 left = 0;
        left = read(0, 1);
        open_list(0);
        if (left == 0) { return; }
        enter_next(1, 0);
        u32 prev = 0;
        prev = ${leb128}();
        prev;
        store_val(1);
        left = left - 1;
        while (left != 0)
        {
            enter_next(1, 0);
            u32 delta = 0;
            delta = ${leb128}();
            prev = prev + delta;
            prev;
            store_val(1);
            left = left - 1;
        }
        return;
    `
}

/**
 * `List<Integer>` -> delta+LEB128, one direction at a time. A fresh
 * `leb128_encode`/`leb128_decode` helper `Procedure` per `produce()` call —
 * this rule doesn't memoize the helper across multiple matching fields in
 * the same program, matching the granularity `buildDeltaLeb128ListCodec`
 * already had as a standalone one-shot builder.
 */
export const deltaLeb128Rule: CodecRule<Direction> = {
    pattern: pList(pInteger(-Infinity, Infinity)),
    produce: (_m, _node, direction) =>
    {
        const leb128 = declareProc(direction === "encode" ? ["value"] : [])
        defineProc(leb128, direction === "encode" ? leb128EncodeBody() : leb128DecodeBody())
        return direction === "encode" ? deltaEncodeBody(leb128) : deltaDecodeBody(leb128)
    },
}

/** Build the self-contained delta+LEB128 program for a `List<Integer>`,
 *  one direction at a time. `node` must be a list of an integer element
 *  type. A thin wrapper over `buildCodec`'s `extraRules` seam — the rule
 *  itself (`deltaLeb128Rule`) is the reusable, composable piece. */
export function buildDeltaLeb128ListCodec(node: TypeNode, direction: Direction): RtlProgram
{
    if(kindOf(node.type) !== SemanticTypeKinds.List)
        throw new Error(`buildDeltaLeb128ListCodec: expected a list type, got "${kindOf(node.type)}"`)
    const elementKind = kindOf(node.edges[0]!.target.type)
    if(elementKind !== SemanticTypeKinds.Integer)
        throw new Error(`buildDeltaLeb128ListCodec: expected List<Integer>, element is "${elementKind}"`)

    return buildCodec(node, direction, [deltaLeb128Rule])
}
