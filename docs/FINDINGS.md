# Findings

Things discovered while working, that are not yet decided.

This file is the only place agents record them. `docs/TODO.md` is the
master plan and is written by hand — an entry reaches it by being picked
from here, never by an agent adding to it.

Conventions: one entry per finding, status first, one fact per line. An
entry leaves this file when it is promoted to `TODO.md`, when it is fixed,
or when it turns out to be false. Nothing accumulates here as history —
what a fix pins belongs in a test, what a decision preserves belongs in the
repo's design doc.

---

## mog-core: the validator range-checks shift immediates only

**Status:** open. `mog-core/src/validate.ts`.
The guard covers `SHIFT_OPS`; every other immediate combo takes any value.
That includes values `encodeLeb128` cannot encode, so the validator can
approve a program the encoder rejects.
Surfaced by constant folding reaching an immediate combo with a negative
value. `rtl.ts`'s `asImm` coerces now; the gate is unchanged.
Settling the legal range per immediate kind is a contract change.
**Promote as:** define the legal immediate range per combo kind, and gate on it.

## mog-core: no fold turns a subtraction of a large constant into an addition

**Status:** open, codegen quality only.
`a - -31` folds to `a - 0xffffffe1`, which lowers to `CONST 31; NEG; RSUB`.
The 5-byte LEB128 immediate loses to three short instructions on cost.
`a - 0xffffffe1` is `a + 31`.
**Promote as:** fold wrap-around subtraction into addition.

## mog-core: `switch` fallthrough is restricted by the table's value order

**Status:** open, design proposal. `mog-core/src/lower.ts`'s `caseCloser`,
isa-core.md §7.1 and §10.3.
Three spellings are rejected: fallthrough across a value gap, backward
fallthrough, and fallthrough out of a `default:` not written last.
All three have one cause — the table is value-ordered, C's fallthrough is
textually-ordered, and `FALLTHROUGH` means "the physically next case".
Only the bytecode encoding has that problem. JS and C++ let cases be written
in any order, the VM walks a tree, and a JIT or AOT backend emits the same
forward branch it already emits for every `BLOCK_END`.
So a consumer targeting only the JS codegen is refused a construct for a
representation it never uses, because the rejection sits in the shared lowerer.
`FALLTHROUGH #k` — continue at case `k` of this dispatch, forward only —
closes the gap and mid-`default:` cases. The target is a table index, so no
offsets and no block crossing, and acc liveness at case `k` is the join
`FALLTHROUGH` already creates.
It subsumes `FALLTHROUGH` and `DEFAULT`: one code for two, three bytes
instead of two, on the irregular case only. `raise.ts` stays total.
Backward fallthrough stays unencodable — body duplication, which
isa-rationale.md already treats as a size decision.
§7.1 names `MISC_OTHER` as the growth path and declines to specify it.
Touches bytecode.ts, vm.ts, validate.ts, raise.ts and the JIT's decoder; a
wire change, so the fuzz seed binaries regenerate.
**Promote as:** add `FALLTHROUGH #k`, forward-only, naming a case of its own dispatch.

## mog-jit: the frame does not bind the extension set

**Status:** open. `mog-jit/docs/design.md` §1.1, §12.
The frame seeds on `PROGRAM_CONTRACT_VERSION` alone.
So a program built against one extension passes the frame of an image
linking another, or none.
That is why `RESOURCE_PROGRAM_EXT_UNKNOWN` and `..._UNSUPPORTED` are still
runtime checks where every other `PROGRAM`-class wire check is an assert.
Blocked on an identity: mog-core's `Extension` has no name field, and C++
would need a weak `extIdentity()` beside `extDescribe`/`extEmit`.
Contract change, so a `PROGRAM_CONTRACT_VERSION` bump.
**Promote as:** give `Extension` an identity and fold it into the frame seed.

## mog-jit: nothing host-side rejects a call-shaped extension

**Status:** open.
mog-core's validator supports `effect.calleeOf`; this backend cannot compile
it, and `Executor::run`'s stack budget rests on its absence.
The rejection belongs in `encodeJitProgram`, which is already
mog-jit-specific, rather than on the target.
**Promote as:** reject `effect.calleeOf` in `encodeJitProgram`.

## mog-jit: two arms are unreached by every sink

**Status:** open, both now measured rather than argued.
`accstate.cpp:63` — `sourceReg`'s `Kind::Boolean` arm. `Effect::comparison`
has no producer that survives to either call site.
`translate_control_flow.cpp:473` — the `window.tos != entryTos` arm after a
loop's condition block. Does validated RTL leave the operand stack
unbalanced there?
Both bits are clear after 20000 candidates and four seeds written to attack
them, and the target bitmap now gives one block one bit, so that is proof
rather than an argument. The second arm was invisible while the bitmap
hashed: it aliased three blocks that do run.
Each is an assert or a deletion once settled.
**Promote as:** delete or assert both arms — nothing reaches either.

## The generator explores width, not depth

**Status:** measured, unfixed.
Statement nesting depth reaches 3 from mutation and 2 from the size ladder,
while the ladder moves statement *count* from 80 to 320.
Expression height is the same story: over 4000 mutants the distribution is
`1:12 2:622 3:1544 4:994 5:347 6:283 7:132 8:49 9:13 10:3 11:1` — maximum
11, 1.6% at 8 or above.
`MAX_EXPR_HEIGHT` was not the constraint: raising it 8 → 32 changed a
3000-candidate campaign's target edge coverage by nothing (597 both ways).
Nesting is a retention-signature axis but nothing drives it.
`RESOURCE_EXHAUSTED_SCAN_STACK` is the visible consequence —
`GUARDED_scanBody` recurses once per open block level, needs tens, sees 3.
Peak TOS depth has the same shape: 13 from mutation, 59 at the 320-statement
rung, against the 131 `ARMV6M_PROFILE` permits.
**Promote as:** add a depth ladder beside the size ladder, on both the statement and expression axes.

## Round-robin seed indexing makes fuzz campaigns irreproducible

**Status:** open, found while verifying the flag-state fix.
`driver.ts` picks `corpus[i % corpus.length]`, so changing the corpus size
changes every candidate a seed produces.
A campaign cannot be re-run across a corpus edit, and stage 2 grows the
corpus *during* a run.
**Promote as:** derive the seed choice from the RNG, not the candidate index.

## mog-jit: the fuzz harness let the stack descend below `__bss_end`

**Status:** fixed, and the class of bug is worth remembering.
`exec_runner.cpp` passed `stackLimit` as the code arena's top, on the
reasoning that this keeps the stack and the arena from meeting. But those two
addresses are only the same when the arena is the last object linked into
`.bss`, and it is not — the coverage bitmap sits above it.
So a deep translation was permitted to descend past `__bss_end` and over
whatever was there. In the coverage build that is `g_covBitmap`, which every
instrumented basic block writes to, so a stack frame overlapping it was
rewritten under itself: 25 nested `if`s hung the image where the shipped one
returned `RESOURCE_EXHAUSTED_TRANSLATOR_STACK` cleanly.
Latent for as long as the bitmap was 256 bytes; fatal at 1KB.
`stackLimit` is `&__bss_end` now, which does not depend on link order.

## The fuzz harness never exercises `Executor::onStack`

**Status:** open. `exec_runner.cpp` only ever builds `Executor::split` with
`interruptReserve = 0`.
So every `overlapsStack` branch in `code_arena.h` is dark by construction and
no seed can reach it — four blocks, in `hardFloor`, `Excursion` and
`ensureSpace`.
That is the mode where the arena and the stack grow towards each other, which
is what a device short of RAM would actually deploy. `test/qemu` covers it;
the fuzzer does not.
**Promote as:** run the fuzz batch through `Executor::onStack` too, alternating with `split`.

## The fuzz extension declares no helper stack

**Status:** open, one block.
`executor.cpp:46`'s `declared ? declared + EXT_THUNK_STACK_BYTES : 0` has a
side nothing reaches: `ext_rawmem` emits everything inline and deliberately
declares no `extHelperStackBytes`, so `declared` is always 0.
Reaching it needs a fuzz extension with a real C helper that costs stack.
**Promote as:** give the fuzz corpus an extension with a declared helper stack.

## Target coverage instruments the harness as well as the DUT

**Status:** open, six blocks.
`exec_runner.cpp` and `semihost.cpp` are the test harness, not the JIT, and
they carry five dark blocks between them — batch-framing bails no program
shape can cause.
`semihostExit` is worse than unreachable: it runs *after* `covReport` has
dumped the bitmap, so it can never be recorded at all.
Excluding both files from `-fsanitize-coverage` would make the denominator
mean "the thing under test".
**Promote as:** instrument only the DUT, not `exec_runner.cpp` and `semihost.cpp`.

## The target axis is saturated; 30 named blocks are left

**Status:** measured. The old 30% figure was a wrong denominator — bits set
against the bitmap's capacity, not against the blocks the image has.
A campaign now reaches 717 of 740 basic blocks (96.9%), up from 710, and gets
most of the way there in the first thousand candidates. More throughput will
not move it.
Of the 30 blocks that were dark, seven are now covered — four by new seeds
(`trap_merge`, `deep_translator_stack`, `deep_scan_stack`, `loop_back_edge`),
each verified block by block with `fuzz/ts/reach.ts`, and the rest by
counting what the seeds reach unmutated.
Of the 23 left: six are harness rather than DUT, five are harness
*configuration* no program can change, two are asserts marked
`GCOV_EXCL_LINE`, and one each belong to the `frame` and `invalid` lanes,
which never run against the instrumented image.
That leaves seven genuinely open — `translate_data_flow.cpp:256`'s spilled
write-back, the three loop-TOS blocks, `AccState`'s two arms, and the
up-front stack-budget refusal — none of which yielded to a directed seed.
Host line/branch figures are still stale — they predate the profile
demotions, which deleted five runtime bails.
**Promote as:** re-measure host line/branch coverage.

## The fuzz pipeline is one tool, at stage 1 of 3

**Status:** stage 1 built, stages 2 and 3 planned and not built.
`./fuzz/fuzz.sh` is the only entry point — builds sinks, calibrates,
measures unmutated seed coverage, runs the campaign with the `invalid` and
`frame` lanes interleaved, reports drops by stage plus edge coverage, and
prints a finding as minimized DSL.
Stage 2: coverage-guided corpus growth over a single on-disk DSL seed path.
Stage 3: parallelism, for the 56-core server — it also lets the `--dbg-every`
and `--cov-every` downsampling be dropped, making coverage attribution exact.
**Promote as:** build stages 2 and 3 of the fuzz pipeline.

## ppl: a bridged integer or list is never range- or capacity-checked

**Status:** open. `src/core/reconcile.ts`'s `resolve`, `src/target-js/engine/codec-codegen-ext.ts`'s `STORE_VAL`/`LOAD_VAL`.
A matched integer leaf always resolves to a bare `bridge`; generated code converts it with no check.
An image `u16` decoded into a local `u8` stores the value unchecked; a local value outside the image's range reaches the codec on encode.
List capacity is ignored the same way.
A decoded value is also never checked against the image's own range: `integer(0, 100)` on a 1-byte wire can decode as 200.
**Promote as:** reconciliation.md §7 stage 3 (validation seams, integer domains).

## ppl: an unbounded list gets a 1-byte count prefix, unchecked

**Status:** open. `src/codecs/components/binary-rules.ts`'s `countPrefixWidth`.
With no `capacity`, the default binary list rules size the count prefix as if capacity were 255.
Nothing checks the count against it: `write` goes through `DataView.setUint8`, which wraps.
A 300-element list encodes as count 44 followed by all 300 elements; decode reads 44 and misreads the rest.
**Promote as:** a variable-length count for unbounded lists, and reconciliation.md §5.2's validation seam for lengths.
