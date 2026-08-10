/**
 * c-emitter.ts — Bare-metal C type projection (NO STL).
 *
 * Projects the semantic type graph into idiomatic bare-metal C types:
 *  - Fixed-size arrays instead of std::vector
 *  - Manual tagged unions (tag byte + union payload) instead of std::variant
 *  - No heap allocation — every type has a compile-time-known size
 *  - C99-compatible (no C++ features)
 *
 * This is the *embedded* dialect of the C/C++ target, distinct from the
 * STL-based C++ emitter in `cpp-emitter.ts`. It uses the projection runner
 * (runRuleset) to walk the type graph and produce CTypeDecl capabilities
 * per node.
 *
 * Pure compile-time host machinery. No IR impact.
 */
import {
    TypeGraph,
    TypeNode,
    child,
    Rule,
    rule,
    runRuleset,
} from "@ppl/core"
import {
    nameOf as declaredNameOf,
} from "@ppl/core"
import {
    pInteger,
    pUnit,
    pStar,
    pStructFields,
    pUnion,
    pUnionFields,
} from "@ppl/core"
import {
    IntegerType,
    ListType,
    isInteger,
    isList,
    isUnit,
} from "@ppl/core"

// ——————————————————————————————————————————————
// Capability type
// ——————————————————————————————————————————————

export interface CTypeDecl
{
    /** How to reference this type in a field position (e.g. "uint8_t", "Timestamp"). */
    readonly ref: string
    /** Full type definition (typedef), if this node needs one. */
    readonly decl?: string
    /** Forward declaration for cyclic / dependency-ordering needs. */
    readonly forward?: string
    /** Node ids this declaration references in field positions. */
    readonly deps: readonly number[]
}

// ——————————————————————————————————————————————
// Helpers
// ——————————————————————————————————————————————

function nameOf(node: TypeNode): string
{
    return declaredNameOf(node.source as any) ?? `T${node.id}`
}

/** Pick the smallest C integer type that fits the range. */
export function cIntType(t: {min: number, max: number}): string
{
    const {min, max} = t
    if (min >= 0)
    {
        if (max <= 255)          return "uint8_t"
        if (max <= 65535)        return "uint16_t"
        if (max <= 4294967295)   return "uint32_t"
        return "uint64_t"
    }
    else
    {
        if (min >= -128 && max <= 127)              return "int8_t"
        if (min >= -32768 && max <= 32767)          return "int16_t"
        if (min >= -2147483648 && max <= 2147483647) return "int32_t"
        return "int64_t"
    }
}

/**
 * Resolve the C type reference for ANY node, given the result map
 * (which must already contain entries for by-name struct/union types
 * visited earlier in pre-order).
 *
 * Integer → C fixed-width type
 * Unit    → "void"
 * Struct  → by name
 * Union   → by name
 * List    → resolved by its enclosing struct (shouldn't be hit directly)
 */
export function cRefOf(
    node: TypeNode,
): string
{
    const t = node.type

    if (isInteger(t))  return cIntType(t as IntegerType)
    if (isUnit(t))     return "void"
    // Structs and unions are always referenced by name.
    return nameOf(node)
}

// ——————————————————————————————————————————————
// Ruleset
// ——————————————————————————————————————————————

/**
 * C type ruleset (no STL).
 *
 * Priority order (first match wins):
 * 1. Integer  → fixed-width C type (leaf, no decl)
 * 2. Unit     → void (leaf, no decl)
 * 3. Union with exact named variants → tagged union (all-unit → just tag)
 * 4. Union with homogeneous variants  → tagged union with payload union
 * 5. Struct   → typedef struct { fields; array+count for lists }
 *
 * Lists are NEVER matched directly — they are inlined by the enclosing
 * struct rule as a fixed array + count field.
 */
export function cTypeRules(): ReadonlyArray<Rule<CTypeDecl>>
{
    return [
        // 1. Integer → fixed-width C type
        rule(pInteger(-Infinity, Infinity), (match) => ({
            ref: cIntType(match),
            deps: [],
        })),

        // 2. Unit → void
        rule(pUnit(), () => ({ref: "void", deps: []})),

        // 3. Union with EXACT named variants — tagged union.
        //    When ALL variants are unit, emit just a tag byte (no data union).
        rule(pUnion({}), (_m, nodeId, graph) => {
            const node = graph.nodes.get(nodeId)!
            const name = nameOf(node)
            const allUnit = node.edges.every(e => isUnit(e.target.type))

            if (allUnit)
            {
                // Purely symbolic enum — just a tag byte, no payload.
                const tagComment = node.edges
                    .map((e, i) => `    // ${i}: ${"variant" in e.step ? e.step.variant : "?"}`)
                    .join("\n")
                return {
                    ref: name,
                    forward: `typedef struct ${name} ${name};`,
                    decl: `typedef struct ${name} {\n    uint8_t tag;\n${tagComment}\n} ${name};`,
                    deps: [],
                }
            }

            // Mixed-payload tagged union.
            const variantFields = node.edges.map(e => {
                const vName = "variant" in e.step ? e.step.variant : "_"
                const vType = cRefOf(e.target)
                return `        ${vType} ${vName};`
            })
            return {
                ref: name,
                forward: `typedef struct ${name} ${name};`,
                decl:
                    `typedef struct ${name} {\n` +
                    `    uint8_t tag;\n` +
                    `    union {\n${variantFields.join("\n")}\n` +
                    `    } data;\n` +
                    `} ${name};`,
                deps: node.edges.map(e => e.target.id),
            }
        }),

        // 4. Homogeneous-variants union (pUnionFields) — fallback for
        //    unions where we don't enumerate every variant name.
        rule(pUnionFields(pStar()), (_m, nodeId, graph) => {
            const node = graph.nodes.get(nodeId)!
            const name = nameOf(node)
            const allUnit = node.edges.every(e => isUnit(e.target.type))

            if (allUnit)
            {
                return {
                    ref: name,
                    forward: `typedef struct ${name} ${name};`,
                    decl: `typedef struct ${name} {\n    uint8_t tag;\n} ${name};`,
                    deps: [],
                }
            }

            const variantFields = node.edges.map(e => {
                const vName = "variant" in e.step ? e.step.variant : "_"
                const vType = cRefOf(e.target)
                return `        ${vType} ${vName};`
            })
            return {
                ref: name,
                forward: `typedef struct ${name} ${name};`,
                decl:
                    `typedef struct ${name} {\n` +
                    `    uint8_t tag;\n` +
                    `    union {\n${variantFields.join("\n")}\n` +
                    `    } data;\n` +
                    `} ${name};`,
                deps: node.edges.map(e => e.target.id),
            }
        }),

        // 5. Struct — each field emitted directly. List fields become
        //    fixed array + count.
        rule(pStructFields(pStar()), (_m, nodeId, graph) => {
            const node = graph.nodes.get(nodeId)!
            const name = nameOf(node)
            const fieldLines: string[] = []
            const deps: number[] = []

            for (const edge of node.edges)
            {
                const fName = "field" in edge.step ? edge.step.field : "_"

                if (isList(edge.target.type))
                {
                    // List → fixed array + count field. Not the struct
                    // rule's own matched pattern (that's pStructFields) —
                    // this is a nested, ad hoc check on a *child* edge, so
                    // there's no rule-level match witness for it to come
                    // from; a real cast against the raw type is the only
                    // option here.
                    const lt = edge.target.type as ListType
                    const elemNode = child(edge.target, {element: true})!
                    const elemType = cRefOf(elemNode)
                    const cap = lt.capacity ?? 255

                    fieldLines.push(`    ${elemType} ${fName}[${cap}];`)
                    fieldLines.push(`    uint8_t ${fName}_count;`)
                    deps.push(elemNode.id)
                }
                else
                {
                    fieldLines.push(`    ${cRefOf(edge.target)} ${fName};`)
                    deps.push(edge.target.id)
                }
            }

            return {
                ref: name,
                forward: `typedef struct ${name} ${name};`,
                decl: `typedef struct ${name} {\n${fieldLines.join("\n")}\n} ${name};`,
                deps,
            }
        }),
    ]
}

// ——————————————————————————————————————————————
// Public API
// ——————————————————————————————————————————————

/**
 * Run the C type projection on a type graph.
 * Returns a Map<nodeId, CTypeDecl>.
 */
export function projectCTypes(
    graph: TypeGraph,
): Map<number, CTypeDecl>
{
    return runRuleset(graph, cTypeRules())
}

/**
 * Emit a complete C header string from a projection result.
 */
export function emitCHeader(
    result: Map<number, CTypeDecl>,
): string
{
    const lines: string[] = []

    lines.push("#pragma once")
    lines.push("#include <stdint.h>")
    lines.push("")

    // Forward declarations
    for (const [, decl] of result)
    {
        if (decl.forward) lines.push(decl.forward)
    }
    lines.push("")

    // Definitions (in node-id order by default from Map iteration in
    // insertion order — the runner inserts in pre-order, so dependencies
    // appear before dependents)
    for (const [, decl] of result)
    {
        if (decl.decl)
        {
            lines.push(decl.decl)
            lines.push("")
        }
    }

    return lines.join("\n")
}
