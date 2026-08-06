/**
 * `ir\`...\`` tagged-template tests — covers procedure identity/reference
 * splicing (docs/ROADMAP.md item 1), not just plain-value interpolation
 * (already exercised indirectly by e2e.test.ts/lowering.test.ts).
 */
import {test, describe} from "node:test"
import * as assert from "node:assert/strict"
import {ir, proc, concat} from "../src/ir"

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
