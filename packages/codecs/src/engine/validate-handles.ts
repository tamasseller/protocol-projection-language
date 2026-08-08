/**
 * @ppl/codecs — Static validation (docs/codec-extension.md §7.1): handle
 * type/bounds checking and cross-procedure delegation-type consistency
 *
 * `@ppl/machine`'s `validate.ts` stays codec-agnostic — no notion of
 * handles/iterators, only TOS depth and the call graph. Everything here
 * rides on one extra piece of data it already carries through untouched:
 * `RtlProc.header`, each `CODEC`-ABI procedure's declared `o0` type (a
 * `TypeNode`, set by `resolver.ts`'s `declareProc`). No header ⇒ `GENERIC`
 * (§4.1) — no `o0`, never a `CALL_CODEC` target.
 *
 * Object handles (§2.4: a handle's type is fully pinned by its
 * provenance) get a fresh `Map<handleId, TypeNode>` per procedure — real,
 * exact, since `CALL_CODEC`/`CALL_CODEC_NEXT` genuinely give the callee a
 * fresh handle frame (§2.2, `codec-extension.ts`'s `frames.push`).
 *
 * Stream iterators are different: `i0` and every fork are *global*, shared
 * across the whole call graph (§2.1 — never rebound at a call), not
 * frame-scoped. A fully correct check would need each procedure's
 * reachable iterator set threaded through every possible caller. Nothing
 * built so far clones an iterator in one procedure and uses it in another
 * (§8.4's checksum-with-fixup is entirely one procedure), so this file
 * takes the conservative, cheaper option instead: each procedure must
 * establish its own iterators (via `CLONE_RD`/`CLONE_WR`) itself, just
 * like handles. This rejects a legal-but-unseen cross-procedure sharing
 * pattern the runtime would actually allow — a deliberate, disclosed
 * scope limit, not a bug.
 *
 * §7.2's per-resource peak-usage stats (object-handle frame peaks, stream-
 * iterator peaks) were built and then removed: envisioned for a target
 * that blindly trusts pre-validation and needs to pre-size its resource
 * tables from the stats alone, without re-deriving them — turned out
 * nothing this project actually builds needs that. The one figure of this
 * shape that *is* a genuine `@ppl/machine`-level concern (`validateProgram`'s
 * own `ProgramStats`, isa-core.md §8.3's call-depth bound) already lives
 * there, generically, for any consumer that wants it; a target that
 * someday needs the codec-specific numbers too can derive them itself and
 * fold them into its own application-level image. No point carrying
 * unused surface here in a domain (§6) where compactness is the
 * overriding goal.
 *
 * `validateCodecHandles` assumes `validateProgram` already ran (no
 * re-derivation of §8.1-§8.5).
 */

import type {RtlProgram, RtlProc, RtlInstr, ExtInstr} from "@ppl/machine"
import {isExtInstr} from "@ppl/machine"
import type {TypeNode} from "@ppl/core"
import {SemanticTypeKinds} from "@ppl/core"
import type {CodecOpcode} from "./opcodes"
import {isCodecOpcode, assertNever} from "./opcodes"

type HandleEnv = Map<number, TypeNode>

/** A stream iterator's statically-known capability — `"any"` for `i0`
 *  (id 0), whose real capability depends on the program's direction, which
 *  this file doesn't take as a parameter (see the file header); a fork's
 *  capability is always known exactly, from which of `CLONE_RD`/
 *  `CLONE_WR` created it. */
type IterCapability = "read" | "write" | "any"
type IterEnv = Map<number, IterCapability>

function fail(procIndex: number, pc: number, message: string): never
{
    throw new Error(`codec validation: procedure ${procIndex}, instruction ${pc}: ${message}`)
}

function handleOf(env: HandleEnv, procIndex: number, pc: number, id: number, opName: string): TypeNode
{
    const type = env.get(id)
    if(!type) fail(procIndex, pc, `${opName}: handle ${id} was never entered in this procedure`)
    return type
}

/** `src`'s child at field/variant index `ref` (§2.4/§2.2's disambiguation
 *  table) — the static twin of `codec-extension.ts`'s own runtime
 *  `computeChild`, minus any actual value access. */
function childOf(src: TypeNode, ref: number, procIndex: number, pc: number, opName: string): TypeNode
{
    if(src.type.kind === SemanticTypeKinds.Struct || src.type.kind === SemanticTypeKinds.Union)
    {
        const edge = src.edges[ref]
        if(!edge)
            fail(procIndex, pc, `${opName}: ref ${ref} out of range (${src.edges.length} field/variant(s) on this ${src.type.kind})`)
        return edge.target
    }
    if(src.type.kind === SemanticTypeKinds.List)
        fail(procIndex, pc, `${opName}: list elements are reached via ENTER_NEXT/CALL_CODEC_NEXT, never by ref`)
    fail(procIndex, pc, `${opName}: source handle is a ${src.type.kind} — struct/union only`)
}

/** `src`'s next list element (§3.4) — the static twin of `computeNext`. */
function nextOf(src: TypeNode, procIndex: number, pc: number, opName: string): TypeNode
{
    if(src.type.kind !== SemanticTypeKinds.List)
        fail(procIndex, pc, `${opName}: source handle is a ${src.type.kind} — list only`)
    const edge = src.edges[0]
    if(!edge) fail(procIndex, pc, `${opName}: list type has no element edge`)
    return edge.target
}

function iterOf(env: IterEnv, procIndex: number, pc: number, id: number, opName: string): IterCapability
{
    const cap = env.get(id)
    if(cap === undefined) fail(procIndex, pc, `${opName}: stream iterator ${id} was never cloned in this procedure`)
    return cap
}

function requireCapability(cap: IterCapability, need: "read" | "write", procIndex: number, pc: number, id: number, opName: string): void
{
    if(cap !== "any" && cap !== need)
        fail(procIndex, pc, `${opName}: iterator ${id} is ${cap}-only, not ${need}`)
}

function checkCalleeType(program: RtlProgram, codecIdx: number, childType: TypeNode, procIndex: number, pc: number, opName: string): void
{
    const callee = program.procedures[codecIdx]
    if(!callee) fail(procIndex, pc, `${opName}: no such procedure ${codecIdx}`)
    const calleeHeader = callee.header as TypeNode | undefined
    if(!calleeHeader)
        fail(procIndex, pc, `${opName}: procedure ${codecIdx} is GENERIC (no declared object type) — can't be a delegation target`)
    // Object identity, not `.id` equality: both sides are always TypeNodes
    // from the one TypeGraph a single `buildCodec` call builds
    // (resolver.ts's `graph ??= buildTypeGraph(...)`, memoized once), so
    // "the same type" and "the same TypeNode object" coincide exactly —
    // the dedup `type-graph.ts`'s own doc comment describes.
    if(calleeHeader !== childType)
        fail(procIndex, pc,
            `${opName}: procedure ${codecIdx}'s declared type (node ${calleeHeader.id}) doesn't match the ` +
            `delegated-to child's actual type (node ${childType.id}) — a field/variant is being decoded with the wrong codec`)
}

function analyzeProcedure(proc: RtlProc, procIndex: number, program: RtlProgram): void
{
    const header = proc.header as TypeNode | undefined
    const body = proc.body

    function handleExt(instr: ExtInstr, env: HandleEnv, iterEnv: IterEnv, pc: number): void
    {
        if(!isCodecOpcode(instr.ext)) fail(procIndex, pc, `unrecognized codec opcode "${instr.ext}"`)
        const op: CodecOpcode = instr.ext

        switch(op)
        {
            case "ENTER":
            {
                const [dst, src, ref] = instr.operands as readonly [number, number, number]
                env.set(dst, childOf(handleOf(env, procIndex, pc, src, op), ref, procIndex, pc, op))
                return
            }
            case "ENTER_NEXT":
            {
                const [dst, src] = instr.operands as readonly [number, number]
                env.set(dst, nextOf(handleOf(env, procIndex, pc, src, op), procIndex, pc, op))
                return
            }
            case "LOAD_VAL":
            case "STORE_VAL":
            {
                const [src] = instr.operands as readonly [number]
                const t = handleOf(env, procIndex, pc, src, op)
                if(t.type.kind !== SemanticTypeKinds.Integer)
                    fail(procIndex, pc, `${op}: handle ${src} is a ${t.type.kind}, not a primitive value`)
                return
            }
            case "COUNT":
            case "OPEN_LIST":
            {
                const [src] = instr.operands as readonly [number]
                const t = handleOf(env, procIndex, pc, src, op)
                if(t.type.kind !== SemanticTypeKinds.List)
                    fail(procIndex, pc, `${op}: handle ${src} is a ${t.type.kind}, not a list`)
                return
            }
            case "TAG":
            {
                const [src] = instr.operands as readonly [number]
                const t = handleOf(env, procIndex, pc, src, op)
                if(t.type.kind !== SemanticTypeKinds.Union)
                    fail(procIndex, pc, `TAG: handle ${src} is a ${t.type.kind}, not a union`)
                return
            }
            case "CALL_CODEC":
            {
                const [codecIdx, src, ref] = instr.operands as readonly [number, number, number]
                const childType = childOf(handleOf(env, procIndex, pc, src, op), ref, procIndex, pc, op)
                checkCalleeType(program, codecIdx, childType, procIndex, pc, op)
                return
            }
            case "CALL_CODEC_NEXT":
            {
                const [codecIdx, src] = instr.operands as readonly [number, number]
                const childType = nextOf(handleOf(env, procIndex, pc, src, op), procIndex, pc, op)
                checkCalleeType(program, codecIdx, childType, procIndex, pc, op)
                return
            }
            case "READ":
            {
                const [iterId] = instr.operands as readonly [number, number]
                requireCapability(iterOf(iterEnv, procIndex, pc, iterId, op), "read", procIndex, pc, iterId, op)
                return
            }
            case "WRITE":
            {
                const [iterId] = instr.operands as readonly [number, number]
                requireCapability(iterOf(iterEnv, procIndex, pc, iterId, op), "write", procIndex, pc, iterId, op)
                return
            }
            case "HAS_NEXT":
            {
                const [iterId] = instr.operands as readonly [number]
                requireCapability(iterOf(iterEnv, procIndex, pc, iterId, op), "read", procIndex, pc, iterId, op)
                return
            }
            case "SEEK":
            {
                const [iterId] = instr.operands as readonly [number, number]
                iterOf(iterEnv, procIndex, pc, iterId, op) // bounds only — either capability may seek
                return
            }
            case "CLONE_RD":
            {
                const [src, dst] = instr.operands as readonly [number, number]
                iterOf(iterEnv, procIndex, pc, src, op) // src's own capability doesn't matter (§2.1)
                iterEnv.set(dst, "read")
                return
            }
            case "CLONE_WR":
            {
                const [src, dst] = instr.operands as readonly [number, number]
                iterOf(iterEnv, procIndex, pc, src, op)
                iterEnv.set(dst, "write")
                return
            }
            default:
                return assertNever(op)
        }
    }

    /** Mirrors `validate.ts`'s own `walk` shape exactly (BR_TABLE's N cases,
     *  LOOP's cond-then-body), threading a handle-type environment instead
     *  of a TOS depth. Each branch/loop sub-block gets its own copy — no
     *  case or iteration's handle bindings are assumed to survive past it,
     *  matching every rule body actually written so far (a hoisted
     *  struct field's ENTER always precedes its own switch, never depends
     *  on a sibling case's bindings; a loop's own ENTER_NEXT always
     *  precedes its own use within the same body block). */
    function walk(pc: number, env: HandleEnv, iterEnv: IterEnv): {nextPc: number; terminated: boolean}
    {
        for(; ;)
        {
            if(pc >= body.length) fail(procIndex, pc, `ran off the end without finding this block's own close`)
            const instr: RtlInstr = body[pc]!

            if(instr.op === "BLOCK_END") return {nextPc: pc + 1, terminated: false}
            if(instr.op === "RETURN" || instr.op === "TRAP") return {nextPc: pc + 1, terminated: true}

            if(instr.op === "BR_TABLE")
            {
                let p = pc + 1
                for(let k = 0; k < instr.imm; k++)
                    ({nextPc: p} = walk(p, new Map(env), new Map(iterEnv)))
                pc = p; continue
            }

            if(instr.op === "LOOP")
            {
                const cond = walk(pc + 1, new Map(env), new Map(iterEnv))
                const body_ = walk(cond.nextPc, new Map(env), new Map(iterEnv))
                pc = body_.nextPc; continue
            }

            if(isExtInstr(instr)) {handleExt(instr, env, iterEnv, pc); pc++; continue}

            pc++
        }
    }

    const seedEnv: HandleEnv = header ? new Map([[0, header]]) : new Map()
    const seedIterEnv: IterEnv = new Map([[0, "any"]])
    walk(0, seedEnv, seedIterEnv)
}

/**
 * Throws on the first §7.1 violation found — a handle used in a way its
 * statically-derived type doesn't support (wrong kind, out-of-range
 * field/variant ref), or a `CALL_CODEC`/`CALL_CODEC_NEXT` site whose callee
 * was built for a different type than the one it's actually being handed.
 * Run alongside `validateProgram`, not instead of it.
 */
export function validateCodecHandles(program: RtlProgram): void
{
    program.procedures.forEach((proc, i) => analyzeProcedure(proc, i, program))
}
