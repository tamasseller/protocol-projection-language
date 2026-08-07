/**
 * `ir\`...\`` tagged-template tests — covers procedure identity/reference
 * splicing (docs/ROADMAP.md item 1), not just plain-value interpolation
 * (already exercised indirectly by e2e.test.ts/lowering.test.ts).
 */
import {test, describe} from "node:test"
import * as assert from "node:assert/strict"
import {ir, proc, concat, declareProc, defineProc} from "../src/ir"
import {lowerProgram} from "../src/lower"
import {run} from "../src/vm"

describe("ir` `: procedure references", () =>
{
    test("plain values still splice as text, calls stays empty", () =>
    {
        const frag = ir`u32 x = ${3} + ${"y"};`
        assert.equal(frag.source, "u32 x = 3 + y;")
        assert.equal(frag.calls.size, 0)
    })

    test("a spliced Procedure becomes a synthetic callee and is recorded in calls", () =>
    {
        const callee = proc(["a"], ir`return a;`)
        const frag = ir`return ${callee}(1);`

        assert.equal(frag.body.length, 1)
        const stmt = frag.body[0] as any
        assert.equal(stmt.type, "ReturnStatement")
        assert.equal(stmt.argument.type, "CallExpression")

        const calleeName: string = stmt.argument.callee.name
        assert.equal(frag.calls.size, 1)
        assert.equal(frag.calls.get(calleeName), callee)
    })

    test("two distinct Procedures spliced into one fragment resolve to two distinct entries", () =>
    {
        const a = proc([], ir`return 1;`)
        const b = proc([], ir`return 2;`)
        const frag = ir`u32 t = ${a}() + ${b}();`

        assert.equal(frag.calls.size, 2)
        assert.equal([...frag.calls.values()].includes(a), true)
        assert.equal([...frag.calls.values()].includes(b), true)
    })

    test("the same Procedure spliced twice collapses to one calls entry", () =>
    {
        const shared = proc([], ir`return 1;`)
        const frag = ir`u32 t = ${shared}() + ${shared}();`

        assert.equal(frag.calls.size, 1)
        assert.equal(frag.calls.get(shared.name), shared)
    })
})

describe("declareProc/defineProc: two-phase construction", () =>
{
    test("a declared Procedure's name is spliceable before its fragment is defined", () =>
    {
        const later = declareProc(["n"])
        const frag = ir`return ${later}(1);`
        assert.equal(frag.calls.get(later.name), later)

        defineProc(later, ir`return n;`)
        assert.equal(later.fragment.body.length, 1)
    })

    test("defining the same Procedure twice throws", () =>
    {
        const p = declareProc([])
        defineProc(p, ir`return 1;`)
        assert.throws(() => defineProc(p, ir`return 2;`), /already has a fragment/)
    })

    test("mutually recursive procedures resolve without either needing the other's fragment first", () =>
    {
        // Neither `a` nor `b` could be built with the eager `proc()` — each
        // needs the other's synthetic name spliced into its own source
        // *before* either fragment is parsed. `declareProc` mints both
        // identities first; each fragment then references the other's
        // already-valid name, and `defineProc` fills each in afterward.
        const a = declareProc(["n"])
        const b = declareProc(["n"])
        defineProc(a, ir`if (n == 0) return 1; return ${b}(n - 1);`)
        defineProc(b, ir`if (n == 0) return 2; return ${a}(n - 1);`)
        const main = proc([], ir`return ${a}(4);`)

        const program = lowerProgram(main)
        const result = run(program)

        assert.ok(result.ok, "expected normal return, got trap")
        // a(4)->b(3)->a(2)->b(1)->a(0) — lands on a's own base case.
        assert.equal(result.acc, 1)
    })
})

describe("concat", () =>
{
    test("concatenates bodies in order and unions calls maps", () =>
    {
        const a = proc([], ir`return 1;`)
        const b = proc([], ir`return 2;`)

        const frag = concat(
            ir`${a}();`,
            ir`${b}();`,
        )

        assert.equal(frag.body.length, 2)
        assert.equal(frag.calls.size, 2)
        assert.equal(frag.calls.get(a.name), a)
        assert.equal(frag.calls.get(b.name), b)
    })

    test("the same Procedure referenced from several concatenated fragments doesn't collide", () =>
    {
        const shared = proc([], ir`return 1;`)

        const frag = concat(
            ir`${shared}();`,
            ir`${shared}();`,
            ir`u32 x = 1;`,
        )

        assert.equal(frag.body.length, 3)
        assert.equal(frag.calls.size, 1)
        assert.equal(frag.calls.get(shared.name), shared)
    })

    test("mirrors how independently-built, per-element fragments (e.g. one per schema field) combine", () =>
    {
        const fieldProc = (n: number) => proc(["self"], ir`return self + ${n};`)
        const fields = [1, 2, 3].map(fieldProc)

        const record = concat(...fields.map(f => ir`${f}(0);`))

        assert.equal(record.body.length, 3)
        assert.equal(record.calls.size, 3)
        for (const f of fields) assert.equal(record.calls.get(f.name), f)
    })
})
