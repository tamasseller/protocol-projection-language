# Implementation Planning Notes

> Status: working notes. Captures lowering strategy, pipeline milestones, and
> open implementation questions. Non-normative; the normative reference is
> [isa-core.md](./isa-core.md).

## Pipeline overview

```
DSL source ──PEG──▶ AST fragment ──stitch──▶ proc IR ──lower──▶ bytecode ──serialize──▶ blob
   (ir`)              (ast.ts)     (merge)    (encoder)     (bin)
```

Each box is a distinct layer. Layers may be implemented in any order once the
contract between them is fixed; the contracts are the ISA's normative
boundaries.

### Milestones (suggested order)

1. **PEG parser + `ir` tag** — parse C-subset string → `IrFragment` AST.
   Grammar already exists at `packages/core/grammer.pegjs`; the `ir` tag wraps
   `parse()` and returns a tagged object. *Smallest unit; unblocks everything.*
2. **Lowerer (pure core)** — AST → IR instruction sequence. No extensions, no
   codec ops. Exercises the full expression/control-flow lowering rules
   (§22). This is where the algorithm below lives.
3. **Bytecode encoder** — IR instruction sequence → byte stream per Part V.
   Pure serialization; no semantic decisions.
4. **Bytecode decoder + validator** — byte stream → validated program.
   Implements Part IV validation rules (TOS balance, call-graph acyclicity,
   dead-code rejection, block well-formedness).
5. **Stitching layer** — combine multiple `IrFragment`s into one procedure.
   Resolve labels across fragments, merge scopes, deduplicate declarations.
6. **Integration layer** — procedure definition, ABI, extension call
   resolution. Out of scope for the Generic Core (§21.2); per-application.

Milestones 1–4 are Generic-Core-only and can be tested end-to-end on the
examples in Appendix A. Milestones 5–6 add the codec domain.

---

## Expression lowering — pattern-rewrite on the Extended AST

### Why not Sethi-Ullman

Standard Sethi-Ullman minimizes **register pressure** on a load/store
machine. This ISA's accumulator+stack+register operand model has a different
cost surface — leaves are addressable inline (zero stack cost), the same
opcode has multiple combo variants with different TOS effects, and
non-commutative ops interact subtly with evaluation order. SU's weight
function maps to this surface badly: leaf weight 0 collapses SU's recurrence,
and SU has no concept of the inline-literal fold (`OP #1` is zero extra
bytes). Rather than adapt SU and override its conclusions, we use a
**pattern-rewrite search** that enumerates tilings and picks the
byte-minimal one.

### The Extended AST (EAST)

The lowerer operates on an **Extended AST**: a tree whose internal nodes are
DSL constructs and whose leaves are either DSL leaves or **RTL-AST nodes**
carrying RTL fragments.

```
EAST node ::= DSL leaf (literal, local)
            | DSL internal (Unary(op,_), Binary(op,_,_), Assign(target,_))
            | RTL-AST leaf (carries an RTL fragment + output + clobber spec)
```

- **DSL nodes are architecture-oblivious** — source-language constructs.
- **RTL-AST nodes are architecture-aware leaves** — each carries:
  - an **RTL fragment**: an ordered instruction list (linearized eagerly;
    children ordered at construction time);
  - an **output location**: `acc`, `tos`, or `reg` — closed set;
  - a **clobber spec**: what the fragment disturbs beyond its output.

A complete EAST is one whose root is an RTL-AST node. Lowering terminates when
no DSL nodes remain.

### Rules

A rule is a pair `(pattern, builder)`:

- **`pattern`** — a tree-shaped predicate that descends an EAST subtree in
  parallel with the pattern tree, exactly the `Matcher<P>` mechanism already
  implemented in [`packages/core/src/matcher.ts`](../packages/core/src/matcher.ts)
  for semantic types. Each pattern node is checked against the corresponding
  EAST node: AST node matchers consider node kind (and, for binary nodes,
  op-class); RTL-AST node matchers additionally consider output location. The
  pairing is recorded into a match object that mirrors the pattern structure.
  Matching is simple recursion.
- **`builder`** — `match → RTL-AST node | none`. Receives the matched
  subtree; produces a replacement RTL-AST node whose fragment is built from
  the matched children's fragments (in a valid evaluation order). Returns
  `none` if no valid child ordering satisfies realizability — the rule then
  does not fire for this match, pruning an unviable variant early.

There is no op-class selector taxonomy. The only thing that varies across
operators is **how many rules are in the table for that operator**:

- **Strict operators** (SHL, SHR, ASR, LT/LE/GT/GE _S/_U): one rule per combo,
  AST order only.
- **Commutative operators** (ADD, MUL, AND, OR, XOR, EQ, NE): *two* rules per
  combo — one direct (L→acc, R→operand, emit `OP`) and one swap (R→acc,
  L→operand, emit `OP`, same opcode). The matcher tries both like any rule
  pair.
- **Pair operators** (SUB ↔ RSUB): two rules per combo — one direct (emit
  `SUB`), one swap (emit `RSUB`, demands reversed, opcode flipped). Same
  mechanism as commutative, just with the opcode also swapped on the variant.

The opcode in the emitted instruction is a lookup from the matched op, not a
rule property.

### Termination invariant

Every rule application replaces ≥1 DSL node with exactly one RTL-AST node.
The DSL-node count strictly decreases; search terminates.

This forbids two things:

- **Rules that expand**: producing new DSL nodes (e.g., "lower this leaf into
  a 3-instruction sequence that creates new unprocessed structure"). All
  lowering work must be inside the matched fragment.
- **Rules that relabel**: consuming an RTL-AST node to produce another
  RTL-AST node (e.g., "coerce acc to tos" as a standalone step). This would
  not decrease the DSL-node count and could loop.

Location conversion (acc↔tos↔reg) is therefore **not** a separate rule. Each
DSL leaf rule emits its output location directly; each operator rule demands
specific child output locations. Variants propagate through the worklist.

### Orchestrator

```
worklist = { initial EAST (pure DSL) }
results  = {}

while worklist nonempty:
    east = worklist.pop()
    for each (rule, match_site) in matcher.find_matches(east, rule_table):
        replacement = rule.builder(match_site)
        if replacement is none: continue           -- realizability prune
        new_east = east with match_site replaced by replacement
        if new_east.root is an RTL-AST node:
            results.add(new_east)
        else:
            worklist.add(new_east)

return results
```

Exhaustive: all viable tilings enumerated. The byte-count pick happens after.

### Leaf rules

Each DSL leaf produces an RTL-AST node with one of the closed-set output
locations. No leaf rule consumes an RTL-AST node.

| AST leaf | output | emit | tos Δ |
|----------|--------|------|------:|
| `lit(k)` | `acc` | `LOAD_IMM #k` | 0 |
| `lit(k)` | `tos` | `LOAD_IMM #k; PUSH` | +1 |
| `lit(k)` | `reg` | `LOAD_IMM #k; STORE r_tmp` (fresh temp) | 0 |
| `local(x)` | `reg` | *(nothing — value already lives in r_x)* | 0 |
| `local(x)` | `acc` | `LOAD r_x` | 0 |
| `local(x)` | `tos` | `LOAD r_x; PUSH` | +1 |

There is no `lit→imm` leaf rule. The inline-literal fold (`OP #k`) is not a
location conversion — it is a property of an **operator rule** whose pattern
descends into the AST and matches a `lit(k)` child directly, baking the `#k`
immediate into its emit (see Operator rules below). The closed output set is
`{acc, tos, reg}`; no `imm`.

There is a single `lit(k)` AST kind — **no small/extended distinction**. The
inline-vs-LEB128 encoding split is a property of the byte layout, not the
AST; both forms produce identical RTL shapes and only differ in byte length,
which is computed trivially at the reaping stage. The byte cost of an
inline-folded `#k` operand is **not** a function of `k` alone: it depends on
the consuming op's per-op inline-literal table (`0xFF` folds free for `AND`,
doesn't for `ADD`). This cost is therefore only computable once the consuming
op is known — i.e., at reaping, after tiling — which is exactly why the
distinction must not leak into the tiling explosion.

The **stack-machine path** (leaf→acc, leaf→tos, balanced via pop) is always
available as a fallback. The **reg path** enters when a leaf is
`local(x)→reg` (zero-emit) or `lit(k)→reg` (2-instruction: load immediate +
store to fresh temp). The literal-into-register leaf is more expensive than
the local-into-register leaf, but it enables paths where a literal must
serve as a reg-mode operand — essential for some non-commutative "wrong
order" tilings (see Operator rules). These ripple upward through operator-rule
demands, and the orchestrator explores all variants in parallel.

### Operator rules — granularity

Each rule is one (operator × combo × optional-operand-kind) tuple. The combo
determines the input demands, the output location, and the tos effect, all
derived directly from the ISA semantics. Most rules emit exactly the op + the
addressing mode. The literal-fold rules are special: their pattern descends
into the AST and matches a `lit(k)` child directly, baking the `#k`
immediate into the emit rather than demanding an `imm`-output RTL-AST node.

**Six core combos** (per operator, AST-order):

| Rule | L | R | output | emit | tos Δ |
|------|---|---|--------|------|------:|
| `op_reg_acc` | RTL→acc | RTL→reg | acc | `OP rN` | 0 |
| `op_reg_wb` | RTL→acc | RTL→reg | reg | `OP rN → rN` | 0 |
| `op_peek_acc` | RTL→acc | RTL→tos | acc | `OP [tos-1]` | 0 |
| `op_peek_wb` | RTL→acc | RTL→tos | tos | `OP [tos-1] → [tos-1]` | 0 |
| `op_pop` | RTL→tos | RTL→acc | acc | `OP [--tos]` | −1 |
| `op_peek_push` | RTL→acc | RTL→tos | pushed | `OP [tos-1] → [tos++]` | +1 |

**Literal-fold combo** (descends into AST, no `imm`-output RTL node):

| Rule | L | R | output | emit | tos Δ |
|------|---|---|--------|------|------:|
| `op_lit_acc` | RTL→acc | `lit(k)` (AST) | acc | `OP #k` | 0 |
| `op_lit_wb` | RTL→acc | `lit(k)` (AST) | reg | `OP #k; STORE r_tmp` | 0 |
| `op_lit_push` | RTL→acc | `lit(k)` (AST) | pushed | `OP #k; MOVE [tos++]` | +1 |

The literal-fold rules consume the literal AST node directly as part of the
match (they do not first rewrite `lit(k)` to an RTL-AST node and then consume
that). The pattern is `Binary(op, RTL→acc, lit(k))` — a two-level pattern.

The `acc` variant is a single instruction (ISA combo 7). The `wb` and `push`
variants are 2-instruction composites (combo 7 + explicit `STORE`/`PUSH`)
because imm mode has only one ISA combo — there is no combo-2/4/6 equivalent
for an immediate operand. These composite variants exist so the orchestrator
can explore all output locations for literal-fold subexpressions. They are
essential for non-commutative ops with "wrong-order" literals: e.g. in
`(x + 5) * y`, the `x + 5` subexpression must land on tos for the parent's
`op_pop` to consume it — `op_lit_push` is the only rule that produces a tos
output from a literal-fold expression.

**Per-operator rule-table population:**

- **Strict operators** (SHL, SHR, ASR, LT/LE/GT/GE _S/_U): the six core
  combos + three literal-fold combos, AST order only. 9 rules per combo-set.
- **Commutative operators** (ADD, MUL, AND, OR, XOR, EQ, NE): double the
  above — one rule-set with children in AST order, one with children flipped
  (same opcode). The matcher tries both like any rule pair.
- **Pair operator** (SUB): one rule-set direct (emit `SUB`), one rule-set
  swap (emit `RSUB`, opcode flipped to pair partner). Same mechanism as
  commutative, just with the opcode also swapped on the variant.

**Unary ops** — one rule, output always `acc`:

| Rule | input | output | emit | tos Δ |
|------|-------|--------|------|------:|
| `unary_acc` | RTL→acc | acc | `OP` | 0 |

### Worked example — `(a + b) * (c + 1)`, balanced tree emerges

No special "balanced tree" rule. Bottom-up tiling:

1. Tile `(a + b)`: matcher tries `op_reg_acc` (L=a→acc, R=b→reg). `local(a)`
   uses its `→acc` leaf rule (`LOAD r_a`); `local(b)` uses its `→reg` leaf
   rule (zero-emit). Replacement: RTL node with output=acc, emit
   `[LOAD r_a; ADD r_b]`.
2. Tile `(c + 1)`: matcher tries `op_lit_acc` (pattern
   `Binary(+, RTL→acc, lit(1))`). `local(c)` uses its `→acc` leaf rule; the
   `lit(1)` is consumed directly by the operator pattern. Replacement:
   output=acc, emit `[LOAD r_c; ADD #1]`.
3. Tile root `MUL(+ab, +c1)`: both children output acc. No MUL rule directly
   matches (all demand one child in a non-acc location). The orchestrator's
   worklist contains variants where leaf-output choices differ; in
   particular, `+ab` may have been tiled with its `→tos` variant
   (`[LOAD r_a; ADD r_b; PUSH]`, output=tos). With that variant:
   - `op_pop` matches: L=+ab→tos, R=+c1→acc, emit `MUL [--tos]`.
   - Result: `[LOAD r_a; ADD r_b; PUSH; LOAD r_c; ADD #1; MUL [--tos]]`. 6 bytes.
4. The orchestrator also tries the flipped rule pair for the commutative MUL
   (L=+c1→acc, R=+ab→tos) — same cost, both kept. No `+c1→reg` path exists
   (+c1 is not a DSL leaf, so no leaf rule fires on it).
5. Byte-count picks a 6-byte minimum. The push-one-side-then-pop pattern
   emerged from composing leaf variants + a single combo rule — no composite
   rule needed.

### Assignment — multi-location output

`y = expr` is a regular EAST node (not a root context). Its rule consumes
the DSL `Assign` node and the matched `expr` RTL-AST node, producing an
RTL-AST node whose output is the **set** `{acc, reg(y)}`:

| Rule | input demand | output | emit |
|------|--------------|--------|------|
| `assign` | acc | `{acc, reg(target)}` | `<expr>; STORE r_target` |

Downstream consumers pick whichever location is cheaper. `a = b = 3` chains
naturally: the inner assignment's `{acc, reg(b)}` feeds the outer assignment,
which stores to `a` — final output `{acc, reg(b), reg(a)}`.

### Realizability and SU-as-tiebreaker

The builder returns `none` if no valid child ordering exists (one child would
clobber a value another needs). This prunes unviable variants during the
worklist expansion — important even for the prototype, since a depth-5 tree
with `several` rules per level becomes `several^5` without pruning.

When multiple valid child orderings exist, the builder uses **Sethi-Ullman
as a tiebreaker**: pick the ordering that minimizes the worst-case stack
depth of the resulting fragment. SU is finally legitimate here — not as the
primary cost model, but as a tiebreaker among realizable orderings of a fixed
tiling.

### Cost and selection

For each completed EAST (root is RTL-AST):

- Walk the fragment, summing per-instruction byte costs from the encoder's
  cost table.
- For a `OP #k` instruction emitted by the literal-fold rule (`op_lit_acc`):
  cost is `1` if `k` is in `OP`'s per-op inline-literal set (e.g. `0xFF` for
  `AND`, `0`/`1` for most ALU ops), else `2 + leb128_size(k)` (extended form).
  This lookup is the only place the inline-vs-extended distinction enters the
  lowerer.
- Minimal-cost tiling wins.
- Emit the linearized instruction sequence. Locals resolve to concrete
  register indices during this same pass (see Local resolution, below) —
  there is no separate later renumbering pass.

### After expression lowering

- **Control flow** — trivial generators: `If(cond) ...` → tile `cond` to acc,
  emit `BR_TABLE N`. `While(cond) ...` → emit `LOOP`, tile `cond` to acc as
  the condition block, `BLOCK_END`, then the body as the second block,
  `BLOCK_END`. `For` places the increment at the end of the body block,
  before its `BLOCK_END`, so it runs once per iteration with no special
  casing. `Return`, `Trap` — direct. There is no `Break`/`Continue`: the
  source DSL has no such keywords, and the ISA carries no opcode for
  either — see [isa-core.md §11.2](./isa-core.md). CFG transformations to
  enable simpler expression lowerings (e.g., complementary-comparison
  selection for if-without-else) are handled as a separate concern.
  A branch/case/loop-body's closing `BLOCK_END` is emitted only when that
  branch doesn't already end control flow unconditionally — an `alwaysTerminates`
  check over the *statement* list (not the compiled instruction tail: an
  `if` without `else` can end its fragment with a `RETURN` that only fires
  along one path, so the instruction tail alone doesn't tell you whether
  the branch truly always terminates). A `for` loop's increment is omitted
  entirely, along with its `BLOCK_END`, when the body always terminates
  first (it would be unreachable otherwise). See `alwaysTerminates` /
  `closeBlock` / `closeControlBody` in `packages/core/src/machine/lower.ts`.
- **Local resolution** — registers are allocated in the same pass as
  control-flow lowering, not a separate discovery-then-allocate phase: each
  scope carries a small allocator that assigns the next free index the
  first time a name is declared, and a nested scope's allocator falls back
  to its parent's map to resolve names it doesn't own itself (see the
  current implementation in `packages/core/src/machine/lower.ts`). A nested
  scope's own numbering is seeded from its parent's current count (rather
  than restarting at 0), so a local declared inside an `if`/`while`/`for`
  body continues the parent's numbering instead of reusing an index the
  parent (or an argument) already holds. This relies on every scope that
  can declare a local closing via a real `BLOCK_END` that resets TOS back
  to the parent's depth (§15.1) — which is exactly why bare block
  statements (a `{ ... }` not attached to a branch or loop) are excluded
  from the grammar entirely (§20.2): a bare block's scope would be
  discarded by the allocator with no `BLOCK_END` ever performing the
  matching runtime reclaim, aliasing a later declaration's register.
- **Function calls** — handled uniformly by a rule that creates an RTL node
  with strictly ordered children (the argument expressions' RTL nodes),
  requires each to output at `tos`, and produces the result in `acc` per the
  ISA spec:

  ```
  rule call {
    pattern: Call(f, args=[a_0, ..., a_{n-1}])
    demands: each a_i → tos
    builder: returns RTL node with emit = [<a_0 eval & push>; ...; <a_{n-1} eval & push>; CALL f]
             output = acc, clobbers = {acc, tos (n popped)}
  }
  ```

  Args are evaluated left-to-right, each pushed; the call node produces its
  result in `acc`. This works uniformly for `CALL` and extends to
  `CALL_CODEC` (codec spec adds the entry-protocol bindings).

### Component structure

```
lowerer/
  orchestrator.ts      -- the worklist loop
  matcher.ts           -- finds rule-pattern matches in an EAST
  rules/
    leaves.ts          -- literal/local → RTL-AST (acc/tos/reg outputs)
    unary.ts           -- NEG/NOT/CLZ/REVBITS → acc
    binary.ts          -- 6 core combos + literal-fold rule; per-operator
                       -- table population: strict (1x), commutative (2x flip),
                       -- pair (SUB↔RSUB 2x flip+opcode)
    assign.ts          -- multi-location-output assignment rule
    call.ts            -- function-call rule (strictly ordered children)
  rtl/
    node.ts            -- RTL-AST node type, EAST types
    fragment.ts        -- ordered instruction list + builder helpers
    cost.ts            -- byte-cost computation
  emit/
    control_flow.ts    -- trivial generators for if/while/for/return/trap
    locals.ts          -- local register allocation
```

Matcher, rule table, and orchestrator are separate; new operator classes add
a rule file without touching the matcher or orchestrator.

> The actual implementation flattened this tree under
> `packages/core/src/machine/` (`orchestrator.ts`, `matcher.ts`, `rules.ts`,
> `rtl.ts`, `east.ts`, `lower.ts`) rather than nesting `lowerer/rules/rtl/emit`
> directories, and there is no standalone `emit/locals.ts` — local register
> allocation happens inline in `lower.ts` as statements are lowered (see
> Local resolution, above), not as a separate emit-time step.

### Memoization (deferred)

The worklist approach as described re-tiles the same subtree many times
across parent contexts. For codec-sized trees this is tractable; for larger
inputs a memoization layer caches `(subtree_identity, demanded_output) →
tiling_set`. Deferred until the prototype is correct and the cost is
measured. Immutable EAST nodes (with structural hashing grounded in DSL-leaf
identity) enable both memoization and copy-on-write wandering trees.

---

## Open implementation questions

### From the ISA design

- **Per-op inline literal values** (§17.3): the bitwise defaults (`0xFF` for
  AND, `0x80` for OR) are guesses. Need corpus measurement to confirm. These
  values feed directly into the lowerer's cost function for the `OP #k`
  instructions emitted by `op_lit_acc` (see Cost and selection) — wrong
  defaults produce wrong byte counts but never wrong code, so this is tunable
  post-hoc.
- **Register-index inline packing**: currently always a trailing byte. Could
  pack r0–r7 inline using reserved mode codes if measurement shows register
  ops are hot.
- **Comparison compact tier**: should `GT`/`GE` be promoted back if
  branch-inversion proves costly in real codecs?
- **BR_TABLE inline range**: currently {1,2,3,4}; may widen or narrow.

### From the lowering strategy

- **Rule table completeness**: the six core combos + literal-fold rule, plus
  the per-operator flip variants (commutative, SUB↔RSUB), need validation
  against real codec expressions. The prototype should stress-test depth-5
  trees to confirm pruning keeps the search tractable.
- **Memoization trigger**: when does the naive worklist become too slow?
  Measure on representative codec bodies; add the
  `(subtree, demanded_output) → tiling_set` cache only if needed.
- **Deduplication** (partially implemented): `tileExpr`'s worklist
  (`orchestrator.ts`) now hashes each partially-tiled tree structurally
  (`hashTree`) and skips re-pushing a tree already reached via a different
  rewrite order — turns tree search into graph search, since independent
  sites can be tiled in either order and previously each order re-explored
  its own copy of the remaining work. This fixed the specific timeout
  observed on a 4-leaf balanced sum (`(a+b)+(c+d)`, `"tos"` demand): >120s
  before, ~24ms after. It is **not** a full fix — the state-space size
  itself (product of per-site output-variant counts) still grows with tree
  width regardless of ordering-duplicate removal: measured ~512ms at 6
  leaves, ~22.5s at 8 leaves, and 10 leaves did not finish in 120s. The
  `(subtree, demanded_output) → tiling_set` memoization described below is
  still needed for wider expressions; the hash-dedup work already provides
  the structural-hashing infrastructure that memoization would reuse for its
  cache key.
- **Known bug — `tosDelta === 1` is not a true invariant for wide trees**
  (found while measuring the dedup fix above, not yet fixed): `lowerVarDecl`
  (`lower.ts`) asserts that a `"tos"`-demand winning tiling always nets
  exactly one push, on the empirically-observed basis that every stack-combo
  rule offers a net-neutral write-back alternative (`PEEK_PEEK`/`POP_ACC`)
  alongside the wasteful RPN one (`PEEK_PUSH`, isa-core.md §6.3 combo 6), and
  the cost model prefers the neutral one. That holds for every shape tested
  up through 7 leaves, but **breaks at 8**: lowering a balanced sum of 8
  identifiers (`((a+b)+(c+d))+((e+f)+(g+h))`) against a `"tos"` demand
  produces a winner with `tosDelta === 2`, ending in
  `ADD [tos-1] → [tos++]` (`PEEK_PUSH`) instead of `POP_ACC` +
  write-back-in-place. Repro (paste into a throwaway `.ts` and run with
  `ts-node` from `packages/core/`):
  ```ts
  import { lowerExpr } from "./src/machine/orchestrator"
  import { DEFAULT_RULESET } from "./src/machine/rules"
  // balanced binary "+" tree over identifiers v0..v7, e.g. via a small
  // recursive helper building EastBinary/Identifier nodes — see chat history
  // for the exact helper used. lowerExpr(tree, DEFAULT_RULESET, "tos").tosDelta === 2
  ```
  This is a real correctness/completeness gap, not a search artifact: dedup
  cannot have caused it (pruning duplicate *paths* to an already-reached
  state never removes a reachable *state*, and the observed instruction
  sequence is legal, just suboptimal).

  **Root cause, verified (not just hypothesized) by dumping every candidate
  `tileExpr` produces for the 8-leaf shape**: the top-level combine here is
  `(tos, acc)` — a completely ordinary, legitimate match (`stackOperandRules`
  requires exactly one `"acc"`-output child and one `"tos"`-output child;
  there is no pattern for two `"tos"` children at all — confirmed by reading
  every rule's pattern in `rules.ts`, a `Binary(tos, tos)` tree is a genuine
  dead end with zero matches and silently drops out of the worklist, which is
  fine and by design). A `tosDelta === 1` candidate for the same site *does*
  exist (same site, `PEEK_PEEK` combo instead of `PEEK_PUSH`), and it is
  **exactly tied** with the winning `tosDelta === 2` candidate on every
  criterion `pickCheapest` (`orchestrator.ts`) currently checks: same byte
  cost, same fragment length, and — this is the non-obvious part — the *same*
  `maxStack === 2`. That last tie is not a `nodeInvariants` bug: the
  `"acc"`-side child here has its own internal scratch push (to combine its
  own two leaves) that transiently stacks on top of the left half's
  already-pushed value, so the true peak really is 2 for *both* candidates —
  `maxStack` genuinely cannot distinguish them, because they don't actually
  differ there. `pickCheapest`'s tie-break chain (bytes → fragment length →
  maxStack) is exhausted in a real tie, so its `reduce` silently falls back
  to whichever candidate the worklist happened to generate first — an
  accident of worklist pop order, not a considered preference.

  **Fix**: add net `tosDelta` itself as a further tie-break criterion in
  `pickCheapest` (prefer lower net stack growth when bytes/length/maxStack
  all tie) — lower `tosDelta` is strictly better all else equal, since it
  leaves fewer permanently-unreclaimed register slots behind, and nothing
  currently scores that. (An earlier version of this note guessed the cause
  was a *missing* rule for combining two stack-resident operands — that
  guess was wrong and has been corrected here: the rule exists and ties, it
  isn't absent.) Until fixed, the `assert.equal(node.tosDelta, 1, ...)` in
  `lowerVarDecl` **will throw on real DSL source** containing a sufficiently
  wide expression in a `let` initializer (empirically, 8+ leaves in a
  balanced binary-op tree; narrower or more skewed trees may have a different
  threshold — not yet characterized). The "Peek-addressed last-declared
  local" optimization idea below is built on this same invariant and is
  unsound as stated until this is fixed.
- **Common-subexpression elimination**: not in scope for v1, but the
  multi-location assignment output (`{acc, reg(y)}`) interacts with it — a
  value already in a register can be the operand of multiple consumers
  without re-evaluation.
- **Peek-addressed last-declared local** (optimization opportunity, not yet
  implemented): a `let` declaration's initializer, when lowered against a
  `"tos"` demand, always nets exactly `tosDelta === 1` (enforced as an
  assertion in `lowerVarDecl` — see the tiling-invariant comment there). That
  means the just-declared local always ends up sitting at register index
  `alloc.next - 1`, i.e. exactly one slot below TOS *at the point evaluation
  of the next expression begins*. If that local is referenced before any
  further declaration in the same scope, it could be addressed via
  `PEEK_ACC`/`PEEK_PEEK` (relative to the running `tosDelta` tracked through
  `nodeInvariants` during that expression's lowering) instead of resolving an
  absolute register number — reusing existing accounting rather than adding a
  new one. The one piece of bookkeeping this needs that expression lowering
  doesn't otherwise carry is the frame-absolute base to translate a relative
  peek back to a concrete register (`alloc.next` at the call site) — already
  available wherever `lowerExpr` is invoked from `lower.ts`, so no new
  plumbing through the tiling search itself. Narrow win: only applies to the
  single most-recently-declared local, only before the next declaration
  shadows it by pushing another slot on top.

### From the integration layer

- **Stitching**: how are jump labels resolved across fragment boundaries?
  Probably per-fragment local labels + a post-stitch rename pass.
- **ABI**: how does a procedure declare its argument count and any
  extension header fields? Out of scope for the Generic Core (§21.2) but
  needs a concrete answer for the codec domain.
- **Extension call resolution**: the mechanism shape (table, framework,
  utilities) is an implementation detail — but the codec integration needs
  *some* concrete answer to start.

---

## Test strategy

### Unit tests (per layer)

- **Parser**: round-trip every DSL construct; reject every excluded form
  (pointers, arrays, `do`, `goto`, …). The existing grammar test suite at
  `packages/core/test/grammar.test.ts` is the starting point.
- **Lowerer**: each Appendix A example should produce the listed IR. Byte
  counts should match (this is also a regression test for the encoder).
- **Encoder/decoder**: round-trip every instruction format in Part V.
  Especially the escape tier and the per-op inline literal table.
- **Validator**: each §15 rule has a positive and negative test.

### Integration tests

- **End-to-end on Appendix A**: DSL source → AST → IR → bytes → decode →
  validate → execute (on a reference interpreter) → check result.
- **Round-trip property test**: for any valid program, encode then decode
  yields the same IR.

### Reference interpreter

A small TS interpreter that executes validated IR. Not a backend target —
just an oracle for testing the lowerer and encoder. Implements the abstract
machine (§2) directly: `acc`, register file, TOS, structured control flow.
