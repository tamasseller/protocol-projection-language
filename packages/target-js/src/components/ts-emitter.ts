/**
 * @ppl/target-js — The default TypeScript type-projection component library
 *
 * Layer 2 (mirrors `@ppl/codecs/src/components/binary-rules.ts`'s own
 * framing): a concrete, opinionated `TsRule[]` built entirely on
 * `../engine/resolver.ts`'s generic resolution primitive
 * (`createTsResolver`/`projectTSTypes`), which knows nothing about this
 * library. `tsTypeRules` has no special standing with `projectTSTypes` — a
 * caller passes it (or doesn't) exactly like any other `TsRule[]`, and can
 * prepend their own rules ahead of it (`[...myOverrides, ...tsTypeRules]`)
 * to preempt specific shapes, same contract `binary-rules.ts` establishes
 * for its own consumers.
 *
 * Idiomatic mapping, no consumer say in it yet:
 *  - `number` for all integers (JS has no fixed-width integers)
 *  - `null` for unit types
 *  - `interface` / `type` for structs and unions
 *  - `T[]` for lists
 */
import type { TypeNode } from "@ppl/core"
import { child, nameOf as declaredNameOf, isUnit } from "@ppl/core"
import { pInteger, pUnit, pStar, pStructFields, pUnionFields, pList } from "@ppl/core"

import type { TsRule } from "../engine/resolver"
import { tsRule } from "../engine/resolver"

// ——————————————————————————————————————————————
// Helpers
// ——————————————————————————————————————————————

/** Resolve a type's TS name: its first-class declared name if present
 *  (`@ppl/core`'s `named()`, read off `node.source` — the pre-deref
 *  object `named()` was actually called on), else `T<id>`. */
function nameOf(node: TypeNode): string
{
    return declaredNameOf(node.source as any) ?? `T${node.id}`
}

// ——————————————————————————————————————————————
// Rules
// ——————————————————————————————————————————————

// 1. Integer → number (leaf, no decl)
const integerRule: TsRule = tsRule(pInteger(-Infinity, Infinity),
    () => "number",
    () => ({ deps: [] }))

// 2. Unit → null (leaf, no decl)
const unitRule: TsRule = tsRule(pUnit(),
    () => "null",
    () => ({ deps: [] }))

// 3. List → T[] (inline, no decl of its own)
const listRule: TsRule = tsRule(pList(pStar()),
    (match, _node, resolve) => `${resolve(match.elementType).ref}[]`,
    (_match, node) => ({ deps: [child(node, { element: true })!.id] }))

// 4. Struct → interface
const structFieldsRule: TsRule = tsRule(pStructFields(pStar()),
    (_match, node) => nameOf(node),
    (match, node, resolve) =>
    {
        const name = nameOf(node)
        const fieldLines = match.fieldMatches.map(f => `  readonly ${f.name}: ${resolve(f.type).ref};`)
        const deps = match.fieldMatches.map(f => child(node, { field: f.name })!.id)
        return { decl: `interface ${name} {\n${fieldLines.join("\n")}\n}`, deps }
    })

// 5. Union → discriminated union (all-unit variants collapse to a plain
//    string-literal union — no tag field needed when there's no payload).
const unionFieldsRule: TsRule = tsRule(pUnionFields(pStar()),
    (_match, node) => nameOf(node),
    (match, node, resolve) =>
    {
        const name = nameOf(node)
        const allUnit = node.edges.every(e => isUnit(e.target.type))

        if(allUnit)
        {
            const literals = match.variantMatches.map(v => `"${v.name}"`).join(" | ")
            return { decl: `type ${name} = ${literals};`, deps: [] }
        }

        const members = match.variantMatches.map(v => `  | { tag: "${v.name}"; value: ${resolve(v.type).ref} }`)
        const deps = match.variantMatches.map(v => child(node, { variant: v.name })!.id)
        return { decl: `type ${name} =\n${members.join("\n")};`, deps }
    })

/** The default TS projection — one array among possibly several, not
 *  privileged by `createTsResolver`/`projectTSTypes` in any way. Pass it
 *  explicitly: `projectTSTypes(root, tsTypeRules)`, or
 *  `projectTSTypes(root, [...myOverrides, ...tsTypeRules])` to preempt
 *  specific shapes. */
export const tsTypeRules: readonly TsRule[] = [integerRule, unitRule, listRule, structFieldsRule, unionFieldsRule]
