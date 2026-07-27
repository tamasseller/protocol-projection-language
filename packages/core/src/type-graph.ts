/**
 * Layer 0: The TypeGraph.
 *
 * Finitizes a (potentially cyclic / infinite) SemanticType into a finite,
 * stable-numbered graph of TypeNodes by cutting recursive references and
 * linking back to their first expansion.
 *
 * Identity is by **type-object identity** (thunk function or direct value),
 * NOT structural equality. Same JS object → same TypeNode (cycle-breaking
 * AND library sharing via `export const X = () => ...`). Different objects
 * that deref to structurally-identical bodies → distinct TypeNodes (the
 * author controls sharing by how they construct/export types).
 *
 * Pure compile-time host machinery. No IR impact.
 */
import {
    ConcreteSemanticType,
    IntegerType,
    isInteger,
    isList,
    isReference,
    isStruct,
    isUnion,
    isUnit,
    ListType,
    SemanticType,
    StructType,
    UnionType,
} from "./metamodel"

/** How a child is reached from its parent. */
export type Step =
    | {field: string}     // struct field
    | {variant: string}   // union variant
    | {element: true}     // list element

export interface TypeEdge
{
    readonly step: Step
    readonly target: TypeNode
}

/**
 * A materialized node in the shared type graph.
 *
 * `type` is always concrete (derefed) — never a thunk function.
 * `source` is the original type object (thunk or value) this node was
 * materialized from — used for trait extraction (symbol-keyed bags
 * attached at definition time) and provenance diagnostics.
 * Back-edges are represented by `target` pointing at an already-allocated
 * TypeNode (one encountered earlier in the DFS).
 */
export interface TypeNode
{
    readonly id: number
    readonly type: ConcreteSemanticType
    readonly source: object
    readonly edges: readonly TypeEdge[]
}

export interface TypeGraph
{
    readonly root: TypeNode
    /** Every node, keyed by id — the registry cross-ruleset queries use. */
    readonly nodes: ReadonlyMap<number, TypeNode>
}

/**
 * Materialize a finite, cycle-broken type graph from a (possibly cyclic)
 * SemanticType.
 *
 * Cycle-breaking: keyed on type-object identity (WeakMap<object, TypeNode>).
 * Descending into a child type object already in the map → back-edge.
 * Works for simple loops, mutual recursion, and library fan-in identically.
 *
 * Thunks: a `() => SemanticType` is deref'd to get the body; the thunk
 * itself is the identity key (so the same thunk referenced from N sites
 * → one TypeNode with N back-edges into it).
 *
 * Nodes are numbered in DFS pre-order (parents before children, back-edges
 * to already-visited ancestors), so a rule callback can safely query
 * prior rulesets' results for any node id.
 */
export function buildTypeGraph(rootType: SemanticType): TypeGraph
{
    const byObject = new WeakMap<object, TypeNode>()
    const nodes = new Map<number, TypeNode>()
    let nextId = 0

    const build = (t: SemanticType): TypeNode =>
    {
        // Thunks: deref, then key on the thunk object itself.
        const key: object = (typeof t === "function") ? (t as object) : (t as object)
        const existing = byObject.get(key)
        if(existing !== undefined) return existing

        const derefed = (typeof t === "function" ? (t as () => SemanticType)() : t) as ConcreteSemanticType
        const node: TypeNode = {id: nextId++, type: derefed, source: key, edges: []}
        byObject.set(key, node)
        nodes.set(node.id, node)

        // Mutate edges in-place after children are built (children may back-edge to `node`).
        ;(node as unknown as {edges: TypeEdge[]}).edges = edgesOf(derefed, build)

        return node
    }

    const root = build(rootType)
    return {root, nodes}
}

/** Build the outgoing edges of a derefed (concrete) type. */
const edgesOf = (t: ConcreteSemanticType, build: (t: SemanticType) => TypeNode): TypeEdge[] =>
{
    if(isUnit(t) || isInteger(t)) return []

    if(isList(t))
    {
        const lt = t as ListType
        return [{step: {element: true}, target: build(lt.elementType)}]
    }

    if(isStruct(t))
    {
        const st = t as StructType
        return [...st.fields.entries()].map(([name, type]) => ({step: {field: name}, target: build(type)}))
    }

    if(isUnion(t))
    {
        const ut = t as UnionType
        return [...ut.variants.entries()].map(([name, type]) => ({step: {variant: name}, target: build(type)}))
    }

    if(isReference(t)) throw new Error("buildTypeGraph: reference thunk not derefed before edgesOf") // unreachable

    throw new Error(`buildTypeGraph: unknown type kind at ${(t as any)?.kind}`)
}

/** Find a child by step. Returns undefined if no edge matches. */
export function child(node: TypeNode, step: Step): TypeNode | undefined
{
    return node.edges.find(e => stepEquals(e.step, step))?.target
}

/** Structural equality for Step values. */
export function stepEquals(a: Step, b: Step): boolean
{
    if("field" in a)  return "field" in b  && a.field  === b.field
    if("variant" in a) return "variant" in b && a.variant === b.variant
    if("element" in a) return "element" in b
    return false
}
