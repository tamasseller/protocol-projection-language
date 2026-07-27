/**
 * Runtime tests for Layer 1: the ruleset runner.
 *
 * Run via: npm test
 */
import {test} from "node:test"
import * as assert from "node:assert/strict"

import {integer, list, struct, union, unit} from "../src/metamodel"
import {buildTypeGraph, child} from "../src/type-graph"
import {Rule, runRuleset} from "../src/projection"
import {extractTraits, TraitRegistry, tag, defineTrait, TypeNameTrait, named} from "../src/traits"
import {pInteger, pList, pStar, pStruct, pStructFields, pUnion, pUnit, pAnyOf} from "../src/matcher"
// pList imported for completeness; not all are used in every test.

// Test-local convenience: run a ruleset with traits extracted from the graph.
const run = <C>(g: ReturnType<typeof buildTypeGraph>, rules: ReadonlyArray<Rule<C>>): Map<number, C> =>
    runRuleset(g, rules, extractTraits(g))

////////////////////////////////////////////////////////////////////////////////////////////////
// Single ruleset: basic coverage
////////////////////////////////////////////////////////////////////////////////////////////////

test("runner: first matching rule per node wins", () => {
    const T = struct({a: integer(0, 1), b: unit})
    const g = buildTypeGraph(T)

    const rules: Rule<string>[] = [
        {pattern: pInteger(0, 255), produce: (_m, id) => `int@${id}`},
        {pattern: pUnit(),          produce: (_m, id) => `unit@${id}`},
        // pStar holes on fields → they are independently matched, not covered.
        {pattern: pStruct({a: pStar(), b: pStar()}), produce: (_m, id) => `struct@${id}`},
    ]

    const r = run(g, rules)
    assert.equal(r.size, 3)
    const aId = child(g.root, {field: "a"})!.id
    const bId = child(g.root, {field: "b"})!.id
    assert.equal(r.get(g.root.id), "struct@0")
    assert.equal(r.get(aId), "int@1")
    assert.equal(r.get(bId), "unit@2")
})

test("runner: uncovered nodes are absent from the result", () => {
    const T = struct({a: integer(0, 1), b: unit})
    const g = buildTypeGraph(T)

    // A ruleset that only handles integers.
    const r = run(g, [{pattern: pInteger(0, 255), produce: () => "int"}])
    const aId = child(g.root, {field: "a"})!.id
    const bId = child(g.root, {field: "b"})!.id
    assert.equal(r.has(aId), true)
    assert.equal(r.has(bId), false)
    assert.equal(r.has(g.root.id), false)
    assert.equal(r.size, 1)
})

test("runner: priority order — earlier rule shadows later", () => {
    const T = integer(0, 1)
    const g = buildTypeGraph(T)

    const r = run(g, [
        {pattern: pInteger(0, 255), produce: () => "specific"},  // matches first
        {pattern: pInteger(0, 1),   produce: () => "narrower"},   // would also match, but shadowed
    ])
    assert.equal(r.get(0), "specific")
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Recursive type — cycle-safe (no infinite loop)
////////////////////////////////////////////////////////////////////////////////////////////////

test("runner: recursive type handled without infinite recursion", () => {
    const T = (): any => union({
        internal: struct({a: T, b: T}),
        leaf: integer(0, 1),
    })
    // Pass the thunk (not T()) so references to T back-edge to the root.
    const g = buildTypeGraph(T)

    // Only the leaf integer matches; the union and struct don't match
    // the given patterns (pUnion needs exact variant set, and the union
    // has `internal` which the pattern omits). The key assertion is that
    // the runner terminates on the cyclic graph without infinite recursion.
    const r = run(g, [
        {pattern: pInteger(0, 1),  produce: () => "leaf"},
    ])

    assert.equal(r.size, 1)
    assert.equal(r.get(2), "leaf")  // node 2 = leaf integer
})

////////////////////////////////////////////////////////////////////////////////////////////////
// StructFieldsPattern — the presence-bitmap partition
////////////////////////////////////////////////////////////////////////////////////////////////

test("runner: structfields+anyof partition produces per-field branch tags", () => {
    const Optional = (T: any) => union({value: T, empty: unit})
    const T = struct({
        flag: Optional(integer(0, 255)),   // optional → branch 0
        count: integer(0, 65535),          // plain   → branch 1
        tag:   Optional(integer(0, 15)),    // optional → branch 0
    })
    const g = buildTypeGraph(T)

    interface FieldPlan {name: string, optional: boolean, childNodeId: number}
    interface WireCap {kind: "presence-bitmap", fields: FieldPlan[]}

    const r = run<WireCap>(g, [
        {
            pattern: pStructFields(pAnyOf(() => [
                pUnion({value: pInteger(0, 255), empty: pUnit()}),  // branch 0: optional
                pInteger(0, 65535),                                   // branch 1: plain
            ])),
            produce: (m, nodeId, graph) => {
                const fields = (m as any).fieldMatches.map((f: any) => ({
                    name: f.name,
                    optional: f.match.branch === 0,
                    childNodeId: child(graph.nodes.get(nodeId)!, {field: f.name})!.id,
                }))
                return {kind: "presence-bitmap", fields}
            },
        },
    ])

    const cap = r.get(g.root.id)!
    assert.equal(cap.kind, "presence-bitmap")
    assert.equal(cap.fields.length, 3)
    assert.equal(cap.fields[0].name, "flag")
    assert.equal(cap.fields[0].optional, true)
    assert.equal(cap.fields[1].name, "count")
    assert.equal(cap.fields[1].optional, false)
    assert.equal(cap.fields[2].name, "tag")
    assert.equal(cap.fields[2].optional, true)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Cross-ruleset: prior ruleset queried via Map.get(nodeId)
////////////////////////////////////////////////////////////////////////////////////////////////

test("cross-ruleset: target ruleset queried by node id from wire callback", () => {
    const Optional = (T: any) => union({value: T, empty: unit})
    const T = struct({flag: Optional(integer(0, 255)), count: integer(0, 65535)})
    const g = buildTypeGraph(T)

    // Target ruleset: how does the host language represent each node?
    type TargetCap = {kind: "c++-field", cxxType: string}
    const target = run<TargetCap>(g, [
        {pattern: pInteger(0, 255),   produce: () => ({kind: "c++-field", cxxType: "uint8_t"})},
        {pattern: pInteger(0, 65535), produce: () => ({kind: "c++-field", cxxType: "uint16_t"})},
        {
            pattern: pUnion({value: pInteger(0, 255), empty: pUnit()}),
            produce: () => ({kind: "c++-field", cxxType: "std::optional<uint8_t>"}),
        },
    ])

    // Wire ruleset: emits presence-bitmap plan; for each field, queries
    // the target ruleset (already computed) for the accessor.
    interface WireCap {kind: "presence-bitmap", fields: Array<{name: string, target?: TargetCap}>}
    const wire = run<WireCap>(g, [
        {
            pattern: pStructFields(pAnyOf(() => [
                pUnion({value: pInteger(0, 255), empty: pUnit()}),
                pInteger(0, 65535),
            ])),
            produce: (m, nodeId, graph) => {
                const fields = (m as any).fieldMatches.map((f: any) => {
                    const childId = child(graph.nodes.get(nodeId)!, {field: f.name})!.id
                    return {name: f.name, target: target.get(childId)}  // ← cross-ruleset lookup
                })
                return {kind: "presence-bitmap", fields}
            },
        },
    ])

    const cap = wire.get(g.root.id)!
    assert.equal(cap.fields[0].target?.cxxType, "std::optional<uint8_t>")
    assert.equal(cap.fields[1].target?.cxxType, "uint16_t")
})

test("cross-ruleset: uncovered node returns undefined (not an error)", () => {
    const T = struct({a: integer(0, 1), b: unit})
    const g = buildTypeGraph(T)

    // Target ruleset only covers integers.
    const target = run(g, [{pattern: pInteger(0, 1), produce: () => "int"}])

    const bId = child(g.root, {field: "b"})!.id
    assert.equal(target.get(bId), undefined)  // unit uncovered — just absent
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Coverage semantics (default-absorb with pStar holes)
////////////////////////////////////////////////////////////////////////////////////////////////

test("coverage: pStar holes are NOT covered — they get independent capabilities", () => {
    // struct({a: int, b: int}) with a rule that re-dispatches both fields.
    const T = struct({a: integer(0, 1), b: integer(0, 1)})
    const g = buildTypeGraph(T)

    const r = run<string>(g, [
        {pattern: pStruct({a: pStar(), b: pStar()}), produce: () => "struct"},
        {pattern: pInteger(0, 1),                    produce: () => "int"},
    ])

    // The struct is covered by rule 1; both int fields are pStar holes →
    // NOT covered → independently matched by rule 2.
    const aId = child(g.root, {field: "a"})!.id
    const bId = child(g.root, {field: "b"})!.id
    assert.equal(r.get(g.root.id), "struct")
    assert.equal(r.get(aId), "int")
    assert.equal(r.get(bId), "int")
    assert.equal(r.size, 3)
})

test("coverage: non-pStar children ARE covered — inhibited from independent matching", () => {
    // struct({a: int}) where `a` is NOT a hole → covered by the struct rule.
    const T = struct({a: integer(0, 1)})
    const g = buildTypeGraph(T)

    const r = run<string>(g, [
        // `a` matched with pInteger but NOT pStar → covered (absorbed).
        {pattern: pStruct({a: pInteger(0, 1)}), produce: () => "struct"},
        {pattern: pInteger(0, 1),               produce: () => "int"},
    ])

    const aId = child(g.root, {field: "a"})!.id
    assert.equal(r.get(g.root.id), "struct")
    assert.equal(r.get(aId), undefined)  // covered → no independent capability
    assert.equal(r.size, 1)
})

test("coverage: presence-bitmap absorbs optionals, re-dispatches value types", () => {
    const Optional = (T: any) => union({value: T, empty: unit})
    // struct{flag: Optional<u8>, count: u16}
    // flag's union: value is pStar (re-dispatch), empty is absorbed.
    const T = struct({flag: Optional(integer(0, 255)), count: integer(0, 65535)})
    const g = buildTypeGraph(T)

    type Cap = {kind: "bitmap"} | {kind: "int", bits: number}
    const r = run<Cap>(g, [
        {
            // Bitmap rule: struct whose fields are either optional-unions
            // (value re-dispatched) or plain ints (re-dispatched).
            pattern: pStructFields(pAnyOf(() => [
                pUnion({value: pStar(), empty: pUnit()}),  // branch 0: optional
                pStar(),                                     // branch 1: plain (re-dispatch)
            ])),
            produce: () => ({kind: "bitmap"} as Cap),
        },
        {pattern: pInteger(0, 255),   produce: () => ({kind: "int", bits: 8} as Cap)},
        {pattern: pInteger(0, 65535), produce: () => ({kind: "int", bits: 16} as Cap)},
    ])

    const flagUnionId = child(g.root, {field: "flag"})!.id
    const flagValueId = child(child(g.root, {field: "flag"})!, {variant: "value"})!.id
    const flagEmptyId = child(child(g.root, {field: "flag"})!, {variant: "empty"})!.id
    const countId = child(g.root, {field: "count"})!.id

    // The struct → bitmap capability.
    assert.equal((r.get(g.root.id) as any)?.kind, "bitmap")
    // The optional union → covered (absorbed into bitmap), no independent cap.
    assert.equal(r.get(flagUnionId), undefined)
    // The union's value variant → pStar hole → re-dispatched → int codec.
    assert.equal((r.get(flagValueId) as any)?.kind, "int")
    assert.equal((r.get(flagValueId) as any)?.bits, 8)
    // The union's empty variant → Unit, covered (absorbed), no independent cap.
    assert.equal(r.get(flagEmptyId), undefined)
    // The plain count field → pStar hole → re-dispatched → int codec.
    assert.equal((r.get(countId) as any)?.kind, "int")
    assert.equal((r.get(countId) as any)?.bits, 16)
    // Total: struct + value-int + count-int = 3. (union and empty covered.)
    assert.equal(r.size, 3)
})

test("coverage: fully-absorbing struct rule covers all descendants", () => {
    // struct({a: struct({x: int})}) — inner struct and int both absorbed.
    const T = struct({a: struct({x: integer(0, 1)})})
    const g = buildTypeGraph(T)

    const r = run<string>(g, [
        {pattern: pStruct({a: pStruct({x: pInteger(0, 1)})}), produce: () => "outer"},
        {pattern: pInteger(0, 1), produce: () => "int"},
    ])

    const aId = child(g.root, {field: "a"})!.id
    const xId = child(child(g.root, {field: "a"})!, {field: "x"})!.id
    assert.equal(r.get(g.root.id), "outer")
    assert.equal(r.get(aId), undefined)   // covered
    assert.equal(r.get(xId), undefined)   // covered
    assert.equal(r.size, 1)
})

////////////////////////////////////////////////////////////////////////////////////////////////
// Traits: pre-seeding, extraction, and cross-projection communication
////////////////////////////////////////////////////////////////////////////////////////////////

test("traits: named() pre-seeds TypeNameTrait, extractTraits copies to registry", () => {
    const Ts = named("Timestamp", struct({secs: integer(0, 4294967295), nanos: integer(0, 999999999)}))
    const g = buildTypeGraph(Ts)
    const traits = extractTraits(g)

    assert.equal(traits.get(TypeNameTrait, g.root.id), "Timestamp")
    // Children have no name trait.
    const secsId = child(g.root, {field: "secs"})!.id
    assert.equal(traits.get(TypeNameTrait, secsId), undefined)
})

test("traits: unnamed nodes have no TypeNameTrait", () => {
    const g = buildTypeGraph(struct({a: integer(0, 1)}))
    const traits = extractTraits(g)
    assert.equal(traits.get(TypeNameTrait, g.root.id), undefined)
})

test("traits: custom trait via tag() + defineTrait()", () => {
    const DocTrait = defineTrait<string>()
    const T = struct({a: integer(0, 1)})
    tag(DocTrait, "A simple struct", T)

    const g = buildTypeGraph(T)
    const traits = extractTraits(g)

    assert.equal(traits.get(DocTrait, g.root.id), "A simple struct")
    // TypeNameTrait not attached → absent.
    assert.equal(traits.get(TypeNameTrait, g.root.id), undefined)
})

test("traits: multiple traits on the same type object", () => {
    const DocTrait = defineTrait<string>()
    const UnitTrait = defineTrait<string>()

    const T = named("MyType", struct({a: integer(0, 1)}))
    tag(DocTrait, "Documented", T)
    tag(UnitTrait, "seconds", T)

    const g = buildTypeGraph(T)
    const traits = extractTraits(g)

    assert.equal(traits.get(TypeNameTrait, g.root.id), "MyType")
    assert.equal(traits.get(DocTrait, g.root.id), "Documented")
    assert.equal(traits.get(UnitTrait, g.root.id), "seconds")
})

test("traits: named thunk (recursive type) carries name", () => {
    const T = named("Tree", (): any => union({
        internal: struct({a: T, b: T}),
        leaf: integer(0, 1),
    }))

    const g = buildTypeGraph(T)
    const traits = extractTraits(g)

    // The thunk is the root → name is on node 0.
    assert.equal(traits.get(TypeNameTrait, g.root.id), "Tree")
    // The struct and integer children have no names.
    assert.equal(traits.get(TypeNameTrait, child(g.root, {variant: "internal"})!.id), undefined)
    assert.equal(traits.get(TypeNameTrait, child(g.root, {variant: "leaf"})!.id), undefined)
})

test("traits: produce callback reads traits via registry", () => {
    const Ts = named("Timestamp", struct({secs: integer(0, 4294967295)}))
    const g = buildTypeGraph(Ts)
    const traits = extractTraits(g)

    // A ruleset that uses the name trait for its capability.
    const r = runRuleset(g, [
        {pattern: pStructFields(pStar()), produce: (_m, nodeId, _graph, tr) => {
            return tr.get(TypeNameTrait, nodeId) ?? `T${nodeId}`
        }},
    ], traits)

    assert.equal(r.get(g.root.id), "Timestamp")
})

test("traits: produce callback WRITES traits (cross-projection)", () => {
    const T = struct({a: integer(0, 1)})
    const g = buildTypeGraph(T)
    const traits = extractTraits(g)

    // A "target" ruleset that writes an accessor trait for each field.
    const AccessorTrait = defineTrait<string>()
    const target = runRuleset(g, [
        {pattern: pStructFields(pStar()), produce: (_m, nodeId, graph, tr) => {
            const node = graph.nodes.get(nodeId)!
            for(const e of node.edges) {
                if("field" in e.step) tr.set(AccessorTrait, e.target.id, `obj.${e.step.field}`)
            }
            return "struct"
        }},
    ], traits)

    // The "codec" ruleset reads the accessor trait.
    const aId = child(g.root, {field: "a"})!.id
    assert.equal(traits.get(AccessorTrait, aId), "obj.a")
    // The struct itself has no accessor.
    assert.equal(traits.get(AccessorTrait, g.root.id), undefined)
})

test("traits: different TraitDef instances are distinct channels", () => {
    const A = defineTrait<string>()
    const B = defineTrait<string>()

    const T = struct({a: integer(0, 1)})
    tag(A, "from-A", T)

    const g = buildTypeGraph(T)
    const traits = extractTraits(g)

    assert.equal(traits.get(A, g.root.id), "from-A")
    assert.equal(traits.get(B, g.root.id), undefined)  // B is a different channel
})
