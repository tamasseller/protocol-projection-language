# Generic Core — Rationale

> The *why*, for the choices in [isa-core.md](./isa-core.md) that aren't
> self-justifying from the spec text alone. If a choice isn't listed here,
> read the spec section directly — this document exists to save a future
> reader from re-deriving the non-obvious ones, not to restate the spec.

---

## Why these choices

**One branching primitive, no offsets.** A conditional branch is a jump
table with two targets, one of which may be empty — so there is one
construct, `BR_TABLE`, not a separate branch-if plus a switch. It carries
no offsets or block lengths, only a case count: the DSL forbids `goto`, so
every branch target is already well-nested, and that structural constraint
is exactly the entropy a generic `br + offset` would otherwise have to
spend bits carrying. The lenient, implicit-default semantics (`acc ≥ N` →
skip every case) let `if`, `if-else`, and `switch` all lower to the same
construct with no separate validate-then-dispatch preamble, and let an
`if`-without-`else` cost `N=1` with no empty trailing block.

**`LOOP` opens two blocks, not one.** A single-block loop can't host a
condition test that runs before every iteration *and* a body that runs
conditionally on it without either duplicating the test or re-testing
inside the body. Splitting into a condition sub-block (always run, leaves
a decision in `acc`) and a body sub-block (conditionally run, then loops
back to the condition) gets a natural pre-test `while`/`for` shape for one
opcode and one pair of block closers. The cost is that `do`/`while` isn't
directly expressible — the condition block has no notion of "skip the test
on the first pass" — so a bottom-test loop needs an explicit
first-iteration flag or iteration-peeling at the lowering layer (spec
§7.2). That's a deliberate trade: `do`/`while` is rare enough in codec
logic that paying two bytes at the *few* lowering sites that need it beats
complicating the one opcode every loop uses.

**No `break`/`continue`.** The DSL exposes no such keyword, so no lowering
path would ever produce the opcode — carrying one that nothing emits costs
encoding space and validation surface for zero benefit. A loop that would
`break` early folds the early-exit test into its condition block instead
of jumping out mid-body.

**TOS-hybrid accumulator + register file, sharing one address space.**
Keeping the operand stack and the register file as the *same* logical
array (indexed by TOS on one side, by name on the other) means a value
doesn't have to commit to being "a local" or "a stack temporary" ahead of
time — the same storage plays both roles depending on how it's addressed.
This is what lets one procedure mix RPN-style expression evaluation (cheap
per node, no naming needed) with named locals and running counters,
choosing per-value rather than per-procedure.

**Every stack-read combo also reclaims its operand.** Arithmetic has
exactly five addressing combos (register→acc, register→register,
peek→peek, pop→acc, immediate→acc), not more. The two that are
conspicuously absent — reading `[tos-1]` without writing back, and pushing
a *new* value on top of `[tos-1]` while leaving it there — sound useful for
RPN chaining, but neither is: a pushed value is always single-use in this
design (there's no common-subexpression elimination, so nothing ever needs
to read a stack slot twice), so any combo that reads a stack operand
without reclaiming it just leaves a register permanently and silently
allocated with no consumer. Every combo that touches the stack either
writes its result back into the same slot (net zero growth) or pops
(net negative) — there is no combo that nets positive from reading an
existing value. The one case that *would* motivate a preserving read — a
named local that must stay addressable after being read mid-expression —
isn't reachable either, since nothing currently addresses "the local
that happens to sit just below TOS" by position; it's always addressed by
its own register index instead.

**Every op is first-class, none quarantined to a second byte.** There is
no "common" vs "rare" tier for arithmetic, comparison, or unary
operations. Splitting a class into a compact subset plus an escape-byte
overflow only pays off if the frequency split is right, and there's no
corpus to measure it against yet — guessing wrong just adds a second
encoding path for no savings. Treating every op in a class identically
keeps the spec's op tables flat and keeps the lowerer's cost model from
needing to know which ops are "expensive to select."

**Arithmetic's immediate operand has no small/inline form; comparison's
does.** The right constant to special-case for `ADD` is not the right one
for `AND`, and picking one per operator without a measured corpus is a
guess with no principled basis — so arithmetic immediates always cost the
extended (LEB128) form, uniformly, no per-operator table to maintain or
get wrong. Comparison is different: comparing against zero (loop bounds,
sign checks, null-like sentinels) is a near-universal idiom independent of
any corpus-specific guess, so it alone gets a dedicated single-byte form.
The asymmetry is deliberate, not an oversight — one is a well-justified
universal case, the other would be a per-operator guess dressed up as a
constant.

**Register indices are LEB128 everywhere, uniformly.** One encoding rule
for "a register index follows" — never a fixed-width byte in some
positions and a variable-length form in others — costs nothing for the
common case (indices under 128 already fit in one LEB128 byte) and removes
a special case from both the spec and any encoder/decoder.

**The core opcode space is a flat range dispatch, not a bit-prefix tree.**
Each instruction class's size is whatever its op count × mode count
actually is (50, 40, 4, 5, 4, 25) — not rounded up to a convenient power of
two. Those sizes don't nest under a cascading single-bit split the way
equal-sized halves would, so the decoder is a handful of numeric range
checks (or one 128-entry table) instead of bit-masking. This is simpler to
implement and verify than forcing every class to a power-of-two boundary
would have been. Almost all of the 128-code budget is spent on exactly
what each class needs, with one narrow exception (spec §5.3): four codes
are deliberately left unassigned, not as a general hedge against
unplanned growth, but as somewhere for one specific, later, *measured*
addition to land without renumbering everything else — the design is
meant to reach a stable, finished state soon, not grow indefinitely, but
"soon" isn't "already decided," and a small bounded pocket costs
essentially nothing.

**The four reserved codes are a bounded exception, not a reopened
question.** A constant-synthesis op for low-entropy value shapes (powers
of two, all-ones masks, contiguous bit-masks — materializing any of them
today costs a 4–6-byte `CONST`-extended or a multi-instruction composite)
is one candidate for that pocket: a single `MASK(width, offset)` move-class
op, with both parameters packed into one trailing byte, would subsume all
three shapes as special cases and cost 2 bytes regardless of which shape
is needed. It is *not* adopted here — there is no corpus showing these
shapes appear often enough to justify it, which is exactly the kind of
unmeasured bet the per-op arithmetic literal table above was correctly
rejected for. The difference is scope: reserving four codes on the chance
one narrow, well-defined addition is later justified is cheap; guessing
the *content* of that addition without evidence is not, so the guess is
deferred, not made.

**The calling convention passes the last argument in `acc`, not the
stack.** `CALL`'s return value overwrites `acc` unconditionally, so nothing
a caller might have left there survives across the call regardless of
whether an argument routes through it — passing the callee's last argument
in `acc` instead of pushing it costs nothing that wasn't already spent.
This makes the single-argument call, by far the most common arity, free of
any `PUSH` at all, and it composes directly for a call nested as another
call's last argument (`f(g(x))`): `g(x)`'s own `acc`-output tiling already
leaves its result exactly where `f`'s call needs it, no stack bridge
(push-then-pop) required in between the way a stack-only convention would
need for the same nesting.

**No `DIV`/`MOD`.** Many microcontrollers lack hardware division, and
including software-emulated division would silently emit expensive loops
on those targets. Codec arithmetic is dominated by shifts, masks, adds,
and compares; modulo by a power of two is `AND (N−1)`. A program that
genuinely needs division calls a software helper procedure instead.

**Bare block statements are excluded from the DSL.** A `{ ... }` is only
reachable as the direct body of `if`/`else`/`while`/`for`. This matters
because `BLOCK_END` is what resets TOS to a block's entry depth (spec
§8.1) — a standalone brace-block with no `BR_TABLE` case or `LOOP`
sub-block behind it would have no `BLOCK_END` to ever perform that reset,
so a local declared inside it would never be reclaimed at the register
level even though the DSL considers it out of scope, silently aliasing
whatever register a later declaration receives. Disallowing bare blocks
outright keeps "every DSL scope closes via a real `BLOCK_END`" a structural
invariant instead of a lowering-time special case.

**Expression lowering is pattern-rewrite search, not Sethi-Ullman.**
Standard Sethi-Ullman minimizes register pressure on a load/store machine,
but this ISA's cost surface is different: leaves are addressable inline at
zero stack cost, the same operator has several addressing-combo variants
with different TOS effects, and non-commutative operators interact with
evaluation order in ways SU's weight function doesn't model (SU's leaf
weight of zero collapses its recurrence here). Rather than force-fit SU's
conclusions onto a cost surface it wasn't built for, the lowerer enumerates
realizable tilings via pattern-rewrite rules and picks the byte-minimal
result directly — SU-style stack-depth reasoning survives only as a
tiebreaker among orderings that already tie on byte cost.

**Pattern matching resolves sub-tilings on demand, not against a
pre-rewritten tree.** A rule's pattern can nest arbitrarily deep (e.g. a
`Unary` inside another `Unary`'s argument slot), and the only leaf that
ever needs an already-tiled value is one explicitly tagged `Rtl(...)` —
every other position is matched directly against the AST's own shape
(operator, kind), untouched. Resolving an `Rtl` leaf means recursively
tiling whatever subtree sits there and filtering its candidates by the
demanded tag, not checking whether some earlier pass happened to have
already rewritten that position. The alternative — reduce every child to
its finished candidate table before a parent's rules ever run — is the
more obvious way to implement bottom-up tiling, but it would silently
foreclose multi-level rules: by the time a parent got to inspect a child,
the child's own raw operator/kind shape would already be gone, replaced by
whatever candidates it reduced to. Demand-driven resolution keeps that raw
shape visible for as many levels as a pattern cares to nest.

**Fixed-lowering built-ins get their own pattern kind, not the real-call
one.** `clz(x)`/`revbits(x)`/`trap(code)` (isa-core.md §10.5) parse
identically to a real procedure call — `Identifier(args)` — but a real
call always resolves its callee against the procedure table (§10.5), and
`CallPattern`'s match is built around that: it needs a resolvable callee
to produce any candidate at all. A built-in has no table entry and no
`CALL` involved — `clz(x)` lowers to one bare `CLZ` on whatever's in `acc`,
`trap(code)` needs `code` to be a literal baked directly into `TRAP`'s own
immediate, not a general expression tiled to any output tag. Rather than
bend `CallPattern` to support callees with no table entry and per-call
argument shapes it otherwise never needs, `BuiltinCallPattern` matches by
callee name and arity directly and demands its one argument at whatever
tag (or raw AST shape, for `trap`) the built-in actually needs. Nothing
reserves these names as keywords — a same-named, same-arity user procedure
would be shadowed rather than ever reaching the real call rule, which is
the accepted cost of "built-in by naming convention," matching how `trap`
is already documented as "a function, not a keyword" (§10.5).

**Tiling prunes to a Pareto frontier at every node, not just once at the
root.** A wide tree's tiling count is combinatorial by construction — each
node's candidate count is the cross product of its children's
tag-relevant candidate counts — so without pruning, candidate tables blow
up long before `pickCheapest` ever gets to run. Two steps, applied locally
at every node before its result is cached (`pruneToFrontier`,
`orchestrator.ts`): first collapse candidates that tie *exactly* on
`(bytes, maxStack, clobbers)` to one representative — the dominant effect
on a commutative tree, since e.g. `x + y`'s two evaluation orders cost
identically but neither one *dominates* the other (domination needs a
strict improvement), so without this step ties alone accumulate and
multiply at the next level up; then apply strict domination across what's
left. Both steps are safe to apply purely locally because `nodeInvariants`
composes bytes additively and maxStack/clobbers monotonically up the
tree — substituting a same-cost or dominating candidate anywhere inside a
larger tiling can only match or beat the original, never lose to it (the
standard justification for local pruning in bottom-up optimal
tree-pattern selection, BURS-style instruction selection). With both
steps, tiling is effectively flat in tree width instead of combinatorial.

**The "peek the last-declared local" optimization idea is dead, not just
unimplemented.** An earlier idea proposed addressing the most-recently
declared local via a preserving peek (since it always sits one slot below
TOS right after its declaration) instead of its absolute register index.
This spec's addressing-mode cut removes the combo that idea depended on —
every remaining stack-read combo reclaims what it reads — so the idea has
no combo left to use, not merely a missing implementation.

**Common-subexpression elimination is out of scope, not just
unimplemented.** Doing it correctly needs SSA-shaped reasoning, not a
textual-equality shortcut: the DSL allows assignments inside expressions,
so two syntactically identical subexpressions aren't safe to treat as the
same value unless nothing could have mutated the registers they read
in between — exactly the aliasing question SSA construction exists to
answer cheaply. Anything short of that is either unsound or amounts to
hand-rolled dataflow analysis, which is real-compiler-scale investment
this project isn't taking on. (The multi-location assignment output,
`{acc, reg(target)}`, would be the one piece of existing machinery CSE
could reuse if that ever changed.)

**Extension opcodes declare their stack effect; the validator never calls
into extension code.** isa-core.md §11.2's effect declarations (TOS delta,
peak transient depth, terminates?, call-shaped?) are static data the
validator consults, not a hook it invokes — a validator that called into
extension-supplied logic to re-derive these same numbers would duplicate
work the declaration already states directly, and would make every one of
§8's guarantees only as trustworthy as whatever extension code happened to
run during validation, rather than provable from data alone. Declaring the
effect once, statically, keeps the validator itself extension-agnostic:
the exact same walk that proves §8.1–§8.5 for the generic core proves them
for any registered extension too, with no extension-specific control flow
inside the validator at all.

