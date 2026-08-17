/**
 * @ppl/target-js — Bridging a received codec image to a local schema
 * (docs/codec-image.md §2/§3, ROADMAP.md item 12).
 *
 * `codec-module.ts`'s `generateCodecModule` compiles a `buildCodec`-built
 * program against the *same* schema it was built from — every procedure
 * boundary's own `TypeNode` doubles as both "what the wire navigates" and
 * "what the local `Accessor` is keyed by." A codec image (`@ppl/codecs`'s
 * `decodeCodecImage`) breaks that assumption on purpose: its own encoder/
 * decoder programs were compiled by a different, independently-built
 * party, against *its* schema (the "image" tree) — the bytecode's own
 * `ENTER`/`CALL_CODEC` `ref` operands stay positional into that tree
 * forever (codec-image.md §2.1), never rewritten, while the *local*
 * schema this call actually wants to bridge to may have added, dropped, or
 * defaulted fields/variants relative to it.
 *
 * `@ppl/core`'s `reconcile()`/`resolve()` compute the mapping (target- and
 * codec-independent, per their own doc comments); this module is what calls
 * them and turns the result into real JS — mirroring `codec-module.ts`'s
 * own shape almost exactly, with `TypeNode` swapped for `Correspondence`
 * throughout: `procedureBoundaryCorrespondences` (`procedureBoundaryTypes`),
 * `generateProcedures` (same name, `Correspondence`-keyed), and the same
 * `RUNTIME_IMPORTS`/`emitTSDeclarations` assembly at the bottom.
 *
 * `codec-codegen.ts`/`codec-codegen-ext.ts` need no separate "bridging
 * mode" of their own to consume this — every join point already checks
 * `GenCtx.correspondences` and falls back to today's exact behavior when
 * it's absent, which is also exactly why `generateCodecModule` itself
 * needed no changes at all: it simply never populates that field.
 */
import type {RtlProgram, RaisedProc} from "@ppl/machine"
import {raiseProgram} from "@ppl/machine"
import type {SemanticType, TypeNode} from "@ppl/core"
import {buildTypeGraph} from "@ppl/core"
import type {Direction, Correspondence} from "@ppl/core"
import {reconcile} from "@ppl/core"
import type {CodecExtInstr, CodecImage} from "@ppl/codecs"
import {resolveHandleCorrespondences, CODEC_EFFECTS} from "@ppl/codecs"
import type {TsRule, TSTypeDecl} from "./resolver"
import {projectTSTypes, emitTSDeclarations} from "./resolver"
import {tsTypeRules} from "../components/ts-emitter"
import {generateProcedure} from "./codec-codegen"
import {RUNTIME_IMPORTS} from "./codec-module"

/** Recover each reachable procedure's own boundary `Correspondence`, by
 *  index, from `root` — the same recursive descent `codec-module.ts`'s own
 *  `procedureBoundaryTypes` does over plain `TypeNode`s, here over
 *  `Correspondence`s instead (`resolveHandleCorrespondences`, `@ppl/codecs`).
 *  A procedure never reached via `CALL_CODEC`/`CALL_CODEC_NEXT` at all (a
 *  GENERIC-ABI helper, e.g. a delta-coder's own synthesized LEB128
 *  procedure) simply never gets an entry here, exactly like
 *  `procedureBoundaryTypes`'s own `entryTypes.get(i)` — `generateProcedure`
 *  already treats that as "no entry node/correspondence at all," its
 *  existing GENERIC-ABI branch, unaffected by any of this. */
function procedureBoundaryCorrespondences(program: RtlProgram<CodecExtInstr>, root: Correspondence): Map<number, Correspondence>
{
    const correspondences = new Map<number, Correspondence>()

    function visit(procIndex: number, c: Correspondence): void
    {
        if(correspondences.has(procIndex)) return
        correspondences.set(procIndex, c)

        const proc = program.procedures[procIndex]
        if(!proc) throw new Error(`generateBridgingCodecModule: no procedure ${procIndex}`)

        resolveHandleCorrespondences(proc.body, c, visit)
    }

    visit(0, root)
    return correspondences
}

/** All procedures for one direction, as one source block — mirrors
 *  `codec-module.ts`'s own `generateProcedures` exactly, `Correspondence`-
 *  keyed. A procedure's own image `TypeNode` (`generateProcedure`'s
 *  `entryNode` parameter, needed for wire navigation regardless of
 *  bridging) is read straight off its own boundary correspondence's
 *  `imageNode` — always present for anything genuinely reached via
 *  `CALL_CODEC`(`_NEXT`) (`resolveHandleCorrespondences`'s own doc
 *  comment), so no separate `TypeNode` map is needed alongside this one. */
function generateProcedures(
    program: RtlProgram<CodecExtInstr>, correspondences: ReadonlyMap<number, Correspondence>, direction: Direction,
    projection: ReadonlyMap<number, TSTypeDecl>,
): string
{
    const raisedProcs: readonly RaisedProc<CodecExtInstr>[] = raiseProgram(program, {effects: CODEC_EFFECTS})
    return raisedProcs
        .map((raised, i) =>
        {
            const c = correspondences.get(i)
            return generateProcedure(i, raised, c?.imageNode, direction, projection, c)
        })
        .join("\n\n")
}

export interface BridgingCodecModuleOptions
{
    /** Used to name the exported pair: `encode${name}`/`decode${name}`. */
    readonly name: string
    /** A received codec image (`@ppl/codecs`'s `decodeCodecImage`) — its
     *  own `typeTree`/`encoderProgram`/`decoderProgram`, untouched by
     *  reconciliation (codec-image.md §2.1: the bytecode's own addressing
     *  never changes). */
    readonly image: CodecImage
    /** The consumer's own, independently-built schema — what every
     *  generated `Accessor` call actually reads/writes through. */
    readonly localType: SemanticType
    /** Same as `CodecModuleOptions.rules` (`codec-module.ts`) — the
     *  local-representation rule list, defaulting to `tsTypeRules`. */
    readonly rules?: readonly TsRule[]
}

/**
 * Generate one self-contained TypeScript module bridging `opts.image` to
 * `opts.localType`: the projected TS type declarations for the *local*
 * schema, every `encode_procN`/`decode_procN` function (compiled from the
 * *image*'s own already-built `RtlProgram`s, per-instruction bridged via
 * `@ppl/core`'s `reconcile`/`resolve`), and a real, typed
 * `encode${name}`/`decode${name}` entry-point pair whose public value type
 * is the *local* schema's own — exactly `generateCodecModule`'s own
 * contract, just reconciled against a schema that may have evolved
 * relative to the image's.
 */
export function generateBridgingCodecModule(opts: BridgingCodecModuleOptions): string
{
    const {name, image, localType, rules = tsTypeRules} = opts

    const imageGraph = buildTypeGraph(image.typeTree)
    const localGraph = buildTypeGraph(localType)
    // Throws on a root kind mismatch (docs/codec-image.md §2.2) — correct:
    // nothing to bridge otherwise. Always "matched" past that point (both
    // roots are real `TypeNode`s by construction).
    const root = reconcile(imageGraph.root, localGraph.root)

    const encodeCorrespondences = procedureBoundaryCorrespondences(image.encoderProgram, root)
    const decodeCorrespondences = procedureBoundaryCorrespondences(image.decoderProgram, root)

    // Every genuine procedure-boundary *local* TypeNode, across both
    // directions — resolved as explicit `extraRoots` so `accessorFor`
    // never misses one, mirroring `codec-module.ts`'s own reasoning
    // exactly. A boundary reached entirely through image-only navigation
    // has no `localNode` at all — nothing to add here for it (its own
    // procedure compiles via the trivial scratch `Accessor`,
    // `codec-codegen-ext.ts`'s own `localAccessorFor`, never a real
    // projection entry).
    const extraRoots = [...encodeCorrespondences.values(), ...decodeCorrespondences.values()]
        .map(c => c.localNode)
        .filter((n): n is TypeNode => n !== undefined)
        .map(n => n.source as SemanticType)

    const typeResult = projectTSTypes(localType, rules, extraRoots, localGraph)
    const valueType = typeResult.get(localGraph.root.id)?.ref ?? "unknown"

    return `import { ${RUNTIME_IMPORTS.join(", ")} } from "@ppl/target-js/src/runtime/codec-runtime"
import type { Ctx } from "@ppl/target-js/src/runtime/codec-runtime"

${emitTSDeclarations(typeResult)}
${generateProcedures(image.encoderProgram, encodeCorrespondences, "encode", typeResult)}

${generateProcedures(image.decoderProgram, decodeCorrespondences, "decode", typeResult)}

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
