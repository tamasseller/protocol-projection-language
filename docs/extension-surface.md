# Extension authoring surface

**Status: design sketch, unimplemented.** Decides where an extension's DSL
ergonomics live. Conclusion: the TS metaprogramming layer; the DSL grammar
stays frozen. Nothing in `packages/` implements the carriers of §5 yet.

## 1. The question

An extension reaches the DSL through one mechanism: `pBuiltinCall` plus
`pConst`/`pRtl` patterns contributed via `Extension.rules` and spliced into
the ruleset at rules.ts:671. That gives flat call syntax with literal
operands — `enter(1, 0, 3)`, `write(0, 1, byte)`. Resource ids are
hand-picked constants in fragment text (binary-rules.ts:228's `O_FIELD = 1`).

Two directions could improve on that: grow the DSL (declaration statements
pinning compile-time constants, `obj.method()` / `memory[addr]` syntax), or
grow the TS layer around it. Only one of them is idiomatic here.

## 2. The rule that decides it

The DSL is a metaprogramming target, not a language to hand-write. So:

> Compile-time values that must be **computed or allocated** live in TS.
> Compile-time values **literal to the fragment** stay in DSL text.

`0x7F` and a field index are literal → text. A handle id that must not
collide across independently-authored fragments is allocated → TS.
Procedure identity already follows this rule: `${proc}` mints a name, no
one writes `__proc7`.

## 3. Why not the DSL

**Declaration statements** pinning compile-time constants are redundant
with `${}` interpolation — ir.ts:201 stringifies any interpolated value, so
a TS carrier object splices today with no change to `@ppl/machine`. They
also contradict §2 directly: nothing about them is computed in the layer
that owns computation.

**Method and subscript syntax** do not contradict §2 — they are sugar for
runtime ops, not compile-time computation. They are rejected for being a
second spelling of what §5 already provides, and for their cost:

| Needed for `a.b()` / `a[i]` | Where |
|---|---|
| grammar production + AST node | grammer.pegjs, ast.ts |
| both closed AST switches | ast.ts:232 `recurseOver`, ast.ts:250 `mapOver` |
| pattern kind, `matchAllEast` case, `MatchOf` row | matcher.ts:184 union |
| binding namespace, third resolver | scope.ts `RegAlloc`, `Extension.rules` |
| opaque-type handling | types.ts, explain.ts |

Two further costs are not just volume. Method syntax leaves the C subset
isa-core.md §10.1 claims (C has `.` on structs, not methods). And an
*assignable* subscript breaks desugar.ts:8's stated premise — "the target
is always an Identifier, so evaluating it twice is free" — guarded today by
`LeftHandSideExpression = Identifier` (grammer.pegjs:204); `memory[i] += 1`
would duplicate the address computation, forcing a real lvalue model
through desugar and lift.

## 4. What stays in DSL text

Runtime-value operands. Four of the codec extension's seventeen ops take a
DSL expression as their last operand (`write`, `store_val`, `write_seq`,
`read_seq` — `pRtl("acc")`, codec-extension.ts:279-304), and they are the
high-frequency ones: every integer encode or decode goes through one.

This is what rules out a TS API that wraps the *whole* call. `wire.write(1,
"byte & 0x7F")` sends a DSL expression through a TS string argument, nesting
badly. Splicing only the constant operands leaves `write(${wire}, 1, byte &
0x7F)`, and the expression never leaves the text.

## 5. The carriers

```ts
/** An allocated stream-iterator id. Splices as its number. */
class Iter { toString(): string }

/** An allocated object-handle slot. Untyped: a slot is reused across
 *  navigations of different types, which is why validate-handles.ts tracks
 *  handle types flow-sensitively rather than in a static table. */
class Slot
{
    toString(): string
    /** Navigate `parent`'s child `ref` into this slot. Pure — computes the
     *  child type and the `enter` text, emits nothing by itself. */
    enter(parent: Handle, ref: number): Handle
}

/** A slot, the type currently in it, and the `enter` that put it there. */
interface Handle
{
    readonly type: TypeNode
    readonly code: IrFragment     // "enter(1, 0, 3);" — empty for o0
    toString(): string            // the slot id
}

interface CodecScope
{
    readonly o0: Handle           // bound by the calling convention
    readonly i0: Iter             // ditto
    slot(): Slot                  // a scratch handle id
    iter(): Iter                  // an iterator id, program-wide
}
```

The carriers are **pure**. A builder that emitted instructions as a side
effect of construction would make DSL statement order a function of TS
evaluation order, invisible from the template text. Every instruction stays
written in the fragment, in the order it runs; TS supplies only the ids and
the `enter` text placed at an explicit `${}`.

## 6. Worked changes

`integerEncodeRule` — the two bare `0`s mean different things:

```ts
ir`write(0, ${intWireSize(match)}, load_val(0));`                       // today
ir`write(${s.i0}, ${intWireSize(match)}, load_val(${s.o0}));`           // with carriers
```

`structEncodeRule` — the scratch slot is allocated rather than chosen, and
the field type comes off the navigation instead of binary-rules.ts:204's
`resolve(f.type, undefined).header as TypeNode` peek and the comment
defending it:

```ts
const f = scope.slot()
const child = f.enter(scope.o0, fieldIndex)     // child.type replaces the peek
ir`${child.code} switch (tag(${child})) { ${cases} }`
```

One slot still serves every field, because `f` is allocated once outside
the `map`.

`leb128EncodeBody` — a fragment that is mostly control flow changes by one
token, `write(0, 1, byte)` → `write(${s.i0}, 1, byte)`. This is the check
that matters: the `${}` holes land only on constant operands, and `byte`,
a DSL local, never travels through TS.

Iterators (§8.4's checksum fork) are the case only TS can serve:

```ts
const sum = scope.iter()
ir`
    clone_rd(${scope.i0}, ${sum});
    while (has_next(${sum})) { acc = acc + read(${sum}, 1); }
`
```

## 7. What the TS side gets that the DSL side cannot

- **Iterators.** They are global across the call graph (codec-extension.md
  §2.1) — the reason validate-handles.ts settled for "each procedure
  establishes its own". A TS allocator is program-scoped by construction; a
  DSL-side `iter` declaration would be block-scoped, the wrong lifetime.
- **Typed navigation.** `Handle.type` walks the same identity-safe
  `TypeGraph` the resolver already trusts, checked in the editor before
  anything runs. No DSL-level type system approaches that.
- **`@ppl/machine` untouched.** Grammar, AST, matcher, types, explain,
  scope all stay as they are, and isa-core.md §10.1's C-subset claim
  survives. `ext_rawmem` (jit-armv6m/test/) gets its first DSL surface for
  free: `pBuiltinCall` rules over `ld8`/`st8`, whose operand convention —
  address on the stack, value in acc — is the one assignmentRules already
  uses.

## 8. Limits

A reused slot has a different type per navigation, so the type rides on the
`enter`, not the slot: TS checks each step, but cannot statically reject
`load_val(${f})` after `f` was re-entered as something else. Flow-sensitive
slot typing stays validate-handles.ts's job, as it must anyway — images
arrive from the wire without passing through any of this.

Ids go monotonic per procedure, with no block-scoped reclaim. Per-procedure
counts stay small (delegation gives each codec a fresh handle frame); an
explicit TS scope is the fix if it ever bites, and is a more precise
lifetime than a DSL block, since the two need not coincide.

No infix sugar. `memory[i] += 1` stays `st8(i, ld8(i) + 1)`, honest about
the double read.

## 9. Footprint

- resolver.ts: build a `CodecScope` per procedure — `o0`'s `TypeNode` is
  already the argument to `declareProc([], node)` (resolver.ts:175) — and
  thread it as a fourth `CodecRule.produce` parameter (resolver.ts:75).
- The ~12 rule bodies in binary-rules.ts, json.ts, delta-leb128.ts.
- Emitted programs are unchanged throughout; codec-image.test.ts and
  struct-encoder.test.ts pin that.
