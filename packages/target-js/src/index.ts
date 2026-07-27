/**
 * @ppl/target-js — JavaScript/TypeScript target emitter.
 *
 * Generates idiomatic JS/TS type declarations and runtime codec
 * functions from the semantic type graph. The JS target emits
 * DataView-based, zero-allocation encoders/decoders.
 *
 * This is a stub — full implementation pending.
 */
import {
    TypeGraph,
    TypeNode,
    TraitRegistry,
    TypeNameTrait,
} from "@ppl/core"

// ——————————————————————————————————————————————
// Placeholder: JS type reference resolution
// ——————————————————————————————————————————————

/** Resolve a JS/TS type reference for a node (inline or by-name). */
export function jsRefOf(
    node: TypeNode,
    graph: TypeGraph,
    traits: TraitRegistry,
): string
{
    // Placeholder — full implementation pending
    return traits.get(TypeNameTrait, node.id) ?? `T${node.id}`
}

// ——————————————————————————————————————————————
// Placeholder: JS type declaration emission
// ——————————————————————————————————————————————

export interface JsTypeDecl
{
    readonly ref: string
    readonly decl?: string
    readonly deps: readonly number[]
}

/**
 * Generate a TypeScript type declaration string from the semantic
 * type graph. Stub — returns a placeholder.
 */
export function generateJsTypes(
    _rootType: import("@ppl/core").SemanticType,
    _rootName?: string,
): string
{
    return "// @ppl/target-js: type generation not yet implemented\n"
}

/**
 * Generate JavaScript runtime codec functions from the semantic
 * type graph. Stub — returns a placeholder.
 */
export function generateJsCodecs(
    _rootType: import("@ppl/core").SemanticType,
    _rootName?: string,
): string
{
    return "// @ppl/target-js: codec generation not yet implemented\n"
}
