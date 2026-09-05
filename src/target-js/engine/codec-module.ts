/**
 * target-js — Codec codegen's public entry point.
 *
 * `codec-codegen.ts` translates one `RaisedProc` into one JS `function`;
 * this module is the whole-program layer around it — raising both
 * directions' `RtlProgram`s, resolving each procedure's entry `TypeNode`
 * and its own local-representation `Accessor` (this module's own
 * `projectTSTypes` call, `./resolver.ts`), and assembling the result into
 * one self-contained TypeScript module with a real, typed
 * `encode${name}`/`decode${name}` pair at the bottom.
 *
 * Exactly one `TypeGraph` gets built for the whole call (`graph`, below)
 * — deliberately, not one per direction plus one inside `projectTSTypes`.
 * `codecs`'s own `resolveProcedureTypes` builds its own graph
 * internally, which would make this module's own procedure-boundary
 * `TypeNode`s (fed into `projectTSTypes` as `extraRoots`, so
 * codec-codegen.ts's `accessorFor` never misses one) *not* the same
 * objects `projectTSTypes`'s own resolution produces for a thunked/self-
 * referential schema (`src/core/type-graph.ts`'s own header comment:
 * dereferencing a thunk twice, independently, produces two structurally-
 * equivalent but non-identical nested objects) — exactly the bug
 * `src/codecs/engine/procedure-types.ts`'s own header describes fixing
 * once already, elsewhere (`classifyHoistableFields`). So this module
 * builds `graph` itself and drives the same procedure-boundary walk
 * locally via the lower-level `resolveHandleTypes` (which takes an
 * already-resolved entry `TypeNode`, no graph of its own) instead of
 * calling `resolveProcedureTypes`, and passes `graph` straight through to
 * `projectTSTypes` too — one graph, shared everywhere in this call.
 */
import type {RtlProgram, RaisedProc} from "mog-core"
import {raiseProgram} from "mog-core"
import type {SemanticType, TypeGraph, TypeNode} from "../../core/index"
import {buildTypeGraph} from "../../core/index"
import type {Direction, CodecExtInstr} from "../../codecs/index"
import {resolveHandleTypes, CODEC_EFFECTS} from "../../codecs/index"
import type {TsRule, TSTypeDecl} from "./resolver"
import {projectTSTypes, emitTSDeclarations} from "./resolver"
import {tsTypeRules} from "../components/ts-emitter"
import {generateProcedure} from "./codec-codegen"

/** Recover each reachable procedure's own `TypeNode`, by index, from
 *  `graph.root` — the same recursive descent `codecs`'s own
 *  `resolveProcedureTypes` does, reusing its exported building block
 *  (`resolveHandleTypes`, written for exactly this kind of external
 *  reuse — see its own doc comment), but seeded from a graph *this*
 *  module already built rather than a second, independently-built one.
 *  Memoized by procedure index for cycle safety, same reason. */
function procedureBoundaryTypes(program: RtlProgram<CodecExtInstr>, graph: TypeGraph): Map<number, TypeNode>
{
    const types = new Map<number, TypeNode>()

    function visit(procIndex: number, node: TypeNode): void
    {
        if(types.has(procIndex)) return
        types.set(procIndex, node)

        const proc = program.procedures[procIndex]
        if(!proc) throw new Error(`generateCodecModule: no procedure ${procIndex}`)

        resolveHandleTypes(proc.body, node, visit)
    }

    visit(0, graph.root)
    return types
}

/** All procedures for one direction, as one source block. `entryTypes`
 *  must be the ones actually resolved against `program` (encode/decode
 *  programs from the same schema have unrelated procedure indices; a
 *  mismatched pair would generate nonsense silently) — `generateCodecModule`
 *  passes in what it already computed via `procedureBoundaryTypes`,
 *  rather than this function recomputing its own.
 *  `projection` is shared across both directions — it's purely about the
 *  local representation, direction-independent. */
function generateProcedures(
    program: RtlProgram<CodecExtInstr>, entryTypes: ReadonlyMap<number, TypeNode>, direction: Direction,
    projection: ReadonlyMap<number, TSTypeDecl>,
): string
{
    const raisedProcs: readonly RaisedProc<CodecExtInstr>[] = raiseProgram(program, {effects: CODEC_EFFECTS})
    return raisedProcs
        .map((raised, i) => generateProcedure(i, raised, entryTypes.get(i), direction, projection))
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

/** Exported for `bridging-codec-module.ts`'s own `generateBridgingCodecModule`
 *  — the same fixed, unconditionally-imported runtime-helper list, since a
 *  bridged module's generated procedures call into exactly the same
 *  `codec-runtime.ts` surface an ordinary one does (see this file's own
 *  header for why an unused import is harmless: no `noUnusedLocals`
 *  anywhere in this repo's tsconfigs). */
export const RUNTIME_IMPORTS = [
    "read", "write", "hasNext", "cloneRd", "cloneWr", "seek", "writeSeq", "readSeq", "readSeqView", "writeSeqRaw",
    "tagOf", "signExtend", "revBits", "CodecTrap",
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

    // One graph, shared by everything below — see this module's own
    // header comment for why a second, independently-built one (e.g.
    // `codecs`'s own `resolveProcedureTypes`) isn't interchangeable.
    const graph = buildTypeGraph(rootType)

    // Every genuine CALL_CODEC/procedure-boundary TypeNode, across both
    // directions — resolved as explicit `extraRoots` below so
    // codec-codegen.ts's own `accessorFor` never misses one, without a
    // blind "resolve literally everything reachable" sweep (a TsRule's
    // own produce()/refOf() only calls resolve() on a child whose
    // *declaration text* it actually needs, a strictly narrower set —
    // see resolver.ts's own `projectTSTypes` doc comment). `node.source`,
    // not `node.type`: `TypeGraph.nodeOf` (which `projectTSTypes`'s own
    // resolve() uses internally) is keyed by the original, possibly-thunk
    // object, not the already-dereferenced concrete type.
    const encodeEntryTypes = procedureBoundaryTypes(encodeProgram, graph)
    const decodeEntryTypes = procedureBoundaryTypes(decodeProgram, graph)
    const extraRoots = [...encodeEntryTypes.values(), ...decodeEntryTypes.values()].map(node => node.source as SemanticType)

    const typeResult = projectTSTypes(rootType, rules, extraRoots, graph)
    const valueType = typeResult.get(graph.root.id)?.ref ?? "unknown"

    return `import { ${RUNTIME_IMPORTS.join(", ")} } from "ppl"
import type { Ctx } from "ppl"

${emitTSDeclarations(typeResult)}
${generateProcedures(encodeProgram, encodeEntryTypes, "encode", typeResult)}

${generateProcedures(decodeProgram, decodeEntryTypes, "decode", typeResult)}

export function encode${name}(value: ${valueType}): Uint8Array {
    const ctx: Ctx = { buffer: new Uint8Array(64), length: 0, iters: [{ pos: 0, capability: "write", overwriteOnly: false }] }
    encode_proc0(value, ctx)
    return ctx.buffer.subarray(0, ctx.length)
}

export function decode${name}(bytes: Uint8Array): ${valueType} {
    const ctx: Ctx = { buffer: bytes, length: bytes.length, iters: [{ pos: 0, capability: "read", overwriteOnly: false }] }
    return decode_proc0(ctx)
}`
}
