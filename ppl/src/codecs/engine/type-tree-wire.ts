/**
 * codecs — Type tree wire encoding (docs/codec-image.md §6, ROADMAP.md
 * item 10)
 *
 * A postorder stack machine, not a table of nodes with pointers (§6.1):
 * `ENTER`/`CALL_CODEC`'s own `ref` addressing is already local/positional
 * (codec-extension.md §2.4), so nothing downstream of decode cares how
 * this section represents the tree internally — only that decode hands
 * back the right shape. Leaves push a value; `LIST`/`STRUCT`/`UNION` pop
 * however many children they have and push the combined result. No
 * pointers, because a postorder walk never needs one.
 *
 * The tag byte's top 2 bits pick a family; for `STRUCT`/`UNION`/`PUSH_REF`
 * — the three that recur once per tree node — the low 6 bits *are* the
 * payload (field/variant count, or backref delta), no separate operand
 * for the overwhelming majority of realistic values. `0xC0`-`0xFF` is
 * everything else (leaves, `LIST`, the `_EXT` escapes, `END`), plain
 * sequential tags — there's no per-node recurrence to exploit there, so a
 * byte per tag is already at floor. See §6.2 for the full table.
 */

import {
    ConcreteSemanticType,
    IntegerType,
    SemanticType,
    SemanticTypeKinds,
    UnionType,
    derefType,
    i16,
    i32,
    i8,
    integer,
    list,
    struct,
    u16,
    u32,
    u8,
    union,
    unit,
} from "../../core/index"
import { decodeLeb128, encodeLeb128 } from "mog-core"

// ── Opcodes ──────────────────────────────────────────────────────────────

const FAMILY_STRUCT = 0
const FAMILY_UNION = 1
const FAMILY_REF = 2
// family 3 (0xC0-0xFF) dispatches on the exact byte, below.

const PUSH_UNIT = 0xC0
const PUSH_U8 = 0xC1
const PUSH_I8 = 0xC2
const PUSH_U16 = 0xC3
const PUSH_I16 = 0xC4
const PUSH_U32 = 0xC5
const PUSH_I32 = 0xC6
const PUSH_INT_MIN0_D0_EXT = 0xC7
const PUSH_INT_MIN0_EXT = 0xC8
const PUSH_INT_D0_EXT = 0xC9
const PUSH_INT_EXT = 0xCA
const LIST_OP = 0xCB
const LIST_EXT = 0xCC
const STRUCT_EXT = 0xCD
const UNION_EXT = 0xCE
const PUSH_REF_EXT = 0xCF
const END = 0xD0

/** Every canonical width `metamodel.ts` exports — all `default = 0`. */
const CANONICAL: ReadonlyArray<readonly [number, IntegerType]> = [
    [PUSH_U8, u8], [PUSH_I8, i8], [PUSH_U16, u16], [PUSH_I16, i16], [PUSH_U32, u32], [PUSH_I32, i32],
]

// ── Signed LEB128 (zigzag) ───────────────────────────────────────────────
//
// `encodeLeb128` is u32-only, and zigzag doubles a value's magnitude — so
// only values representable as a genuine 32-bit signed int (min/max/
// default in [-2^31, 2^31-1]) round-trip correctly here. A custom integer
// range needing more than that (nothing in this codebase declares one)
// hits the guard below rather than silently wrapping.

function encodeSigned(n: number): number[]
{
    if(n < -2147483648 || n > 2147483647)
        throw new Error(`type-tree-wire: ${n} is outside the signed 32-bit range this encoding supports`)
    return encodeLeb128(((n << 1) ^ (n >> 31)) >>> 0)
}

function decodeSigned(bytes: Uint8Array, offset: number): { value: number; next: number }
{
    const { value: zz, next } = decodeLeb128(bytes, offset)
    return { value: (zz >>> 1) ^ -(zz & 1), next }
}

// ── Integer leaf ─────────────────────────────────────────────────────────

function encodeInteger(t: IntegerType): number[]
{
    for(const [tag, canon] of CANONICAL)
        if(t.min === canon.min && t.max === canon.max && t.default === 0) return [tag]

    if(t.min === 0 && t.default === 0) return [PUSH_INT_MIN0_D0_EXT, ...encodeLeb128(t.max)]
    if(t.min === 0) return [PUSH_INT_MIN0_EXT, ...encodeLeb128(t.max), ...encodeSigned(t.default)]
    if(t.default === 0) return [PUSH_INT_D0_EXT, ...encodeSigned(t.min), ...encodeSigned(t.max)]
    return [PUSH_INT_EXT, ...encodeSigned(t.min), ...encodeSigned(t.max), ...encodeSigned(t.default)]
}

// ── String table + name specification (§6.3) ────────────────────────────

/** `(base << 1) | 1` for a single name; `(length - 2) << 1` then `base`
 *  for a run of `length ≥ 2` consecutive indices — self-terminating
 *  against the caller-known total count, no range-count operand needed.
 *  Given a fixed table order, greedily merging every numerically-adjacent
 *  pair of indices is already optimal (§6.3) — no search required. */
function encodeNameSpec(indices: readonly number[]): number[]
{
    const bytes: number[] = []
    let i = 0
    while(i < indices.length)
    {
        let j = i
        while(j + 1 < indices.length && indices[j + 1] === indices[j]! + 1) j++
        const base = indices[i]!
        const length = j - i + 1
        if(length === 1) bytes.push(...encodeLeb128((base << 1) | 1))
        else bytes.push(...encodeLeb128((length - 2) << 1), ...encodeLeb128(base))
        i = j + 1
    }
    return bytes
}

function decodeNameSpec(bytes: Uint8Array, offset: number, count: number, names: readonly string[]): { values: string[]; next: number }
{
    const values: string[] = []
    let pos = offset
    while(values.length < count)
    {
        const v = decodeLeb128(bytes, pos)
        pos = v.next
        let base: number, length: number
        if(v.value % 2 === 1) { base = (v.value - 1) / 2; length = 1 }
        else
        {
            length = v.value / 2 + 2
            const b = decodeLeb128(bytes, pos)
            base = b.value
            pos = b.next
        }
        for(let k = 0; k < length; k++) values.push(names[base + k]!)
    }
    return { values, next: pos }
}

// ── Encode ───────────────────────────────────────────────────────────────

/** Encode a semantic type tree (docs/codec-image.md §6). */
export function encodeTypeTree(root: SemanticType): Uint8Array
{
    const names: string[] = []
    const nameIndexOf = new Map<string, number>()
    const nameIndex = (name: string): number =>
    {
        const existing = nameIndexOf.get(name)
        if(existing !== undefined) return existing
        const idx = names.length
        names.push(name)
        nameIndexOf.set(name, idx)
        return idx
    }

    // Keyed by *value* (a structural signature), not by emitted bytes: a
    // repeated composite's second occurrence would otherwise never match
    // its first, since its children resolve to short PUSH_REFs rather
    // than the first occurrence's real construction bytes — a
    // byte-content key would see those as different, missing the dedup
    // entirely for anything with children (structurally identical leaves
    // still would have matched, but this file's own §6.4 spec explicitly
    // wants composite reuse caught too, e.g. two independently-written
    // `struct({a: u8, b: unit})` calls). Signature keying sidesteps that:
    // it's a pure function of shape, never of *where* a subtree sits.
    const dedup = new Map<string, number>() // structural signature -> construction index
    let constructionCount = 0
    const instructions: number[] = []

    function signatureOf(node: SemanticType): string
    {
        const t = derefType(node)
        switch(t.kind)
        {
            case SemanticTypeKinds.Unit: return "u"
            case SemanticTypeKinds.Integer: return `i:${t.min}:${t.max}:${t.default}`
            case SemanticTypeKinds.List: return `l:${t.capacity ?? "-"}:${signatureOf(t.elementType)}`
            case SemanticTypeKinds.Struct:
                return `s:${[...t.fields.entries()].map(([k, v]) => `${k}=${signatureOf(v)}`).join(",")}`
            case SemanticTypeKinds.Union:
                return `n:${t.defaultVariant ?? "-"}:${[...t.variants.entries()].map(([k, v]) => `${k}=${signatureOf(v)}`).join(",")}`
        }
    }

    function encodeNode(node: SemanticType): void
    {
        const t: ConcreteSemanticType = derefType(node)
        const sig = signatureOf(t)
        const seenAt = dedup.get(sig)
        if(seenAt !== undefined)
        {
            const delta = constructionCount - seenAt
            instructions.push(...(delta <= 64 ? [0x80 + (delta - 1)] : [PUSH_REF_EXT, ...encodeLeb128(delta)]))
            return
        }

        switch(t.kind)
        {
            case SemanticTypeKinds.Unit: instructions.push(PUSH_UNIT); break
            case SemanticTypeKinds.Integer: instructions.push(...encodeInteger(t)); break
            case SemanticTypeKinds.List:
            {
                encodeNode(t.elementType)
                instructions.push(...(t.capacity === undefined ? [LIST_OP] : [LIST_EXT, ...encodeLeb128(t.capacity)]))
                break
            }
            case SemanticTypeKinds.Struct:
            {
                const fieldNames = [...t.fields.keys()]
                for(const name of fieldNames) encodeNode(t.fields.get(name)!)
                const n = fieldNames.length
                instructions.push(...(n < 64 ? [n] : [STRUCT_EXT, ...encodeLeb128(n)]))
                instructions.push(...encodeNameSpec(fieldNames.map(nameIndex)))
                break
            }
            case SemanticTypeKinds.Union:
            {
                const variantNames = [...t.variants.keys()]
                for(const name of variantNames) encodeNode(t.variants.get(name)!)
                const n = variantNames.length
                instructions.push(...(n < 64 ? [0x40 + n] : [UNION_EXT, ...encodeLeb128(n)]))
                instructions.push(...encodeNameSpec(variantNames.map(nameIndex)))
                const defaultIdx = t.defaultVariant === undefined ? 0 : variantNames.indexOf(t.defaultVariant) + 1
                instructions.push(...encodeLeb128(defaultIdx))
                break
            }
        }

        dedup.set(sig, constructionCount)
        constructionCount++
    }

    encodeNode(root)
    instructions.push(END)

    const table: number[] = [...encodeLeb128(names.length)]
    const encoder = new TextEncoder()
    for(const name of names)
    {
        const utf8 = encoder.encode(name)
        table.push(...encodeLeb128(utf8.length), ...utf8)
    }

    return Uint8Array.from([...table, ...instructions])
}

// ── Decode ───────────────────────────────────────────────────────────────

/** Decode a semantic type tree from `offset` (docs/codec-image.md §6).
 *  `next` is the offset immediately after `END` — the caller's cue for
 *  where the following container section (§7) starts. */
export function decodeTypeTree(bytes: Uint8Array, offset: number = 0): { type: SemanticType; next: number }
{
    let pos = offset

    const countR = decodeLeb128(bytes, pos)
    pos = countR.next
    const names: string[] = []
    const decoder = new TextDecoder()
    for(let i = 0; i < countR.value; i++)
    {
        const lenR = decodeLeb128(bytes, pos)
        const start = lenR.next
        names.push(decoder.decode(bytes.subarray(start, start + lenR.value)))
        pos = start + lenR.value
    }

    const constructions: SemanticType[] = []
    const stack: SemanticType[] = []

    const popN = (n: number): SemanticType[] => stack.splice(stack.length - n, n)

    const push = (t: SemanticType): void => { constructions.push(t); stack.push(t) }

    for(;;)
    {
        const byte = bytes[pos]!
        pos++
        const family = byte >> 6

        if(family === FAMILY_STRUCT || family === FAMILY_UNION)
        {
            const n = byte & 0x3F
            const spec = decodeNameSpec(bytes, pos, n, names)
            pos = spec.next
            const children = popN(n)
            const fields: { [k: string]: SemanticType } = {}
            spec.values.forEach((name, i) => { fields[name] = children[i]! })

            if(family === FAMILY_STRUCT) push(struct(fields))
            else
            {
                const defR = decodeLeb128(bytes, pos)
                pos = defR.next
                const defaultVariant = defR.value === 0 ? undefined : spec.values[defR.value - 1]
                push(union(fields, defaultVariant))
            }
        }
        else if(family === FAMILY_REF)
        {
            const delta = (byte & 0x3F) + 1
            stack.push(constructions[constructions.length - delta]!)
        }
        else switch(byte)
        {
            case PUSH_UNIT: push(unit); break
            case PUSH_U8: push(u8); break
            case PUSH_I8: push(i8); break
            case PUSH_U16: push(u16); break
            case PUSH_I16: push(i16); break
            case PUSH_U32: push(u32); break
            case PUSH_I32: push(i32); break
            case PUSH_INT_MIN0_D0_EXT:
            {
                const maxR = decodeLeb128(bytes, pos); pos = maxR.next
                push(integer(0, maxR.value, 0))
                break
            }
            case PUSH_INT_MIN0_EXT:
            {
                const maxR = decodeLeb128(bytes, pos)
                const defR = decodeSigned(bytes, maxR.next)
                pos = defR.next
                push(integer(0, maxR.value, defR.value))
                break
            }
            case PUSH_INT_D0_EXT:
            {
                const minR = decodeSigned(bytes, pos)
                const maxR = decodeSigned(bytes, minR.next)
                pos = maxR.next
                push(integer(minR.value, maxR.value, 0))
                break
            }
            case PUSH_INT_EXT:
            {
                const minR = decodeSigned(bytes, pos)
                const maxR = decodeSigned(bytes, minR.next)
                const defR = decodeSigned(bytes, maxR.next)
                pos = defR.next
                push(integer(minR.value, maxR.value, defR.value))
                break
            }
            case LIST_OP:
            {
                const element = popN(1)[0]!
                push(list(element))
                break
            }
            case LIST_EXT:
            {
                const capR = decodeLeb128(bytes, pos); pos = capR.next
                const element = popN(1)[0]!
                push(list(element, capR.value))
                break
            }
            case STRUCT_EXT:
            case UNION_EXT:
            {
                const nR = decodeLeb128(bytes, pos)
                const n = nR.value
                const spec = decodeNameSpec(bytes, nR.next, n, names)
                pos = spec.next
                const children = popN(n)
                const fields: { [k: string]: SemanticType } = {}
                spec.values.forEach((name, i) => { fields[name] = children[i]! })

                if(byte === STRUCT_EXT) push(struct(fields))
                else
                {
                    const defR = decodeLeb128(bytes, pos)
                    pos = defR.next
                    const defaultVariant = defR.value === 0 ? undefined : spec.values[defR.value - 1]
                    push(union(fields, defaultVariant))
                }
                break
            }
            case PUSH_REF_EXT:
            {
                const deltaR = decodeLeb128(bytes, pos); pos = deltaR.next
                stack.push(constructions[constructions.length - deltaR.value]!)
                break
            }
            case END:
                if(stack.length !== 1) throw new Error(`decodeTypeTree: END with ${stack.length} values on the stack, expected 1`)
                return { type: stack[0]!, next: pos }
            default:
                throw new Error(`decodeTypeTree: unknown opcode 0x${byte.toString(16)}`)
        }
    }
}
