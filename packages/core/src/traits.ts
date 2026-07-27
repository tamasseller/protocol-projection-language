/**
 * Trait mechanism: a decoupled annotation channel keyed on TypeNode ids.
 *
 * Traits are symbol-branded values attached to type objects at definition
 * time (via `tag()`), extracted into a `TraitRegistry` by `extractTraits`
 * after the TypeGraph is built, and queried by ruleset produce callbacks
 * and cross-projection code.
 *
 * The metamodel, TypeGraph builder, matcher, and projection runner know
 * nothing about specific traits. New trait kinds are `defineTrait<T>()`
 * calls — zero core changes. Libraries and codegens depend only on the
 * trait modules they care about.
 *
 * Pre-seeding convention: all trait data on a type object lives under a
 * single well-known symbol (`TRAITS`), whose value is a symbol-keyed bag.
 * This namespaces trait data away from any other symbol properties on
 * the type object.
 */

import {TypeGraph} from "./type-graph"

/**
 * A trait definition: a symbol branded with its value type.
 * The symbol is the trait's identity (rendezvous point for cooperating
 * components); the brand gives compile-time type safety at call sites.
 */
export type TraitDef<T> = {readonly _: T} & symbol

/**
 * Define a new trait. Each call mints a unique symbol.
 * Convention: export the result from a shared module so cooperating
 * components import the same trait identity.
 */
export const defineTrait = <T>(): TraitDef<T> => Symbol() as unknown as TraitDef<T>

/**
 * The per-build trait registry. One symbol-keyed map per trait,
 * each mapping node id → trait value.
 *
 * Writable from any produce callback (for cross-projection communication);
 * readable from any produce callback or external code.
 */
export class TraitRegistry
{
    private readonly byTrait = new Map<symbol, Map<number, unknown>>()

    /** Attach a trait value to a node. Any component may call this. */
    set<T>(trait: TraitDef<T>, nodeId: number, value: T): void
    {
        let m = this.byTrait.get(trait as unknown as symbol)
        if(m === undefined) {m = new Map(); this.byTrait.set(trait as unknown as symbol, m)}
        m.set(nodeId, value)
    }

    /** Query a trait. Returns undefined if the node has no value OR
     *  no component attached this trait at all — indistinguishable,
     *  which is correct (absence is absence). */
    get<T>(trait: TraitDef<T>, nodeId: number): T | undefined
    {
        return this.byTrait.get(trait as unknown as symbol)?.get(nodeId) as T | undefined
    }

    /** Internal: set by raw symbol (used by extractTraits). */
    setRaw(sym: symbol, nodeId: number, value: unknown): void
    {
        let m = this.byTrait.get(sym)
        if(m === undefined) {m = new Map(); this.byTrait.set(sym, m)}
        m.set(nodeId, value)
    }
}

// — Pre-seeding: attach traits to type objects at definition time ————

/** Well-known symbol under which all pre-seeded trait data is namespaced. */
const TRAITS = Symbol("traits")

/**
 * Attach a trait value to a type object (pre-seeding at definition time).
 * The value is stored under the TRAITS bag, keyed by the trait's symbol.
 */
export const tag = <T>(trait: TraitDef<T>, value: T, obj: object): void =>
{
    const bag = (obj as any)[TRAITS] as Record<symbol, unknown> | undefined
    if(bag === undefined)
    {
        (obj as any)[TRAITS] = {[trait as unknown as symbol]: value}
    }
    else
    {
        bag[trait as unknown as symbol] = value
    }
}

/**
 * Extract all pre-seeded traits from the TypeGraph into a fresh registry.
 * For each node, reads the TRAITS bag off `node.source` and copies each
 * symbol-keyed entry into the registry under the node's id.
 */
export const extractTraits = (graph: TypeGraph): TraitRegistry =>
{
    const reg = new TraitRegistry()
    for(const node of graph.nodes.values())
    {
        const bag = (node.source as any)?.[TRAITS] as Record<symbol, unknown> | undefined
        if(bag === undefined) continue
        for(const sym of Object.getOwnPropertySymbols(bag))
        {
            reg.setRaw(sym, node.id, bag[sym])
        }
    }
    return reg
}

// — Built-in traits ————————————————————————————————

/** The type-name trait: a human-readable name for a type node. */
export const TypeNameTrait: TraitDef<string> = defineTrait<string>()

/**
 * Sugar: attach a name to a type object at definition time.
 * Usage: `named("Timestamp", struct({secs: u32, nanos: u32}))`
 * or:    `const Ts = named("Timestamp", () => struct({...}))`
 */
export const named = <T extends object>(name: string, obj: T): T =>
{
    tag(TypeNameTrait, name, obj)
    return obj
}
