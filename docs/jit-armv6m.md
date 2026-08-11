# MCU JIT: Generic Core → ARMv6-M

> **Status:** Plan/draft — captures the envisioned design, open questions, and
> risk areas before any implementation starts. Not a normative spec like
> isa-core.md; expect this to be revised as the harder pieces (§6, §10) get a
> worked derivation or a prototype. Assumes isa-core.md throughout.

---

## 1. Goal

A native C/C++ function, callable from bare-metal firmware, that JIT-compiles
and executes one Generic Core program fragment injected at runtime:

```c
Report mcu_jit_run(const uint8_t *program,
                    uint8_t *work_area, size_t work_area_size,
                    const uint8_t *args, size_t args_size);

typedef struct { Status status; uint32_t value; } Report;
// status ∈ { RETURNED, TRAPPED, RESOURCE_ERROR }; value = return value,
// trap code (isa-core.md §4.5), or an implementation-defined error code.
```

Constraints: target is ARMv6-M (Cortex-M0/M0+ baseline Thumb, no Thumb-2
extensions). `work_area` may be too small to hold every procedure's compiled
code simultaneously — execution must still be attempted, compiling and
evicting procedures on demand. Translation is single-pass and as
context-free as possible, followed by one branch/table fixup pass. Generated
code is position-independent (no embedded absolute addresses) so eviction +
compaction never needs a full relocation pass.

---

## 2. Memory layout

`work_area` splits into fixed-size static regions, sized once at init, plus
an arena for the rest:

| Region | Sizing source | Purpose |
|---|---|---|
| Return-address stack | `validateProgram`'s max-call-depth figure (isa-core.md §8.3) | one `(proc_idx, offset)` record per active call (§7) |
| Operand/TOS spill stack | `validateProgram`'s `totalDepth` (§8.3, already exposed as `ProgramStats.totalDepth`) | overflow beyond the 4-register window (§5) |
| Dispatch table | one entry per procedure (program header's `proc_count`) | code pointer/state + LRU links (§9) |
| Native support stack | implementation constant | real C stack for the translator/dispatcher/evictor's own execution |
| Arena | `work_area_size − (above)` | bump-allocated compiled-code blocks (§9) |

**Prerequisite, not yet built:** isa-core.md §8.3 already *describes* the
max-call-depth figure as falling out of the same bottom-up DFS as
`totalDepth`, but `validate.ts`'s `ProgramStats` only exposes `totalDepth`
today (checked directly — no `maxCallDepth`/`callDepth` field exists). Sizing
the return-address stack from real static data, rather than a hand-picked
constant, needs that field added first.

The arena is a pure bump allocator (single high-water pointer) between two
phases: alloc-only until exhausted, then evict-LRU-and-compact (§9).

---

## 3. Register assignment

| Reg(s) | Role |
|---|---|
| `r3` | `acc` |
| `r4–r7` | TOS window, circularly renamed (§5) |
| `r0–r2, r12` | scratch — instruction implementation, trampoline argument passing |
| `r8–r11` | table base pointers (dispatch table, arena/LRU metadata, helper vector — §10.4) |
| `sp` | operand/TOS spill stack (§2) — **never** the real C call stack while compiled code runs |
| `lr` | transient, `BLX`-scoped only |

`r8–r11` are addressed only via the
ARMv6-M "hi register" `ADD`/`MOV`/`CMP` forms, matching hardware reality:
those are the *only* three ops with a hi-register operand form on this
architecture.

---

## 4. Wire vs. physical register indexing

isa-core.md §2.5 already defines TOS as per-frame — every invocation gets
its own entry point. The window mapping (§5) rides directly on that: it's 
defined purely in terms of a procedure's own frame-relative `rN`/`tos`, 
exactly as the bytecode already expresses them, with nothing global layered on top.

That's only sound because of §6's canonical-phase invariant: every frame
base is forced to phase 0 (`k=0 → r4`) regardless of the caller's own
frame-relative `tos` at the call site. Given that, a procedure's
translation only ever needs to reason about its *own* frame-relative depth
— never the call chain's accumulated depth — which is what makes it
context-free: no bookkeeping crosses a `CALL` boundary except the shuffle
itself (§6).

---

## 5. The register window

Physical register for frame-relative index `k` (isa-core.md's own `rN`,
or TOS depth relative to the current frame base):

```
in_window(k)  ⟺  tos − k < 4
phys(k)       =  r4 + (k mod 4)          when in_window(k)
              =  spilled to SP stack     otherwise
```

This is a pure function of `k` and current `tos` — **not** of push/pop
history along whichever control-flow path reached this point. That's the
property that makes it context-free: two `BR_TABLE` cases (or a `LOOP`
back-edge) that reconverge at the same `tos` always agree on `phys(k)` for
every live `k`, with no cross-path reconciliation needed.

**Spill/fill.** Pushing slot `k+4` evicts slot `k`'s current value from its
register to the SP-addressed stack (native `STR`, SP-relative, before the
register is overwritten). Popping back down unconditionally reloads it
(native `LDR`) — no liveness tracking, "unconditionally recovered ... to
keep the translator simple" per the brief. Correct but leaves cheap
dead-reload elimination on the table; deliberate trade, not an oversight.

**Block-exit truncation is not free.** isa-core.md §8.1: at `BLOCK_END`/
`RETURN`, TOS surplus above the enclosing entry depth is *implicitly
dropped* — a validator-level guarantee, not a bytecode-level pop sequence.
Because `phys(k)` cycles through r4-r7 as `tos` grows, a path that pushed
extra values has overwritten (and spilled) some in-window slots that belong
to the target depth. The translator must synthesize an explicit
pop-multiple-equivalent restore at every truncation point (`BLOCK_END`,
`LOOP` back-edge, `RETURN`) to bring r4-r7 back to what the target depth's
`phys(k)` mapping expects — a real, local (current tos → target tos,
always statically known) piece of codegen, not a no-op. Same operation as
the call-boundary shuffle (§6), different trigger.

---

## 6. Calling convention

isa-core.md §6: callee frame base = caller's TOS at the call; args
`0..K-1` on the stack, arg `N-1` (if any) in `acc`.

**Canonical-phase invariant.** Every procedure's native code is translated
assuming its *own* frame base always lands at phase 0 (`k=0 → r4`) —
independent of the caller's absolute global `tos` at the call site,
which varies per call site and per invocation. This is required for two
things the design depends on:

- the same compiled procedure is called from multiple, differently-phased
  call sites;
- return must be re-enterable after the callee's *caller* was itself
  evicted and recompiled (§7) — recompiling the same bytecode must
  reproduce the same native-code layout, which only holds if translation
  never depends on caller-side compile-time context.

**The shuffle.** Before `CALL`, the caller's window is generally at some
non-zero phase relative to what the callee expects at `k=0`. Re-phasing is
a spill/fill round-trip: push the currently-cached contiguous run to the
spill stack, then pop it back starting at `r4` — `POP`'s fixed ascending-
register-to-ascending-address semantics naturally re-establishes phase 0
for free (no cross-register `MOV`s needed, since `PUSH`/`POP` can't swap
registers without a memory round-trip anyway, and none is required if both
sides already keep window contents in ascending logical order — which they
do, by construction of §5's formula).

The brief's claim ("a sequence of three push/pop-multiple instructions can
implement any shuffle needed") is **plausible but not yet proven** — the
push-then-pop-from-r4 pattern covers the common case in one or two
instructions; a third likely covers the boundary case where the callee
needs more resident slots than the caller had cached, requiring an
additional fill from the explicit spill stack. **Needs a worked derivation**
(exhaustive case enumeration over phase difference × argument count) before
relying on "3" as a hard bound — this is the single trickiest piece of the
whole translator and the one most worth prototyping first.

**Callee-side prologue.** The shuffle above is the *caller's* job. The
callee has its own, smaller obligation: isa-core.md §4.6's last argument
arrives in `acc`, not at its frame-relative home register — and nothing
else in a procedure's own bytecode body guarantees `acc` survives
untouched until the first instruction that reads it (in the Appendix
worked example, `CONST #1` clobbers `acc` before `v` is ever read back).
So every procedure with `arg_count ≥ 1` needs one implicit prologue
instruction, emitted unconditionally (no lookahead to check whether the
body's first real instruction happens to consume `acc` immediately) —
copy `acc` into the last argument's canonical home register before
translating the body at all. Same "keep the translator simple, no
lookahead" bias as §5's unconditional spill recovery.

---

## 7. Return

`RETURN` cannot compile to a bare native return: the caller may have been
evicted from the arena while the callee was running. The call stack
therefore stores `(proc_idx, offset)`, not a raw code address — `offset`
is a native-code offset relative to the caller's compiled procedure start.

This is only stable across eviction+recompile because of §6's
canonical-phase invariant: translation is a pure function of `(proc_idx,
bytecode)` alone, so recompiling the same procedure reproduces the same
native-code layout, and a saved `offset` remains valid.

Return path: `RETURN` → dispatch trampoline → look up `proc_idx` in the
dispatch table → if evicted, recompile → jump to `code_ptr + offset`. Same
mechanism, same table, as a forward `CALL` (§9) — return is not a distinct
code path, it's a dispatch through the same table with a resume offset
instead of a fixed entry offset.

**At the call site, this is cheap.** `RETURN`'s own compiled form doesn't
inline any of the above — it just hands off to one shared runtime routine
(`dispatch_return`, part of §9's runtime, popping the return-address stack
and doing the table lookup itself): move the return value into `acc`, then
jump to `dispatch_return`. That routine is a single, fixed, non-arena
location — reached the same way §11 ends up reaching `CLZ`/`REVBITS`
helpers and §9 reaches dispatch-table entries: through a reserved,
fixed-offset slot addressed via the *same* table-base register `CALL`
already uses (§9), not a fresh literal-pool word at every `RETURN` site.
Worth folding back into §11's still-open decision — `RETURN` sites are
plentiful (one per procedure, typically more), so amortizing the address
lookup over one shared table entry likely beats paying a literal-pool word
per site, more so than a single rare `CLZ`/`REVBITS` call site would on its
own.

---

## 8. Pinning

The currently-executing procedure (top of the return-address stack) must
never be evicted — its code is what the core is fetching from right now.
Every procedure *below* it on the return stack is safely evictable, exactly
because §7 makes return re-enterable after recompilation. LRU bookkeeping
must exclude the pinned top entry; if compiling a callee needs more space
than is free after evicting every other entry, that's the `RESOURCE_ERROR`
report path (§12) — not a stack-depth violation, since §2's static regions
already guarantee no overflow there.

---

## 9. Dispatch table & trampolines

One entry per procedure: `{ state, code_ptr, size, lru_prev, lru_next }`.
`CALL proc_idx` compiles to: load the table slot (table-base register +
compile-time-constant offset, §3), `BLX` whatever is currently there —
either compiled native code directly, or a shared compiler trampoline stub
that compiles the procedure on demand, updates the slot, and falls through
into the freshly compiled code. Standard lazy-compilation pattern (same
shape as a JIT's "compile on first call" stub, or a classic overlay
linker's load-on-demand stub).

---

## 10. Translation pipeline

**Pass 1 — per-instruction emission**, single forward walk, no
cross-instruction analysis beyond the local `tos` the pass already tracks
(same invariant `validateProgram` relies on for §8.3). Mechanical
per-opcode-class notes:

- **Arithmetic/comparison** (§4.1/§4.2 addressing modes): register-mode
  operand already in-window → one native ALU op. Out-of-window operand →
  one spill-stack `LDR` first. Peek/pop modes are direct consequences of
  §5's window (peek = top-of-window register in place; pop = read + shrink
  window, unconditional refill per §5).
- **Comparison + branch fusion is required, not optional.** ARMv6-M has no
  compare-and-set instruction (no `IT`+conditional-`MOV` equivalent to
  materializing a real 0/1 in one or two ops the way later architectures
  can) — synthesizing an actual boolean into `acc` from a `CMP` needs
  ~4–5 instructions (`CMP`, branch, two immediate loads). A comparison op
  is, in every bytecode this ISA can express, immediately consumed by
  exactly one `BLOCK_END`/`BR_TABLE` test (isa-core.md §4.5's "lenient
  test") — so the translator must recognize that adjacency and fuse the
  pair directly into one `CMP` + one conditional branch, never
  materializing an intermediate value. This is the one deliberate,
  bounded exception to "no lookahead" elsewhere in this design: it's a
  fixed one-instruction peek, not dataflow analysis, and without it the
  §14 estimates for `if`/`while` conditions (assumed fused) are off by
  roughly 5 instructions per comparison — i.e. wrong by more than the
  estimate itself, given how often a loop condition executes. See the
  Appendix worked example for the concrete before/after.
- **`BR_TABLE`** — no `TBB`/`TBH` on ARMv6-M (Thumb-2 only). `N ≤ 2` (the
  overwhelming common case — `if`/`if-else`, isa-core.md §7.1) compiles to a
  plain `CMP` + conditional branch, no table at all. Larger `N` needs an
  actual literal-pool jump table plus computed `BX` (load target into a
  register, branch to it — ARMv6-M has no memory-indirect branch).
- **`CLZ`/`REVBITS`** — no ARMv6-M instruction for either (`CLZ` is
  ARMv5T+Thumb-2; `RBIT` is ARMv7-M+). Both compile to a `BL` into a fixed
  software helper routine, not inline code. Real cost, but not a
  disadvantage vs. hand-written `-Os` C on the same core, which pays the
  identical software-emulation tax.
- **`MUL`** — native `MULS`, part of ARMv6-M baseline. Fine as-is.
- **No `DIV`/`MOD`** in the ISA (isa-core.md §4.1) — nothing to synthesize.

**Producer→`STORE` fusion — the same idea, generalized beyond
comparisons.** Any instruction that produces a fresh `acc` value,
immediately followed by `STORE rK` with `rK` currently in-window, can
skip the copy into `r3` and write straight into `phys(rK)` instead — the
same one-instruction-peek shape as comparison fusion above, but only
sound if the producer's native form can target an arbitrary destination
register rather than being forced to write back into whichever register
holds `acc`. That's a hard ARMv6-M constraint, not a design choice:

| Retargetable (`Rd` independent of the acc operand) | Not retargetable (Thumb-1 2-op encoding forces `Rd` = a source) |
|---|---|
| `CONST`/immediate loads (`MOVS Rd,#imm`, `LDR Rd,[PC,#imm]`) | `AND`, `EOR`/`XOR`, `ORR`, `MUL`, `BIC`, `ADC`, `SBC` |
| `LOAD` (pure copy — fuses straight through, bypassing `acc` entirely) | shift-by-*register* (`LSL`/`LSR`/`ASR` reg-reg form) |
| `ADD`/`SUB` (Thumb's 3-operand register or imm3 form) | comparisons not immediately branch-fused (still only ever write `acc`) |
| shift-by-*immediate* (3-operand `Imm5` form) | `CALL`'s return value — ABI-fixed into `r3` by the shared dispatch trampoline (§7/§9), not under this call site's control |
| `NEG`, `NOT`, `SXH`/`SXB`/`UXH`/`UXB`/`REV`/`REV16`/`REVSH` (destination-only field, doesn't read its own prior value) | |

The left column has a genuine 3-independent-operand (or destination-only)
hardware encoding; the right column's Thumb-1 2-operand form reads
whichever register the destination field names as an *input* too — a
naive retarget there wouldn't just risk a stale value later, it would
silently compute the wrong result immediately, a different and worse
failure mode than the liveness question below, worth keeping distinct.

*Why this stays sound with only a one-instruction trigger, no lookahead
past that.* The ISA has no instruction that reads `acc` without either
overwriting it in the same instruction or being a pure capture (`STORE`,
`PUSH`) that leaves it unchanged — inspection of every op in §4 confirms
this; nothing "peeks" at `acc` and leaves it live for a third reader. So
the real invariant isn't "used at most once," but close enough to be just
as useful: a run of zero or more consecutive `STORE`/`PUSH` instructions
can validly read the same `acc` value, terminated only by the next
producer. That bounds the danger enough to make a purely causal scheme
sound — track `acc_home` (a physical register, defaulting to `r3`) as one
more piece of compile-time state, the same style §5's window already
keeps:

- Fusing a producer into a following `STORE rK` sets `acc_home =
  phys(rK)` instead of emitting the copy.
- Every later read of "acc" (another `STORE`/`PUSH`, or an operand slot)
  reads from `acc_home`, not a hardcoded `r3` — a second consecutive
  `STORE`/`PUSH` in the same run just works, unmodified, since `acc_home`
  already points at the value.
- The only remaining danger, per the invariant above: §5's window
  rotation evicting the *specific* physical register `acc_home` points
  at, before a new producer ever supersedes it — only reachable if enough
  consecutive `PUSH`es land inside the same acc-reading run to rotate
  that exact slot out (§5's 4-deep window). Cheap, mechanical,
  rare-to-trigger fallback bolted onto rotation logic §5 already runs:
  emit one `MOVS r3, acc_home` first, then proceed as if `acc_home` had
  been `r3` all along.

Not specific to this project's own `lower.ts` output either — it's a
structural fact about any accumulator ISA with no non-consuming peek at
`acc`, so it holds against arbitrary conforming bytecode, not just
"well-behaved" DSL-generated programs. In practice (this project's own
generated code included), the fallback essentially never fires — real
generated code doesn't chain four `PUSH`es between a stored value and its
next use — but nothing here *requires* that to be true for soundness.

**Quantified on the Appendix's `leb128_len`:** `CONST #1`+`STORE 1` fuses
to `MOVS r5, #1`; `SHR #7`+`STORE 0` fuses to `LSRS r4, r3, #7`; `ADD
1`+`STORE 1` fuses to `ADDS r5, r3, r5` — 16 native instructions down to
13, landing at parity with the bytecode's own 13 opcodes rather than 1.2×
over it. See the Appendix's fused variant.

A mirror-image sibling, not detailed here or folded into the count above:
fusing a `LOAD` into the *next* instruction's source operand instead of a
producer into the *following* `STORE` (e.g. `LOAD 0; SHR #7` → `LSRS r4,
r4, #7` directly, no copy on either side) — same underlying hardware
property (independent operand fields), applied at the front of an
operation instead of the back. Worth the same treatment later.

**Pass 2 — fixup.** Two independent jobs, not one:
- *Branch range.* Thumb conditional branches are ±252 bytes (8-bit signed
  imm×2); a procedure whose basic blocks span further needs the standard
  invert-and-long-branch idiom any Thumb-1 assembler already uses. This is
  the same reason a fixup pass is needed at all, not just for
  procedure-external targets.
- *Jump tables.* Materializes the `BR_TABLE N>2` literal-pool tables once
  every case's final address is known.

---

## 11. Position independence under compaction

Compaction moves surviving procedures' code to close the gap left by an
evicted one, then updates only the dispatch table's `code_ptr` entries —
O(procedure count), not O(code size). This is cheap *only if* no generated
instruction embeds an address that depends on the code's own location.

Two things already satisfy this by construction: PC-relative literal-pool
loads (`LDR Rd, [PC, #imm]`) stay correct after a `memmove` because the
displacement is relative to the (moved-together) load site, not absolute;
inter-procedure `CALL`s already go through the table-base-relative dispatch
mechanism (§9), never a direct `BL`/`BLX` to another procedure's address.

**One real gap:** a `BL` to a *fixed* helper routine outside the arena
(§10's `CLZ`/`REVBITS` helpers, if implemented as ordinary flash-resident
C functions) is *not* free under compaction — `BL`'s displacement is
relative to the (moving) call site, not the (fixed) helper, so a naive
re-emitted `BL` needs a different immediate after every move.

Worse than that, actually: on a typical MCU memory map, flash and SRAM sit
far enough apart (e.g. `0x08000000` vs `0x20000000` on the common
Cortex-M layout — ~384 MB apart) that `BL`'s own ±4 MB range likely can't
reach a flash-resident helper from arena-resident (SRAM) code *at all*,
independent of compaction or where in the arena the call site lands. A
direct `BL` to a fixed helper isn't just inconvenient to patch — it's
plausibly out of range from the start. Ways out:

1. Load the helper's address from a **per-call-site literal pool entry**
   (PC-relative `LDR`, the same mechanism already needed for `CONST-ext`
   and large immediates) into a register, then `BLX` it. Compaction-safe
   for free — the load is relative to the (moved-together) call site, same
   reasoning as §11's other literal-pool loads — and needs no shared table
   or reserved base register, just one extra pool word per call site.
   Simplest option; likely the default.
2. Route helper calls indirectly through a fixed helper-vector table (a
   4th table-base register, or a slot in an existing one) — same
   compaction-safety, but one shared table entry instead of a literal-pool
   word per call site. Worth it only if `CLZ`/`REVBITS` call sites turn out
   to be common enough that the per-site pool word actually costs more
   than one more base register's worth of indirection.
3. Patch the (small, bounded) set of helper-call sites during compaction —
   moot given the range problem above: there's no guarantee a valid direct
   `BL` encoding exists for a given call site regardless of when it's
   patched, so this isn't a real option unless the helpers are somehow
   guaranteed reachable (e.g. linked into a fixed low-address region *and*
   the arena is also known to sit within range of it — not assumable in
   general).
4. Recompile relocated survivors from bytecode instead of moving bytes —
   defeats "cheap memmove," but reuses machinery that has to exist anyway
   (eviction already recompiles), and sidesteps this whole class of bug.

Leaning toward (1) for `CLZ`/`REVBITS` specifically — call sites for either
are likely rare, so the per-site literal-pool cost stays small. **Revised
after §7's return-path derivation**, though: `RETURN` needs the identical
"reach a fixed, non-arena routine" capability, at far more sites (one per
`RETURN`, i.e. commonly per procedure) — and it turns out to cost nothing
extra there, since it reuses the *same* table-base register `CALL` already
needs for dispatch (§9) via one reserved, fixed-offset slot, no new
register or per-site literal pool at all. That reframes this as a spectrum,
not a binary choice: a **shared reserved slot in the existing
dispatch-table mechanism** (no new bookkeeping, amortizes over every call
site) is probably the right default whenever the target is reached often
enough to be worth a permanent slot — `RETURN`'s `dispatch_return` clearly
qualifies; `CLZ`/`REVBITS` are the marginal case where a per-site literal
pool word (option 1) may still be cheaper in aggregate, precisely because
they're rare. Worth deciding with real call-site counts from a
representative program, not in the abstract.

---

## 12. Report / error model

`RESOURCE_ERROR` is a genuinely new failure mode this target introduces —
distinct from anything isa-core.md's own static guarantees (§9) cover.
Stack overflow shouldn't happen (§2's static regions are sized from
`validateProgram`'s own figures); the real runtime failure here is
specifically **arena exhaustion where a single procedure doesn't fit even
after evicting everything evictable** (§8) — e.g. one procedure larger than
the whole arena, or every evictable slot still too fragmented pre-
compaction. `TRAPPED` carries the ISA's own `TRAP #code` value unchanged.

---

## 13. Precedents

- **WebAssembly baseline compilers** (V8 Liftoff, SpiderMonkey baseline) —
  closest modern analogue: single forward pass, no register allocator, a
  compile-time value stack mapped onto physical registers with overflow
  spilled to a real stack. Missing piece they don't need: code
  eviction/compaction under a hard memory ceiling.
- **Forth native-code compilers** (VFX Forth, SwiftForth, classic
  subroutine-threaded → native-compiling Forths) — TOS caching in
  registers is a decades-old Forth compilation technique; caching 4 deep
  with circular relabeling is a more aggressive version of the same idea.
- **SPARC register windows / Itanium rotating register files** — same
  trick underlying §5: cyclic relabeling of physical registers avoids
  actual data movement across a boundary (call, in SPARC's case; window
  slide, here).
- **Copy-and-patch code generation** (Xu & Kjolstad) — same "fast,
  template-driven, single-pass, no real register allocation" philosophy,
  though this ISA is small enough to hand-emit per-opcode rather than
  needing a template-extraction toolchain.
- **HotSpot CodeCache / JVM code-cache eviction**, and **classic overlay
  linkers** (segmented-memory mainframes, N64/PS1 overlay systems) — the
  arena + LRU-eviction + compaction scheme is a miniaturized version of
  software-managed code overlay, decades-precedented outside the JIT
  world specifically.
- **MicroPython's `emitnative` backend** — a real, shipping example of a
  compact Thumb-emitting bytecode-to-native compiler in C, worth reading
  for concrete emission-pattern ideas even though it doesn't do
  eviction/compaction.

---

## 14. Performance estimate

Rough, pre-implementation. Per Generic Core opcode, native Thumb
instruction count:

| Case | Instructions |
|---|---|
| ALU op, operand in-window | 1 |
| ALU op, operand spilled | 2 (extra `LDR`) |
| `PUSH`/`POP`, no window boundary crossed | 0 (pure relabeling) |
| `PUSH`/`POP`, crossing the 4-deep boundary | 1 (`STR`/`LDR`) |
| `CONST`/`LOAD`/`STORE` | 1–2 |
| `if`/`if-else` (`BR_TABLE` ≤2) | 2–3 (`CMP` + branch(es)) — **only with
  the fusion §10 requires**; ~7 unfused |
| `CALL` | ~5–6 (shuffle + table load + `BLX` + return handling) |
| `RETURN` | 2 (move return value to `acc` + jump to the shared
  `dispatch_return` routine, §7) |

Expansion factor from one Generic Core opcode to native instructions is
roughly 1–3× for arithmetic-heavy code, maybe 4–6× amortized with control
flow and calls — no bytecode-dispatch overhead at all, since there's no
dispatch loop left at runtime. Expect overall throughput within a small
constant factor (rough guess: 2–4×) of equivalent `-Os` C on the same core,
with `CLZ`/`REVBITS` and the call-shuffle cost being the main structural
overheads relative to native — and neither is a real disadvantage, since
`-Os` C pays the first cost too and the second is comparable to any real
calling convention's own bookkeeping.

First real data point (Appendix): a full, leaf, loop-and-comparison
procedure expands from 24 bytecode bytes to 32 bytes of native code plus a
4-byte literal-pool entry — 16 native instructions against 13 bytecode
opcodes (excluding the structural `LOOP` marker), a ~1.2× instruction-count
expansion and ~1.5× byte expansion, at the good end of the range above.
Caveat: this example has no `CALL` and never crosses the 4-register window
boundary, so it doesn't exercise §6's shuffle or §5's spill/fill at all —
see §16.

Translation throughput itself (JIT compiling the JIT, so to speak) should
land in the few-hundred-native-instructions-per-bytecode-instruction range
for a simple table-driven emitter — on a 48–133 MHz M0/M0+, that's
microseconds per instruction translated, i.e., low-single-digit
milliseconds to JIT-compile a modest few-hundred-byte procedure. Acceptable
for compile-on-first-call, assuming the arena/LRU sizing keeps eviction
relatively rare in practice.

---

## 15. Code-size estimate

Order of magnitude, `-Os`:

| Component | Rough size |
|---|---|
| Per-opcode-class emitters (arithmetic/comparison templated by ALU op; move/const; control flow; `CALL`) | 800–1500 lines C/C++ |
| Fixup pass (branch range, jump tables) | 150–300 lines |
| Runtime (dispatch, arena bump-alloc, LRU evict, compaction, init) | 300–500 lines |
| **Total** | **~1500–2500 lines**, plausibly **4–10 KB flash** |

Comparable in spirit to small threaded-code Forth kernels (famously 2–6 KB)
— this does more work per opcode than a threaded dispatcher, but the
opcode count and addressing-mode space are both small and heavily
templated, keeping the emitter itself compact.

---

## Appendix — Worked Example: `leb128_len`

Hand-translation of isa-core.md's own worked example (its Appendix),
`arg_count = 1` (`r0 = v`). Frame-relative `tos` starts at 1 (isa-core.md
§2.5) and — since this bytecode contains no `PUSH`/`POP` at all — never
moves for the whole procedure body. So per §5's formula, `phys(0) = r4`
(`v`) and `phys(1) = r5` (`n`) are fixed for the entire body: no window
rotation, no spill, no fill. This is the simple case; see §16 item 5 for
what it doesn't exercise.

```
                                    ; --- prologue (§6) — not in the bytecode ---
        MOVS  r4, r3                ; v's home (r4) = incoming last arg (acc)

                                    ; CONST #1 ; STORE 1
        MOVS  r3, #1                ; acc = 1
        MOVS  r5, r3                ; n (r5) = acc

L_cond:                             ; LOOP condition block
        MOVS  r3, r4                ; LOAD 0: acc = v
        CMP   r3, #0x80             ; GE_U #0x80 — fused (§10) with the
        BLO   L_exit                ; BLOCK_END below: v<0x80 (GE_U false) → exit

L_body:                             ; LOOP body block — falls through, no branch needed
        MOVS  r3, r4                ; LOAD 0: acc = v
        LSRS  r3, r3, #7            ; SHR #7: acc = v >> 7 (imm fits directly, §4.1 IMM_EXT)
        MOVS  r4, r3                ; STORE 0: v = acc
        MOVS  r3, #1                ; CONST #1
        ADDS  r3, r3, r5            ; ADD 1: acc = 1 + n
        MOVS  r5, r3                ; STORE 1: n = acc
        B     L_cond                ; BLOCK_END: back-edge

L_exit:
        MOVS  r3, r5                ; LOAD 1: acc = n (return value)
        LDR   r0, [r9, #dispatch_return_off]  ; RETURN (§7): reserved slot,
        BX    r0                              ; same table-base reg as CALL (§9)
```

16 native instructions (32 bytes) + one 4-byte reserved-slot reference
already amortized elsewhere (§7 — no per-procedure literal pool needed for
this), against 13 bytecode opcodes / 24 bytecode bytes (both counts
excluding the structural `LOOP` marker, which has no native emission of
its own). ~1.2× instruction-count expansion, ~1.3× byte expansion — the
good end of §14's range, as expected for a procedure with no spill and no
call.

**What this would have cost unfused (§10):** materializing `GE_U #0x80`'s
result as a real 0/1 in `acc` before testing it needs `CMP r3, #0x80` /
`BHS .t` / `MOVS r3, #0` / `B .d` / `.t: MOVS r3, #1` / `.d:` (5
instructions) followed by a separate `CMP r3, #0` / `BEQ L_exit` (2 more)
— 7 instructions where the fused form takes 2. The difference (5
instructions) recurs on every loop iteration here, which is why §10 treats
fusion as required rather than a nice-to-have optimization.

**With producer→`STORE` fusion (§10) also applied:**

```
                                    ; --- prologue (§6) — not in the bytecode ---
        MOVS  r4, r3                ; v's home (r4) = incoming last arg (acc)

                                    ; CONST #1 ; STORE 1 — fused
        MOVS  r5, #1                ; n (r5) = 1, directly — no acc round-trip

L_cond:                             ; LOOP condition block
        MOVS  r3, r4                ; LOAD 0: acc = v
        CMP   r3, #0x80             ; GE_U #0x80 — fused with the
        BLO   L_exit                ; BLOCK_END below, as before

L_body:                             ; LOOP body block
        MOVS  r3, r4                ; LOAD 0: acc = v — stays unfused; its
                                    ; own consumer (SHR) isn't a STORE
                                    ; SHR #7 ; STORE 0 — fused
        LSRS  r4, r3, #7            ; v (r4) = v >> 7, directly

        MOVS  r3, #1                ; CONST #1 — stays unfused; its own
                                    ; consumer (ADD) isn't a STORE either
                                    ; ADD 1 ; STORE 1 — fused
        ADDS  r5, r3, r5            ; n (r5) = 1 + n, directly
        B     L_cond                ; BLOCK_END: back-edge

L_exit:
        MOVS  r3, r5                ; LOAD 1: acc = n — stays unfused;
                                    ; RETURN's ABI needs the value in r3
        LDR   r0, [r9, #dispatch_return_off]  ; RETURN (§7), unchanged
        BX    r0
```

13 native instructions (26 bytes) + the same reserved-slot reference as
before — down from 16/32, and now at exact parity with the bytecode's own
13 opcodes rather than 1.2× over it (byte expansion drops to ~1.25×). Only
three of the seven candidate producer→consumer pairs actually fuse here
(`CONST`+`STORE`, `SHR`+`STORE`, `ADD`+`STORE`) — every `LOAD` in this
example stays unfused because its own very next consumer is an operand
read, not a `STORE`, which is exactly the case §10 notes as the mirror-image
sibling opportunity, not yet folded in here.

**Not exercised by this example** (§16 item 5): no `CALL`, so no instance
of §6's shuffle; `tos` never moves past 1, so no instance of §5's
spill/fill across the 4-register boundary, and so no instance of §10's
`acc_home` rotation-eviction fallback either. A second worked example
covering all three is the next thing worth hand-translating.

---

## 16. Open questions / risks

1. **§6's shuffle bound** — "three push/pop-multiple instructions cover any
   shuffle" needs a real case-by-case derivation, not just the plausibility
   argument given here. Worth prototyping before anything else in this doc.
2. **`validateProgram` max-call-depth** — not yet exposed (§2); needed to
   size the return-address stack from real data instead of a guess.
3. **Compaction vs. fixed helper calls** (§11) — per-call-site literal-pool
   address vs. shared helper-vector table vs. recompile-on-move; leaning
   toward the literal-pool form, not yet locked in. Patch-on-compact is
   likely off the table outright — flash/SRAM address separation on a
   typical MCU memory map plausibly puts a direct `BL` to a fixed helper
   out of `BL`'s ±4 MB range regardless of when it's patched.
4. **Thumb-bit hygiene** — every dispatch-table code pointer must have bit
   0 set (`BX`/`BLX` requirement); easy to get wrong once pointers are
   computed rather than link-time constants.
5. **No prototype yet, and one example isn't enough** — the Appendix's
   hand-translation of isa-core.md's `leb128_len` confirms §5's window
   formula, §10's comparison-branch and producer→`STORE` fusion rules, and
   §7's cheap `RETURN` path, but it's a leaf procedure with no `CALL` and a
   `tos` that never moves — it validates none of §6's shuffle, §8's
   pinning, §5's spill/fill across the 4-register boundary, or §10's
   `acc_home` rotation-eviction fallback. A second worked example that
   actually calls another procedure and pushes past 4 live values is the
   next real signal to get, before §6's open shuffle-bound question
   (item 1) can be settled with any confidence.
6. **Producer→`STORE` fusion's `acc_home` scheme (§10) is reasoned, not
   implemented or tested** — the soundness argument rests on "no
   instruction reads `acc` without overwriting or capturing it," checked
   by inspection of §4's opcode list here, not by a mechanical proof or a
   test that actually exercises the rotation-eviction fallback path. Worth
   a dedicated small test case (a producer immediately followed by a
   `STORE`, then enough `PUSH`es to rotate the aliased register out before
   the next real producer) once there's a translator to run it against.
   The mirror-image `LOAD`-into-operand fusion (§10's noted sibling) isn't
   designed in any more detail than the one paragraph mentioning it.
