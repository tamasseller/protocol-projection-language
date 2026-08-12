/**
 * @ppl/target-js — Codec codegen's public entry point.
 *
 * `codec-codegen.ts` translates one `RaisedProc` into one JS `function`;
 * this module is the whole-program layer around it — raising both
 * directions' `RtlProgram`s, resolving each procedure's entry `TypeNode`
 * (`@ppl/codecs`'s `resolveProcedureTypes`), and assembling the result
 * into one self-contained TypeScript module with a real, typed
 * `encode${name}`/`decode${name}` pair at the bottom.
 */
import type {RtlProgram, RaisedProc} from "@ppl/machine"
import {raiseProgram} from "@ppl/machine"
import type {SemanticType} from "@ppl/core"
import {buildTypeGraph} from "@ppl/core"
import type {Direction, CodecExtInstr} from "@ppl/codecs"
import {resolveProcedureTypes, CODEC_EFFECTS} from "@ppl/codecs"
import {projectTSTypes, emitTSDeclarations} from "./resolver"
import {tsTypeRules} from "../components/ts-emitter"
import {isStructKind} from "./codec-type-nav"
import {generateProcedure} from "./codec-codegen"

/** All procedures for one direction, as one source block — `program` and
 *  `rootType` must be the ones actually passed to the matching
 *  `buildCodec` call (encode/decode programs from the same schema have
 *  unrelated procedure indices; nothing here assumes otherwise, but a
 *  mismatched pair would generate nonsense silently, so get this from the
 *  same `buildCodec(root, {encode,decode}Rules, ...)` call it names). */
function generateProcedures(program: RtlProgram<CodecExtInstr>, rootType: SemanticType, direction: Direction): string
{
    const entryTypes = resolveProcedureTypes(program, rootType)
    const raisedProcs: readonly RaisedProc<CodecExtInstr>[] = raiseProgram(program, {effects: CODEC_EFFECTS})
    return raisedProcs
        .map((raised, i) => generateProcedure(i, raised, entryTypes.get(i)!, direction))
        .join("\n\n")
}

export interface CodecModuleOptions
{
    /** Used to name the exported pair: `encode${name}`/`decode${name}`. */
    readonly name: string
    readonly rootType: SemanticType
    readonly encodeProgram: RtlProgram<CodecExtInstr>
    readonly decodeProgram: RtlProgram<CodecExtInstr>
}

const RUNTIME_IMPORTS = [
    "getH", "setH", "ensureStruct", "ensured", "enterVariant", "activeVariantPayload",
    "tagOf", "nextChild", "openList", "countOf", "loadVal", "storeVal",
    "read", "write", "hasNext", "cloneRd", "cloneWr", "seek", "writeSeq", "readSeq", "CodecTrap",
] as const

/**
 * Generate one self-contained TypeScript module: the projected TS type
 * declarations for `rootType` (this package's own existing type codegen,
 * `components/ts-emitter.ts`), every `encode_procN`/`decode_procN`
 * function, and a real, typed `encode${name}`/`decode${name}` entry-point
 * pair. Import it, or pass it to `ts-check.ts`'s `assertCompiles` (test
 * suite only) — this function only ever returns text, never touches
 * `ts.transpileModule`/`eval` itself.
 */
export function generateCodecModule(opts: CodecModuleOptions): string
{
    const {name, rootType, encodeProgram, decodeProgram} = opts

    const typeResult = projectTSTypes(rootType, tsTypeRules)
    const rootNode = buildTypeGraph(rootType).root
    const valueType = typeResult.get(rootNode.id)?.ref ?? "unknown"
    const rootIsStruct = isStructKind(resolveProcedureTypes(encodeProgram, rootType).get(0)!)

    // Uint8Array at the public boundary — the standard cross-runtime
    // (Node and browser) binary type, and what a caller actually wants
    // to hand to `fs.writeFile`/`Response`/`WebSocket.send`/etc. Internally
    // `Ctx.buffer` stays a plain `number[]` (codec-runtime.ts's own doc
    // comment): encoding needs a *growable* sink (WRITE appends past the
    // current length), which a fixed-size Uint8Array can't do, so the
    // conversion to Uint8Array happens once, only on the way out/in here —
    // never inside the runtime helpers themselves.
    const ensureStructLine = rootIsStruct ? "    ensureStruct(root)\n" : ""

    return `import { ${RUNTIME_IMPORTS.join(", ")} } from "@ppl/target-js/src/runtime/codec-runtime"
import type { Handle, Ctx } from "@ppl/target-js/src/runtime/codec-runtime"
import { evalBinary, evalUnary } from "@ppl/machine"

${emitTSDeclarations(typeResult)}
${generateProcedures(encodeProgram, rootType, "encode")}

${generateProcedures(decodeProgram, rootType, "decode")}

export function encode${name}(value: ${valueType}): Uint8Array {
    const buffer: number[] = []
    const ctx: Ctx = { buffer, iters: [{ pos: 0, capability: "write", overwriteOnly: false }] }
    encode_proc0({ c: { v: value }, k: "v" }, ctx)
    return new Uint8Array(buffer)
}

export function decode${name}(bytes: Uint8Array): ${valueType} {
    const ctx: Ctx = { buffer: Array.from(bytes), iters: [{ pos: 0, capability: "read", overwriteOnly: false }] }
    const root: Handle = { c: {}, k: "v" }
${ensureStructLine}    decode_proc0(root, ctx)
    return getH(root) as ${valueType}
}`
}
