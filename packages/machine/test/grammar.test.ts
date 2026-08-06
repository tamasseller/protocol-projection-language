/**
 * Grammar smoke tests — validates the PEG.js parser produces correct ASTs
 * for the minimal C-like DSL.
 */
import {test, describe} from "node:test"
import * as assert from "node:assert/strict"
import {parse} from "../src/parser.js"

/** Pretty-print an AST node for snapshot testing. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stripLoc(node: any): any
{
    if (Array.isArray(node))
        return node.map(stripLoc)
    if (node !== null && typeof node === "object")
        return Object.fromEntries(
            Object.entries(node)
                .filter(([k]) => k !== "location")
                .map(([k, v]) => [k, stripLoc(v)])
        )
    return node
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p = (input: string): any => stripLoc(parse(input))

// ——————————————————————————————————————————————
// 1. Declarations
// ——————————————————————————————————————————————

describe("Declarations", () =>
{
    test("variable declaration without init", () =>
    {
        const ast = p("u32 x;")
        assert.deepEqual(ast, {
            type: "Program",
            body: [{
                type: "VariableDeclaration",
                declarations: [{
                    type: "VariableDeclarator",
                    id: {type: "Identifier", name: "x"},
                    init: null,
                }],
            }],
        })
    })

    test("variable declaration with init", () =>
    {
        const ast = p("u32 x = 42;")
        assert.deepEqual(ast, {
            type: "Program",
            body: [{
                type: "VariableDeclaration",
                declarations: [{
                    type: "VariableDeclarator",
                    id: {type: "Identifier", name: "x"},
                    init: {type: "Literal", value: 42, raw: "42"},
                }],
            }],
        })
    })
})

// ——————————————————————————————————————————————
// 2. Expressions
// ——————————————————————————————————————————————

describe("Expressions", () =>
{
    test("binary operators — arithmetic", () =>
    {
        const ast = p("x = a + b * c;")
        assert.deepEqual(ast.body[0].expression.left.name, "x")
        assert.equal(ast.body[0].expression.right.type, "BinaryExpression")
        assert.equal(ast.body[0].expression.right.operator, "+")
        assert.equal(ast.body[0].expression.right.right.type, "BinaryExpression")
        assert.equal(ast.body[0].expression.right.right.operator, "*")
    })

    test("binary operators — shift", () =>
    {
        const ast = p("x = a << 2;")
        assert.equal(ast.body[0].expression.right.operator, "<<")
    })

    test("binary operators — bitwise", () =>
    {
        const ast = p("x = a | b & ~c;")
        // bitwise OR has lower precedence than AND, which has lower than unary ~
        const e = ast.body[0].expression.right
        assert.equal(e.operator, "|")
        assert.equal(e.right.operator, "&")
        assert.equal(e.right.right.operator, "~")
    })

    test("ternary operator", () =>
    {
        const ast = p("x = a ? b : c;")
        const e = ast.body[0].expression.right
        assert.equal(e.type, "ConditionalExpression")
        assert.equal(e.test.name, "a")
        assert.equal(e.consequent.name, "b")
        assert.equal(e.alternate.name, "c")
    })

    test("ternary is right-associative", () =>
    {
        const ast = p("x = a ? b : c ? d : e;")
        const e = ast.body[0].expression.right
        assert.equal(e.type, "ConditionalExpression")
        assert.equal(e.alternate.type, "ConditionalExpression")
    })

    test("assignment is right-associative", () =>
    {
        const ast = p("x = y = 42;")
        const e = ast.body[0].expression
        assert.equal(e.type, "AssignmentExpression")
        assert.equal(e.right.type, "AssignmentExpression")
    })

    test("compound assignment operators", () =>
    {
        for (const op of ["+=", "-=", "*=", "/=", "%=", "<<=", ">>=", "&=", "^=", "|="])
        {
            const ast = p(`x ${op} 1;`)
            assert.equal(ast.body[0].expression.operator, op, `operator ${op}`)
        }
    })

    test("prefix increment/decrement", () =>
    {
        const ast = p("x = ++y;")
        assert.equal(ast.body[0].expression.right.type, "UpdateExpression")
        assert.equal(ast.body[0].expression.right.operator, "++")
        assert.equal(ast.body[0].expression.right.prefix, true)
    })

    test("postfix increment/decrement", () =>
    {
        const ast = p("x = y++;")
        assert.equal(ast.body[0].expression.right.type, "UpdateExpression")
        assert.equal(ast.body[0].expression.right.operator, "++")
        assert.equal(ast.body[0].expression.right.prefix, false)
    })

    test("logical operators", () =>
    {
        const ast = p("x = a && b || c;")
        const e = ast.body[0].expression.right
        assert.equal(e.type, "LogicalExpression")
        assert.equal(e.operator, "||")
        assert.equal(e.left.operator, "&&")
    })

    test("relational operators", () =>
    {
        const ast = p("x = a < b == c > d;")
        const e = ast.body[0].expression.right
        assert.equal(e.operator, "==")
        assert.equal(e.left.operator, "<")
        assert.equal(e.right.operator, ">")
    })

    test("hex literals", () =>
    {
        const ast = p("x = 0xFF;")
        assert.equal(ast.body[0].expression.right.value, 255)
    })

    test("function calls", () =>
    {
        const ast = p("foo(1, x);")
        assert.equal(ast.body[0].expression.type, "CallExpression")
        assert.equal(ast.body[0].expression.callee.name, "foo")
        assert.equal(ast.body[0].expression.arguments.length, 2)
    })

    test("parenthesized expressions", () =>
    {
        const ast = p("x = (a + b) * c;")
        // Parentheses force + before *
        const e = ast.body[0].expression.right
        assert.equal(e.operator, "*")
        assert.equal(e.left.operator, "+")
    })
})

// ——————————————————————————————————————————————
// 3. Control Flow
// ——————————————————————————————————————————————

describe("Control Flow", () =>
{
    test("if-else with blocks", () =>
    {
        const ast = p("if (x) { foo(); } else { bar(); }")
        assert.equal(ast.body[0].type, "IfStatement")
        assert.equal(ast.body[0].consequent.type, "BlockStatement")
        assert.equal(ast.body[0].alternate.type, "BlockStatement")
    })

    test("if-else", () =>
    {
        const ast = p("if (x) foo(); else bar();")
        assert.equal(ast.body[0].consequent.type, "ExpressionStatement")
        assert.equal(ast.body[0].alternate.type, "ExpressionStatement")
    })

    test("dangling-else binds to nearest if", () =>
    {
        const ast = p("if (a) if (b) foo(); else bar();")
        // else binds to inner if(b)
        assert.equal(ast.body[0].consequent.alternate.type, "ExpressionStatement")
        assert.equal(ast.body[0].alternate, null)
    })

    test("while", () =>
    {
        const ast = p("while (x) { x = x - 1; }")
        assert.equal(ast.body[0].type, "WhileStatement")
    })

    test("for — classic", () =>
    {
        const ast = p("for (u32 i = 0; i < 10; i = i + 1) { foo(); }")
        const f = ast.body[0]
        assert.equal(f.type, "ForStatement")
        assert.equal(f.init.type, "VariableDeclaration")
        assert.equal(f.test.type, "BinaryExpression")
        assert.equal(f.update.type, "AssignmentExpression")
    })

    test("for — empty clauses", () =>
    {
        const ast = p("for (;;) { return 0; }")
        const f = ast.body[0]
        assert.equal(f.init, null)
        assert.equal(f.test, null)
        assert.equal(f.update, null)
    })

    test("switch-case", () =>
    {
        const ast = p(`
            switch (x) {
                case 1: foo();
                case 2: bar();
                default: baz();
            }
        `)
        const s = ast.body[0]
        assert.equal(s.type, "SwitchStatement")
        assert.equal(s.cases.length, 3)
        assert.equal(s.cases[0].test.value, 1)
        assert.equal(s.cases[0].consequent.length, 1) // foo();
        assert.equal(s.cases[1].test.value, 2)
        assert.equal(s.cases[2].test, null) // default
    })

    test("return with value", () =>
    {
        const ast = p("return 42;")
        assert.equal(ast.body[0].type, "ReturnStatement")
        assert.equal(ast.body[0].argument.value, 42)
    })

    test("return without value", () =>
    {
        const ast = p("return;")
        assert.equal(ast.body[0].type, "ReturnStatement")
        assert.equal(ast.body[0].argument, null)
    })
})

// ——————————————————————————————————————————————
// 4. Comments
// ——————————————————————————————————————————————

describe("Comments", () =>
{
    test("single-line comments are ignored", () =>
    {
        const ast = p("// comment\nu32 x;")
        assert.equal(ast.body.length, 1)
        assert.equal(ast.body[0].declarations[0].id.name, "x")
    })

    test("multi-line comments are ignored", () =>
    {
        const ast = p("/* comment */ u32 x;")
        assert.equal(ast.body[0].declarations[0].id.name, "x")
    })
})

// ——————————————————————————————————————————————
// 5. Rejection (negative tests)
// ——————————————————————————————————————————————

describe("Rejection", () =>
{
    // Expected to throw — no pointer type
    test("rejects pointer type", () =>
    {
        assert.throws(() => parse("u32* x;"), SyntaxError)
    })

    // Expected to throw — no array syntax
    test("rejects array type", () =>
    {
        assert.throws(() => parse("u32 x[10];"), SyntaxError)
    })

    // Expected to throw — no function definition
    test("rejects nested function definition", () =>
    {
        assert.throws(() => parse("u32 foo() { return 1; }"), SyntaxError)
    })

    // Expected to throw — no struct
    test("rejects struct keyword", () =>
    {
        assert.throws(() => parse("struct x { };"), SyntaxError)
    })

    // Expected to throw — do-while is banned (top-test loops only)
    test("rejects do-while", () =>
    {
        assert.throws(() => parse("do { x = x - 1; } while (x > 0);"), SyntaxError)
    })

    // Expected to throw — break/continue are banned (no intra-loop jumps)
    test("rejects break", () =>
    {
        assert.throws(() => parse("while (x) { break; }"), SyntaxError)
    })

    test("rejects continue", () =>
    {
        assert.throws(() => parse("while (x) { continue; }"), SyntaxError)
    })

    // Expected to throw — a bare `{ ... }` is not a standalone statement: a
    // Block is only reachable as the direct body of if/else/while/for
    // (ControlBody in grammer.pegjs), because only those positions have a
    // real RTL block construct to reclaim the block's locals at BLOCK_END
    // (see docs/isa-core.md §20.2, §15.1).
    test("rejects bare block statement at top level", () =>
    {
        assert.throws(() => parse("u32 x = 1; { u32 y = 2; } return x;"), SyntaxError)
    })

    test("rejects bare block statement nested in a loop body", () =>
    {
        assert.throws(() => parse("while (x) { { u32 y = 1; } }"), SyntaxError)
    })
})