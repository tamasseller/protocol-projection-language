/**
 * codecs — delta-encoded `List<Integer>`, LEB128 (codec-extension.md §8.6)
 *
 * A specific, *opt-in* optimization — not one of `binary-rules.ts`'s defaults,
 * since "this list's values are close enough to their neighbors that
 * delta-coding pays for itself" is a judgment call about the *data*, not
 * something a type alone tells you. First element encoded as-is, every
 * subsequent one as the signed delta from the previous, both LEB128.
 * Self-contained: the list-walk plus a shared `leb128_encode`/
 * `leb128_decode` `GENERIC`-ABI helper (§8.3), invoked by plain `CALL` —
 * never `call_codec` — because a delta is a computed register value, not
 * an object handle (§3.3).
 *
 * A real pair of `CodecRule<void>`s (`deltaLeb128EncodeRule`/
 * `deltaLeb128DecodeRule`, both matching `List<Integer>`), not a standalone
 * one-off function — each composes into a `rules` array exactly like any
 * other rule, so it can preempt the generic list rule for one specific
 * field nested inside a larger struct, not just a standalone root.
 * `buildDeltaLeb128ListCodec` remains as a thin, backward-compatible
 * wrapper over that, picking whichever rule matches its own `direction`
 * argument.
 *
 * Diverges from §8.6's own worked example (illustration only, not a
 * mandate) in one deliberate way: every value actually handed to
 * `leb128_encode`/`leb128_decode` — the first element as well as every
 * later delta — is zigzag-transformed first (`(v << 1) ^ -((v &
 * 0x80000000) != 0)` on the way in, `(v >> 1) ^ -(v & 1)` on the way out —
 * `-(bool)` turns a 0/1 comparison result into an all-0s/all-1s mask), not
 * fed straight through. The sign test is a bitwise top-bit check
 * (`json.ts`'s own `jsonIntegerBody` uses the same idiom), not `v < 0`:
 * this DSL's `<` is only ever `LT_U` (rules.ts's `OP_TABLE`) — unsigned —
 * so `v < 0` is trivially always false, never what you want here; the
 * signed comparison opcodes (`LT_S` etc.) exist in the ISA but, like
 * `ASR` below, were never wired to a DSL token. §8.6's own unsigned-only
 * version wraps a negative value to its 32-bit two's-complement pattern
 * before LEB128 sees it — round-trips fine, but unsigned LEB128 then
 * spends up to 5 bytes on what zigzag turns into a small, cheap-to-encode
 * unsigned number instead (exactly why protobuf's `sint32`/`sint64` do
 * the same transform ahead of their own varint encoding). Chosen over
 * "true" SLEB128 (DWARF/WASM's sign-extend-the-last-byte convention)
 * specifically because it needs nothing this ISA doesn't already have:
 * `leb128_encode`/`leb128_decode` stay genuinely unsigned and untouched,
 * and the zigzag step itself only needs ops already reachable from the
 * DSL (`<<`, `&`, `!=`, `>>` i.e. `SHR` logical shift, unary `-`) — a real
 * SLEB128 encoder's own `value >>= 7` convergence step needs an
 * *arithmetic* shift, which this DSL doesn't expose (`ASR` is a real,
 * fully-implemented ISA opcode — isa-core.md §4.2/the encoding table —
 * just never wired to grammar syntax; a future addition, not needed here).
 */

import type { IrFragment, Procedure, RtlProgram } from "mog-core"
import { ir, declareProc, defineProc } from "mog-core"
import type { SemanticType, ListType, ListPattern, IntegerPattern } from "../../core/index"
import { concreteKindOf, derefType, SemanticTypeKinds, pList, pInteger } from "../../core/index"
import type { Direction } from "../engine/codec-extension"
import { buildCodec } from "../engine/resolver"
import { codecRule } from "../engine/resolver"
import type { CodecExtInstr } from "../engine/codec-ext-instr"

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
            write(0, 1, byte);
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
        write(0, 1, left);
        if (left == 0) { return; }
        enter_next(1, 0);
        u32 prev = 0;
        prev = load_val(1);
        ${leb128}((prev << 1) ^ -((prev & 0x80000000) != 0));
        left = left - 1;
        u32 cur = 0;
        u32 delta = 0;
        while (left != 0)
        {
            enter_next(1, 0);
            cur = load_val(1);
            delta = cur - prev;
            ${leb128}((delta << 1) ^ -((delta & 0x80000000) != 0));
            prev = cur;
            left = left - 1;
        }
    `
}

function deltaDecodeBody(leb128: Procedure): IrFragment
{
    return ir`
        u32 left = 0;
        left = read(0, 1);
        open_list(0);
        if (left == 0) { return; }
        u32 zz = 0;
        u32 prev = 0;
        u32 delta = 0;
        enter_next(1, 0);
        zz = ${leb128}();
        prev = (zz >> 1) ^ -(zz & 1);
        store_val(1, prev);
        left = left - 1;
        while (left != 0)
        {
            enter_next(1, 0);
            zz = ${leb128}();
            delta = (zz >> 1) ^ -(zz & 1);
            prev = prev + delta;
            store_val(1, prev);
            left = left - 1;
        }
    `
}

/**
 * `List<Integer>` -> delta+LEB128 — two rules, not one branching on a
 * threaded direction (see binary-rules.ts for why: a resolver run already
 * commits to one direction for its whole walk, so there's nothing for a
 * runtime flag to select between within a single `produce` call). Each
 * mints its own fresh `leb128_encode`/`leb128_decode` helper `Procedure`
 * per `produce()` call — neither rule memoizes the helper across multiple
 * matching fields in the same program, matching the granularity
 * `buildDeltaLeb128ListCodec` already had as a standalone one-shot builder.
 */
const LIST_OF_INTEGER = pList(pInteger(-Infinity, Infinity))

export const deltaLeb128EncodeRule = codecRule<ListPattern<IntegerPattern>, void>(LIST_OF_INTEGER, () =>
{
    const leb128 = declareProc(["value"])
    defineProc(leb128, leb128EncodeBody())
    return deltaEncodeBody(leb128)
})

export const deltaLeb128DecodeRule = codecRule<ListPattern<IntegerPattern>, void>(LIST_OF_INTEGER, () =>
{
    const leb128 = declareProc([])
    defineProc(leb128, leb128DecodeBody())
    return deltaDecodeBody(leb128)
})

/** Build the self-contained delta+LEB128 program for a `List<Integer>`,
 *  one direction at a time. `root` must be a list of an integer element
 *  type. A thin wrapper picking whichever of `deltaLeb128EncodeRule`/
 *  `deltaLeb128DecodeRule` matches `direction` — those rules are the
 *  reusable, composable pieces. */
export function buildDeltaLeb128ListCodec(root: SemanticType, direction: Direction): RtlProgram<CodecExtInstr>
{
    if(concreteKindOf(root) !== SemanticTypeKinds.List)
        throw new Error(`buildDeltaLeb128ListCodec: expected a list type, got "${concreteKindOf(root)}"`)
    const elementKind = concreteKindOf((derefType(root) as ListType).elementType)
    if(elementKind !== SemanticTypeKinds.Integer)
        throw new Error(`buildDeltaLeb128ListCodec: expected List<Integer>, element is "${elementKind}"`)

    return direction === "encode"
        ? buildCodec(root, [deltaLeb128EncodeRule], undefined)
        : buildCodec(root, [deltaLeb128DecodeRule], undefined)
}
