# Generic Core ISA - Rationale

> The *why* behind the choices in [isa-core.md](./isa-core.md) that the
> spec text doesn't justify on its own. Choices not listed here are
> self-evident from the spec section itself.

---

## Control flow

**One branching primitive, no offsets.** A conditional branch is a jump
table with two targets, one possibly empty, so there is one construct
(`BR_TABLE`) rather than branch-if plus switch. It carries a case count and
no offsets or block lengths: the DSL forbids `goto`, so every branch target
is already well-nested, and that structural constraint is exactly the
entropy a generic `br + offset` would spend bits carrying. Lenient
implicit-default semantics (`acc ≥ N` skips every case) let `if`,
`if-else` and `switch` share the construct with no validate-then-dispatch
preamble, and cost an `if`-without-`else` only `N=1` with no empty trailing
block.

**`LOOP` opens two blocks.** A condition sub-block (always run, leaves a
decision in `acc`) plus a body sub-block (run conditionally, then loops
back to the condition) gives a pre-test `while`/`for` for one opcode and
one pair of block closers. A single-block loop would have to either
duplicate the condition test or re-test inside the body. The cost is that
`do`/`while` isn't directly expressible, since the condition block has no
"skip the test on the first pass" notion, so a bottom-test loop needs an
explicit first-iteration flag or iteration peeling at the lowering layer
(isa-core.md §7.2). `do`/`while` is rare in codec logic, so paying two
bytes at the few lowering sites that need it beats complicating the one
opcode every loop uses.

**No `break`/`continue`.** The DSL exposes no such keyword, so no lowering
path would ever emit the opcode, and carrying one costs encoding space and
validation surface for nothing. A loop that would `break` early folds the
early-exit test into its condition block.

**`TRAP` is one generic opcode, not a per-domain family.** Any consumer of
this ISA needs a way to stop and report a reason: a codec validating a
checksum, a filter rejecting malformed input, anything built on top. The
reasons are domain-specific, the action (stop, report a code, let the host
decide) is not, and encoding abort as a degenerate loop or jump-to-nowhere
would break the structured-control-flow invariant for no gain. So
`TRAP #code` lives in the core with an error-code space partitioned by
convention (`0` reserved, rest host-defined) rather than by ISA-enforced
semantics: the host owns all stream cleanup and handle teardown and decides
the response. Every real ISA made the same call: x86 `INT`, ARM
`BKPT`/`SVC`, RISC-V `EBREAK`, Wasm `unreachable`, eBPF exit-with-nonzero.

**A split clobbers acc unconditionally (§8.7), stricter than it needs to be
for any program this toolchain actually produces.** `lower.ts` never
carries acc across a `BR_TABLE`/`LOOP` boundary — `lowerReturn` always
freshly re-lowers its own argument, `lowerBlock` is a flat concatenation of
independently-lowered fragments, and no statement-level construct threads
a value through a branch boundary — so no real compiled program is made
illegal by this rule. It exists to close a JIT-backend bug (jit-armv6m's
comparison-fusion optimization defers a comparison's boolean to a CPU
condition code and never materializes it on the edge that skips the branch
body) by construction: rather than teach every backend to correctly
compile a pattern nothing legitimate uses, the pattern is simply not valid
input. This also sets up the general discipline a future value-producing
branch construct (a ternary — parsed today but not yet lowered) would need:
"split clobbers, join requires an explicit flush on every incoming edge" is
standard SSA/phi-node discipline, so nothing here forecloses a real value
legitimately crossing a branch later.

**Bare block statements are excluded from the DSL.** A `{ ... }` is only
reachable as the direct body of `if`/`else`/`while`/`for`. `BLOCK_END` is
what resets TOS to a block's entry depth (isa-core.md §8.1), and a
standalone brace-block has no `BR_TABLE` case or `LOOP` sub-block behind
it, so it would have no `BLOCK_END` to perform that reset: a local declared
inside would never be reclaimed at the register level even though the DSL
considers it out of scope, silently aliasing whatever register a later
declaration receives. Disallowing bare blocks keeps "every DSL scope closes
via a real `BLOCK_END`" a structural invariant instead of a lowering-time
special case.

---

## Storage and addressing

**TOS-hybrid accumulator plus register file, sharing one address space.**
Keeping the operand stack and the register file as the same logical array,
indexed by TOS on one side and by name on the other, means a value never
has to commit to being "a local" or "a stack temporary" ahead of time: the
same storage plays both roles depending on how it is addressed. One
procedure can therefore mix RPN-style expression evaluation (cheap per
node, no naming) with named locals and running counters, choosing per value
rather than per procedure.

**Every stack-read combo also reclaims its operand.** Arithmetic has
exactly five addressing combos (register→acc, register→register,
peek→peek, pop→acc, immediate→acc). The two conspicuously absent ones,
reading `[tos-1]` without writing back and pushing a new value on top of
`[tos-1]` while leaving it there, look useful for RPN chaining and are not:
a pushed value is always single-use here (there is no common-subexpression
elimination, so nothing reads a stack slot twice), so a combo that reads a
stack operand without reclaiming it leaves a register permanently and
silently allocated with no consumer. Every stack-touching combo either
writes its result back into the same slot (net zero growth) or pops (net
negative). The one case that would motivate a preserving read, a named
local that must stay addressable after being read mid-expression, is
unreachable too: nothing addresses "the local that happens to sit just
below TOS" by position, always by its own register index. This also
disposes of the "peek the most-recently-declared local instead of its
absolute index" idea, which depended on exactly the combo this cut removes.

**Register indices are LEB128 everywhere.** One rule for "a register index
follows", never fixed-width in some positions and variable-length in
others. Indices under 128 already fit in one LEB128 byte, so the common
case costs nothing, and both the spec and any encoder/decoder lose a
special case.

---

## Opcode space

**Every op is first-class, none quarantined to a second byte.** There is no
"common" versus "rare" tier for arithmetic, comparison or unary ops.
Splitting a class into a compact subset plus an escape-byte overflow pays
off only if the frequency split is right, and there is no corpus to measure
against yet: guessing wrong adds a second encoding path for no savings.
Treating every op in a class identically keeps the op tables flat and keeps
the lowerer's cost model from needing to know which ops are expensive to
select.

**Arithmetic's immediate operand has no small form; comparison's does.**
The right constant to special-case for `ADD` is not the right one for
`AND`, and picking one per operator without a measured corpus has no
principled basis, so arithmetic immediates uniformly cost the extended
(LEB128) form with no per-operator table to maintain. Comparing against
zero (loop bounds, sign checks, null-like sentinels) is a near-universal
idiom independent of any corpus, so comparison alone gets a dedicated
single-byte form. One is a justified universal case, the other would be a
per-operator guess.

**The core opcode space is a flat range dispatch, not a bit-prefix tree.**
Each instruction class's size is its actual op × mode count (50, 40, 4, 5,
4, 25), not rounded up to a power of two. Those sizes don't nest under a
cascading single-bit split the way equal halves would, so the decoder is a
handful of numeric range checks or one 128-entry table instead of bit
masking, and is simpler to implement and verify. Almost all of the 128-code
budget goes to what each class needs, with four codes left unassigned
(isa-core.md §5.3) as somewhere for one specific, later, *measured*
addition to land without renumbering.

**The four reserved codes are a bounded exception, not a reopened
question.** One candidate for that pocket: a constant-synthesis op for
low-entropy value shapes (powers of two, all-ones masks, contiguous bit
masks), each of which today costs a 4-6 byte extended `CONST` or a
multi-instruction composite. A single `MASK(width, offset)` move-class op
packing both parameters into one trailing byte would subsume all three at
2 bytes. It is not adopted: no corpus shows these shapes appearing often
enough, which is the same unmeasured bet the per-op arithmetic literal
table was rejected for. The difference is scope: reserving four codes
against the chance one narrow addition is later justified is cheap;
guessing its content without evidence is not.

---

## Calls and arithmetic

**The calling convention passes the last argument in `acc`.** `CALL`'s
return value overwrites `acc` unconditionally, so nothing a caller left
there survives the call regardless of whether an argument routes through
it: passing the callee's last argument in `acc` instead of pushing it costs
nothing already spent. This makes the single-argument call, by far the most
common arity, free of any `PUSH`, and composes directly for a call nested
as another call's last argument (`f(g(x))`), where `g(x)`'s own acc-output
tiling already leaves its result where `f`'s call needs it, with no
push-then-pop stack bridge in between.

**No `DIV`/`MOD`.** Many microcontrollers lack hardware division, and
including software-emulated division would silently emit expensive loops
on those targets. Codec arithmetic is dominated by shifts, masks, adds and
compares; modulo by a power of two is `AND (N−1)`. A program that genuinely
needs division calls a software helper procedure.

---

## Lowering

**Expression lowering is pattern-rewrite search, not Sethi-Ullman.**
Sethi-Ullman minimizes register pressure on a load/store machine; this
ISA's cost surface is different. Leaves are addressable inline at zero
stack cost, the same operator has several addressing-combo variants with
different TOS effects, and non-commutative operators interact with
evaluation order in ways SU's weight function doesn't model (its leaf
weight of zero collapses the recurrence here). The lowerer instead
enumerates realizable tilings via pattern-rewrite rules and picks the
byte-minimal result; SU-style stack-depth reasoning survives only as a
tiebreaker among orderings already tied on byte cost.

**Pattern matching resolves sub-tilings on demand.** A rule's pattern can
nest arbitrarily deep (a `Unary` inside another `Unary`'s argument slot,
say), and the only leaf needing an already-tiled value is one tagged
`Rtl(...)`; every other position matches the AST's own shape (operator,
kind) directly, untouched. Resolving an `Rtl` leaf recursively tiles
whatever subtree sits there and filters its candidates by the demanded tag.
The alternative, reducing every child to its finished candidate table
before a parent's rules run, is the more obvious bottom-up implementation
but forecloses multi-level rules: by the time a parent inspected a child,
the child's raw operator/kind shape would already be gone. Demand-driven
resolution keeps that raw shape visible for as many levels as a pattern
cares to nest.

**Fixed-lowering built-ins get their own pattern kind.**
`clz(x)`/`revbits(x)`/`trap(code)` (isa-core.md §10.5) parse identically to
a real procedure call, `Identifier(args)`, but a real call resolves its
callee against the procedure table and `CallPattern`'s match is built
around that: it needs a resolvable callee to produce any candidate at all.
A built-in has no table entry and no `CALL` involved: `clz(x)` lowers to
one bare `CLZ` on whatever is in `acc`, and `trap(code)` needs `code` baked
into `TRAP`'s own immediate as a literal, not tiled to an output tag. So
`BuiltinCallPattern` matches by callee name and arity and demands its
argument at whatever tag (or raw AST shape, for `trap`) the built-in
actually needs, instead of bending `CallPattern` to support table-less
callees. Nothing reserves these names as keywords: a same-named,
same-arity user procedure is shadowed rather than reaching the real call
rule, the accepted cost of built-in-by-naming-convention, matching `trap`
being documented as a function rather than a keyword.

**Tiling prunes to a Pareto frontier at every node.** A wide tree's tiling
count is combinatorial by construction (each node's candidate count is the
cross product of its children's tag-relevant counts), so without pruning
candidate tables blow up long before `pickCheapest` runs. Two steps applied
locally at every node before its result is cached (`pruneToFrontier`,
`orchestrator.ts`): collapse candidates tying *exactly* on
`(bytes, maxStack, clobbers)` to one representative, then apply strict
domination across the rest. The tie-collapse step is the dominant effect on
a commutative tree, where `x + y`'s two evaluation orders cost identically
yet neither dominates the other (domination needs a strict improvement), so
ties alone would accumulate and multiply at the next level up. Both steps
are safe locally because `nodeInvariants` composes bytes additively and
maxStack/clobbers monotonically up the tree, so substituting a same-cost or
dominating candidate anywhere inside a larger tiling can only match or beat
the original. This is the standard justification for local pruning in
bottom-up optimal tree-pattern selection (BURS-style instruction
selection). With both steps, tiling is effectively flat in tree width.

**Common-subexpression elimination is out of scope.** Doing it correctly
needs SSA-shaped reasoning rather than a textual-equality shortcut: the DSL
allows assignments inside expressions, so two syntactically identical
subexpressions are the same value only if nothing mutated the registers
they read in between, exactly the aliasing question SSA construction exists
to answer cheaply. Anything short of that is either unsound or hand-rolled
dataflow analysis, real-compiler-scale investment this project isn't taking
on. The multi-location assignment output, `{acc, reg(target)}`, is the one
piece of existing machinery CSE could reuse if that changed.

---

## Extensions

**Extension opcodes declare their stack effect; the validator never calls
into extension code.** isa-core.md §11.2's effect declarations (TOS delta,
peak transient depth, terminates?, call-shaped?) are static data the
validator consults, not a hook it invokes. A validator calling into
extension-supplied logic to re-derive those numbers would duplicate what
the declaration already states, and would make every §8 guarantee only as
trustworthy as whatever extension code ran during validation rather than
provable from data alone. Declaring the effect once, statically, keeps the
validator extension-agnostic: the same walk that proves §8.1-§8.5 for the
core proves them for any registered extension, with no extension-specific
control flow inside the validator.
