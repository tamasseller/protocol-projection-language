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

---

## Known gaps and open work

This section is the one place this document tracks state rather than
timeless rationale — it exists so a future session doesn't have to
rediscover the following from scratch.

**The RTL-level implementation is migrated; a real byte encoder still
doesn't exist.** `packages/core/src/machine/` (`rtl.ts`'s combo/opcode
types, `rules.ts`'s rule generation, `encoding.ts`'s cost model, `vm.ts`'s
dispatch) now match this spec's combo set and op classification — the
peek-without-reclaim and push-on-top-of-peek combos are gone, `MOVE` is
split into its own move-class ops, and the cost model reflects arithmetic's
extended-only immediate and comparison's small-zero form. What's still
unstarted is an actual bit-level serializer/deserializer implementing §5's
byte layout — `encoding.ts` remains a relative cost estimate for the
lowerer's own candidate comparison, not a real codec, matching the
abstraction level the code was already at before this migration.

**The cost-model tie-break gap this migration exposed is now structurally
closed, not patched over.** `orchestrator.ts`'s `pickCheapest` still breaks
ties by byte count, then fragment length, then peak stack depth
(`maxStack`), with no `tosDelta` criterion — but the specific tie that
this gap could previously expose (a wasteful peek-without-reclaim combo
tying a net-neutral write-back combo on every other criterion) can no
longer arise, because the wasteful combo no longer exists at all. A
regression test (`e2e.test.ts`, "add: 8-leaf balanced tree... wide-tree
regression") lowers and executes the exact shape that used to trip
`lowerVarDecl`'s `tosDelta === 1` assertion, confirming `tosDelta` comes
back `1` as expected. `pickCheapest` still has no `tosDelta` tie-break —
that remains true — but nothing currently reachable needs one.

**The "peek the last-declared local" optimization idea is dead, not just
unimplemented.** An earlier idea proposed addressing the most-recently
declared local via a preserving peek (since it always sits one slot below
TOS right after its declaration) instead of its absolute register index.
This spec's addressing-mode cut removes the combo that idea depended on —
every remaining stack-read combo reclaims what it reads — so the idea has
no combo left to use, not merely a missing implementation.

**Dedup is implemented; full memoization is not — still open for wide
trees.** `tileExpr`'s worklist (`orchestrator.ts`) hashes each
partially-tiled expression tree structurally and skips re-exploring a
state already reached via a different rewrite order, which fixed a real
timeout (a 4-leaf balanced sum under a `"tos"` demand: >120s before,
~20ms after). It does not fix the underlying growth in distinct
output-variant combinations as trees widen. Measured after the combo-set
migration above (which roughly halved the branching factor at every
stack-bridging site by removing two of the four stack combos): ~186ms at 6
leaves, ~5.6s at 8, ~28s at 9, and 10 did not finish in the time given —
better than the pre-migration figures (~22.5s at 8, 10 not finishing in
120s) but still exponential-ish, not fixed. A `(subtree, demanded_output)
→ tiling_set` memoization cache — reusing the same structural-hashing
machinery — remains the next step if wider expressions need to lower
quickly.

**Common-subexpression elimination is not implemented.** A repeated
subexpression re-evaluates every occurrence; the multi-location
assignment output (`{acc, reg(target)}`) is the one piece of machinery
already in place that CSE could build on, since it lets a value already
resident in a register serve as an operand for more than one consumer
without re-computing it.

**`CALL` has no working dispatch.** The spec's `CALL proc_idx` takes a
numeric procedure-table index, but the current IR (`rtl.ts`) carries a
`callee: string` name instead, and the VM's `CALL` case throws rather than
resolving and invoking anything. Turning procedure names into table
indices — and, more generally, how a program's procedure table gets built
from multiple lowered fragments — is unstarted infrastructure work, not a
bug in an existing mechanism.

**Extension integration is unresolved.** How multiple `ir\`...\`` fragments
stitch into one procedure (label/scope merging across fragment
boundaries), how a procedure declares any extension header fields beyond
`arg_count`, and how an extension registers its own call names for
resolution — all remain open, application-layer questions with no chosen
mechanism yet.
