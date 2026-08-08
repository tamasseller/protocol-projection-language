/**
 * @ppl/codecs — The codec extension's opcode vocabulary (docs/codec-
 * extension.md §3)
 *
 * The single source of truth for the 15 mnemonics `codec-extension.ts`'s
 * `codecRules()`/`EFFECTS`/`exec()` and `validate-handles.ts`'s static
 * checks all dispatch on — every op in §3, including the stream-fork
 * class (`HAS_NEXT`/`CLONE_RD`/`CLONE_WR`/`SEEK`). A typo in any one
 * wouldn't be caught by anything otherwise (`ExtInstr.ext` is a bare
 * `string` — opaque to `@ppl/machine` by design, isa-core.md §5.1);
 * `CodecOpcode` lets `EFFECTS` be typed `Record<CodecOpcode, ExtOpEffect>`
 * (missing/misspelled key ⇒ compile error) and lets `exec`/
 * `validate-handles.ts`'s dispatches be checked exhaustively via
 * `assertNever` below.
 *
 * Deliberately NOT used to regenerate `codecRules()`'s own rule table —
 * that stays a flat, literal `rule(...)` list by design (each entry is a
 * distinct DSL surface with its own argument pattern, not a uniform
 * shape a data table could drive without re-obscuring it).
 */

export const CODEC_OPCODES = [
    "ENTER",
    "ENTER_NEXT",
    "LOAD_VAL",
    "STORE_VAL",
    "COUNT",
    "TAG",
    "OPEN_LIST",
    "READ",
    "WRITE",
    "HAS_NEXT",
    "CLONE_RD",
    "CLONE_WR",
    "SEEK",
    "CALL_CODEC", "CALL_CODEC_NEXT",
] as const

export type CodecOpcode = typeof CODEC_OPCODES[number]

const CODEC_OPCODE_SET: ReadonlySet<string> = new Set(CODEC_OPCODES)

/** Narrows a bare `ExtInstr.ext` string to `CodecOpcode` — the runtime
 *  counterpart of the compile-time union, needed once per dispatch site
 *  since `@ppl/machine` itself never knows this vocabulary. */
export function isCodecOpcode(ext: string): ext is CodecOpcode
{
    return CODEC_OPCODE_SET.has(ext)
}

/** Exhaustiveness assertion for a `switch`/`if`-chain over `CodecOpcode`:
 *  reachable only if some future opcode was added to `CODEC_OPCODES`
 *  without a matching case here, in which case TS itself rejects the
 *  call site (the `never` parameter type) before this ever runs. */
export function assertNever(op: never): never
{
    throw new Error(`codec extension: unhandled opcode "${op}"`)
}
