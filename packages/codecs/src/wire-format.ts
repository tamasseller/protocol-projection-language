/**
 * wire-format.ts — Binary wire layout projection.
 *
 * Projects the same semantic type graph into a description of the
 * binary wire format. This is the "signal" level from ARCHITECTURE.md:
 * the physical byte layout independent of the host data model.
 *
 * Wire format conventions (default profile):
 *  - Little-endian byte order
 *  - Struct fields serialized in declaration order, packed
 *  - Integers: exactly ceil(log2(range)/8) bytes (no varint)
 *  - Lists:   1-byte count prefix, then elements inline (no delimiter)
 *  - Unions:  1-byte tag, then the active variant's payload
 *  - Units:   0 bytes (no wire representation — purely symbolic)
 *
 * Uses runRuleset to produce a WireShape tree per TypeNode. This is the
 * generic wire-shape descriptor layer; the IR instruction emission
 * (encoding/decoding opcodes) is a separate concern built on top of it.
 *
 * Pure compile-time host machinery. No IR impact.
 */
import {
    TypeGraph,
    child,
    Rule,
    runRuleset,
    TraitRegistry,
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
// Wire shape descriptors
// ——————————————————————————————————————————————

/** A fixed-size integer on the wire. */
export interface WireFixed
{
    readonly kind: "fixed"
    /** Size in bytes. */
    readonly size: number
}

/** A list: 1-byte count followed by inline elements. */
export interface WireCounted
{
    readonly kind: "counted"
    /** Wire shape of each element. */
    readonly element: WireShape
    /** Maximum number of elements. */
    readonly maxCount: number
}

/** A tagged union: 1-byte tag then the active variant's payload. */
export interface WireTagged
{
    readonly kind: "tagged"
    /** Variant name → payload shape. Unit variants have size 0. */
    readonly variants: Readonly<Record<string, WireShape>>
}

/** A struct: fields in declaration order, packed. */
export interface WireStructFields
{
    readonly kind: "struct"
    /** Ordered field descriptors. */
    readonly fields: ReadonlyArray<{readonly name: string; readonly shape: WireShape}>
}

export type WireShape = WireFixed | WireCounted | WireTagged | WireStructFields

// ——————————————————————————————————————————————
// Sizing helpers
// ——————————————————————————————————————————————

/** Bytes needed to represent the integer range on the wire (fixed-width). */
export function intWireSize(t: IntegerType): number
{
    // Find the smallest power-of-2 byte count that fits the range.
    const range = t.max - t.min
    if (range <= 0xFF)       return 1
    if (range <= 0xFFFF)     return 2
    if (range <= 0xFFFFFFFF) return 4
    return 8
}

/** Total fixed wire size of any WireShape (variable-sized portions = 0). */
export function wireSize(s: WireShape): number
{
    switch (s.kind)
    {
        case "fixed":   return s.size
        case "counted": return 1 // count byte only; elements are variable
        case "tagged":  return 1 // tag byte; variants vary
        case "struct":  return s.fields.reduce((n, f) => n + wireSize(f.shape), 0)
    }
}

// ——————————————————————————————————————————————
// Ruleset
// ——————————————————————————————————————————————

/**
 * Wire-format ruleset.
 *
 * Priority order:
 * 1. Integer  → WireFixed
 * 2. Unit     → WireFixed(0) — no wire bytes
 * 3. Union (exact named variants) → WireTagged
 * 4. Union (homogeneous variants)  → WireTagged
 * 5. Struct   → WireStructFields
 */
export function wireFormatRules(): ReadonlyArray<Rule<WireShape>>
{
    return [
        // 1. Integer → fixed-width
        {
            pattern: pInteger(-Infinity, Infinity),
            produce: (_m, nodeId, graph) => {
                const t = graph.nodes.get(nodeId)!.type as IntegerType
                return {kind: "fixed", size: intWireSize(t)}
            },
        },

        // 2. Unit → 0 bytes
        {
            pattern: pUnit(),
            produce: () => ({kind: "fixed", size: 0}),
        },

        // 3. Union with exact named variants → tagged
        {
            pattern: pUnion({}),
            produce: (_m, nodeId, graph) => {
                const node = graph.nodes.get(nodeId)!
                const variants: Record<string, WireShape> = {}
                for (const edge of node.edges)
                {
                    const vName = "variant" in edge.step ? edge.step.variant : "_"
                    variants[vName] = edge.target.type.kind === "integer"
                        ? {kind: "fixed", size: intWireSize(edge.target.type as IntegerType)}
                        : edge.target.type.kind === "unit"
                            ? {kind: "fixed", size: 0}
                            : {kind: "fixed", size: 0} // fallback — resolved by child rules
                }
                return {kind: "tagged", variants}
            },
        },

        // 4. Homogeneous-variants union → tagged
        {
            pattern: pUnionFields(pStar()),
            produce: (_m, nodeId, graph) => {
                const node = graph.nodes.get(nodeId)!
                const variants: Record<string, WireShape> = {}
                for (const edge of node.edges)
                {
                    const vName = "variant" in edge.step ? edge.step.variant : "_"
                    variants[vName] = isUnit(edge.target.type)
                        ? {kind: "fixed", size: 0}
                        : {kind: "fixed", size: 0} // fallback
                }
                return {kind: "tagged", variants}
            },
        },

        // 5. Struct → packed fields
        {
            pattern: pStructFields(pStar()),
            produce: (_m, nodeId, graph) => {
                const node = graph.nodes.get(nodeId)!
                const fields: Array<{name: string; shape: WireShape}> = []

                for (const edge of node.edges)
                {
                    const fName = "field" in edge.step ? edge.step.field : "_"

                    if (isList(edge.target.type))
                    {
                        // List → counted with 1-byte prefix
                        const lt = edge.target.type as ListType
                        const elemNode = child(edge.target, {element: true})!
                        const elemShape: WireShape = isInteger(elemNode.type)
                            ? {kind: "fixed", size: intWireSize(elemNode.type as IntegerType)}
                            : {kind: "fixed", size: 0} // nested compound — resolved by child rules
                        fields.push({
                            name: fName,
                            shape: {
                                kind: "counted",
                                element: elemShape,
                                maxCount: lt.capacity ?? 255,
                            },
                        })
                    }
                    else if (isInteger(edge.target.type))
                    {
                        fields.push({
                            name: fName,
                            shape: {kind: "fixed", size: intWireSize(edge.target.type as IntegerType)},
                        })
                    }
                    else if (isUnit(edge.target.type))
                    {
                        fields.push({name: fName, shape: {kind: "fixed", size: 0}})
                    }
                    else
                    {
                        // Nested struct or union — placeholder, resolved by
                        // its own rule entry in the result map.
                        fields.push({name: fName, shape: {kind: "fixed", size: 0}})
                    }
                }

                return {kind: "struct", fields}
            },
        },
    ]
}

// ——————————————————————————————————————————————
// Public API
// ——————————————————————————————————————————————

/**
 * Run the wire-format projection on a type graph.
 *
 * Wire format is purely structural — it does not need traits, so a fresh
 * empty registry is used internally.
 */
export function projectWireFormat(graph: TypeGraph): Map<number, WireShape>
{
    return runRuleset(graph, wireFormatRules(), new TraitRegistry())
}

/**
 * Pretty-print a WireShape tree for diagnostics / test assertions.
 */
export function formatWireShape(s: WireShape, indent: number = 0): string
{
    const pad = "  ".repeat(indent)
    switch (s.kind)
    {
        case "fixed":
            return `${pad}fixed(${s.size}B)`
        case "counted":
            return `${pad}counted(max=${s.maxCount}) [\n${formatWireShape(s.element, indent + 1)}\n${pad}]`
        case "tagged":
        {
            const vs = Object.entries(s.variants)
                .map(([k, v]) => `${pad}  ${k}: ${formatWireShape(v, 0).trim()}`)
                .join("\n")
            return `${pad}tagged {\n${vs}\n${pad}}`
        }
        case "struct":
        {
            const fs = s.fields
                .map(f => `${pad}  ${f.name}: ${formatWireShape(f.shape, 0).trim()}`)
                .join("\n")
            return `${pad}struct {\n${fs}\n${pad}}`
        }
    }
}
