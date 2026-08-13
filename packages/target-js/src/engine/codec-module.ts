/**
 * @ppl/target-js — Codec codegen's public entry point.
 *
 * `codec-codegen.ts` translates one `RaisedProc` into one JS `function`;
 * this module is the whole-program layer around it — raising both
 * directions' `RtlProgram`s, resolving each procedure's entry `TypeNode`
 * (`@ppl/codecs`'s `resolveProcedureTypes`) and its own local-
 * representation `Accessor` (this module's own `projectTSTypes` call,
 * `./resolver.ts`), and assembling the result into one self-contained
 * TypeScript module with a real, typed `encode${name}`/`decode${name}`
 * pair at the bottom.
 */
import type {RtlProgram, RaisedProc} from "@ppl/machine"
import {raiseProgram} from "@ppl/machine"
import type {SemanticType} from "@ppl/core"
import {buildTypeGraph} from "@ppl/core"
import type {Direction, CodecExtInstr} from "@ppl/codecs"
import {resolveProcedureTypes, CODEC_EFFECTS} from "@ppl/codecs"
import type {TsRule, TSTypeDecl} from "./resolver"
import {projectTSTypes, emitTSDeclarations} from "./resolver"
import {tsTypeRules} from "../components/ts-emitter"
import {generateProcedure} from "./codec-codegen"

/** All procedures for one direction, as one source block — `program` and
 *  `rootType` must be the ones actually passed to the matching
 *  `buildCodec` call (encode/decode programs from the same schema have
 *  unrelated procedure indices; nothing here assumes otherwise, but a
 *  mismatched pair would generate nonsense silently, so get this from the
 *  same `buildCodec(root, {encode,decode}Rules, ...)` call it names).
 *  `projection` is shared across both directions — it's purely about the
 *  local representation, direction-independent. */
function generateProcedures(
    program: RtlProgram<CodecExtInstr>, rootType: SemanticType, direction: Direction,
    projection: ReadonlyMap<number, TSTypeDecl>,
): string
{
    const entryTypes = resolveProcedureTypes(program, rootType)
    const raisedProcs: readonly RaisedProc<CodecExtInstr>[] = raiseProgram(program, {effects: CODEC_EFFECTS})
    return raisedProcs
        .map((raised, i) => generateProcedure(i, raised, entryTypes.get(i)!, direction, projection))
        .join("\n\n")
}

export interface CodecModuleOptions
{
    /** Used to name the exported pair: `encode${name}`/`decode${name}`. */
    readonly name: string
    readonly rootType: SemanticType
    readonly encodeProgram: RtlProgram<CodecExtInstr>
    readonly decodeProgram: RtlProgram<CodecExtInstr>
    /** The local-representation rule list — defaults to `tsTypeRules`
     *  (the same default `projectTSTypes` callers reach for elsewhere).
     *  Pass `[...myOverrides, ...tsTypeRules]` to opt a specific shape
     *  into an alternative representation (`ts-alternative-rules.ts`) —
     *  `codec-codegen.ts` consumes whichever `Accessor` this projection
     *  produced, so the compiled codec always matches whatever these
     *  rules actually declared, never a hard-coded assumption. */
    readonly rules?: readonly TsRule[]
}

const RUNTIME_IMPORTS = [
    "read", "write", "hasNext", "cloneRd", "cloneWr", "seek", "writeSeq", "readSeq", "tagOf", "signExtend", "CodecTrap",
] as const

/**
 * Generate one self-contained TypeScript module: the projected TS type
 * declarations for `rootType` (this package's own existing type codegen,
 * `components/ts-emitter.ts` by default), every `encode_procN`/
 * `decode_procN` function, and a real, typed `encode${name}`/
 * `decode${name}` entry-point pair. Import it, or pass it to
 * `ts-check.ts`'s `assertCompiles` (test suite only) — this function only
 * ever returns text, never touches `ts.transpileModule`/`eval` itself.
 */
export function generateCodecModule(opts: CodecModuleOptions): string
{
    const {name, rootType, encodeProgram, decodeProgram, rules = tsTypeRules} = opts

    const typeResult = projectTSTypes(rootType, rules)
    const rootNode = buildTypeGraph(rootType).root
    const valueType = typeResult.get(rootNode.id)?.ref ?? "unknown"

    return `import { ${RUNTIME_IMPORTS.join(", ")} } from "@ppl/target-js/src/runtime/codec-runtime"
import type { Ctx } from "@ppl/target-js/src/runtime/codec-runtime"
import { evalBinary, evalUnary } from "@ppl/machine"

${emitTSDeclarations(typeResult)}
${generateProcedures(encodeProgram, rootType, "encode", typeResult)}

${generateProcedures(decodeProgram, rootType, "decode", typeResult)}

export function encode${name}(value: ${valueType}): Uint8Array {
    const buffer: number[] = []
    const ctx: Ctx = { buffer, iters: [{ pos: 0, capability: "write", overwriteOnly: false }] }
    encode_proc0(value, ctx)
    return new Uint8Array(buffer)
}

export function decode${name}(bytes: Uint8Array): ${valueType} {
    const ctx: Ctx = { buffer: Array.from(bytes), iters: [{ pos: 0, capability: "read", overwriteOnly: false }] }
    return decode_proc0(ctx)
}`
}
