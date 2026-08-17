/**
 * @ppl/codecs — Recovering per-procedure types without `header`
 *
 * `createCodecResolver` (resolver.ts) stamps each `Procedure`'s `header`
 * with the `TypeNode` it was built from — enough to know "this procedure
 * handles struct Foo" for a program built fresh, in-process, this run.
 * That's not enough for a program that arrived any other way: a codec
 * image decoded off the wire (codec-image.ts), or a program round-tripped
 * through `bytecode.ts`'s own wire encoding — `header` doesn't survive
 * either ("Decoded procedures always come back with header: undefined —
 * nothing wire-level to restore it from", bytecode.ts §5.5).
 *
 * The type is still recoverable, from the program's own structure: the
 * entry procedure's type is whatever root type the caller is
 * encoding/decoding against (always known externally — it's the one thing
 * a caller of `run()`/a codec always supplies, regardless of where the
 * `RtlProgram` itself came from), and every other procedure's type
 * follows from *how it's reached* — `ENTER`/`ENTER_NEXT` navigate to a
 * child of an already-known type (a struct field, a union variant, a
 * list element — codec-extension.ts's own `computeChild`/`computeNext`,
 * replayed here at the type level instead of the value level), and
 * `CALL_CODEC`/`CALL_CODEC_NEXT` hand that freshly-computed child type to
 * whichever procedure they call. A recursive descent from the known root,
 * following exactly these four opcodes, recovers every reachable
 * procedure's type — no `header`, no wire format, needed.
 *
 * Navigation goes through one `buildTypeGraph(rootType)` call and its
 * `TypeNode.edges` — never a direct `derefType`/thunk re-invocation on a
 * field/variant's raw type. That distinction is load-bearing, not
 * stylistic: for a self-referential schema, dereferencing a thunk
 * directly re-invokes it fresh, producing a structurally-equivalent but
 * *not identical* object every time (the exact bug this module's own
 * shakedown found in `binary-rules.ts`'s `classifyHoistableFields`, fixed
 * alongside this file). Routing through the graph's own canonical
 * `TypeNode`s instead means every occurrence of the same logical type —
 * however many times it's reached — resolves to the exact same object,
 * and lets this module return `TypeNode`s directly: strictly more useful
 * than a bare `SemanticType` (a caller gets `.edges`/`.id` too), and
 * exactly the shape `header` already carries for the in-process case — a
 * caller can treat "`header` present" and "recovered via this module" as
 * fully interchangeable.
 *
 * This is what any codegen wanting to interpret a raised (`@ppl/machine`'s
 * raise.ts) `ENTER`'s `ref` operand as a real field *name* needs,
 * regardless of whether the program came from a fresh `buildCodec` call
 * or a deserialized image — one shared, target-independent primitive, not
 * something each consumer re-derives.
 */

import type { RtlProgram, RtlInstr } from "@ppl/machine"
import { isExtInstr } from "@ppl/machine"
import type { SemanticType, TypeNode } from "@ppl/core"
import { buildTypeGraph, SemanticTypeKinds } from "@ppl/core"
import type { Correspondence, CorrespondenceEdge } from "@ppl/core"
import type { CodecExtInstr } from "./codec-ext-instr"

/** A struct field's/union variant's child edge, navigated the same way
 *  `computeChild` does at runtime: by declaration-order `ref` index —
 *  codec-extension.md §2.4's "no per-instruction type_ref" design, edges
 *  already in declaration order, so no name lookup is needed to resolve
 *  `ref` itself. Exported: a JS codegen (target-js) walking a *raised*
 *  (`@ppl/machine`'s raise.ts) tree needs this exact navigation too, but
 *  per raised-instruction rather than per-flat-RtlInstr — see
 *  {@link resolveHandleTypes}'s own doc comment for why that means it
 *  can't just call resolveHandleTypes itself and has to drive this
 *  directly. */
export function childNode(node: TypeNode, ref: number): TypeNode
{
    if(node.type.kind !== SemanticTypeKinds.Struct && node.type.kind !== SemanticTypeKinds.Union)
        throw new Error(`resolveProcedureTypes: ENTER/CALL_CODEC on a ${node.type.kind} type isn't supported`)
    const edge = node.edges[ref]
    if(!edge)
        throw new Error(`resolveProcedureTypes: no edge #${ref} on this ${node.type.kind} (${node.edges.length} edge(s))`)
    return edge.target
}

/** A list's element edge — unconditional, no `ref` operand, matching
 *  `computeNext`'s own "a list TypeNode always has exactly one outgoing
 *  edge" reasoning. Exported alongside {@link childNode} — see its doc
 *  comment. */
export function nextNode(node: TypeNode): TypeNode
{
    if(node.type.kind !== SemanticTypeKinds.List)
        throw new Error(`resolveProcedureTypes: ENTER_NEXT/CALL_CODEC_NEXT on a ${node.type.kind} type isn't supported`)
    const edge = node.edges[0]
    if(!edge) throw new Error(`resolveProcedureTypes: list type has no element edge`)
    return edge.target
}

/** Exported alongside {@link childNode}/{@link nextNode} — a codegen doing
 *  its own handle-slot-type bookkeeping wants the same "no known type yet"
 *  error, not a second copy of it. */
export function requireSlotNode(slotNodes: ReadonlyMap<number, TypeNode>, slot: number, opName: string): TypeNode
{
    const node = slotNodes.get(slot)
    if(!node)
        throw new Error(`resolveProcedureTypes: ${opName} references frame slot ${slot} with no known type in this procedure (ENTER-before-use?)`)
    return node
}

/**
 * One procedure body's worth of handle-slot type bookkeeping: scans
 * `body` (a flat, already-lowered `RtlInstr[]`) left to right, tracking
 * which `TypeNode` each handle-table slot holds via `ENTER`/`ENTER_NEXT` —
 * the same slot index can (and in `binary-rules.ts`'s hoisted-tag struct
 * rule, does) hold a *different* type at different points in the same
 * body, so this has to be a genuine left-to-right scan, not a
 * last-write-wins summary read out of order. `onCall`, when given, is
 * invoked for every `CALL_CODEC`/`CALL_CODEC_NEXT` with the callee's own
 * index and entry `TypeNode` — {@link resolveProcedureTypes} uses it to
 * recurse across the whole program's call graph.
 *
 * Extracted as its own function (rather than inlined into
 * `resolveProcedureTypes`'s own walk) because a JS codegen (target-js)
 * needs this exact bookkeeping too, but interleaved with its own
 * per-instruction code emission over the *raised* (`@ppl/machine`'s
 * raise.ts) tree rather than this flat `body` — it can't just call this
 * function once and reuse the result, since the result at any one point
 * depends on how far the scan has gotten (the same slot-reuse reason
 * above). What it *can* reuse is this walk's exact per-op rules, which is
 * why `childNode`/`nextNode`/`requireSlotNode` are exported directly
 * rather than being this function's own private helpers.
 */
export function resolveHandleTypes(
    body: readonly RtlInstr<CodecExtInstr>[],
    entryNode: TypeNode,
    onCall?: (calleeIndex: number, childNode: TypeNode) => void,
): Map<number, TypeNode>
{
    const slotNodes = new Map<number, TypeNode>([[0, entryNode]])

    for(const instr of body)
    {
        if(!isExtInstr(instr)) continue

        switch(instr.ext)
        {
            case "ENTER":
            {
                const {dst, src, ref} = instr
                const srcNode = requireSlotNode(slotNodes, src, "ENTER")
                slotNodes.set(dst, childNode(srcNode, ref))
                break
            }
            case "ENTER_NEXT":
            {
                const {dst, src} = instr
                const srcNode = requireSlotNode(slotNodes, src, "ENTER_NEXT")
                slotNodes.set(dst, nextNode(srcNode))
                break
            }
            case "CALL_CODEC":
            {
                const {calleeIndex, src, ref} = instr
                const srcNode = requireSlotNode(slotNodes, src, "CALL_CODEC")
                onCall?.(calleeIndex, childNode(srcNode, ref))
                break
            }
            case "CALL_CODEC_NEXT":
            {
                const {calleeIndex, src} = instr
                const srcNode = requireSlotNode(slotNodes, src, "CALL_CODEC_NEXT")
                onCall?.(calleeIndex, nextNode(srcNode))
                break
            }
        }
    }

    return slotNodes
}

/**
 * Recover each reachable procedure's own `TypeNode`, by index, from the
 * known root type of the entry procedure (`program.procedures[0]`) — a
 * recursive descent over `ENTER`/`ENTER_NEXT`/`CALL_CODEC`/
 * `CALL_CODEC_NEXT` (via {@link resolveHandleTypes}), memoized by
 * procedure index for cycle safety (a self- or mutually-recursive schema
 * reaches the same procedure more than once — same reason
 * `reconcile.ts`/`resolver.ts` both memoize their own recursive walks).
 */
export function resolveProcedureTypes(program: RtlProgram<CodecExtInstr>, rootType: SemanticType): Map<number, TypeNode>
{
    const graph = buildTypeGraph(rootType)
    const types = new Map<number, TypeNode>()

    function visit(procIndex: number, node: TypeNode): void
    {
        if(types.has(procIndex)) return
        types.set(procIndex, node)

        const proc = program.procedures[procIndex]
        if(!proc) throw new Error(`resolveProcedureTypes: no procedure ${procIndex}`)

        resolveHandleTypes(proc.body, node, visit)
    }

    visit(0, graph.root)
    return types
}

// ─────────────────────────────────────────────────────────────────────────
// Correspondence-aware navigation — for a target codegen bridging a
// received codec image to a local schema (docs/codec-image.md §2/§3,
// `reconcile.ts`). Mirrors everything above exactly, one level up: where
// `childNode`/`nextNode`/`resolveHandleTypes` navigate a single `TypeNode`
// tree, these navigate a `Correspondence` tree instead — same shape, same
// reason for being exported here rather than left private to a single
// caller (this file's own header: "a JS codegen needs this exact
// bookkeeping too").
// ─────────────────────────────────────────────────────────────────────────

/** A struct field's/union variant's own `CorrespondenceEdge`, navigated by
 *  *name* — mirrors {@link childNode}'s by-`ref` navigation into the image
 *  tree, but into `parent.children` instead. Every name on either side has
 *  an entry (`reconcile.ts`'s own doc comment on `Correspondence.children`),
 *  so this never misses one for a genuinely `"matched"` `parent` — the same
 *  precondition `resolve()` itself has. */
export function correspondenceChild(parent: Correspondence, name: string): CorrespondenceEdge
{
    const edge = parent.children?.find(e => e.name === name)
    if(!edge) throw new Error(`correspondenceChild: no edge named "${name}" on this Correspondence`)
    return edge
}

/** A list's one element `Correspondence` — mirrors {@link nextNode}. Always
 *  present on a `"matched"`, list-kind `Correspondence` (`reconcile.ts`'s
 *  own doc comment: a list's element edge is always `"matched"` itself,
 *  even when what's nested inside it diverges). */
export function correspondenceElement(parent: Correspondence): Correspondence
{
    if(!parent.element) throw new Error(`correspondenceElement: no element Correspondence on this Correspondence`)
    return parent.element
}

/** Recovers the field/variant *name* a `ref` operand addresses, off the
 *  image side of `srcCorrespondence` — the bytecode's own `ref` operands
 *  stay positional into the *image* tree regardless of reconciliation
 *  (docs/codec-image.md §2.1), so this is the one place that positional
 *  index has to be translated into the name {@link correspondenceChild}
 *  actually looks up by. */
function nameOfRef(srcCorrespondence: Correspondence, ref: number, opName: string): string
{
    const srcImage = srcCorrespondence.imageNode
    if(!srcImage) throw new Error(`resolveHandleCorrespondences: ${opName} references a correspondence with no image node`)
    if(srcImage.type.kind !== SemanticTypeKinds.Struct && srcImage.type.kind !== SemanticTypeKinds.Union)
        throw new Error(`resolveHandleCorrespondences: ${opName} on a ${srcImage.type.kind} type isn't supported`)
    const edge = srcImage.edges[ref]
    if(!edge) throw new Error(`resolveHandleCorrespondences: no edge #${ref} on this ${srcImage.type.kind} (${srcImage.edges.length} edge(s))`)
    const step = edge.step as { field: string } | { variant: string }
    return "field" in step ? step.field : step.variant
}

/**
 * Mirrors {@link resolveHandleTypes} exactly — same four-opcode,
 * left-to-right, slot-reuse-safe scan — but threads a `Correspondence`
 * alongside each handle slot's own image `TypeNode`, for a target codegen
 * bridging a received codec image to a local schema. Purely navigational:
 * direction-agnostic, matching `reconcile()`'s own nature — a caller
 * decides `bridge`/`drop`/`default`/`trap` itself, per instruction, by
 * calling `resolve()` on whatever this returns; this function never calls
 * `resolve()` itself.
 *
 * `onCall`'s `childCorrespondence` may be `"image-only"` — nothing has gone
 * wrong; a codegen that wants to keep navigating a dropped subtree (e.g. to
 * correctly consume its own wire bytes even though the result gets
 * dropped) still needs its own `Correspondence` to do so, same as
 * {@link resolveHandleTypes}'s own `onCall` is invoked regardless of
 * whether the caller ends up using the callee's result.
 */
export function resolveHandleCorrespondences(
    body: readonly RtlInstr<CodecExtInstr>[],
    entryCorrespondence: Correspondence,
    onCall?: (calleeIndex: number, childCorrespondence: Correspondence) => void,
): Map<number, Correspondence>
{
    const slotCorrespondences = new Map<number, Correspondence>([[0, entryCorrespondence]])

    function requireSlot(slot: number, opName: string): Correspondence
    {
        const c = slotCorrespondences.get(slot)
        if(!c)
            throw new Error(`resolveHandleCorrespondences: ${opName} references frame slot ${slot} with no known correspondence (ENTER-before-use?)`)
        return c
    }

    for(const instr of body)
    {
        if(!isExtInstr(instr)) continue

        switch(instr.ext)
        {
            case "ENTER":
            {
                const {dst, src, ref} = instr
                const srcC = requireSlot(src, "ENTER")
                slotCorrespondences.set(dst, correspondenceChild(srcC, nameOfRef(srcC, ref, "ENTER")).correspondence)
                break
            }
            case "ENTER_NEXT":
            {
                const {dst, src} = instr
                slotCorrespondences.set(dst, correspondenceElement(requireSlot(src, "ENTER_NEXT")))
                break
            }
            case "CALL_CODEC":
            {
                const {calleeIndex, src, ref} = instr
                const srcC = requireSlot(src, "CALL_CODEC")
                onCall?.(calleeIndex, correspondenceChild(srcC, nameOfRef(srcC, ref, "CALL_CODEC")).correspondence)
                break
            }
            case "CALL_CODEC_NEXT":
            {
                const {calleeIndex, src} = instr
                onCall?.(calleeIndex, correspondenceElement(requireSlot(src, "CALL_CODEC_NEXT")))
                break
            }
        }
    }

    return slotCorrespondences
}
