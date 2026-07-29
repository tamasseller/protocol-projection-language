/**
 * ts-emitter.ts — TypeScript type projection.
 *
 * Projects the semantic type graph into idiomatic TypeScript types
 * suitable for desktop/server/cloud consumers:
 *  - `number` for all integers (JS has no fixed-width integers)
 *  - `null` for unit types
 *  - `interface` / `type` for structs and unions
 *  - `T[]` for lists
 *
 * This is the "Proper Platform" target — the cloud gateway / mobile app /
 * bridge that consumes the wire data. Uses the projection runner
 * (runRuleset) to walk the type graph and produce TSTypeDecl capabilities
 * per node.
 *
 * Pure compile-time host machinery. No IR impact.
 */
import {
    TypeGraph,
    TypeNode,
    child,
    Rule,
    runRuleset,
} from "@ppl/core"
import {
    TraitRegistry,
    TypeNameTrait,
} from "@ppl/core"
import {
    pInteger,
    pUnit,
    pStar,
    pStructFields,
    pUnion,
    pUnionFields,
    pList,
} from "@ppl/core"
import {
    isInteger,
    isList,
    isUnit,
} from "@ppl/core"

// ——————————————————————————————————————————————
// Capability type
// ——————————————————————————————————————————————

export interface TSTypeDecl
{
    /** How to reference this type in a field position. */
    readonly ref: string
    /** Full type declaration (type / interface), if needed. */
    readonly decl?: string
    /** Node ids referenced. */
    readonly deps: readonly number[]
}

// ——————————————————————————————————————————————
// Helpers
// ——————————————————————————————————————————————

function nameOf(nodeId: number, traits: TraitRegistry): string
{
    return traits.get(TypeNameTrait, nodeId) ?? `T${nodeId}`
}

/**
 * Resolve a TS type reference for a node.
 * Integers → "number", Unit → "null", Lists → "T[]", others → by name.
 */
export function tsRefOf(node: TypeNode, traits: TraitRegistry): string
{
    const t = node.type

    if (isInteger(t)) return "number"
    if (isUnit(t))    return "null"

    if (isList(t))
    {
        const elemNode = child(node, {element: true})!
        return `${tsRefOf(elemNode, traits)}[]`
    }

    return nameOf(node.id, traits)
}

// ——————————————————————————————————————————————
// Ruleset
// ——————————————————————————————————————————————

/**
 * TS type ruleset.
 *
 * Priority order:
 * 1. Integer → "number" (leaf, no decl)
 * 2. Unit    → "null"   (leaf, no decl)
 * 3. List    → "T[]"    (inline, no decl)
 * 4. Union   → discriminated union type
 * 5. Struct  → interface
 */
export function tsTypeRules(): ReadonlyArray<Rule<TSTypeDecl>>
{
    return [
        // 1. Integer → number
        {
            pattern: pInteger(-Infinity, Infinity),
            produce: () => ({ref: "number", deps: []}),
        },

        // 2. Unit → null
        {
            pattern: pUnit(),
            produce: () => ({ref: "null", deps: []}),
        },

        // 3. List → T[] (inline)
        {
            pattern: pList(pStar()),
            produce: (_m, nodeId, graph, traits) => {
                const elemNode = child(graph.nodes.get(nodeId)!, {element: true})!
                return {ref: `${tsRefOf(elemNode, traits)}[]`, deps: [elemNode.id]}
            },
        },

        // 4. Union (exact named variants) → discriminated union
        {
            pattern: pUnion({}),
            produce: (_m, nodeId, graph, traits) => {
                const node = graph.nodes.get(nodeId)!
                const name = nameOf(nodeId, traits)

                const allUnit = node.edges.every(e => isUnit(e.target.type))
                if (allUnit)
                {
                    // Symbolic enum — string literal union
                    const literals = node.edges
                        .map(e => `"${"variant" in e.step ? e.step.variant : "?"}"`)
                        .join(" | ")
                    return {ref: name, decl: `type ${name} = ${literals};`, deps: []}
                }

                // Discriminated union with tag field
                const members = node.edges.map(e => {
                    const vName = "variant" in e.step ? e.step.variant : "_"
                    const vType = tsRefOf(e.target, traits)
                    return `  | { tag: "${vName}"; value: ${vType} }`
                })
                return {
                    ref: name,
                    decl: `type ${name} =\n${members.join("\n")};`,
                    deps: node.edges.map(e => e.target.id),
                }
            },
        },

        // 5. Homogeneous-variants union → discriminated union
        {
            pattern: pUnionFields(pStar()),
            produce: (_m, nodeId, graph, traits) => {
                const node = graph.nodes.get(nodeId)!
                const name = nameOf(nodeId, traits)

                const allUnit = node.edges.every(e => isUnit(e.target.type))
                if (allUnit)
                {
                    const literals = node.edges
                        .map(e => `"${"variant" in e.step ? e.step.variant : "?"}"`)
                        .join(" | ")
                    return {ref: name, decl: `type ${name} = ${literals};`, deps: []}
                }

                const members = node.edges.map(e => {
                    const vName = "variant" in e.step ? e.step.variant : "_"
                    const vType = tsRefOf(e.target, traits)
                    return `  | { tag: "${vName}"; value: ${vType} }`
                })
                return {
                    ref: name,
                    decl: `type ${name} =\n${members.join("\n")};`,
                    deps: node.edges.map(e => e.target.id),
                }
            },
        },

        // 6. Struct → interface
        {
            pattern: pStructFields(pStar()),
            produce: (_m, nodeId, graph, traits) => {
                const node = graph.nodes.get(nodeId)!
                const name = nameOf(nodeId, traits)
                const fieldLines = node.edges.map(e => {
                    const fName = "field" in e.step ? e.step.field : "_"
                    return `  readonly ${fName}: ${tsRefOf(e.target, traits)};`
                })
                return {
                    ref: name,
                    decl: `interface ${name} {\n${fieldLines.join("\n")}\n}`,
                    deps: node.edges.map(e => e.target.id),
                }
            },
        },
    ]
}

// ——————————————————————————————————————————————
// Public API
// ——————————————————————————————————————————————

/**
 * Run the TS type projection on a type graph.
 */
export function projectTSTypes(
    graph: TypeGraph,
    traits: TraitRegistry,
): Map<number, TSTypeDecl>
{
    return runRuleset(graph, tsTypeRules(), traits)
}

/**
 * Emit a complete TypeScript declaration string from a projection result.
 */
export function emitTSDeclarations(
    result: Map<number, TSTypeDecl>,
): string
{
    const lines: string[] = []
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
