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

**The block-nesting stack — one record per currently-open `BR_TABLE`/`LOOP`
in whichever procedure is presently being translated (§10, §16 item 7) — is
not one of the fixed regions above; it shares the arena itself, growing
from the opposite end.** Compiled code bump-allocates upward from the
arena's low address (as above); block-nesting records bump-allocate
downward from its high address. Neither gets an independent worst-case
reservation — the two meet wherever they meet, bounded only by how much of
each the procedure actually being translated needs, strictly tighter than
sizing either side from a fixed constant. When they meet, that's the same
trigger §9's evict-LRU-and-compact phase already exists for, just measuring
a different sum (code so far + open block records, not code alone) — see
§11 for what compaction additionally has to cover here, and §12 for the
failure path once nothing more is evictable.

Only sound because nothing a block record holds can be an absolute arena
address — every offset inside one (a jump-table base, a pending branch
fixup) has to be relative to the current procedure's own start, the same
position-independence §11 already requires of every emitted instruction.
Given that, compaction sliding the code region never invalidates anything a
still-open block record points at; the records themselves never move and
never need to.

---

## 3. Register assignment

| Reg(s) | Role |
|---|---|
| `r0` | `acc` |
| `r4–r7` | TOS window, circularly renamed (§5) |
| `r1–r3, r12` | scratch — instruction implementation, trampoline argument passing |
| `r8–r11` | table base pointers (dispatch table, arena/LRU metadata, helper vector — §11) |
| `sp` | operand/TOS spill stack (§2) — **never** the real C call stack while compiled code runs |
| `lr` | transient, `BLX`-scoped only |

`r8–r11` are addressed only via the
ARMv6-M "hi register" `ADD`/`MOV`/`CMP` forms, matching hardware reality:
those are the *only* three ops with a hi-register operand form on this
architecture.

**Why `acc` is `r0`, not (e.g.) `r3`.** AAPCS passes a native function's
first argument and its return value in `r0`. A single-argument helper
(§10's `CLZ`/`REVBITS`, and whatever else lands in §11's "helper vector")
can then be reached with a bare `BLX` — `acc` is already the argument
register going in and already the return register coming out, no `MOV` on
either side. This only pays for arity-1 helpers: this design never holds
more than one value "hot" in `acc`, so a hypothetical 2-argument helper
would still need a second operand shuffled from the window/spill stack
into `r1` regardless of which register hosts `acc`. It also only pays if
the helper is a true leaf with a zero-byte stack frame: `sp` here is the
operand spill stack, not a real call stack (see the `sp` row above), sized
with no slack for a helper's own transient frame — and since `lr` is
transient/`BLX`-scoped, a helper that itself calls something else has
nowhere to preserve `lr` but the stack, so "doesn't touch the stack" and
"is a leaf" are the same requirement here. Two ways to get there: gate the
helper's translation unit with `-Wstack-usage=0` promoted to a hard error
(`-Werror=stack-usage=`) — since GCC's only way to preserve `lr` across a
nested call is pushing it, a 0-byte report transitively proves leaf-ness
too, not just frame size — or, for something as small as `CLZ`/`REVBITS`,
hand-write it (`__attribute__((naked))` + inline Thumb), guaranteed by
construction rather than checked, matching how this project already
hand-writes its own Thumb encoder rather than trusting a compiler.
**Naming collision to watch for:** isa-core.md's own worked examples use
`r0`, `r1`, ... as *abstract* frame-relative slot names (`LOAD 0` reads
frame slot 0) — a different namespace from this section's *physical* ARM
`r0`, which now shares its name. Disambiguate explicitly ("isa-core's
`r0`" vs. plain `r0`) anywhere both could appear near each other — the
Appendix below is exactly such a spot.

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
in_window(k)  ⟺  tos − k ≤ 4
phys(k)       =  r7 − (k mod 4)          when in_window(k)
              =  spilled to SP stack     otherwise
```

`phys`'s cyclic direction is descending, not the ascending `r4 + (k mod
4)` this section originally guessed — chosen, once actually building the
`CALL` shuffle (§6), to make historical spill-stack reloads batchable at
all: it's what makes a real, already-emitted sequence of individual
chronological spills exactly equivalent to one hypothetical batched
`PUSH`, so a batched `POP` can read it back later (`jit-armv6m/prototype`'s
`window.ts`, own header comment, has the full argument). Direction aside,
the property that matters here is unchanged: `phys(k)` is a pure function
of `k` and current `tos` — **not** of push/pop history along whichever
control-flow path reached this point. That's what makes it context-free:
two `BR_TABLE` cases (or a `LOOP` back-edge) that reconverge at the same
`tos` always agree on `phys(k)` for every live `k`, with no cross-path
reconciliation needed.

**Spill/fill.** Pushing slot `k+4` evicts slot `k`'s current value from its
register to the spill stack — a real, `sp`-decrementing single-register
`PUSH` (not a fixed-offset store to a pre-reserved region — see §6's own
note on why `sp` has to genuinely move), before the register is
overwritten. Popping back down unconditionally reloads it (a real
`sp`-incrementing `POP`) — no liveness tracking, "unconditionally
recovered ... to keep the translator simple" per the brief. Correct but
leaves cheap dead-reload elimination on the table; deliberate trade, not
an oversight.

**`LOAD`/`STORE` (and register-mode arithmetic operands) work the same way
across the window boundary, not just `PUSH`/`POP`.** A slot that's fallen
out of window — any local that survives past `WINDOW_SIZE` more pushes,
`CALL` args among them (§6) — is still a completely ordinary reference;
`LOAD`/`STORE`/a `REG_ACC`/`REG_REG` operand just resolve to the spill
stack (`spillOffset`, below) instead of a register, one `LDR`/`STR`
against `sp` instead of zero. Not a separate mechanism from the
window's own spill/fill — the same "most recently spilled closest to
`sp`" addressing, just read directly instead of via a `PUSH`/`POP` pair.
Prototyped in `jit-armv6m/prototype` (`window.ts`'s `spillOffset`,
`translateProc.ts`'s `LOAD`/`STORE`/arithmetic-operand cases) once it
became clear `CALL`'s own `stackArgs ≥ WINDOW_SIZE` case needed exactly
this (§6) — genuinely general, not `CALL`-specific: any procedure with
more than `WINDOW_SIZE` concurrently-live locals hits it, no `CALL`
involved at all.

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

**The shuffle — worked derivation, resolving item 1 below.** Before `CALL`,
the caller's window is generally at some non-zero phase relative to what
the callee expects at `k=0`. Let `S = max(callee.arg_count − 1, 0)` (the
stack-passed argument count, isa-core.md §4.6) and `callerTos` be the
caller's own frame-relative `tos` right at the call. The caller's window
currently holds `w = min(callerTos, 4)` resident slots — some suffix of
which, `m = min(S, w)`, are exactly the *top* `m` stack args (the rest,
`w − m`, are the caller's own older locals that happen to still be
resident alongside them; any of the `S` args below the window's own
bottom edge are already spilled, at their own correct address, and never
need to move at all).

The brief's claim ("a sequence of three push/pop-multiple instructions can
implement any shuffle needed") **does not hold as stated, once actually
worked through** — real hardware `PUSH`/`POP` store/load in a *fixed
ascending-register-number* order, and that only coincides with
ascending-*k* order (which is what a spill address keyed on `k` needs)
when the window's own bottom already sits at phase 0 — precisely the case
with nothing to shuffle in the first place. Concretely: if the window
holds `k = 5,6,7,8` (wrapped once), `phys(k)` is `r5,r6,r7,r4` in that
order — register-ascending order visits them `r4(k=8), r5(k=5), r6(k=6),
r7(k=7)`, i.e. *k = 8,5,6,7* — not ascending in `k` at all. A single
`PUSH {r4-r7}` would silently write the wrong value to the wrong slot
address the moment the window has actually wrapped.

**What does hold**, and is what the prototype (`window.ts`'s
`spillForCall`/`fillCalleeArgs`/`reloadAfterCall`, exercised by
`jit-armv6m/prototype/test/call.test.ts` on real QEMU) actually
implements — two *different* orderings for two *different* consumers, not
one unified batching scheme:

1. **The caller's own non-argument locals** (`w − m` of them, if any are
   resident alongside the args) are handled by a fact simpler than
   "ordering": Thumb's `PUSH`/`POP` register-list is an arbitrary 8-bit
   mask, not required to be contiguous. If nothing touches a set of
   registers between a `PUSH{that set}` and a later `POP{that exact same
   set}`, the `POP` restores exactly what was pushed — trivially, by
   hardware's own inverse guarantee, regardless of `k`, wrap, or ordering
   entirely. So the whole leftover set spills in **one** `PUSH` (whatever
   mask it happens to be), and comes back in **one** mirrored `POP` of
   that identical mask, later, in `reloadAfterCall` — no per-`k` "natural
   order" reasoning needed at all, because it was never a reload keyed by
   `k` in the first place, just a round-trip forced by the callee's
   execution genuinely intervening (contrast `restoreWindow`'s block-exit
   case, item 5 below, where nothing intervenes and the same round-trip
   correctly reduces to *no* instructions).
2. **The stack-passed args** (`m = min(S, w)` of them) get a genuinely
   different treatment, because unlike the leftovers this *is* a remap:
   rather than coming back into their own registers, they're popped
   straight into the callee's canonical `phys(0)..phys(m-1)`. That
   consumer — one combined ascending-register `POP` — wants "smallest arg
   (`arg0`) closest to `sp`," which a batched `PUSH` can only deliver via
   (at most) two instructions when the arg range wraps (push the
   post-wrap/larger-arg run first, the pre-wrap/smaller-arg run — which
   includes `arg0` — second, so whichever executes second, landing lower,
   is the one `POP` will read first).

Net cost: 1 (leftovers, one mirrored `PUSH`, any mask) + at most 2 (args,
remap-batched) to spill, 1 to fill (`fillCalleeArgs`, if `S > 0`), and
symmetrically 1 (leftovers' mirrored `POP`) + up to `WINDOW_SIZE`
individual `POP`s for whatever's genuinely deeper than the leftover range
(spilled long before this call, via ordinary individual natural-order
spills, with no single `PUSH` to mirror) to restore the caller's own
window after the callee returns. Cheaper than the brief's own guess of
"3" in the common case (`argCount ≤ 1`, `S = 0`, costs *nothing* at all —
nothing to spill, nothing to fill, nothing deeper than a currently-live
window to reach into), and not fundamentally worse even at its most
adversarial. **Not** a hard requirement to hit "3" instructions exactly —
this was never about squeezing the count, only about whether the shuffle
is *correct at all* (item 1 below's real concern), and with this split it
is — verified by `call.test.ts`'s own adversarial case (phase-misaligned
args *and* surviving leftover locals, real QEMU) down to the actual
disassembly: the exact `PUSH{r5,r6}` / `POP{r5,r6}` pair this section
describes, hand-verified against the emitted machine code.

Two more pieces the brief's shuffle discussion doesn't mention at all,
found only once a real, multi-procedure `CALL` existed to expose them:

- A procedure whose own body contains a `CALL` clobbers its own `lr`
  (`BL` sets it) and must save/restore it around the nested call, exactly
  like any ordinary calling convention — a leaf procedure (no `CALL` in
  its own body) never needs to. Nothing in §2's register table or §7's
  return discussion calls this out; it's an unavoidable consequence of
  `lr` being "transient, `BLX`-scoped only" (§3) applying just as much to
  a procedure's *own* use of `BL` as to the dispatch mechanism reaching it.
- **`sp` must genuinely track current depth — no fixed per-procedure
  reservation.** An earlier draft of this section (and the prototype's
  own first implementation) assumed each procedure reserves a fixed
  `localPeak`-sized block via `SUB sp,#4·localPeak` on entry, addressing
  every spill at a constant offset from that unmoving base — plausible-
  looking, since it *does* keep frames from colliding (a callee's fixed
  block still lands below whatever the caller reserved). But §8.3
  computes the whole-program bound as a **maximum** over call sites and
  local peaks, explicitly **tighter than summing per-procedure maxima
  along the call chain** — and a fixed-reservation scheme's real footprint
  *is* that sum (each nested call's block stacks additively below the
  caller's), not the max. Only *reusing* the same storage as frames come
  and go achieves the tight bound — i.e., `sp` has to be a real, moving
  stack pointer: every ordinary spill a genuine `sp`-decrementing `PUSH`,
  every fill a genuine `sp`-incrementing `POP`, with nothing reserved up
  front. This is what makes `w − m` "natural order" and the shuffle's own
  batched `PUSH`es (item 2 above) land in the right place automatically —
  no separate "permanent vs. transient" storage concept needed anywhere:
  every spill, batched or not, is a real push, and a callee's own spills
  land strictly below whatever the caller had already pushed, purely
  because `sp` only ever moves further down under it, never sideways.

**`stackArgs ≥ WINDOW_SIZE` — resolved, and it turned out to be almost
free.** The shuffle above was originally described (and implemented) only
for `stackArgs ≤ WINDOW_SIZE` — a callee with more stack-passed arguments
than the window holds needs some of its own arguments addressable from
its very first instruction despite starting below the window, which needs
§5's spill-stack addressing to work for `LOAD`/`STORE` generally, not just
`PUSH`/`POP` at the window boundary (§5's own text now describes this).
Once that existed, `spillForCall`/`reloadAfterCall` needed no logic
changes at all — the "natural chronological ordering" invariant they
already rely on happens to produce exactly the right memory layout for a
callee's deep arguments for free. Two real bugs surfaced only by actually
building the concrete case (`jit-armv6m/prototype/test/deep-args.test.ts`,
real QEMU), both latent and unexercised by any prior test:

- `fillCalleeArgs` had an off-by-one — `stackArgs === WINDOW_SIZE` exactly
  already silently dropped argument 0 (`physReg(0)` and the callee's own
  acc-delivered last argument land on the *same* physical register,
  `physReg` being periodic mod `WINDOW_SIZE` — the callee's prologue write
  clobbers what `fillCalleeArgs` just placed there). Fixed by capping at
  `WINDOW_SIZE - 1`.
- Once genuinely deep arguments exist, `fillCalleeArgs`'s own naive single
  batched `POP` stopped being valid — the args needing register delivery
  no longer start at phase 0, so the range can wrap `physReg`'s cyclic
  boundary, and a combined pop across that wrap silently reassigns which
  value lands in which register. Needed the same "at most two batched
  `POP`s, larger-`k`-first" mechanism (`popRuns`) `restoreWindow`/
  `reloadAfterCall` already use for historical spilled data.
- `reloadAfterCall` assumed everything below the caller's own
  currently-resident window was unrelated leftover data the caller still
  needs post-call — true whenever `stackArgs ≤` that window (every test
  before this one), but not once `stackArgs` exceeds it: some of what's
  "deeper" was itself consumed as an argument, not surviving caller state,
  and reloading it anyway reads memory the callee's own epilogue had
  already reclaimed. Fixed by capping the historical-reload range at
  `targetTos`, not just the window's own bottom.

**Callee-side prologue.** The shuffle above is the *caller's* job. The
callee has its own, smaller obligation: isa-core.md §4.6's last argument
arrives in `acc`, not at its frame-relative home register `phys(argidx)`
— and nothing else in a procedure's own bytecode body guarantees `acc`
survives untouched until the first instruction that reads it (in the
Appendix worked example, `CONST #1` clobbers `acc` before `v` is ever read
back). Rather than an unconditionally-emitted copy instruction, this is
folded into §10.1's state machine as its own entry state — see §10.1's
"Callee-side prologue as a fold" — so a procedure whose first real
instruction reads the argument straight back (a common shape for small
procedures) pays nothing for it at all. (`acc` is `r0` — §3 — which is
also why this dovetails with AAPCS's own first-argument register for the
single-argument helper calls discussed there.)

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
- **`BR_TABLE`** — no `TBB`/`TBH` on ARMv6-M (Thumb-2 only). `N ≤ 2` (the
  overwhelming common case — `if`/`if-else`, isa-core.md §7.1) compiles to a
  plain `CMP` + conditional branch, no table at all. `N > 2` — prototyped,
  `jit-armv6m/prototype`'s `blocks.ts` (`openBrTableJump`/
  `emitBrTableHelper`), real QEMU (`test/br-table.test.ts`) — needs an
  actual literal-pool jump table plus computed `BX`, but not a per-call-site
  one: a single small dispatch routine, shared by every `BR_TABLE N>2` site
  in the same procedure, reached by `BL` with the call site's own table
  addressed relative to `lr` (the same "shared reserved routine" pattern
  §11 uses for `RETURN`/`CLZ`/`REVBITS`, here validated for computed jumps
  too). Table entries are clamped to `N` (one slot *past* the last real
  case), not `N - 1` — isa-core.md's own `acc ≥ N` behavior is "no case
  body runs at all, `acc` left untouched," not "re-run the last case,"
  which is what a naive `N`-entry clamp would silently do instead; the
  register holding the clamped index is deliberately never `acc` itself,
  so it survives the dispatch unmodified on both the in-range and
  out-of-range path. **A genuinely non-obvious ARMv6-M trap, caught only
  by tracing a real QEMU hang down to a live instruction trace:** `BL`
  always sets `lr` with bit 0 forced to 1 (the Thumb-mode marker a later
  `BX`/`POP{PC}` needs) — harmless for a branch target, since hardware
  strips it there, but reading `lr` into a general register for ordinary
  address arithmetic (this dispatch routine's whole mechanism) carries
  that bit straight into the computation. Left in place, it makes the
  *table lookup* address odd — `LDRH` needs an aligned address, and a
  Cortex-M0 with no real fault handler installed just hangs, not errors.
  Cleared for the lookup and *not* restored before the final `BX`, it makes
  the *jump target* even — `BX` reads bit 0 as an ARM/Thumb mode switch,
  not part of the address, so clearing it there flips the CPU into ARM
  mode and it starts decoding the same Thumb bytes as ARM instructions.
  Both failure modes look identical from the outside (a silent hang, no
  fault message) and only diverge once actually traced. Any future
  mechanism that reads `lr`/`pc` into a register for address math — §7's
  `dispatch_return`, §9's dispatch-table trampolines, anything computed
  relative to a return address rather than a literal pool — needs the same
  clear-for-arithmetic, restore-for-branching discipline.
- **`CLZ`/`REVBITS`** — no ARMv6-M instruction for either (`CLZ` is
  ARMv5T+Thumb-2; `RBIT` is ARMv7-M+). Both compile to a `BL` into a fixed
  software helper routine, not inline code. Real cost, but not a
  disadvantage vs. hand-written `-Os` C on the same core, which pays the
  identical software-emulation tax.
- **`MUL`** — native `MULS`, part of ARMv6-M baseline. Fine as-is.
- **No `DIV`/`MOD`** in the ISA (isa-core.md §4.1) — nothing to synthesize.

### 10.1 Local peephole combining: the `acc` state machine

The three fusions this design needs (comparison+branch, a producer folding
into a following `STORE`, and a producer folding a *preceding* value in as
its own operand) are one mechanism, not three — worth presenting as such
rather than as separate ad-hoc rules layered on top of each other. What
bounds it cleanly: **every ARMv6-M ALU-class instruction is strictly
binary** — two source operands, at most one free destination, no ternary
form — so the combining never needs to chain more than one bytecode
instruction deep in either direction. It resolves *at* the next
instruction, never several ahead.

**The state.** At any point in the walk, `acc`'s status is exactly one of:

- **`CLEAN(reg)`** — already sitting in a committed physical register
  (usually `r0`, sometimes an alias left by an earlier destination-fold).
- **`PENDING(shape)`** — not yet emitted; `shape` is `Imm(k)` (from
  `CONST`) or `Reg(r)` (from `LOAD` *or* `POP` — the same class, since
  both just mean "the value already sits in some resident physical
  register"; classifying by *result shape*, not opcode, is what keeps the
  table small).

**The transitions**, one bytecode instruction at a time:

| Current state | Next instruction | Action |
|---|---|---|
| `CLEAN` | a producer (`CONST`/`LOAD`/`POP`) | → `PENDING(shape)`; nothing emitted yet |
| `PENDING(shape)` | a compatible consumer (table below) | emit **one** instruction folding `shape` in as the left operand; peek one more token for a following `STORE` to fold as the destination too → `CLEAN(dest)` |
| `PENDING(shape)` | no match in the table | **flush**: emit `shape`'s trivial materialization into `r0` → `CLEAN(r0)`; reprocess the next instruction fresh |
| `CLEAN(reg)` | an ordinary consumer | emit normally, reading `reg`; still peek one token for a `STORE`-fold on the destination |

Worked example — `LOAD rN; ADD rM; STORE rD` (three bytecode ops) — both
slots fire on the same native instruction: `LOAD` → `PENDING(Reg(rN))`;
`ADD rM` folds `rN` in as the left operand *and* peeks `STORE rD` to fold
the destination → one instruction, `ADDS rD, rN, rM`.

Arithmetic's two write-back-in-place addressing modes — mode 2,
register-destination (`rN = acc ⟨op⟩ rN`), and mode 3, peek
(`[tos-1] = acc ⟨op⟩ [tos-1]`, isa-core.md §4.1) — are this exact same
destination-fold, just pre-supplied by the instruction's own combo instead
of needing the one-token peek at a following `STORE`: no new
native-encoding case (peek's destination is just `phys(tos-1)`, the same
window register a named `rN` would map to), and — per the acc-clobbering
convention discussed further below — both terminate the run exactly like a
`STORE`-fold would, `acc` included.

This also reframes comparison+branch fusion (ARMv6-M has no
compare-and-set instruction, so materializing a real 0/1 from a bare `CMP`
costs ~4–5 instructions on its own) as a *third*, more aggressive fold
axis rather than a special case bolted on separately: the destination
isn't redirected to a register at all, it's eliminated — a
`BLOCK_END`/`BR_TABLE` test consumes the flags `CMP` already set, so nothing
ever gets materialized. Three axes, one mechanism: fold a pending producer
in as an operand (front), fold a result's destination into a following
`STORE` (back), or skip materializing a comparison's result into any
register at all when a branch is the only consumer (back, zero-destination
case). Without the front-and-back folds, `if`/`while` conditions cost
several instructions more than assumed elsewhere in this doc — real enough
that leaving this out isn't a viable fallback design, only a
"how much" question. See the Appendix for the concrete instruction counts
across all four tiers (unfused, branch-fusion only, +destination-fold,
+operand-fold).

**Classification is by native-encoding shape, not opcode** — a handful of
consumer classes, and this is a hard ARMv6-M constraint, not a design
choice:

| Class | Examples | Folds a pending operand? | Folds a following `STORE`? |
|---|---|---|---|
| Commutative 3-op (reg-reg or reg-imm3) | `ADD` | yes, either shape, either side | yes |
| Order-sensitive 3-op, mirror available | comparisons | `Reg` always; `Imm` via a swapped relational op (see below) | no (branch-fused instead, or writes `acc` if not) |
| Order-sensitive 3-op, no mirror | `SUB` | `Reg` always; `Imm` only if `k=0` (`RSB`) | yes |
| Shift-by-*immediate* (3-op) | `SHL`/`SHR`/`ASR` imm form | `Reg` (as the shifted value) | yes |
| Destination-only, no own-value read | `NEG`, `NOT`, `SXH`/`SXB`/`UXH`/`UXB`/`REV`/`REV16`/`REVSH` | `Reg` | yes |
| 2-op in-place, no immediate form | `AND`, `EOR`/`XOR`, `ORR`, `MUL`, `BIC`, `ADC`, `SBC`, shift-by-*register* | never — Thumb-1's 2-operand encoding reads the destination field as an input too | never |

The bottom row is a genuinely different, worse failure mode than the
ordering question below if gotten wrong: retargeting one of those would
silently compute the wrong result immediately, not just risk a stale
value later — pending state must always flush before one of these,
without exception.

**The one real correctness wrinkle: operand order.** `PENDING(Reg(r))`
always folds safely into anything, regardless of the op — it's just
skipping a copy, `r` genuinely *is* what `acc` would hold, so the
operand's position in the encoding is unchanged. `PENDING(Imm(k))` is
where order can bite, and it's worth a concrete pair that looks symmetric
and isn't: `RSUB` (`operand − acc`) folds a pending `Imm(k)` cleanly via
Thumb's `SUBIMM` (`Rd = Rn − imm3`, exactly `operand − k`) — but `SUB`
(`acc − operand`, wanting `k − operand`) has no matching form at all in
Thumb-1 baseline (`RSB`'s only immediate is literal `0`) and must flush
unless `k` happens to be `0`. Comparisons get a way out `SUB` doesn't:
since all eight relational ops are independently available (isa-core.md
§4.2), "`k < rN`" can be recast as "`rN > k`" — same truth value, operand
and immediate now on the sides Thumb's `CMP Rn,#imm8` actually supports —
via a small, mechanical *swap* table (`LT_S`↔`GT_S`, `LE_S`↔`GE_S`,
`LT_U`↔`GT_U`, `LE_U`↔`GE_U`, `EQ`↔`EQ`, `NE`↔`NE`), the same kind of
table isa-core.md §7.3's complementary-comparison (a *negation*, not a
swap — a different transform, same mechanical flavor) already uses one
layer down, at lowering time rather than translation time.

**Why a one-token trigger stays sound with no lookahead past that.** This
does *not* follow from raw ISA physics — arithmetic's two write-back-in-place
addressing modes (isa-core.md §4.1: mode 2, `rN = acc ⟨op⟩ rN`; mode 3,
peek, `[tos-1] = acc ⟨op⟩ [tos-1]`) both read `acc` and, bit-for-bit, leave
it untouched; neither is a producer nor `STORE`/`PUSH`. Taken as a hardware
fact, a third reader downstream really could observe the same value. What
actually makes the run-length argument hold is a *declared* convention this
project's toolchain already commits to elsewhere, not a physical one:
rtl.ts's combo table marks every write-back-in-place combo — `REG_REG`
(mode 2) and `PEEK_PEEK` (mode 3) alike — as clobbering `acc`
(`clobbers: ["acc"]`, `PEEK_PEEK` also clobbering `"tos"`), and raise.ts's
`binary()` already acts on it verbatim (`this.acc = undefined // clobbered`
for the `REG_REG` case) when reconstructing structured code from flat
`RtlProc` bodies. So the rule this scheme leans on is "a write-back-in-place
op terminates an acc-reading run exactly like a producer would," by the
same contract raise.ts and the EAST-level fragment-combining logic
(builders.ts/orchestrator.ts) already rely on — not a from-scratch
inspection of §4. With that convention in hand, the real invariant isn't
"used at most once," but close enough to be just as useful: a run of zero
or more consecutive `STORE`/`PUSH` instructions can validly read the same
`acc` value, terminated by the next producer *or* a write-back-in-place op.
That bounds the danger enough to make a purely causal scheme
sound with no lookahead beyond the one-token fold/flush decision above:

- A second consecutive `STORE`/`PUSH` reading the same `acc` value just
  works, unmodified, since `CLEAN`'s `reg` already points at the value —
  no special-casing needed.
- **Looked like a remaining danger, resolved without needing a
  fallback.** §5's window rotation evicting the *specific* physical
  register a fused result now lives in, before a new producer ever
  supersedes it, seemed to need a rescue instruction — but worked through
  concretely (`jit-armv6m/prototype`'s `window.ts`, `test/rotation.test.ts`,
  real QEMU; §16 item 6), it isn't reachable the way first assumed.
  `accState` can only depend on the *exact* register a given `PUSH` is
  about to evict by directly referencing that same slot in the first
  place — nothing else currently maps to that register — which makes the
  value about to be pushed and the value about to be evicted provably
  identical: one `PUSH` away (a `LOAD`/destination-fold of the window's
  oldest slot immediately followed by a `PUSH`), not "enough consecutive
  `PUSH`es to rotate a slot out." The ordinary spill-then-flush a `PUSH`
  already emits handles it for free — the flush's destination and the
  dependency's register are the same one (`physReg(evictedByPush) ===
  physReg(tos)`, both reducing to the same `k mod WINDOW_SIZE`), so it's a
  same-register self-move that `materializeShape` already elides. No
  separate fallback, no extra instruction, nothing bolted onto rotation
  logic.

Not specific to this project's own `lower.ts` output either — it holds
against any bytecode that honors the acc-clobbering convention discussed
above (not yet statically enforced — §16 item 6), not just "well-behaved"
DSL-generated programs specifically.

**Callee-side prologue as a fold.** isa-core.md §4.6's last argument
arrives in `acc`, not at its frame-relative home register `phys(argidx)`
— and `phys(argidx)` itself currently holds stale data (whatever the
caller's shuffle left there, never overwritten, since the calling
convention routes this one argument through `acc` instead). Rather than
an unconditional `MOVS phys(argidx), r0` emitted before Pass 1 even
starts, a procedure with `arg_count ≥ 1` starts Pass 1 at `CLEAN(r0)` plus
one standing obligation — "`phys(argidx)` isn't populated yet" — resolved
by the same one-token machinery, plus one genuinely free case:

- **`LOAD argidx`** (or any acc-destination addressing mode reading
  `argidx`) as the next instruction is a true no-op: it's asking for
  exactly what `CLEAN(r0)` already holds, so nothing is emitted and the
  obligation is discharged for free. Common in practice — any small
  procedure that reads its last argument back near the top hits this.
- **A register-mode operand reference to `argidx`** (mode 1/2/3) is
  served by substituting `r0` for that one operand in the native
  encoding — but since these reads are non-consuming (the value stays
  live at that slot for later reads too, unlike `POP`), this does *not*
  discharge the obligation, only defers it past this one instruction.
- **Any other producer** forces the flush right there (`MOVS
  phys(argidx), r0`) before it overwrites `acc` — the same cost as the
  unconditional version, just possibly delayed by one token instead of
  paid upfront regardless of whether anything ever needed it.
- **Rotation eviction** is the same hazard as the ordinary case above,
  with `phys(argidx)`'s stale contents as the thing at risk instead of a
  fused result's — one more trigger for the same bolted-on
  force-a-flush-first fallback, not a new mechanism.

No lookahead deeper than the one token already in use anywhere else in
this scheme — the obligation just persists across the same
`STORE`/`PUSH`-shaped run already bounded above, rather than resolving
within a single step.

**Pass 2 — fixup.** Down to one job, not two, once actually built:
- *Branch range.* Thumb conditional branches are ±252 bytes (8-bit signed
  imm×2); a procedure whose basic blocks span further needs the standard
  invert-and-long-branch idiom any Thumb-1 assembler already uses. This is
  the same reason a fixup pass is needed at all, not just for
  procedure-external targets — still unprototyped.
- *Jump tables* — turned out **not** to need one. `BR_TABLE N>2`'s own
  table entries resolve exactly the same way ordinary branch targets
  already do (blocks.ts's header): each slot is a deferred fixup, patched
  the moment the corresponding case's `BLOCK_END` is reached in the single
  forward pass, never needing to have seen anything past that point. No
  case's final address needs to be known any earlier than an ordinary
  branch target already requires — see §10's own `BR_TABLE` entry above.

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

**A second, unrelated compaction extension, needed once the block-nesting
stack shares the arena with code (§2, §16 item 7):** the procedure whose
code is growing up against that stack is, by definition, not yet complete
— it has no dispatch-table entry yet, so it's invisible to compaction as
described above ("moves surviving procedures... updates the dispatch
table's `code_ptr` entries" only covers procedures already registered
there). Triggering compaction from that collision needs to relocate the
in-progress code too, and update the translator's own base-pointer/cursor
for it — mechanically identical to updating one more `code_ptr`, just one
that isn't in the table yet. The block-nesting records themselves need no
equivalent update (§2's own note on why).

---

## 12. Report / error model

`RESOURCE_ERROR` is a genuinely new failure mode this target introduces —
distinct from anything isa-core.md's own static guarantees (§9) cover.
Stack overflow shouldn't happen (§2's static regions are sized from
`validateProgram`'s own figures); the real runtime failure here is
specifically **arena exhaustion where a single procedure's code and its own
in-progress block-nesting stack (§2) don't together fit** even after
evicting everything evictable (§8) — e.g. one procedure larger than the
whole arena, or every evictable slot still too fragmented pre-compaction.
`TRAPPED` carries the ISA's own `TRAP #code` value unchanged.

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
  §10.1's fusion**; ~7 unfused |
| `CALL` | up to ~8 for the shuffle itself (§6's worked derivation: `1+≤2`
  spilling the caller's own resident window — one mirrored `PUSH` for any
  non-argument locals, at most two remap-`PUSH`es for the args — `+1`
  filling the callee's args, `+≤4` reloading the caller's own window once
  the callee returns — revised from this table's original ~2 guess, see
  §6/§16 item 1) plus table load + `BLX` + return handling; far less for
  the common
  `argCount ≤ 1` case, where the shuffle costs nothing at all |
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
procedure (14 bytecode opcodes / 24 bytes, excluding the structural `LOOP`
marker) comes in at 21 native instructions (42 bytes) with no fusion at
all, 16 (32 bytes) with just branch-fusion, 13 (26 bytes) once
destination-folding joins in, and 10 (20 bytes) with the full §10.1 scheme
— that last figure is *below* the bytecode's own instruction count and
byte size, not just "the good end of" some expansion range. Caveat: this
example has no `CALL` and never crosses the 4-register window boundary, so
it doesn't exercise §6's shuffle, §5's spill/fill, or §10.1's
rotation-eviction case at all — see §16.

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
`arg_count = 1` (isa-core's own abstract `r0 = v` — §3's naming-collision
note applies: this is *not* the physical ARM `r0` the code below assigns
to `acc`). Frame-relative `tos` starts at 1 (isa-core.md
§2.5) and — since this bytecode contains no `PUSH`/`POP` at all — never
moves for the whole procedure body. So per §5's formula, `phys(0) = r4`
(`v`) and `phys(1) = r5` (`n`) are fixed for the entire body: no window
rotation, no spill, no fill. This is the simple case; see §16 item 5 for
what it doesn't exercise.

The raw bytecode is 14 opcodes / 24 bytes (`CONST`, `STORE`, `LOAD`,
`GE_U`, `BLOCK_END`, `LOAD`, `SHR`, `STORE`, `CONST`, `ADD`, `STORE`,
`BLOCK_END`, `LOAD`, `RETURN` — excluding the structural `LOOP` marker,
which has no native emission of its own). Four tiers below, each strictly
subtracting one class of the naive translation's waste, land at 21, 16,
13, and 10 native instructions respectively.

**Tier 0 — no fusion at all.** Not worth a full listing, but worth stating
precisely as the honest baseline everything else is measured against:
materializing `GE_U #0x80`'s result as a real 0/1 costs `CMP` / `BHS .t` /
`MOVS r0,#0` / `B .d` / `.t: MOVS r0,#1` / `.d:` (5 instructions) followed
by a *separate* `CMP r0,#0` / `BEQ L_exit` to actually branch on it (2
more) — 7 instructions where §10.1's branch-fusion takes 2, and every
other bytecode op translates one-for-one with no folding at all. Total: 21
instructions (42 bytes) — prologue (1) plus 20 for the 14 bytecode ops
themselves (the `RETURN` and unfused-comparison-plus-test pairs each cost
more than one instruction). 1.5× instruction-count expansion, 1.75× byte
expansion.

**Tier 1 — comparison+branch fusion only** (§10.1's "zero-destination"
axis):

```
                                    ; --- prologue (§6) — not in the bytecode ---
        MOVS  r4, r0                ; v's home (r4) = incoming last arg (acc)

                                    ; CONST #1 ; STORE 1
        MOVS  r0, #1                ; acc = 1
        MOVS  r5, r0                ; n (r5) = acc

L_cond:                             ; LOOP condition block
        MOVS  r0, r4                ; LOAD 0: acc = v
        CMP   r0, #0x80             ; GE_U #0x80 — fused (§10.1) with the
        BLO   L_exit                ; BLOCK_END below: v<0x80 (GE_U false) → exit

L_body:                             ; LOOP body block — falls through, no branch needed
        MOVS  r0, r4                ; LOAD 0: acc = v
        LSRS  r0, r0, #7            ; SHR #7: acc = v >> 7 (imm fits directly, §4.1 IMM_EXT)
        MOVS  r4, r0                ; STORE 0: v = acc
        MOVS  r0, #1                ; CONST #1
        ADDS  r0, r0, r5            ; ADD 1: acc = 1 + n
        MOVS  r5, r0                ; STORE 1: n = acc
        B     L_cond                ; BLOCK_END: back-edge

L_exit:
        MOVS  r0, r5                ; LOAD 1: acc = n (return value)
        LDR   r1, [r9, #dispatch_return_off]  ; RETURN (§7): reserved slot,
        BX    r1                              ; same table-base reg as CALL (§9)
```

16 native instructions (32 bytes) + one 4-byte reserved-slot reference
already amortized elsewhere (§7 — no per-procedure literal pool needed for
this). 1.14× instruction-count expansion, 1.33× byte expansion over the
14/24 raw bytecode. The saved 5 instructions (7→2) recur on every loop
iteration here, which is why §10.1 treats this fusion as required rather
than a nice-to-have.

**Tier 2 — destination-fold also applied** (§10.1's "back" axis: a
producer's result redirected into a following `STORE` instead of a copy):

```
                                    ; --- prologue (§6) — not in the bytecode ---
        MOVS  r4, r0                ; v's home (r4) = incoming last arg (acc)

                                    ; CONST #1 ; STORE 1 — fused
        MOVS  r5, #1                ; n (r5) = 1, directly — no acc round-trip

L_cond:                             ; LOOP condition block
        MOVS  r0, r4                ; LOAD 0: acc = v
        CMP   r0, #0x80             ; GE_U #0x80 — fused with the
        BLO   L_exit                ; BLOCK_END below, as before

L_body:                             ; LOOP body block
        MOVS  r0, r4                ; LOAD 0: acc = v — stays unfused; its
                                    ; own consumer (SHR) isn't a STORE
                                    ; SHR #7 ; STORE 0 — fused
        LSRS  r4, r0, #7            ; v (r4) = v >> 7, directly

        MOVS  r0, #1                ; CONST #1 — stays unfused; its own
                                    ; consumer (ADD) isn't a STORE either
                                    ; ADD 1 ; STORE 1 — fused
        ADDS  r5, r0, r5            ; n (r5) = 1 + n, directly
        B     L_cond                ; BLOCK_END: back-edge

L_exit:
        MOVS  r0, r5                ; LOAD 1: acc = n — stays unfused;
                                    ; RETURN's ABI needs the value in r0
        LDR   r1, [r9, #dispatch_return_off]  ; RETURN (§7), unchanged
        BX    r1
```

13 native instructions (26 bytes) — already *below* the bytecode's own 14
opcodes, 1.08× byte expansion. Only three of the candidate
producer→consumer pairs fuse here (`CONST`+`STORE`, `SHR`+`STORE`,
`ADD`+`STORE`) — every `LOAD` in this tier stays unfused, because its very
next consumer reads it as an operand, not a `STORE`. That's exactly what
tier 3 picks up.

**Tier 3 — the full §10.1 state machine** (operand-fold joins
destination-fold — every `LOAD`'s `PENDING(Reg(...))` now gets folded
forward into whatever reads it, instead of being flushed into `r0` first):

```
                                    ; --- prologue (§6) — not in the bytecode ---
        MOVS  r4, r0                ; v's home (r4) = incoming last arg (acc)

                                    ; CONST #1 ; STORE 1 — fused (dest-fold)
        MOVS  r5, #1                ; n (r5) = 1, directly

L_cond:                             ; LOOP condition block
                                    ; LOAD 0 ; GE_U #0x80 ; BLOCK_END — all
                                    ; three fused: LOAD → PENDING(Reg(r4)),
                                    ; folded as CMP's left operand, then
                                    ; branch-fused as before — v never
                                    ; touches r0 at all
        CMP   r4, #0x80
        BLO   L_exit

L_body:                             ; LOOP body block
                                    ; LOAD 0 ; SHR #7 ; STORE 0 — all three
                                    ; fused: r4 folded in as SHR's source
                                    ; (operand-fold) *and* as its
                                    ; destination (dest-fold)
        LSRS  r4, r4, #7

                                    ; CONST #1 ; ADD 1 ; STORE 1 — all
                                    ; three fused: the pending #1 folds via
                                    ; Thumb's ADDIMM form directly (ADD is
                                    ; commutative, so which side the
                                    ; immediate came from doesn't matter),
                                    ; destination folds into n's own
                                    ; register too
        ADDS  r5, r5, #1
        B     L_cond                ; BLOCK_END: back-edge

L_exit:
                                    ; LOAD 1 — PENDING(Reg(r5)), but
                                    ; RETURN's ABI needs the value
                                    ; specifically in r0 (§7/§9, not a
                                    ; foldable destination) — flush
        MOVS  r0, r5
        LDR   r1, [r9, #dispatch_return_off]  ; RETURN (§7), unchanged
        BX    r1
```

10 native instructions (20 bytes) — *smaller*, by both measures, than the
bytecode it was translated from (14 opcodes / 24 bytes), while being
directly-executable machine code with no interpretation loop at all. 0.71×
instruction-count "expansion," 0.83× byte "expansion" — genuine
compression, not just a favorable ratio. Every fold that fires here is
exactly one of the three axes §10.1 names: destination-fold (`CONST`→`n`,
`SHR`→`v`, `ADD`→`n`), operand-fold (`LOAD`→`CMP`, `LOAD`→`SHR`,
`CONST`→`ADD`), and the mandatory zero-destination branch-fusion
(`GE_U`+`BLOCK_END`) — nothing here needed a chain deeper than the single
bytecode instruction on either side, confirming §10.1's claim that the
binary-op ceiling bounds this cleanly.

**Not exercised by this example** (§16 item 5): no `CALL`, so no instance
of §6's shuffle; `tos` never moves past 1, so no instance of §5's
spill/fill across the 4-register boundary, and so no instance of §10.1's
rotation-eviction case either. `jit-armv6m/prototype/test/call.test.ts` and
`test/rotation.test.ts` since covered all three, on real hardware rather
than by hand-translation — see §16 items 5/6.

---

## 16. Open questions / risks

1. **§6's shuffle bound — resolved, prototyped.** Not "3 push/pop-multiple
   instructions" as guessed, but not simply "wrong" either — real hardware
   `PUSH`/`POP` takes an arbitrary register-list mask (not required to be
   contiguous), and that mask means two genuinely different things for two
   genuinely different consumers here. The caller's own non-argument
   locals (if any) only ever need to come back into their *own* registers
   unchanged, so a `PUSH{whatever mask}` followed, later, by a `POP{that
   identical mask}` restores them correctly regardless of `k` or wrap —
   hardware's own inverse guarantee, not a "natural order" argument at
   all: **one** `PUSH` to spill them, **one** mirrored `POP` to bring them
   back. The stack-passed args are a real remap (into the callee's own
   canonical registers, not their own), which is where "ascending register
   ⟺ ascending address" actually bites: at most 2 `PUSH`es (push the
   larger-arg/post-wrap run first, the smaller-arg/pre-wrap run second, so
   `arg0` lands closest to `sp`), one combined `POP` to fill the callee.
   Net: `1 + ≤2` to spill, `1` to fill, `1 + ≤4` to reload the caller's own
   window after the callee returns (the `≤4` part is whatever's genuinely
   deeper than the leftover range — spilled long before this call, with no
   single `PUSH` to mirror, so that part alone stays individual) —
   correct unconditionally, and cheaper whenever fewer slots are actually
   live or fewer args are stack-passed.
   Also surfaced, only once a real multi-argument `CALL` existed to expose
   them: a procedure containing its own `CALL` must save/restore its own
   `lr` around it (§6's shuffle discussion said nothing about this); the
   callee-side prologue's target register was `phys(0)` instead of
   `phys(argCount-1)` (indistinguishable in every single-argument-only
   test that existed before this); and `sp` needs to be a genuinely
   moving stack pointer, not a fixed per-procedure reservation, to match
   §8.3's own max-based (not sum-based) whole-program sizing — see §6's
   own note on all three. Implemented in `jit-armv6m/prototype`
   (`window.ts`'s `spillForCall`/`fillCalleeArgs`/`reloadAfterCall`,
   `translateProc.ts`'s `CALL` case, `program.ts`'s whole-program linking)
   and verified on real `qemu-system-arm` by `test/call.test.ts`, including
   the case this item's own worry is actually about: a phase-misaligned
   shuffle (args landing at a non-zero window phase) with non-argument
   locals resident in the same 4-register window that must survive the
   call untouched. Extended since to `stackArgs ≥ WINDOW_SIZE` too — see
   §6's own "resolved, and it turned out to be almost free" note and
   `test/deep-args.test.ts`.
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
5. **Partially resolved.** The Appendix's hand-translation of isa-core.md's
   `leb128_len` confirms §5's window formula and §10.1's fusion state
   machine (all three axes — see the Appendix's tier 3) plus §7's cheap
   `RETURN` path, but it's a leaf procedure with no `CALL` and a `tos`
   that never moves. `jit-armv6m/prototype/test/call.test.ts` is the
   second worked example this item asked for — a real `CALL` (3
   arguments, 2 stack-passed) with a deliberately phase-misaligned window
   and non-argument locals resident alongside the args, verified on real
   `qemu-system-arm` — and it's what let item 1's shuffle-bound question
   actually get settled (see item 1). `jit-armv6m/prototype/test/rotation.test.ts`
   subsequently covered §10.1's rotation-eviction case too — see item 6.
   Still not covered by any prototype: §8's pinning and §9's dispatch
   table/eviction (this prototype deliberately has neither — see
   jit-armv6m/prototype's own scope notes, `translateProc.ts`'s header).
6. **§10.1's `CLEAN`/`PENDING` state machine is reasoned, and two of its
   corners are now implemented and tested — the acc-liveness enforcement
   half is still open.** The soundness argument rests on "every
   op either overwrites `acc`, is a pure capture (`STORE`/`PUSH`), or is a
   write-back-in-place combo (`REG_REG`/`PEEK_PEEK`), which is declared
   (not physically forced) to clobber `acc` the same way." That declaration
   already exists and is already load-bearing elsewhere — rtl.ts's combo
   table (`REG_REG`/`PEEK_PEEK`: `clobbers: ["acc", ...]`) and raise.ts's
   `binary()` (`this.acc = undefined // clobbered`) — but nothing enforces
   it as a static guarantee today: `validate.ts`'s §8 checks (TOS balance,
   call-graph acyclicity, stack-depth, dead code, header/block
   well-formedness) have no `acc`-liveness pass, and `vm.ts`'s interpreter
   doesn't poison `acc` after a `REG_REG`/`PEEK_PEEK` write the way
   raise.ts does — so a hand-crafted program that violates the convention
   would silently compute the bit-accurate-by-luck answer under `vm.ts`
   rather than get caught. Still worth closing before a real translator
   leans on it: a `validate.ts` acc-liveness check (structurally similar to
   its existing per-procedure walk) plus matching `vm.ts` poisoning, with
   test cases for both.

   The rotation-eviction corner *has* now been built and worked through
   (`jit-armv6m/prototype`'s `window.ts`, `test/rotation.test.ts`, real
   QEMU) — see §10.1's own updated account. It turned out not to need the
   rescue instruction originally envisioned: the hazard is only reachable
   one `PUSH` away from a direct reference to the window's oldest slot (a
   `LOAD` or a destination-fold `STORE` of exactly that slot, immediately
   followed by a `PUSH`), not "enough consecutive `PUSH`es to rotate a slot
   out" as first framed here — and in that exact case the value being
   pushed and the value being evicted are provably identical, so the
   ordinary spill-then-flush already emitted handles it for free (a
   same-register self-move, elided by `materializeShape`). Both fold shapes
   that can reach it (`LOAD`'s operand-fold, a `STORE`'s destination-fold)
   are covered by `test/rotation.test.ts`'s two cases.

   A second, genuinely distinct gap in the same state machine surfaced
   while building `BR_TABLE N>2` (§10, §16 item 1's own extension): a
   `case` boundary (any `BR_TABLE`, `N ≤ 2` or `N > 2` alike) is a
   control-flow *merge* point, but `accState` is one linear,
   compile-time-sequential belief threaded through a single forward pass.
   A value left `PENDING` at the end of one case — never itself read again
   within that case, e.g. a bare `CONST` immediately followed by
   `BLOCK_END`, as a `switch`-like construct that just returns a per-case
   constant would produce — survived past that case's own close and got
   silently overwritten by the *next* case's own translation, so whatever
   the merged code read afterward ended up being the *last* case's value,
   never whichever case actually ran. Unexercised by every prior test
   (including `call.test.ts`/`rotation.test.ts`), since nothing in that
   corpus ever left a value pending across a case boundary specifically.
   Fixed by flushing `accState` unconditionally at every case boundary
   (`blocks.ts`'s `closeBlockEnd`, `accstate.ts`'s new `flushLive` — a
   no-op when already `CLEAN`, and safe to call when `POISONED` too,
   unlike a bare `flush`) — cheap when nothing was actually left pending,
   the real cost paid only in the exact case that needed it.
   `LOOP`'s own back-edge is structurally the same kind of merge (initial
   fall-through vs. the body's back-edge reconverging on one, shared,
   already-emitted condition block) and wasn't audited for the identical
   risk — every existing loop condition happens to start with a fresh
   producer of its own, which sidesteps it by construction, but that's an
   empirical property of the current corpus, not a guarantee.

   The consumer-class table (§10.1) is also reasoned per-op by hand, not
   derived mechanically from armv6.h's own encoder signatures — worth
   cross-checking the two now that a translator exists, since a
   transcription error there would silently misclassify one op's
   foldability rather than fail loudly.
7. **Block-nesting stack — resolved, no new mechanism needed.** Auditing
   every piece of translator-owned state that survives across the single
   forward pass (window.ts's `tos`, accstate.ts's `AccState`, blocks.ts's
   `BlockStack`) against §2's no-heap, fixed-region model found exactly one
   structure whose size isn't already a compile-time constant or a value
   computed once from `validateProgram`: `BlockStack.frames`, sized by
   however deeply `BR_TABLE`/`LOOP` happen to nest in a given procedure — a
   figure nothing in `@ppl/machine` computes today (checked directly:
   neither `validate.ts` nor `vm.ts` tracks block-nesting depth anywhere;
   `vm.ts`'s own `ctrl: BlockFrame[]` is itself an unbounded array,
   harmless only because it's host-side JS).

   Closing it needed two independent pieces. First, every `Frame` variant
   has to actually be fixed-size — not true as prototyped today:
   `openBrTableJump`'s `case` frame holds a `table.fixups: number[]` and an
   `endFixups: number[]`, both sized by the switch's own arity `N`. The
   first is redundant outright (slot `i`'s offset is `base + i*2`,
   arithmetically derivable, no array needed); the second genuinely can't
   be computed, since each case body is a different length, but doesn't
   need an array either — the standard backpatch-chain technique (thread
   pending sites through their own placeholder branches' displacement
   fields, one `number | null` "last pending site" instead of a list) turns
   it into the same O(1) shape as everything else. Same fix applies to
   `BlockStack.brTableHelperSites`, since every site it holds resolves to
   the identical single target. None of this is implemented in
   `jit-armv6m/prototype` yet — found by design review, not yet built or
   tested.

   Second, and this is the part that avoids needing any new
   `validateProgram` figure at all: rather than sizing `BlockStack.frames`
   from a hard-coded compile-time constant (workable, but wastes space or
   rejects otherwise-valid programs depending which way the constant is
   picked, unlike the tight, program-derived bounds the other two static
   regions in §2 get), it shares the arena itself with compiled code,
   growing from the opposite end — see §2's own account, and §11's note on
   the one compaction extension it needs. Meeting in the middle is the
   exact same trigger, and the exact same `RESOURCE_ERROR` failure path
   (§12), that arena exhaustion already needed; §8's pinning still applies
   unchanged (exactly one procedure — the current call chain's top — is
   ever unevictable, so the true floor is that pinned caller's code plus
   whatever the one in-progress callee needs, not literally nothing else).
