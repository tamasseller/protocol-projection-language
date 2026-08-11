/**
 * @ppl/target-js — JavaScript/TypeScript target emitter.
 *
 * Generates idiomatic JS/TS type declarations from the semantic type
 * graph. The JS target is the "Proper Platform" side of the three-way
 * split — the desktop/server/cloud consumer that parses telemetry.
 *
 * Two API levels:
 *  - Ruleset API (composable): `tsTypeRules`, `projectTSTypes`,
 *    `emitTSDeclarations`, `TSTypeDecl` — for projects that want to
 *    compose this projection with others over a shared type graph.
 *  - Convenience API (one-shot): `generateJsTypes` / `generateJsCodecs`
 *    — build the graph and emit in a single call.
 *
 * Codec (encoder/decoder) generation: compiled-source JS, not an
 * interpreter call — `components/codec-codegen.ts`'s `generateCodecModule`
 * turns a `buildCodec`-produced `RtlProgram` pair (`@ppl/codecs`) into
 * literal `encode`/`decode` functions, one JS `function` per procedure,
 * built on `@ppl/machine`'s `raise.ts` for control-flow shape and
 * `@ppl/codecs`'s `resolveProcedureTypes` for field/variant names.
 * `runtime/codec-runtime.ts` is the small, genuinely-dynamic primitive set
 * (buffer position, byte read/write, container/key indirection) the
 * generated code calls into — see that module's own doc comment.
 *
 * Grouped like `@ppl/codecs` (docs/ARCHITECTURE.md's "Mappings" layering):
 * `engine/` is the generic on-demand resolver primitive
 * (`TsRule`/`createTsResolver`/`projectTSTypes`/`emitTSDeclarations`),
 * `components/` is the concrete, swappable rule library built on it
 * (`tsTypeRules`, `generateCodecModule`), `runtime/` is what the
 * *generated* code depends on at its own run time, not what this package
 * depends on to generate it.
 */
export * from "./engine/resolver"
export * from "./components/ts-emitter"
export * from "./components/ts-alternative-rules"
export * from "./components/codec-codegen"
export * from "./runtime/codec-runtime"

import type {SemanticType} from "@ppl/core"
import {projectTSTypes, emitTSDeclarations} from "./engine/resolver"
import {tsTypeRules} from "./components/ts-emitter"
import {generateCodecModule} from "./components/codec-codegen"
import {buildCodec, binaryEncodeRules, binaryDecodeRules} from "@ppl/codecs"

/**
 * One-shot: project `rootType` and emit TypeScript declarations.
 * Convenience wrapper around the composable rule-based API.
 */
export function generateJsTypes(
    rootType: SemanticType,
    _rootName?: string,
): string
{
    const result = projectTSTypes(rootType, tsTypeRules)
    return emitTSDeclarations(result)
}

/**
 * One-shot: emit compiled `encode`/`decode` functions for `rootType`,
 * using `@ppl/codecs`'s default binary wire format. `rootName` names the
 * exported pair (`encode${rootName}`/`decode${rootName}`) — defaults to
 * "Root" for an anonymous type, matching `generateJsTypes`'s own "no name
 * available" convention (`nameOf`, `components/ts-emitter.ts`).
 */
export function generateJsCodecs(
    rootType: SemanticType,
    rootName = "Root",
): string
{
    const encodeProgram = buildCodec(rootType, binaryEncodeRules, undefined)
    const decodeProgram = buildCodec(rootType, binaryDecodeRules, undefined)
    return generateCodecModule({ name: rootName, rootType, encodeProgram, decodeProgram })
}
