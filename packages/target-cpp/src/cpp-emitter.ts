/**
 * C++ Header Generator (Target Type Mapping projection).
 *
 * Generates idiomatic C++ struct/variant header files from a semantic
 * type tree. This is the "Target data model generation" arrow from
 * ARCHITECTURE.md — independent of the codec IR (wire format) arrow.
 *
 * Architecture:
 * - A ruleset of Rule<TypeDecl> runs via runRuleset.
 * - Each rule produces a TypeDecl (ref string, optional decl, forward, deps).
 * - refOf() resolves the C++ type reference for any node (inline for
 *   leaves/lists/optionals; by-name for structs/unions).
 * - emitCppHeader() walks the result map, emits forward declarations
 *   first, then definitions in dependency order.
 *
 * Pure compile-time host machinery. No IR impact.
 */
import {TypeGraph, TypeNode, child} from "@ppl/core"
import {Rule, rule, runRuleset} from "@ppl/core"
import {TraitRegistry, TypeNameTrait} from "@ppl/core"
import {
    pInteger,
    pUnit,
    pStar,
    pStructFields,
    pUnionFields,
    pList,
    pUnion,
} from "@ppl/core"
import {
    ConcreteSemanticType,
    isInteger,
    isList,
    isStruct,
    isUnion,
    isUnit,
    IntegerType,
    ListType,
    StructType,
    UnionType,
} from "@ppl/core"

/**
 * A C++ type declaration: the capability produced by each rule.
 */
export interface TypeDecl
{
    /** How to reference this type in a field/parameter position. */
    readonly ref: string
    /** If this type needs its own declaration, the full definition text. */
    readonly decl?: string
    /** Forward declaration for cyclic refs (C++ needs this). */
    readonly forward?: string
    /** Node ids this type references (for emission ordering). */
    readonly deps: readonly number[]
}

/**
 * Resolve the C++ type reference for a node (inline for leaves/lists/
 * optionals; by-name for structs/unions). Does NOT require the node
 * to have been matched by the ruleset — used by struct/union produce
 * callbacks to resolve child field types.
 *
 * Structural types (struct/union) are always referenced by name —
 * this is what makes cyclic types work (forward declarations cover
 * the cycle; the ref is the name, not an expanded inline type).
 */
export function refOf(node: TypeNode, graph: TypeGraph, traits: TraitRegistry): string
{
    const t = node.type

    if(isInteger(t))
    {
        return integerRef(t as IntegerType)
    }

    if(isUnit(t))
    {
        return "std::monostate"
    }

    if(isList(t))
    {
        const elemNode = child(node, {element: true})!
        return `std::vector<${refOf(elemNode, graph, traits)}>`
    }

    if(isUnion(t))
    {
        const ut = t as UnionType
        // Optional-shaped: union({value:T, empty:unit}) → std::optional<T>
        const valueEntry = [...ut.variants.entries()].find(([_, v]) => isUnit(v as ConcreteSemanticType) === false)
        const hasEmpty = [...ut.variants.values()].some(v => isUnit(v as ConcreteSemanticType))
        if(valueEntry && hasEmpty && ut.variants.size === 2)
        {
            const valueNode = child(node, {variant: valueEntry[0]})!
            return `std::optional<${refOf(valueNode, graph, traits)}>`
        }
        // Generic union → by name
        return nameOf(node.id, traits)
    }

    if(isStruct(t))
    {
        return nameOf(node.id, traits)
    }

    return "/* unknown */"
}

/** Pick the smallest fixed-width C++ integer type that fits the range. */
function integerRef(t: {min: number, max: number}): string
{
    const {min, max} = t
    if(min >= 0)
    {
        if(max <= 255)        return "uint8_t"
        if(max <= 65535)      return "uint16_t"
        if(max <= 4294967295) return "uint32_t"
        return "uint64_t"
    }
    else
    {
        if(min >= -128 && max <= 127)         return "int8_t"
        if(min >= -32768 && max <= 32767)     return "int16_t"
        if(min >= -2147483648 && max <= 2147483647) return "int32_t"
        return "int64_t"
    }
}

/** Resolve a type's C++ name: TypeNameTrait if present, else T<id>. */
function nameOf(nodeId: number, traits: TraitRegistry): string
{
    return traits.get(TypeNameTrait, nodeId) ?? `T${nodeId}`
}

/**
 * The C++ target ruleset.
 *
 * Rule priority (first match wins):
 * 1. Integers → fixed-width C++ types (leaf, no decl)
 * 2. Unit → std::monostate (leaf, no decl)
 * 3. Optional union (union{value:T, empty:unit}) → std::optional<T> (inline, no decl)
 * 4. Struct → C++ struct with named fields (decl + forward)
 * 5. Generic union → C++ struct wrapping std::variant (decl + forward)
 * 6. List → std::vector<T> (inline, no decl)
 *
 * All structural rules use pStar() on children → children are independently
 * matched, getting their own TypeDecls. refOf() resolves child refs inline
 * (for leaves) or by-name (for structs/unions).
 */
export function cppRules(): ReadonlyArray<Rule<TypeDecl>>
{
    return [
        // 1. Integers → fixed-width C++ types (catch-all: any integer range)
        rule(pInteger(-Infinity, Infinity),
             (match) => ({ref: integerRef(match), deps: []})),

        // 2. Unit → std::monostate
        rule(pUnit(),
             () => ({ref: "std::monostate", deps: []})),

        // 3. Optional: union({value:T, empty:unit}) → std::optional<T>
        rule(pUnion({value: pStar(), empty: pUnit()}),
             (_m, nodeId, graph, traits) => {
                 const valueNode = child(graph.nodes.get(nodeId)!, {variant: "value"})!
                 return {ref: `std::optional<${refOf(valueNode, graph, traits)}>`, deps: [valueNode.id]}
             }),

        // 4. Struct → C++ struct with named fields
        rule(pStructFields(pStar()),
             (_m, nodeId, graph, traits) => {
                 const node = graph.nodes.get(nodeId)!
                 const name = nameOf(nodeId, traits)
                 const fieldLines = node.edges.map(e => {
                     const fieldName = "field" in e.step ? e.step.field : "_"
                     return `    ${refOf(e.target, graph, traits)} ${fieldName};`
                 })
                 return {
                     ref: name,
                     forward: `struct ${name};`,
                     decl: `struct ${name} {\n${fieldLines.join("\n")}\n};`,
                     deps: node.edges.map(e => e.target.id),
                 }
             }),

        // 5. Generic union → C++ struct wrapping std::variant
        rule(pUnionFields(pStar()),
             (_m, nodeId, graph, traits) => {
                 const node = graph.nodes.get(nodeId)!
                 const name = nameOf(nodeId, traits)
                 const variantTypes = node.edges.map(e => refOf(e.target, graph, traits))
                 return {
                     ref: name,
                     forward: `struct ${name};`,
                     decl: `struct ${name} { std::variant<${variantTypes.join(", ")}> data; };`,
                     deps: node.edges.map(e => e.target.id),
                 }
             }),

        // 6. List → std::vector<T>
        rule(pList(pStar()),
             (_m, nodeId, graph, traits) => {
                 const elemNode = child(graph.nodes.get(nodeId)!, {element: true})!
                 return {ref: `std::vector<${refOf(elemNode, graph, traits)}>`, deps: [elemNode.id]}
             }),
    ]
}

/**
 * Emit a complete C++ header file from a ruleset result.
 *
 * Emits:
 * 1. #include guards + standard headers
 * 2. Forward declarations for all named types (handles cycles)
 * 3. Type definitions in node-id order (forward decls cover cycles)
 * 4. A root type alias
 */
export function emitCppHeader(
    result: Map<number, TypeDecl>,
    graph: TypeGraph,
    rootName?: string,
): string
{
    const lines: string[] = []

    // Header guard + includes
    lines.push("#pragma once")
    lines.push("#include <cstdint>")
    lines.push("#include <optional>")
    lines.push("#include <variant>")
    lines.push("#include <vector>")
    lines.push("#include <monostate>")
    lines.push("")

    // Forward declarations for types that have a `forward`
    for(const [nodeId, decl] of result)
    {
        if(decl.forward)
        {
            lines.push(decl.forward)
        }
    }
    lines.push("")

    // Type definitions in node-id order
    for(const [nodeId, decl] of result)
    {
        if(decl.decl)
        {
            lines.push(decl.decl)
            lines.push("")
        }
    }

    // Root type alias
    const rootDecl = result.get(graph.root.id)
    if(rootDecl)
    {
        const aliasName = rootName ?? "Root"
        lines.push(`using ${aliasName} = ${rootDecl.ref};`)
    }

    return lines.join("\n")
}

/**
 * Convenience: build the TypeGraph, run the C++ ruleset, and emit the header.
 */
export function generateCppHeader(
    rootType: import("@ppl/core").SemanticType,
    rootName?: string,
): string
{
    // Lazy import to avoid circular dependency at module load
    const {buildTypeGraph} = require("@ppl/core")
    const {extractTraits} = require("@ppl/core")

    const graph: TypeGraph = buildTypeGraph(rootType)
    const traits: TraitRegistry = extractTraits(graph)
    const result = runRuleset(graph, cppRules(), traits)
    return emitCppHeader(result, graph, rootName)
}
