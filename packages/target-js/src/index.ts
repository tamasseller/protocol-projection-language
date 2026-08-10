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
 * Codec (encoder/decoder) generation is still pending — see
 * `generateJsCodecs`.
 */
export * from "./ts-emitter"

import {SemanticType, TypeGraph, buildTypeGraph} from "@ppl/core"
import {projectTSTypes, emitTSDeclarations} from "./ts-emitter"

/**
 * One-shot: build the type graph for `rootType` and emit TypeScript
 * declarations. Convenience wrapper around the composable ruleset API.
 */
export function generateJsTypes(
    rootType: SemanticType,
    _rootName?: string,
): string
{
    const graph: TypeGraph = buildTypeGraph(rootType)
    const result = projectTSTypes(graph)
    return emitTSDeclarations(result)
}

/**
 * One-shot: emit runtime codec functions (encoder/decoder) for `rootType`.
 *
 * STATUS: STUB — codec IR generation is not yet implemented. Returns a
 * placeholder so dependents can wire up the call site today.
 */
export function generateJsCodecs(
    _rootType: SemanticType,
    _rootName?: string,
): string
{
    return "// @ppl/target-js: codec generation not yet implemented\n"
}
