/**
 * @ppl/machine — what a procedure's `return`s add up to
 *
 * isa-core.md §8.7: a procedure returns a value on every path or on none,
 * and which one is *derived* rather than declared — nothing in §2.3's header
 * carries it. An `ir` fragment is a statement sequence, not a function
 * definition, so there is no signature position in the source to declare it
 * in either; this deduces it from the body's own `return`s, the way C++14
 * deduces an `auto` return type.
 */

import type {ControlBody, Statement} from "./ast"

/** True when the body returns a value anywhere. A body with no `return` at
 *  all is void: it either runs off its end, which is C's implicit `return;`
 *  for a void function, or it only ever traps, where nothing returns and the
 *  answer costs nothing either way. Throws on a body that does both, the one
 *  shape no caller could be told apart. */
export function returnsValue(stmts: readonly Statement[], what: string): boolean
{
    let valued = false
    let empty = false

    function walk(list: readonly Statement[]): void
    {
        for(const s of list)
        {
            switch(s.type)
            {
                case "ReturnStatement": if(s.argument) valued = true; else empty = true; break
                case "IfStatement": body(s.consequent); if(s.alternate) body(s.alternate); break
                case "WhileStatement": case "DoWhileStatement": case "ForStatement": body(s.body); break
                case "SwitchStatement": for(const c of s.cases) walk(c.consequent); break
                case "BlockStatement": walk(s.body); break
                default: break
            }
        }
    }

    function body(b: ControlBody): void
    {
        walk(b.type === "BlockStatement" ? b.body : [b])
    }

    walk(stmts)

    if(valued && empty)
        throw new Error(`${what}: returns a value on some paths and none on others — a procedure returns one on every path or on none (isa-core.md §8.7)`)

    return valued
}
