/**
 * target-js — Pure `TypeNode`/`TypeEdge` helpers for codec codegen.
 *
 * Nothing here touches a `RaisedProc`, an `Expr`/`Stmt`, or emits any JS —
 * it only answers questions about the semantic type graph
 * (`resolveProcedureTypes`'s own `TypeNode`s) that `codec-codegen.ts`'s
 * translation needs along the way: which edge does this `ref` mean, is
 * this node a struct, what are a union's variant names in declaration
 * order. Kept separate so the RaisedProc-walking backbone in
 * `codec-codegen.ts` isn't interleaved with type-graph navigation that has
 * nothing to do with tree-walking.
 */
import {kindOf, SemanticTypeKinds} from "../../core/index"
import type {TypeNode, TypeEdge} from "../../core/index"

export function requireEdge(node: TypeNode, ref: number, opName: string): TypeEdge
{
    const edge = node.edges[ref]
    if(!edge) throw new Error(`codec-codegen: ${opName}: no edge #${ref} on this ${node.type.kind} (${node.edges.length} edge(s))`)
    return edge
}

export function isStructKind(node: TypeNode): boolean {return kindOf(node.type) === SemanticTypeKinds.Struct}

export function variantNamesOf(node: TypeNode): string[]
{
    return node.edges.map(e =>
    {
        if(!("variant" in e.step)) throw new Error(`codec-codegen: expected a union edge, got ${JSON.stringify(e.step)}`)
        return e.step.variant
    })
}

/** The `// proc N: <kind>` header comment's own label. */
export function describeType(node: TypeNode): string
{
    const kind = kindOf(node.type)
    if(kind === SemanticTypeKinds.Struct || kind === SemanticTypeKinds.Union)
    {
        const named = (node.type as {name?: string}).name
        return named ? `${kind} ${named}` : kind
    }
    return kind
}
