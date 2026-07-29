/**
 * compose.ts — The composition layer.
 *
 * This is the heart of the three-way split: it takes the SHARED semantic
 * schema (this project's only real asset) and COMPOSES the generic
 * projection packages over it to produce three independent artifacts:
 *
 *   ┌─────────────┐   cTypeRules    (@ppl/target-cpp)    ┌──────────────┐
 *   │  schema.ts  │ ──────────────────────────────────▶ │  C header    │
 *   │ (semantic)  │                                      │  (embedded)  │
 *   │             │   wireFormatRules (@ppl/codecs)      ├──────────────┤
 *   │             │ ──────────────────────────────────▶ │  wire shapes │
 *   │             │                                      ├──────────────┤
 *   │             │   tsTypeRules    (@ppl/target-js)    │  TS decls    │
 *   │             │ ──────────────────────────────────▶ │  (desktop)   │
 *   └─────────────┘                                      └──────────────┘
 *
 * The example owns NOTHING generic here — no rulesets, no emitters.
 * It only:
 *   1. Defines the domain schema (schema.ts).
 *   2. Builds the shared type graph + traits once.
 *   3. Applies each package's projection to that single graph.
 *
 * Change the schema → all three artifacts regenerate consistently.
 * Swap a package → only that artifact changes. This is composition.
 */
import {buildTypeGraph, extractTraits, TypeGraph, TraitRegistry} from "@ppl/core"
import {projectCTypes, emitCHeader, CTypeDecl} from "@ppl/target-cpp"
import {projectWireFormat, WireShape} from "@ppl/codecs"
import {projectTSTypes, emitTSDeclarations, TSTypeDecl} from "@ppl/target-js"

import {TelemetryPacket} from "./schema"

// ——————————————————————————————————————————————
// Shared foundation (built once, reused by all three projections)
// ——————————————————————————————————————————————

/** The finitized type graph for TelemetryPacket. */
export const graph: TypeGraph = buildTypeGraph(TelemetryPacket)

/** Traits (type names) extracted from the schema. */
export const traits: TraitRegistry = extractTraits(graph)

// ——————————————————————————————————————————————
// Composed artifacts
// ——————————————————————————————————————————————

/** Embedded C header (no STL) projected from the schema. */
export const cTypes: Map<number, CTypeDecl> = projectCTypes(graph, traits)
export const cHeader: string = emitCHeader(cTypes)

/** Binary wire-format shapes projected from the schema. */
export const wireShapes: Map<number, WireShape> = projectWireFormat(graph)

/** TypeScript declarations (desktop/server) projected from the schema. */
export const tsTypes: Map<number, TSTypeDecl> = projectTSTypes(graph, traits)
export const tsDeclarations: string = emitTSDeclarations(tsTypes)
