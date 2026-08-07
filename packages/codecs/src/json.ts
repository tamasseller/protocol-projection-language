/**
 * @ppl/codecs — Encoder-only pretty-printed JSON
 *
 * Demonstrates two things at once: (1) the codec model has no built-in
 * binary bias — `write(0, 1)` is just "append a byte," and ASCII text is
 * just bytes, so a text format costs nothing extra at the ISA level; (2)
 * nothing requires a decoder to exist — direction never even enters this
 * file — and a program's call graph only has to be internally coherent,
 * never paired with an opposite-direction twin. `buildJsonEncoder` never
 * builds or returns a decode-direction anything.
 *
 * Regularized onto the same `createCodecResolver` (`./rules.ts`)
 * `buildCodec` (builders.ts) is built on, not a bespoke driver of its own —
 * the two differ only in rule list and context type (`Direction` there,
 * nesting depth here). Pretty-printing needs each nesting level's own
 * indent string, but nesting depth is *structural* (known from the type
 * graph, not the data) — so, unlike `builders.ts`, resolution here is
 * memoized by `(TypeNode, depth)`, not `TypeNode` alone, and every indent is
 * a literal byte sequence baked in at generation time; no runtime
 * indent-depth register is threaded through anything. The real cost of
 * that choice: it can't terminate on a genuinely recursive type (each
 * recursive level would demand a new depth, hence a new procedure,
 * forever) — fine for every schema this codebase actually has, not fine in
 * general (and, per builders.test.ts's own recursive-type test, a
 * recursive *call graph* is rejected by the validator regardless — see
 * isa-core.md §8.2). A recursive-safe pretty-printer would need depth as a
 * runtime argument instead, sacrificing the no-indent-register
 * simplification.
 *
 * Integers are formatted as decimal ASCII via `emit_decimal`, a shared
 * `GENERIC`-ABI helper that converts by repeated subtract-largest-
 * fitting-power-of-ten — bounded (≤9 subtractions per digit, 10 digits
 * for a u32) and needs no `DIV`, matching the ISA's deliberate lack of one
 * (ir-engine.md, "No DIV/MOD"). A signed type's negative values are
 * detected by their sign-extended top bit (`load_val`'s `>>> 0` already
 * sign-extends any negative JS number to the full 32-bit pattern, so this
 * check is uniform regardless of the field's declared width) and negated
 * before decimal conversion, with a leading `-` emitted first. Union
 * encoding: an all-unit-variant union emits just its variant name as a
 * JSON string; a union with a real payload emits a single-key object
 * (`{"variantName": <payload>}`).
 */

import type { IrFragment, Procedure, RtlProgram } from "@ppl/machine"
import { ir, declareProc, defineProc, lowerProgram } from "@ppl/machine"
import type { IntegerType, TypeNode } from "@ppl/core"
import { kindOf, SemanticTypeKinds, pInteger, pUnit, pList, pUnionFields, pStructFields, pStar } from "@ppl/core"
import { codecRules } from "./codec-extension"
import type { CodecRule } from "./rules"
import { createCodecResolver, irSeq } from "./rules"

const indent = (depth: number): string => "  ".repeat(depth)

/** `s`'s characters as literal per-byte statements — field names,
 *  punctuation, and indentation are all compile-time-known text, never
 *  runtime data, so this needs no string primitive or runtime loop: it's
 *  just N unrolled `<code>; write(0, 1);` statements, one per character. */
function emitLiteral(s: string): string
{
    return Array.from(s).map(ch => `${ch.codePointAt(0)}; write(0, 1);\n`).join("")
}

// ── emit_decimal(value) — no DIV/MOD; repeated subtract-largest-power ───

const POWERS_OF_TEN = [1_000_000_000, 100_000_000, 10_000_000, 1_000_000, 100_000, 10_000, 1_000, 100, 10, 1]

function emitDecimalBody(): IrFragment
{
    const ZERO = "0".codePointAt(0)!
    // `digit` is declared exactly once, up front, and *reassigned* (never
    // redeclared) per power below. A `u32 x = ...;` declaration always
    // pushes a fresh stack slot to seed its statically-allocated register
    // (lowerVarDecl, lower.ts:226-249) — fine once, or repeated *inside* a
    // runtime loop body (whose own BLOCK_END resets `tos` before every
    // iteration, isa-core.md §8.1) — but wrong here: these ten blocks are
    // flat, sequential, unrolled-at-generation-time siblings with no loop
    // (and hence no `tos`-resetting BLOCK_END) between them, so a second
    // `u32 digit = 0;` would push yet another slot instead of resetting
    // the one `digit` actually refers to, drifting out of sync with it.
    let src = "u32 started = 0;\nu32 digit = 0;\n"

    POWERS_OF_TEN.forEach((power, i) =>
    {
        const isUnits = i === POWERS_OF_TEN.length - 1
        src +=
            "digit = 0;\n" +
            `while (value >= ${power})\n{\n` +
            `    value = value - ${power};\n` +
            "    digit = digit + 1;\n" +
            "}\n"

        // Always shown — the only digit a value of exactly 0 ever prints.
        if(isUnits)
        {
            src += `digit = digit + ${ZERO};\ndigit;\nwrite(0, 1);\n`
        }
        else
        {
            src +=
                "if ((digit != 0) | started)\n{\n" +
                `    digit = digit + ${ZERO};\n` +
                "    digit;\n" +
                "    write(0, 1);\n" +
                "    started = 1;\n" +
                "}\n"
        }
    })

    src += "return;"
    return ir`${src}`
}

// ── Per-kind body generators ─────────────────────────────────────────────

type Resolve = (node: TypeNode, depth: number) => Procedure

function jsonIntegerBody(t: IntegerType, emitDecimal: Procedure): IrFragment
{
    if(t.min >= 0)
        return irSeq(["", emitDecimal, "(load_val(0));\nreturn;"])

    return irSeq([
        "u32 val = 0;\n" +
        "val = load_val(0);\n" +
        "if ((val & 0x80000000) != 0)\n{\n" +
        emitLiteral("-") +
        "val = -val;\n" +
        "}\n",
        emitDecimal,
        "(val);\nreturn;",
    ])
}

function jsonStructBody(node: TypeNode, depth: number, resolve: Resolve): IrFragment
{
    const parts: (string | Procedure)[] = [emitLiteral("{\n")]

    node.edges.forEach((edge, fieldIndex) =>
    {
        if(!("field" in edge.step)) return
        const isLast = fieldIndex === node.edges.length - 1

        parts.push(emitLiteral(`${indent(depth + 1)}"${edge.step.field}": `))
        parts.push("call_codec(")
        parts.push(resolve(edge.target, depth + 1))
        parts.push(`, 0, ${fieldIndex});\n`)
        parts.push(emitLiteral(isLast ? "\n" : ",\n"))
    })

    parts.push(emitLiteral(`${indent(depth)}}`) + "\nreturn;")
    return irSeq(parts)
}

function jsonListBody(node: TypeNode, depth: number, resolve: Resolve): IrFragment
{
    const elem = resolve(node.edges[0]!.target, depth + 1)

    return irSeq([
        emitLiteral("[\n") +
        "u32 left = 0;\n" +
        "left = count(0);\n" +
        "while (left != 0)\n{\n" +
        emitLiteral(indent(depth + 1)) +
        "call_codec_next(",
        elem,
        ", 0);\n" +
        "left = left - 1;\n" +
        "if (left == 0)\n{\n" +
        emitLiteral("\n") +
        "}\nelse\n{\n" +
        emitLiteral(",\n") +
        "}\n" +
        "}\n" +
        emitLiteral(`${indent(depth)}]`) + "\nreturn;",
    ])
}

function jsonUnionBody(node: TypeNode, depth: number, resolve: Resolve): IrFragment
{
    const allUnit = node.edges.every(e => kindOf(e.target.type) === SemanticTypeKinds.Unit)
    const parts: (string | Procedure)[] = ["switch (tag(0))\n{\n"]

    node.edges.forEach((edge, variantIndex) =>
    {
        if(!("variant" in edge.step)) return
        parts.push(`case ${variantIndex}: `)

        if(allUnit)
        {
            parts.push(emitLiteral(`"${edge.step.variant}"`))
        }
        else
        {
            // The payload is resolved at the *same* depth, not depth+1 —
            // `{"name": ...}` is an inline wrapper, not its own nesting
            // level the way a struct's braces are.
            parts.push(emitLiteral(`{"${edge.step.variant}": `))
            parts.push("call_codec(")
            parts.push(resolve(edge.target, depth))
            parts.push(`, 0, ${variantIndex});\n`)
            parts.push(emitLiteral("}"))
        }
        parts.push("\n")
    })

    parts.push("}\nreturn;")
    return irSeq(parts)
}

// ── Entry point ──────────────────────────────────────────────────────────

/** Build an encode-only `RtlProgram` that pretty-prints `root` as JSON.
 *  There is no decode-direction counterpart — see the file header. */
export function buildJsonEncoder(root: TypeNode): RtlProgram
{
    // `emit_decimal` is reserved lazily, on first actual need — a fresh
    // singleton per `buildJsonEncoder` call, shared by every integer node
    // at any depth (unlike TypeNode-keyed resolution, it isn't memoized
    // by `createCodecResolver`'s own cache at all, since it isn't keyed by
    // any TypeNode — declared once, referenced by closure).
    let emitDecimal: Procedure | undefined

    function getEmitDecimal(): Procedure
    {
        if(!emitDecimal)
        {
            emitDecimal = declareProc(["value"])
            defineProc(emitDecimal, emitDecimalBody())
        }
        return emitDecimal
    }

    const jsonRules: readonly CodecRule<number>[] = [
        { pattern: pInteger(-Infinity, Infinity), produce: (_m, node) => jsonIntegerBody(node.type as IntegerType, getEmitDecimal()) },
        { pattern: pUnit(), produce: () => ir`${emitLiteral("null")}return;` },
        { pattern: pList(pStar()), produce: (_m, node, depth, resolve) => jsonListBody(node, depth, resolve) },
        { pattern: pUnionFields(pStar()), produce: (_m, node, depth, resolve) => jsonUnionBody(node, depth, resolve) },
        { pattern: pStructFields(pStar()), produce: (_m, node, depth, resolve) => jsonStructBody(node, depth, resolve) },
    ]

    const resolve = createCodecResolver(jsonRules, (node, depth) => `${depth}|${node.id}`)
    return lowerProgram(resolve(root, 0), { rules: codecRules })
}
