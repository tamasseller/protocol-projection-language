# Design decisions

A running record of decisions whose reasoning must outlive the change that
made them. One entry per decision, kept tight — the specifications live in
each repo's own docs.

## Where an extension's authoring ergonomics live (ppl)

**Decided, and implemented in `ppl/src/codecs/engine/scope.ts`.** What
survives here is the reasoning: the DSL grammar stays frozen, and what it
would cost to unfreeze it. The carriers themselves are code — a rule body
receives its procedure's `CodecScope` as `produce`'s fourth argument — so
this entry does not sketch them.

### The question

An extension reaches the DSL through one mechanism: `pBuiltinCall` plus
`pConst`/`pRtl` patterns contributed via `Extension.rules` and spliced into
the ruleset at `mog-core`'s `rules.ts`. That gives flat call syntax with literal
operands — `enter(1, 0, 3)`, `write(0, 1, byte)`. Resource ids used to be
hand-picked constants in fragment text — `ppl's binary-rules.ts` carried its own
`O_FIELD = 1` for whichever struct field it was processing.

Two directions could improve on that: grow the DSL (declaration statements
pinning compile-time constants, `obj.method()` / `memory[addr]` syntax), or
grow the TS layer around it. Only one of them is idiomatic here.

### The rule that decides it

The DSL is a metaprogramming target, not a language to hand-write. So:

> Compile-time values that must be **computed or allocated** live in TS.
> Compile-time values **literal to the fragment** stay in DSL text.

`0x7F` and a field index are literal → text. A handle id that must not
collide across independently-authored fragments is allocated → TS.
Procedure identity already follows this rule: `${proc}` mints a name, no
one writes `__proc7`.

### Why not the DSL

**Declaration statements** pinning compile-time constants are redundant
with `${}` interpolation — `ir.ts` stringifies any interpolated value it
does not recognize, so a TS carrier object splices with no change to
`mog-core` at all. They also contradict §2 directly: nothing about them is
computed in the layer that owns computation.

**Method and subscript syntax** do not contradict §2 — they are sugar for
runtime ops, not compile-time computation. They are rejected for being a
second spelling of what the carriers already provide, and for their cost:

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

### What stays in DSL text

Runtime-value operands. Four of the codec extension's seventeen ops take a
DSL expression as their last operand (`write`, `store_val`, `write_seq`,
`read_seq` — `pRtl("acc")`, codec-extension.ts:279-304), and they are the
high-frequency ones: every integer encode or decode goes through one.

This is what rules out a TS API that wraps the *whole* call. `wire.write(1,
"byte & 0x7F")` sends a DSL expression through a TS string argument, nesting
badly. Splicing only the constant operands leaves `write(${wire}, 1, byte &
0x7F)`, and the expression never leaves the text.

### What the TS side gets that the DSL side cannot

- **Iterators.** A fork lives for its procedure (codec-extension.md §2.1):
  it must outlast the calls that procedure makes — that is what a parked
  fixup writer is for — but no longer. A TS allocator matches that
  exactly, one `CodecScope` per procedure; a DSL-side `iter` declaration
  would be block-scoped, too short.
- **Typed navigation.** A handle's `type` walks the same identity-safe
  `TypeGraph` the resolver already trusts, checked in the editor before
  anything runs. No DSL-level type system approaches that.
- **`mog-core` untouched.** Grammar, AST, matcher, types, explain,
  scope all stay as they are, and isa-core.md §10.1's C-subset claim
  survives. `ext_rawmem` (mog-jit/support/ext-rawmem/) gets its first DSL
  surface for free: `pBuiltinCall` rules over `ld8`/`st8`, whose operand
  convention —
  address on the stack, value in acc — is the one assignmentRules already
  uses.

### Limits

A reused slot has a different type per navigation, so the type rides on the
`enter`, not the slot: TS checks each step, but cannot statically reject
`load_val(${f})` after `f` was re-entered as something else. Flow-sensitive
slot typing stays ppl's validate-handles.ts's job, as it must anyway — images
arrive from the wire without passing through any of this.

Ids go monotonic per procedure, with no block-scoped reclaim. Per-procedure
counts stay small (delegation gives each codec fresh handle and fork
frames); an explicit TS scope is the fix if it ever bites, and is a more
precise lifetime than a DSL block, since the two need not coincide.

No infix sugar. `memory[i] += 1` stays `st8(i, ld8(i) + 1)`, honest about
the double read.
