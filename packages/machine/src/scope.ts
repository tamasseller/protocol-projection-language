/**
 * @ppl/machine — Lexical scope and register allocation
 *
 * One `RegAlloc` per DSL scope, mapping a name to the register index its
 * value lives in and to its declared type. Numbering is by TOS depth, so a
 * scope's identity is inseparable from where its block starts and ends —
 * see the constructor.
 */

import type {PrimType} from "./ast"
import type {ExtOpPayload} from "./rtl"
import type {ProcSignature, TypeEnv} from "./types"
import type {Extension} from "./extension"
import {Rule, ruleset} from "./rules"

export class RegAlloc<E extends { ext: string } = ExtOpPayload> implements TypeEnv
{
    private map = new Map<string, number>()
    private types = new Map<string, PrimType>()
    private next: number

    /**
     * A nested scope's numbering continues from its parent's current count
     * rather than restarting at 0. This matters because the ISA resets TOS
     * to a block's entry depth at its `BLOCK_END` (isa-core.md §15.1): once
     * this scope's own block closes, its locals are gone and the parent
     * resumes allocating from exactly where it left off. If a child instead
     * renumbered from 0, its locals would alias whatever the parent (or an
     * argument) already put at those low indices.
     */
    constructor(
        private _parent?: RegAlloc<E>,
        private _resolveCallee?: (name: string, argCount?: number) => number | undefined,
        private _extension?: Extension<E>,
        base?: number,
        private _returns?: PrimType | "void",
        private _signatureOf?: (name: string) => ProcSignature | undefined,
    )
    {
        this.next = base ?? _parent?.next ?? 0
    }

    /** How far TOS has grown by the time this scope's next allocation
     *  lands — the index that allocation will get. */
    get depth(): number {return this.next}

    get parent(): RegAlloc<E> | undefined {return this._parent}

    /** A nested scope (`new RegAlloc(alloc)`, no second argument) has no
     *  callee resolver of its own — it inherits the enclosing procedure's,
     *  the same way it inherits register numbering via `parent`. Returning
     *  `undefined` (rather than throwing) for a name it can't place is
     *  deliberate: `callRule` (rules.ts) treats that as "not a viable
     *  candidate here," which is what lets a builtin call (`clz`, `trap`,
     *  `revbits`) fall through to its own dedicated rule instead of every
     *  call site hard-failing on names that were never meant to resolve
     *  against a procedure table. */
    get resolveCallee(): (name: string, argCount?: number) => number | undefined
    {
        return this._resolveCallee
            ?? this._parent?.resolveCallee
            ?? (() => undefined)
    }

    /** A callee's declared/deduced signature, inherited by nested scopes the
     *  way `resolveCallee` is. */
    signatureOf(name: string): ProcSignature | undefined
    {
        return (this._signatureOf ?? this._parent?.signatureOf.bind(this._parent))?.(name)
    }

    /** What the procedure being lowered returns — declared, or deduced from
     *  its own `return`s (isa-core.md §8.7). Inherited by nested scopes the
     *  way `extension` is; `undefined` where nothing resolved it, which
     *  `lowerReturn` reads as the conservative "some value". */
    get returns(): PrimType | "void" | undefined
    {
        return this._returns ?? this._parent?.returns
    }

    /** A nested scope has no `Extension` of its own — it inherits the
     *  enclosing procedure's, same as `resolveCallee`. */
    get extension(): Extension<E> | undefined
    {
        return this._extension ?? this._parent?.extension
    }

    /**
     * Allocate a named variable, returning its index.
     *
     * A name this scope already holds is a redeclaration, and rejected: the
     * caller emits a push for every declaration, so silently handing back
     * the old index would leave the new slot orphaned and every later
     * declaration numbered one too low. A *nested* scope may shadow freely
     * — it has its own map, and its block reclaims the slot at `BLOCK_END`.
     */
    alloc(name: string, varType: PrimType = "u32"): number
    {
        if(this.map.has(name))
            throw new Error(`Redeclaration of '${name}' in the same scope`)

        const idx = this.next++
        this.map.set(name, idx)
        this.types.set(name, varType)
        return idx
    }

    /** The declared type of `name`, through enclosing scopes the way
     *  `resolve` goes. Undefined for a procedure argument, which is a plain
     *  word — types.ts supplies that default. */
    typeOf(name: string): PrimType | undefined
    {
        return this.types.get(name) ?? this._parent?.typeOf(name)
    }

    /** Map a string register name to its allocated index. */
    resolve(name: string): number | undefined
    {
        const own = this.map.get(name)
        if(own !== undefined) return own
        return this._parent?.resolve(name)
    }

    rules(): Rule<E>[]
    {
        return ruleset<E>(
            name => this.resolve(name) ?? (() => {throw new Error(`Unknown variable '${name}'`)})(),
            this.resolveCallee,
            this.extension,
        )
    }
}
