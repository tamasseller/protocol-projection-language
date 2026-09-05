# Generic Core ISA

> **Status:** normative spec, the *what*. Rationale for the non-obvious
> choices: [isa-rationale.md](./isa-rationale.md). What the machine is for:
> [applications.md](./applications.md). §11 specifies how a
> domain extension plugs into the core: the opcode space it owns (§5.1),
> and what it must declare about its own opcodes to keep §8's guarantees
> intact. What a concrete extension's opcodes *do* is specified separately
> (the codec extension: `docs/codec-extension.md`).

---

## 1. Overview

The Generic Core is a small, statically analyzable instruction set for a
TOS-hybrid accumulator machine.

- **Portable.** A procedure is a byte blob any conforming target can
  AOT-compile, JIT-evaluate, or interpret, microcontrollers included.
- **Compact.** On-wire procedure size is the overriding metric; backend
  execution cost is not a constraint.
- **Statically analyzable.** Stack depth, call-graph termination and
  resource footprint are all computable ahead of execution.
- **Zero-allocation.** No instruction allocates; all storage is statically
  bounded.
- **Extensible.** The upper half of the opcode space belongs to a domain
  extension (§5.1). The extension declares each opcode's stack effect
  (§11.2), so the validator and VM prove every §8 guarantee over programs
  using them while staying ignorant of what they do.

The core contains no domain-specific concepts. A program is a **procedure
table**: an indexed array of procedures, each a fixed header plus an
instruction body. The machine has one accumulator (`acc`), one register
file indexed from zero, and one TOS pointer indirecting into that same
register file. Control flow is fully structured: two block constructs
(`BR_TABLE`, and a loop in a pre-test and a post-test form) and two
terminators (`RETURN`, `TRAP`) cover everything the source DSL can express.
There are no arbitrary jumps, and no `break`/`continue` naming a loop.

---

## 2. Abstract Machine

### 2.1 Values

The only value type is the **word**: a 32-bit pattern, read as unsigned or
signed per operation. A **boolean** is the word `0` or `1`. Control flow
uses the **lenient test**: any non-zero word means "true"/"continue", so a
comparison result, a plain count or a tag drives a branch with no
normalization step.

### 2.2 Storage

| Storage | Description |
|---|---|
| **`acc`** | Accumulator. Implicit operand 1 of every binary/comparison op; implicit source or destination of most others. |
| **Register file** | Logical array `r0, r1, r2, …`, word-sized, indexed from 0. Holds locals and intermediates. No fixed upper bound; the backend maps indices to physical storage. |
| **TOS pointer** | A logical index into the *same* register file, giving indirect push/pop/peek access (§2.4). There is no separate operand stack. |

A **frame** (§2.5) is the region of the register file owned by one
procedure invocation. Register indices in instructions are frame-relative.

### 2.3 Programs

```
procedure = header + body
header    = { arg_count, ...extension fields }
body      = instruction*
```

`arg_count` is the number of value arguments, visible as
`r0..r(arg_count-1)` in the procedure's frame. The body must end in a
terminator (`RETURN` or `TRAP`); falling off the end is a validation
error. `CALL` (§4.6) references procedures by a literal index into the
procedure table. There is no indirect call.

### 2.4 TOS pointer

| Mode | Notation | Effect | Capability |
|---|---|---|---|
| Push | `[tos++]` | write `r[tos]`, then `tos += 1` | write-only |
| Pop | `[--tos]` | `tos -= 1`, then read `r[tos]` | read-only |
| Peek | `[tos-1]` | read/write `r[tos-1]`, `tos` unchanged | read-write |

TOS indexes the register file directly, so a pushed value is later
readable by its register index, and a register at the current TOS can be
pushed/popped/peeked. TOS is per-frame: every invocation gets its own
entry point (§2.5). Referencing a register by index outside push/pop/peek
requires TOS to have grown past it, checked statically (§8.6).

### 2.5 Frames

A procedure's frame starts at frame base `F`:

```
r0 .. r(N-1)   : arguments   (N = arg_count)
rN ..          : local scratch, TOS starts here
```

Caller and callee frames are disjoint; a procedure never addresses storage
outside its own frame. §6 gives the exact frame-base computation across a
`CALL`.

### 2.6 Static guarantees

Every valid program satisfies:

1. **TOS balance.** Every block and every procedure body exits at the TOS
   depth it entered with (§8.1).
2. **Bounded stack depth.** The call graph's worst-case register-file depth
   is statically computable (§8.3); runtime stack overflow is impossible.
3. **Acyclic calls.** The call graph over literal procedure indices has no
   cycles (§8.2). How the authoring layer ensures this is out of scope; the
   IR is accepted or rejected on the property alone.
4. **No heap allocation.**

---

## 3. Addressing Modes

An addressing mode says where an instruction's second operand (the one
that isn't `acc`) comes from, and where the result goes.

| Mode | Operand source | Can read? | Can write? |
|---|---|---|---|
| Register | `rN` | yes | yes |
| Peek | `[tos-1]` | yes | yes |
| Pop | `[--tos]` | yes | no |
| Push | `[tos++]` | no | yes (result only) |
| Immediate | inline or trailing literal | yes | no |

Read-only modes (pop, immediate) and the write-only mode (push) force the
result destination, so semantically invalid pairings are unencodable. Each
instruction class (§4) lists exactly which mode × destination combinations
it supports; arithmetic, comparison and move each support a different
subset (isa-rationale.md).

---

## 4. Instruction Reference

### 4.1 Arithmetic (binary-class)

Ten operations, all sign-agnostic unless noted, all
`result = acc ⟨op⟩ operand`:

| Op | Semantics |
|---|---|
| `ADD` | `acc + operand` |
| `SUB` | `acc − operand` |
| `RSUB` | `operand − acc` |
| `MUL` | `(acc × operand) mod 2³²` |
| `AND` / `OR` / `XOR` | bitwise |
| `SHL` | left shift, vacated bits zero |
| `SHR` | logical right shift, vacated bits zero (unsigned) |
| `ASR` | arithmetic right shift, vacated bits sign-filled (signed) |

`SHL`/`SHR`/`ASR` take the shift amount as the operand. Amounts `0..31`
behave as described above; **for any other amount the result is an
unspecified 32-bit value.** Unspecified is not undefined: the operation
still produces some value, traps nothing, touches no other state, and
never licenses a projection to reason backwards about what the amount
could have been. Which value it is varies by projection — a projection
lowering to a host `<<` gets the host's own masking, one lowering to
ARMv6-M's register-form shift gets `Rm[7:0]`, and a constant-folded shift
may differ from the same shift performed at run time. A program that must
work for an unbounded amount masks it itself (`AND #31`).

The immediate combo carries the amount as a literal, so the whole
compile-time half of that class is a validator error rather than a silent
divergence: `SHL`/`SHR`/`ASR` in the immediate combo require `0 <= imm <=
31`. Only the register, peek and pop combos can reach the unspecified
case.

Rationale: 5-bit masking is what most targets do for free (x86 masks `CL`
to five bits, AArch64 `LSLV` and RISC-V mask likewise, as does a JS `<<`),
but ARMv6-M's register-form shift reads `Rm[7:0]`, and Thumb-1 has no
AND-immediate — so guaranteeing the masked result there costs two extra
instructions on every dynamic shift, to define a case no real codec
depends on. See jit-armv6m/docs/fuzzing-campaign.md finding 5.

There is no `DIV`/`MOD`: division essentially never appears in codec
arithmetic and many microcontrollers lack hardware support, so a program
needing it calls a software helper procedure.

Five addressing combinations, identical across all ten ops:

| # | Mode | Operand | Result | Example (`ADD`) |
|---|---|---|---|---|
| 1 | register | `rN` | `acc` | `acc = acc + rN` |
| 2 | register | `rN` | `rN` | `rN = acc + rN` |
| 3 | peek | `[tos-1]` | `[tos-1]` | `[tos-1] = acc + [tos-1]` |
| 4 | pop | `[--tos]` | `acc` | `acc = acc + [--tos]` |
| 5 | immediate (extended only) | trailing LEB128 | `acc` | `acc = acc + imm` |

State count: 10 ops × 5 modes = **50 states**.

### 4.2 Comparison-class

Ten operations, result always a boolean in `acc`:

| Op | Semantics |
|---|---|
| `EQ` / `NE` | bit-pattern equal / unequal |
| `LT_S` / `LE_S` / `GT_S` / `GE_S` | signed relational |
| `LT_U` / `LE_U` / `GT_U` / `GE_U` | unsigned relational |

All eight relational comparisons encode directly; `GT`/`GE` are never
derived from `LT`/`LE` by branch inversion.

Four addressing combinations, result always to `acc`:

| # | Mode | Operand | Example (`LT_S`) |
|---|---|---|---|
| 1 | register | `rN` | `acc = (acc < rN)` |
| 2 | pop | `[--tos]` | `acc = (acc < [--tos])` |
| 3 | immediate, small | `#0` only | `acc = (acc < 0)` |
| 4 | immediate, extended | trailing LEB128 | `acc = (acc < imm)` |

State count: 10 ops × 4 modes = **40 states**. The small-immediate form is
zero-only, covering zero-test and sign-test in one byte; every other
comparison constant uses the extended form.

### 4.3 Unary-class

Operate on `acc` in place, no addressing-mode bits:

| Op | Semantics |
|---|---|
| `NEG` | two's-complement negation |
| `NOT` | bitwise complement |
| `SXTB` / `SXTH` | sign-extend the low 8 / 16 bits to 32 |
| `UXTB` / `UXTH` | zero-extend the low 8 / 16 bits to 32 |

Two more reach acc the same way but encode through §5.3's `MISC_UNARY`
escape rather than a dedicated code, so they cost two bytes each:

| Op | Sub-code | Semantics |
|---|---|---|
| `REVBITS` | `0` | reverse bit order (32-bit width) |
| `CLZ` | `1` | count leading zeros (0-32) |

`CTZ` has no op at all: `CTZ(x) = CLZ(REVBITS(x))`.

The four extend ops exist for the narrow integer types (§2.1's word is the
only *storage* type; a narrow type is a word constrained to a range). A
narrow variable always holds an already-extended word, so the extend happens
where a value is written into one, never where one is read. Each also
subsumes a two-instruction composite — `SHL #24; ASR #24`, or `AND #0xff` —
at a quarter of the bytes, which is why they are ops rather than an
idiom.

### 4.4 Move-class

Plain data movement, no ALU combining, for the *unfused* case. An
arithmetic op that also needs a register operand uses its own register-mode
combo (§4.1 #1/#2) and needs no `LOAD` first.

| Op | Effect | Trailing |
|---|---|---|
| `PUSH` | `[tos++] = acc` | none |
| `LOAD` | `acc = rN` | LEB128 register index |
| `STORE` | `rN = acc` | LEB128 register index |
| `CONST #k` (small) | `acc = k`, `k ∈ 0..15` | none (`k` inline in opcode) |
| `CONST #imm` (extended) | `acc = imm` | LEB128 `u32` |
| `DROP #n` (small) | `tos -= n`, `n ∈ 1..4` | none (`n` inline in the sub-code) |
| `DROP #n` (extended) | `tos -= n`, `n ≥ 5` | LEB128 `n − 5` |

`PUSH` is how a call's non-last arguments (§4.6, §6) and expression
temporaries reach the stack; §4.1 has no push-mode combo of its own.
`CONST` is the only way to get an arbitrary constant into `acc`.

There is no single-value `POP`: every stack operand is consumed by the combo
that reads it (§4.1's `POP_ACC`). `DROP #n` is not that. It is for a *scope*
that ends where no block boundary does — a `for` init's declarations, a bare
`{ … }` — reclaiming `n` slots at once, reading nothing and leaving `acc`
alone. It may not cross the enclosing block's entry depth (§8.1). `DROP #0`
has no encoding at all: it would be a no-op.

### 4.5 Control-flow ops

Three block openers, one universal closer, two case closers, two
terminators. No operand carries a branch offset; every target follows from
static block nesting.

**`BR_TABLE N`** opens **N+1** blocks and dispatches on `acc`: `acc < N`
executes `case[acc]`, and any other value executes `case[N]`, the **default
case**. Every value of acc therefore selects a case, so the dispatch is
total — there is no edge that skips the construct, and a value can cross
the merge (§8.7). `N` is a literal case count, at least 1; `BR_TABLE 0`
would be a single always-taken block — a scoped block, not a branch — and
has no encoding at all (§5.2). `if`/`if-else`/ternary/`switch` all lower to
this (§7.1).

The index is exact below `N` and lenient at or above it, which makes
`BR_TABLE 1` a **truthy** two-way test: `acc = 0` takes `case[0]`, anything
else takes `case[1]`. That is the convention a loop's condition block uses
too (§7.2), so a comparison never has to be normalized to 0/1 before a
dispatch, and it is the one dispatch shape the whole DSL needs apart from
`switch`.

**`FALLTHROUGH`** closes a dispatch case by continuing into the **next
case's body** instead of leaving the construct. It resets TOS to the block's
entry depth exactly as `BLOCK_END` does (§8.1), and like every case entry
the case it continues into starts with acc dead. It is valid only as a
dispatch case's closer — never a loop sub-block's — and never on `case[N]`,
which has nothing to continue into. This is what C's `case 0: case 1: X`
needs: the empty label's case is a lone `FALLTHROUGH`, and so is any case
whose body runs on into the next.

**`DEFAULT`** closes a dispatch case by continuing into that same dispatch's
**default case** (`case[N]`), wherever it sits. It resets TOS exactly as
`BLOCK_END` does, and the default case it enters starts with acc dead like
any case entry. Valid only as a dispatch case's closer — never a loop
sub-block's — and never on `case[N]` itself, which is already the default.
Two things need it: a gap inside a `switch` span, which C sends to
`default:` and which would otherwise cost a copy of the whole clause, and a
case that falls through into a `default:` written after it (§7.1).

**`LOOP_PRE`** and **`LOOP_POST`** each open **two** nested sub-blocks in
fixed order, each closed by its own `BLOCK_END`:

```
LOOP_PRE                 ; entry jumps over the body, to the condition
  <body block>
BLOCK_END                ; unconditional continue into the condition
  <condition block>      ; leaves a continue/exit decision in acc
BLOCK_END                ; acc≠0 → back-edge to the body; acc=0 → exit
```

Body first, condition second: that is *emission* order, not execution
order. The two openers differ in exactly one thing — `LOOP_PRE` enters at
the condition, so zero body iterations is possible (C's `while`/`for`);
`LOOP_POST` enters at the body, so at least one always runs (C's
`do`/`while`). Ordering the sub-blocks this way is what makes that a
one-bit distinction, and what lets a straight-line backend emit the rotated
shape — one taken branch per iteration instead of two — without buffering
the condition in order to move it.

**`BLOCK_END`** closes the innermost open block, leaving the construct. Its
meaning depends on what it closes: unconditional jump to the merge for a
`BR_TABLE` case, unconditional continue into the condition for a loop's
body block, conditional back-edge-or-exit for a loop's condition block. One
opcode, three meanings, disambiguated purely by block nesting.

**`RETURN`** ends the procedure; `acc` is the return value, if the procedure
establishes one at all (§8.7); the frame is popped.

**`TRAP #code`** ends the procedure abnormally with an opaque error code
(`0` is unreachable/panic by convention; the rest of the space is
host-defined). Both terminators exit the procedure: no `BLOCK_END` after
either is needed or valid, and no instruction may follow one within the
same block (§8.4).

There is no `break`, `continue` or other in-procedure re-target, and
`DEFAULT` is not one: it names its own dispatch's last case, not an
arbitrary block. The only early way out of a running loop is a terminator
reached from inside it, or the condition block testing false on a later
iteration.

### 4.6 Procedure invocation

**`CALL proc_idx`** invokes `procedure[proc_idx]`. Let
`N = procedure[proc_idx].arg_count`. The caller pushes (via `PUSH`, §4.4)
the first `N-1` arguments in order; the *last* argument (if `N ≥ 1`) stays
in `acc`, which the call clobbers anyway with the return value. Together
these become `r0..r(N-1)` in the callee's frame (§6). The return value
comes back in `acc`; the caller's TOS rewinds to discard the pushed
argument block on return.

A corollary worth stating outright, because it decides whether the most
trivial imaginable procedure is legal: **a procedure with `N = 0` begins
with acc not live.** Nothing establishes it — there is no last argument, and
nothing a caller left in acc survives a call (isa-rationale.md). So
`arg_count 0` with body `[RETURN]` is a *validation error* (§8.7), not a
procedure returning some unspecified value; the trivial procedure is
`[CONST #x, RETURN]`. Two conforming implementations disagreed on that
unspecified value in practice — one seeded 0, one returned whatever the
caller had left behind — which is precisely what this rule removes.

---

## 5. Encoding

### 5.1 First byte

```
byte < 128  → Generic Core, dispatched by the ranges in §5.2
byte ≥ 128  → Extension (upper 128 codes), owned by the active extension
```

No bit-field masking: the core's 128 codes are contiguous numeric ranges,
one per instruction class, each sized to that class's exact state count
(§4). A decoder is a handful of range comparisons or a static 128-entry
table.

### 5.2 Range assignment

| Range | Class | Decode |
|---|---|---|
| `0-49` | Arithmetic (§4.1) | `op = code / 5`, `mode = code % 5` |
| `50-89` | Comparison (§4.2) | `op = (code−50) / 4`, `mode = (code−50) % 4` |
| `90-95` | Unary (§4.3) | `code − 90` selects `NEG, NOT, SXTB, SXTH, UXTB, UXTH` |
| `96-100` | Local flow control | `code − 96` selects `BLOCK_END, LOOP_PRE, LOOP_POST, BR_TABLE#1, BR_TABLE-ext` |
| `101-104` | Global flow control | `code − 101` selects `CALL, RETURN, TRAP#0, TRAP-ext` |
| `105-124` | Move/const (§4.4) | `code − 105` selects `PUSH, LOAD, STORE, CONST-ext, CONST#0..CONST#15` |
| `125-127` | Escapes (§5.3) | `MISC_BINARY, MISC_UNARY, MISC_OTHER`, each with a sub-code |

Op ordering within the two flat-indexed classes: arithmetic is `ADD, SUB,
RSUB, MUL, AND, OR, XOR, SHL, SHR, ASR` (0-9); comparison is `EQ, NE,
LT_S, LE_S, GT_S, GE_S, LT_U, LE_U, GT_U, GE_U` (0-9). Mode ordering:
arithmetic `REG_ACC, REG_REG, PEEK_PEEK, POP_ACC, IMM_EXT` (0-4);
comparison `REG_ACC, POP_ACC, IMM_SMALL, IMM_EXT` (0-3).

This uses all 128 core codes: 50 + 40 + 6 + 5 + 4 + 20 + 3. See §5.3 for
what the last three buy. The Appendix expands the formulas into one row per
byte value.

The formulas above describe the numbering, not a required algorithm — §5.1's
static table is equally normative, and on a target without a hardware
divider it is the only sane choice: `jit-armv6m` decodes through a
109-entry table precisely because `code / 5` and `code % 5` otherwise
compile to two libgcc `__udivsi3` calls per instruction decoded. A decoder
is free to pick either; `jit-armv6m/test/host/test_decode_encode.cpp`
checks its table against these formulas for every assigned opcode.

### 5.3 Escape opcodes

Every one of the 128 core codes is assigned, and the last three are escapes:
one per instruction class, each taking an unsigned LEB128 **sub-code** as
its trailing operand. They are where a core op goes once the single-byte
ranges are full — two bytes instead of one, in exchange for a space that
does not run out.

| Code | Escape | Assigned sub-codes |
|---|---|---|
| `125` | `MISC_BINARY` | none yet |
| `126` | `MISC_UNARY` | `0` = `REVBITS`, `1` = `CLZ` |
| `127` | `MISC_OTHER` | `0` = `FALLTHROUGH`, `1` = `DEFAULT`, `2` = `DROP-ext`, `3..6` = `DROP #1..#4` |

A sub-code's own operand shape — whether anything trails the sub-code, and
what — is defined when that sub-code is assigned, not by the escape. So an
**unassigned sub-code has no length**, and a decoder cannot skip over one:
it must reject the program, exactly as it rejects an extension byte no
extension claims (§11.1). This is the one place where a well-formed-looking
core byte can still be invalid.

`MISC_BINARY` is deliberately empty: it is reserved for the
general-purpose arithmetic the core should own rather than push onto a
domain extension — `UDIV`/`IDIV`/`MOD`, a multiply-accumulate — and nothing
there is specified yet. `MISC_OTHER` takes everything that earns a core
opcode without earning a single byte, and is also the growth path for
control flow the block structure cannot express: a `break` or `continue`
naming an enclosing block, say, which `DEFAULT` deliberately is not.

`MISC_OTHER`'s three sit there rather than in §5.2's ranges because the
single-byte space holds exactly five local-flow codes and every one is a
whole construct or its universal closer. `FALLTHROUGH` and `DEFAULT` occur
at most once per `switch` label, `DROP` once per scope, so the second byte
falls where nothing hot pays it.


### 5.4 Trailing operands

| Field | Encoding |
|---|---|
| Extended immediate (arithmetic/comparison ext form, `CONST` ext form) | unsigned LEB128, 1-5 bytes |
| Register index (`LOAD`, `STORE`, both classes' `REG_ACC`/`REG_REG` combos) | unsigned LEB128 |
| `BR_TABLE` extended case count (biased: the operand is `N − 2`), `TRAP` extended code, `CALL` procedure index | unsigned LEB128 |
| Escape sub-code (§5.3's `MISC_*`) | unsigned LEB128 |
| `DROP` extended count (biased: the operand is `n − 5`), after `MISC_OTHER`'s own sub-code | unsigned LEB128 |

`BR_TABLE`'s extended operand is biased by 2, so the extended form covers
`N ≥ 2` and nothing else: `N = 1` has only its dedicated code, `N = 0` has
no encoding at all (§4.5), and no case count has two spellings. The bias is
the whole reason the dedicated small form is `#1` alone — with `if`,
`if-else` and the ternary all lowering to `BR_TABLE 1` (§7.1), `N = 2` is
just a two-label `switch` group and no more special than `N = 3`.

`DROP`'s bias works the same way and for the same reason: `#1..#4` have
their own sub-codes, the extended form covers `n ≥ 5` and nothing else, and
`#0` — a no-op — has no encoding at all.

Register indices are LEB128 in every instruction that carries one: one
rule, no special case for small frames. `CALL`'s `proc_idx` is a plain
unbounded LEB128 with no compact form, the same treatment `codec_idx` gets
in `docs/codec-extension.md` §6.4, since a procedure-table index has no
small natural ceiling.

### 5.5 Program framing

A whole program (§2.3: a procedure table, entry at index 0) serializes as
one procedure count, then each procedure's own `arg_count` immediately
followed by its own body — no separate header table, no stored body
length:

```
program   := proc_count:LEB128  procedure{proc_count}
procedure := arg_count:LEB128  body_bytes
```

A body needs no length prefix because it is self-delimiting: §8.4 forbids
anything following a terminator within the same block, so the first
terminator seen with *no block open at all* is guaranteed to be the body's
own last byte — a decoder derives that boundary by tracking open
loop/`BR_TABLE` nesting the same way any consumer already has to
(§7.1/§7.2), never from a stored length. A terminator seen with a block
still open closes that block instead, exactly as its own closer would, and
the enclosing scope's bytes continue right after it; only an empty nesting
stack means "this ends the procedure". §7.2's block order is what keeps
that a plain count rather than a per-frame kind: a loop's last sub-block is
its condition, which only `BLOCK_END` may close, so no loop ever ends on a
terminator.

`arg_count` is the only core-mandated wire-level header field. A
procedure header's extension fields (§2.3, §11.4) are not wire-encoded:
they are opaque to the core, and the one real consumer so far (the codec
extension's `o0` `TypeNode`) is a build/validate-time value resolved before
serialization. Persisting extension header data would take a symmetric
`Extension.header` codec hook mirroring `Extension.codec`, added when a
real need appears.

Nothing here is self-delimiting from the outside, and nothing here binds a
program to the validator that produced it. Both are a target's own concern —
see `jit-armv6m/docs/design.md` §1.1 for one target's envelope and frame.

---

## 6. Calling Convention

On `CALL proc_idx`, let `N = procedure[proc_idx].arg_count` and
`K = max(N-1, 0)`, the number of arguments passed via the stack; the last
one (if `N ≥ 1`) travels in `acc` (§4.6). The callee's **frame base** is
the caller's TOS value at the moment of the call:

```
F_callee = caller_tos_at_call
r0 .. r(K-1)   : arguments 0..(K-1)   (= caller's top K stack slots)
r(N-1)         : argument N-1         (= acc at the moment of the call, if N ≥ 1)
rN ..          : local scratch, callee's TOS starts here
```

The caller computes each of `arg0 .. arg(K-1)` into `acc` and executes
`PUSH`, in order; its top `K` slots are exactly the callee's first `K`
arguments. It then computes `arg(N-1)` into `acc` and executes `CALL` with
no `PUSH` for that last argument. The caller's frame below `F_callee` is
untouched by the callee and reappears at its original indices after the
call.

On `RETURN` the callee's TOS must be at its entry point (`F_callee + K`),
or validation fails (§8.1). The frame is popped, the caller's TOS rewinds
to its pre-call value, and the caller resumes after the `CALL` with `acc`
holding the return value. Return is single-word.

**Available optimization, not implemented.** `r(N-1)`'s TOS slot is
established unconditionally at entry (`tos = N`), so a backend cannot tell
without its own peephole whether the callee's first instruction consumes
that argument straight out of `acc` (an immediate `RETURN`, or a
`REG_ACC`/`IMM_ACC` op) or needs it in stable storage first. The ARMv6-M
JIT backend always emits the move, then sometimes immediately undoes it.
Leaving `r(N-1)` in `acc` uncounted by TOS until an explicit `PUSH`
promotes it (`tos = K` at entry) moves that decision to the lowering pass,
which sees the whole body and can omit the `PUSH`. Cost: `walk`'s
`entryTos` (validate.ts) changes from `argCount` to
`stackArgsOf(argCount)`, and every existing test procedure addressing
`r(N-1)` without an explicit `PUSH` needs one added.

---

## 7. Control-Flow Semantics

### 7.1 `BR_TABLE` lowering forms

The test is emitted as written — never complemented, never normalized to
0/1 — because §4.5's index is truthy at `N = 1`: `acc = 0` is the *false*
outcome and takes `case[0]`.

| DSL construct | `N` | Case placement |
|---|---|---|
| `if-else` | 1 | else = `case[0]`, then = `case[1]` |
| `if` (no else) | 1 | `case[0]` is an empty block (a lone `BLOCK_END`), then = `case[1]` |
| ternary | 1 | alternate = `case[0]`, consequent = `case[1]`, arm order as `if-else`; each arm ends with its value in acc, which crosses the merge (§8.7). A ternary nested inside a larger expression cannot — something else runs before the consumer — so that one takes the slot form instead |
| `do`/`while` | — | `LOOP_POST`, identical to `while` but for the opener (§7.2) |
| `switch` | span of one run of labels | a `case` label is a *value*: consecutive labels index the table directly (shifted by the run's base, so an out-of-range discriminant lands past the span), and runs too far apart to bridge chain through each other's default case. The `default:` clause is `case[N]` |
| `switch`, gap in a span | — | a lone `DEFAULT` where there is a `default:` clause to reach, a lone `BLOCK_END` where there is not (falling out of the construct is then what "no label matched" means anyway) |
| `switch`, fallthrough | — | a case whose body runs on into the next closes with `FALLTHROUGH`, or with `DEFAULT` when what follows it in the source is the `default:` clause. An empty body — C's `case 0: case 1: X` — is just the degenerate case of that |

A `switch` chain needs no range test of its own: a group's `case[N]` *is*
"none of these", so the next group's own dispatch goes straight in there,
and the last group's `case[N]` holds the `default:` clause. `DEFAULT` inside
a chained group therefore lands in the *next* group's dispatch rather than
on the clause itself — which still arrives, because a discriminant that
reached a gap in group `k` matches no label in any later group either and
falls out of each in turn. Correct, and one dispatch per link slower than
the single-group case — which is why a two-byte gap is worth filling well
past the point a chain link becomes cheaper in bytes alone.

Fallthrough is expressible exactly between labels **adjacent in value**,
because emission order is the table's order and `FALLTHROUGH` continues
into the physically next case. `case 5: … case 1:` (backward) and
`case 1: … case 3:` (a gap block sits between them) are not encodable and
are rejected rather than mis-lowered; both want a branch naming a specific
block, which is §5.3's `MISC_OTHER` growth path and not specified here.

### 7.2 Loop block order

A loop's sub-blocks are emitted body-first, condition-second (§4.5). That is
the opposite of the order they first *run* in for `LOOP_PRE`, and it is
chosen for the backend that reads the stream once, in order, and emits as it
goes:

```
        B    cond          ; LOOP_PRE only; LOOP_POST just falls in
body:   …body…             ; the body block; its BLOCK_END emits nothing
cond:   …condition…
        Bcc  body          ; the condition block's own BLOCK_END
out:
```

One taken branch per iteration, and the entry branch is the only thing the
two openers disagree about. Condition-first would force the same backend to
emit a conditional exit *and* an unconditional back-edge — two branches an
iteration, one of them always taken — since it cannot rotate a block it has
already emitted.

Three consequences follow. The back-edge and the entry branch each span one
sub-block rather than one branch spanning both, so a range-limited branch
reaches further. Both of the condition block's predecessors — the entry edge
and the body's fallthrough — are known before it is walked, so acc liveness
there is one forward pass with no re-walk. And a loop always ends on
`BLOCK_END`, which is what lets §5.5's self-delimiting body scan stay a
plain count.

A loop's body block may still be closed by a terminator instead of
`BLOCK_END`: under `LOOP_PRE` that is a loop which tests its condition,
runs its body once and leaves via `RETURN`/`TRAP`, never taking the
back-edge — a legitimate non-cyclic use of the construct purely to host a
pre-test. Under `LOOP_POST` it would make the condition block unreachable,
and is rejected (§8.5).

---

## 8. Static Validation

A conforming validator rejects a program unless all of the following hold.

### 8.1 TOS balance

At every block closer (`BLOCK_END`, `FALLTHROUGH`, `DEFAULT`) and every
`RETURN`, any TOS surplus above the enclosing block's entry depth is
implicitly dropped: the producer emits no explicit cleanup pops, the block
boundary handles it. TOS may never go *below* the entry depth, which would
mean popping a value owned by an enclosing scope.

`DROP #n` (§4.4) is the one explicit decrease, for a scope that ends where
no block boundary does. It is held to the same floor: `tos - n` may not
fall below the enclosing block's entry depth.

### 8.2 Call-graph acyclicity

The graph over literal procedure indices referenced by `CALL` must be
acyclic.

### 8.3 Stack-depth bound

Per procedure, the maximum TOS depth reached on any path (its **local
peak**) is statically computable. Across the call graph the worst-case
total is a tight bound: each call site contributes its own TOS depth at
the moment of the call (relative to the callee's frame base, §6) plus the
callee's own worst-case total; the whole-program bound is the maximum over
every procedure's local peak and every call site's contribution, computed
bottom-up over the acyclic (§8.2) call graph. This beats summing
per-procedure local peaks along the longest chain, since a given call's own
depth is frequently less than the caller's local peak reached elsewhere in
its body. A program whose bound exceeds a target's resources is rejected
by the backend; the ISA imposes no numeric limit.

The same DFS yields a second figure: **maximum call depth**, the largest
number of simultaneously active frames on any path (each call site's depth
is 1 + the callee's own worst case). The two quantities are independent: a
long shallow chain has a small TOS bound and a large call depth, an
operand-heavy single frame the reverse. The stack-depth bound sizes a
backend's *operand* storage; call depth sizes whatever remembers "resume
here" across a call, which is free for a backend implementing
`CALL`/`RETURN` by native recursion and load-bearing for one threading
invocation through an explicit loop with a pre-sized array of return
records. Both are validator return values, neither is written into the
program image.

### 8.4 Dead-code rejection

Nothing may follow a terminator within the same block with no intervening
control target. The rule is structural — a consumer checks it with the
nesting count it already tracks (§5.5's self-delimiting body). Code
unreachable only for value reasons, such as the merge of a construct whose
every case terminated or a case of a dispatch on a constant, is not a
validation error: proving it would need a reachability analysis no
consumer otherwise performs.

A procedure body must end in a terminator of its own. A construct
structurally continues into its merge whatever its cases do, so a body
ending in one still needs an instruction at that merge to close on even
when no path reaches it — `TRAP #0`, §4.5's reserved "unreachable".

### 8.5 Header and block well-formedness

For every `CALL proc_idx`: the procedure must exist, and the TOS depth
pushed since the callee's entry point must equal `max(arg_count - 1, 0)`
(§6). Every `BR_TABLE` opener must have exactly `N + 1` case-closers (§4.5).
`N = 0` is unencodable, so no opener has fewer than two. `FALLTHROUGH` and
`DEFAULT` close a dispatch case only, never a loop sub-block, and neither
may close `case[N]`.

Every loop opener must have exactly two sub-block closers. The second — the
condition — is always `BLOCK_END`, since it is the loop's own dispatch. The
first — the body — may be `BLOCK_END` or a terminator under `LOOP_PRE`, and
must be `BLOCK_END` under `LOOP_POST`, whose condition block a terminating
body would leave unreachable (§7.2).

Every `BLOCK_END` must close some open block.

### 8.6 Register liveness

A register index is valid to reference via `LOAD`, `STORE` or a
`REG_ACC`/`REG_REG` register operand only once TOS has grown past it:
`target < tos` at that instruction, where `tos` counts both the frame's
`arg_count` initial slots (valid from procedure entry) and whatever
`PUSH`es have run since.

§8.1's TOS balance does not imply this: it bounds
`PUSH`/peek/pop-combo/`CALL` against a block's entry depth and never
looks at a `LOAD`/`STORE`/register-combo operand. Violating §8.6 is a
validation error, not undefined runtime behavior: a register no `PUSH`
established has no value to read and no reason to be writable.

This closes a gap real backends already relied on. A
physical-register-window backend (the ARMv6-M JIT,
`jit-armv6m/docs/design.md` §5) derives a register's entire physical
location, in-window or spilled and at what address, purely from how far
TOS has grown past it. A register no `PUSH` ever covered has no derivable
location, so such a program would validate and run under the reference
interpreter's defensive fallback for an unwritten slot, only to be
untranslatable by that class of backend with no diagnostic.

### 8.7 Acc liveness across control flow

Acc liveness is a derived static property, tracked forward from a
procedure's entry, where it is live iff that procedure takes at least one
argument (§4.6). A
write-back-in-place combo (`REG_REG`/`PEEK_PEEK` — §4.1) invalidates it
without re-establishing it, and so does an extension opcode declaring the
destroying accumulator effect (§11.2). Every instruction that reads acc as an implicit
operand — an arithmetic/comparison combo, `STORE`, `PUSH`,
`NEG`/`NOT`/`CLZ`/`REVBITS`, a `CALL` whose callee takes at least one
argument, or a `BR_TABLE` or loop-condition dispatch itself — is a
validation error if acc is not live at that point.

**`RETURN` is the exception, and defines what a void procedure is.** Acc
being dead at a `RETURN` is not an error: it means this path returns no
value. A procedure returns one **on every path or on none** — doing both is
the error, since a caller cannot be told which path ran. Acc after a `CALL`
is live only when the callee returns a value, and that is what keeps a
caller from reading one that was never established. The property is derived,
not declared: nothing in §2.3's header carries it, so every consumer infers
it the same way from the body.

A void procedure's result still travels in acc as far as the ABI is
concerned (§4.6 is unchanged) — it is simply unspecified, and no validated
program reads it. The exception is the entry procedure, whose result leaves
for the host: a host reading it there reads whatever that implementation
happened to leave behind, so `vm.ts`'s `run` reports `accLive` beside it.

`BR_TABLE` and the two loop openers are this ISA's multi-successor-edge
constructs. **A CFG split point clobbers acc unconditionally**: every
successor edge — any dispatch case, a loop body, a loop exit — starts with
acc *not live*, regardless of what was live going into the split. That is
the entry rule, and it is the same for all three. A loop's *body* block is
therefore entered dead under both openers: under `LOOP_PRE` its only
predecessor is the condition's own branch, and under `LOOP_POST` the
sequential entry edge meets that same branch there.

A loop's *condition* block is the one join, and its predecessors are all
known before it is reached (§7.2): the body's fallthrough always, plus the
opener's entry edge under `LOOP_PRE`. Acc is live entering it iff it is live
on every one of them. Its own `BLOCK_END` is a dispatch and reads acc, so
that must come out live.

At the exit the constructs differ. **Acc is never live after a loop**: its
exit edge is a successor of the condition sub-block's own dispatch, and no
instructions sit on it, so there is nowhere to establish a value.

**After a `BR_TABLE` acc is live iff every case that reaches the merge
leaves it live.** §4.5's dispatch is total — `acc ≥ N` runs `case[N]`, not
nothing — so every edge into the merge is a case body, somewhere
instructions can actually go. A case ending in a terminator reaches nothing
and constrains nothing, and so does one ending in `FALLTHROUGH` or
`DEFAULT`, which hands the question to the case it continues into; if no
case reaches the merge, acc is dead there.

Either way acc liveness stays a **local property**: a validator decides it
from the cases' own exit liveness, never from the dispatch value, and never
has to reason about which case can actually run.

So a value-producing branch — a ternary — rides acc across the merge and
needs no slot: each case simply ends with the value in acc. Reserving a slot
before the dispatch (not inside a case, where §8.1 drops it at that case's
own `BLOCK_END`), storing to it at the end of every case and loading it
after is seven bytes of plumbing that this rule removes outright.

---

## 9. Resource Guarantees

A validated program is guaranteed no heap allocation (§2.6), no runtime
stack overflow given a backend meeting the computed bound (§8.3), and no
infinite recursion (§8.2). **Termination is not guaranteed**: a loop
whose condition block never tests false runs indefinitely. The ISA
promises bounded resource usage, not termination.

---

## 10. Textual DSL

### 10.1 Overview

The DSL is a strict subset of C99; this section specifies only the delta
from C, whose expression/statement grammar and precedence are inherited
unchanged. The authoring entry point is a TypeScript tagged template,
`` ir`<C-subset source>` ``, parsed by the PEG grammar at
`packages/machine/grammer.pegjs` into an AST (`ast.ts`).

### 10.2 Included

Expressions: C's operators with C's precedence, except `/` and `%` (no
opcode — §4.1); `=` and compound assignment; prefix and postfix `++`/`--`;
`&&`/`||`, short-circuiting; the conditional operator; narrowing casts
(§10.4); integer literals (decimal, `0x…`, `0b…`); function calls;
parenthesization. Statements: expression statements; `if`/`else`, `while`,
`do`/`while`, `for`, `switch`/`case`/`default`/`break`, `return`; block
statements `{ … }`, both as the direct body of a branch or loop and
standalone. Declarations: any number of locals per statement (`u32 a, b = 1;`),
of any §10.4 type, each optionally initialized. `//` and `/* */` comments.

Everything below the surface syntax is a rewrite into what the tiler
already covers: compound assignment into `a = a op e`, `!e` into `e == 0`,
`a && b` into a conditional, a conditional into a `BR_TABLE` whose arms
each leave the value in acc (§8.7). Only a postfix `++`/`--` whose value is read needs a slot of its
own, for the value from before the step.

A scope that ends where no block boundary does — a bare `{ … }`, a `for`
init's declarations — closes with `DROP #n` over the locals it declared
(§4.4), which is what lets those slots be reused rather than held to the end
of the enclosing block.

### 10.3 Excluded

- Pointers, arrays, `struct`/`union`/`enum`/`typedef`.
- Function *definitions* (a DSL body is one procedure's statement
  sequence); function *calls* are allowed (§10.5).
- `goto`/labels, and `break`/`continue` naming a *loop*: the ISA carries no
  opcode for irregular exit (§4.5), so a loop that would `break` early folds
  the early-exit test into its condition. `break` inside a `switch` is
  allowed, and is not irregular — it is that case block's own `BLOCK_END`.
- **`switch` fallthrough between labels that are not adjacent in value.**
  Table order is label-value order and `FALLTHROUGH` continues into the
  physically next case (§7.1), so falling backward, or across a gap, is
  rejected rather than mis-lowered. Falling into a `default:` clause written
  after the case is fine — that is `DEFAULT`.
- **Fallthrough out of `default:`** into a labelled case, which C allows
  when `default:` is not written last. It needs a branch naming a specific
  block; nothing does.
- **Octal literals.** A leading zero is rejected, not reinterpreted: this
  is a subset of C, so it may refuse a spelling, but must not disagree with
  C about what one means.
- `/` and `%`, which parse but have no opcode to lower to (§4.1).
- Comma operator, `sizeof`, non-integer literals, storage qualifiers, the
  preprocessor.

### 10.4 Types

The six primitive types of §4.3: `u32`/`i32` are the machine word, and
`u16`/`u8`/`i16`/`i8` are that word held already extended, which is what
makes reading one free and writing one cost an extend.

```
u32 x;            // ok — reserves a zeroed slot
i16 y = -5;       // ok
u8  z = u8(y);    // ok — a cast is written call-style (§10.5)
u32 a, b;         // rejected: one declarator per statement
int x;            // rejected
```

A name may not be declared twice in one scope, and a procedure argument is
in the body's own scope, so a local may not shadow one either — both would
push a slot the name no longer answers to. A nested scope may shadow
freely: its block reclaims the slot at `BLOCK_END`. A `for` init's
declarations are scoped to the loop, but their registers are not reclaimed
until the enclosing block ends.

Function parameters are `u32`, declared out-of-band in the procedure
header (§2.3), visible as named locals from the body's first statement.

### 10.5 Function calls

Calls parse as `Identifier ( arglist )`. Three core built-ins have fixed
lowering:

| Call | Lowers to |
|---|---|
| `trap(code)` | `TRAP #code` |
| `clz(x)` | `CLZ` |
| `revbits(x)` | `REVBITS` |
| `i8(x)` / `i16(x)` / `u8(x)` / `u16(x)` | `SXTB` / `SXTH` / `UXTB` / `UXTH` |

A cast takes the same call-like syntax rather than C's `(u8)x`: a leading
parenthesis is already a parenthesized expression, and telling the two
apart needs unbounded lookahead. The four names are the §10.4 types that
narrow; a cast to `u32`/`i32` is the identity and emits nothing. The same
extend is inserted implicitly wherever a value lands in a narrow variable.

`trap` is a function rather than a keyword so `return` stays the only
procedure-exit keyword. Resolving any other call name (procedure table
entries, extension ops, codec invocations) is an application-layer
mechanism, out of scope here.

### 10.6 Lowering rules

| DSL construct | Lowers to |
|---|---|
| expression | instructions computing the value into `acc`, using TOS for intermediates as needed; operand addressing mode is an implementation choice |
| `if (c) T` | `c` into `acc`; `BR_TABLE 1`, an empty `case[0]`, `T` at `case[1]` |
| `if (c) T else E` | `c` into `acc`; `BR_TABLE 1`, `E` at `case[0]`, `T` at `case[1]` (§7.1) |
| `switch (v) { case k: … }` | `v` into `acc`; `BR_TABLE` over one run of labels, shifted by that run's base; a gap in the run is a lone `DEFAULT`; `case[N]` holds either the next run's own dispatch (off a slot holding `v`) or the `default:` clause |
| `while (c) B` | `LOOP_PRE`; body block = `B`; `BLOCK_END`; condition block = `c` into `acc`; `BLOCK_END` |
| `do B while (c);` | the same, with `LOOP_POST` |
| `for (init; c; inc) B` | `init`; `LOOP_PRE`; body block = `B` then `inc`; `BLOCK_END`; condition block = `c` (omitted ⇒ `1`); `BLOCK_END`; `DROP #n` over the init's own declarations |
| `{ … }` (standalone) | the statements, then `DROP #n` over the locals they declared |
| `return e;` / `return;` | `e` into `acc`; `RETURN` (a void procedure needs no producer — §8.7) |
| body running off its end | `RETURN`, when the procedure returns nothing (§8.7) — a body owing a value has none to put there, and is rejected |
| `trap(c);` | `TRAP #c` |
| `u32 x = e;` | `e` into TOS: the push that computes it *is* the slot, and `x` names that index |
| `u32 x;` | `CONST #0`, `PUSH` — the slot still has to exist, and `PUSH` needs a live value |
| `c ? a : b` | `BR_TABLE 1` with `b` at `case[0]` and `a` at `case[1]`, each arm leaving its value in acc (§8.7); nested inside a larger expression it takes a slot reserved by `PUSH` instead, stored from each arm |
| `a op= e`, `++a`, `!e`, `a && b` | rewritten into the above before anything is emitted (§10.2) |
| `a++` (value read) | `LOAD a`, `PUSH` — the pre-step value in a slot — then the step |

The `for` increment lowers to a single copy at the end of the body block,
immediately before its `BLOCK_END`: with no `continue` to jump around it,
every path through the body reaches it exactly once per iteration.

---

## 11. Extension Mechanism

### 11.1 The `EXT` instruction

Every byte ≥128 (§5.1) encodes one **extension opcode**: an opaque name
owned entirely by the active extension, plus a fixed-arity operand list.
The core never interprets either; it needs only each opcode's *effect*
(§11.2) to keep validating and executing programs containing them.

### 11.2 Effect declarations

For §8's guarantees to hold over a program containing extension opcodes
without the validator or VM knowing what any opcode does, every extension
opcode declares:

| Field | Meaning |
|---|---|
| TOS delta | Net TOS depth change contributed by the opcode itself. |
| Peak transient depth | The deepest TOS gets above its own entry depth while the opcode executes, even if it nets back by the time the opcode is done. |
| Terminates? | Whether the opcode ends its enclosing block on its own, as `RETURN`/`TRAP` do (§4.5, §8.4). |
| Call-shaped? | Whether the opcode invokes a procedure, and if so which operand carries the resolved procedure-table index and what the callee's logical argument count `N` is. |
| Reads acc? | Whether the opcode's input includes whatever `acc` already holds, on top of whatever it pops. |
| Accumulator effect | What it leaves behind in `acc`: **preserves**, **writes**, or **destroys**. |

The accumulator effect is three-valued and defaults to *preserves*: an
opcode that says nothing about `acc` leaves its value and its liveness
(§8.7) exactly as it found them. *Writes* establishes a fresh value, so
`acc` is live after the opcode whatever it was before. *Destroys* leaves
nothing readable, exactly as a CFG split does: `acc` is dead after the
opcode, and reading it before something re-establishes one is a validation
error.

*Destroys* is what an opcode that hands its work to target code reached
through an argument register has to declare — on a register machine the
accumulator's own register is one of those, so the value is gone whether
the opcode wanted it gone or not. Reading is orthogonal to all three:
consume-and-destroy is that opcode's ordinary shape.

A call-shaped extension opcode follows `CALL`'s convention (§4.6, §6):
only `max(N-1, 0)` of its arguments are expected on the stack, the last
(if any) already in `acc`. Its call target folds into the same call-graph
accounting as an ordinary `CALL` for §8.2's acyclicity check and §8.3's
depth bound.

A program containing an extension opcode with no matching effect
declaration is rejected: an opcode the validator has no effect information
for cannot be assumed to preserve §8's guarantees.

### 11.3 Literal operands only

Every extension opcode's operands are literal constants resolved ahead of
execution: register indices, procedure-table indices, small handle
literals, never a value computed at runtime. This is what lets an
ahead-of-time translator implement whatever an extension opcode abstracts
away (a struct field access, a `*ptr++` read, a checksum-field patch-up) as
ordinary target-native code instead of an interpreter loop, since every
operand it needs is known at translation time.

### 11.4 Header extension fields

A procedure header's extension fields (§2.3) are opaque to the core,
never read or interpreted by it, and carried through unchanged for
whichever extension put them there to read back, for example selecting
between an encoder and a decoder ABI for the same procedure shape.

### 11.5 Call-name resolution

Resolving a call-like syntax to a specific extension opcode, as opposed to
a procedure-table `CALL` (§10.5), is an application-layer mechanism, out of
scope here, exactly as procedure-table resolution itself is.

---
## Appendix - Opcode Table

The literal expansion of §5.2/§5.3's range assignment: every byte value
0-127, derived mechanically from the formulas and orderings given there
(arithmetic `op*5 + mode`, comparison `50 + op*4 + mode`, everything else a
fixed offset). It exists so implementing an encoder/decoder never requires
re-deriving a byte value by hand; §5.2/§5.3 remain the source of truth.
Every trailing operand, where present, is unsigned LEB128 (§5.4).

| Byte | Mnemonic | Trailing operand |
|---|---|---|
| `0` | `ADD REG_ACC` | register index |
| `1` | `ADD REG_REG` | register index |
| `2` | `ADD PEEK_PEEK` | none |
| `3` | `ADD POP_ACC` | none |
| `4` | `ADD IMM_EXT` | immediate value |
| `5` | `SUB REG_ACC` | register index |
| `6` | `SUB REG_REG` | register index |
| `7` | `SUB PEEK_PEEK` | none |
| `8` | `SUB POP_ACC` | none |
| `9` | `SUB IMM_EXT` | immediate value |
| `10` | `RSUB REG_ACC` | register index |
| `11` | `RSUB REG_REG` | register index |
| `12` | `RSUB PEEK_PEEK` | none |
| `13` | `RSUB POP_ACC` | none |
| `14` | `RSUB IMM_EXT` | immediate value |
| `15` | `MUL REG_ACC` | register index |
| `16` | `MUL REG_REG` | register index |
| `17` | `MUL PEEK_PEEK` | none |
| `18` | `MUL POP_ACC` | none |
| `19` | `MUL IMM_EXT` | immediate value |
| `20` | `AND REG_ACC` | register index |
| `21` | `AND REG_REG` | register index |
| `22` | `AND PEEK_PEEK` | none |
| `23` | `AND POP_ACC` | none |
| `24` | `AND IMM_EXT` | immediate value |
| `25` | `OR REG_ACC` | register index |
| `26` | `OR REG_REG` | register index |
| `27` | `OR PEEK_PEEK` | none |
| `28` | `OR POP_ACC` | none |
| `29` | `OR IMM_EXT` | immediate value |
| `30` | `XOR REG_ACC` | register index |
| `31` | `XOR REG_REG` | register index |
| `32` | `XOR PEEK_PEEK` | none |
| `33` | `XOR POP_ACC` | none |
| `34` | `XOR IMM_EXT` | immediate value |
| `35` | `SHL REG_ACC` | register index |
| `36` | `SHL REG_REG` | register index |
| `37` | `SHL PEEK_PEEK` | none |
| `38` | `SHL POP_ACC` | none |
| `39` | `SHL IMM_EXT` | immediate value |
| `40` | `SHR REG_ACC` | register index |
| `41` | `SHR REG_REG` | register index |
| `42` | `SHR PEEK_PEEK` | none |
| `43` | `SHR POP_ACC` | none |
| `44` | `SHR IMM_EXT` | immediate value |
| `45` | `ASR REG_ACC` | register index |
| `46` | `ASR REG_REG` | register index |
| `47` | `ASR PEEK_PEEK` | none |
| `48` | `ASR POP_ACC` | none |
| `49` | `ASR IMM_EXT` | immediate value |
| `50` | `EQ REG_ACC` | register index |
| `51` | `EQ POP_ACC` | none |
| `52` | `EQ IMM_SMALL (#0)` | none |
| `53` | `EQ IMM_EXT` | immediate value |
| `54` | `NE REG_ACC` | register index |
| `55` | `NE POP_ACC` | none |
| `56` | `NE IMM_SMALL (#0)` | none |
| `57` | `NE IMM_EXT` | immediate value |
| `58` | `LT_S REG_ACC` | register index |
| `59` | `LT_S POP_ACC` | none |
| `60` | `LT_S IMM_SMALL (#0)` | none |
| `61` | `LT_S IMM_EXT` | immediate value |
| `62` | `LE_S REG_ACC` | register index |
| `63` | `LE_S POP_ACC` | none |
| `64` | `LE_S IMM_SMALL (#0)` | none |
| `65` | `LE_S IMM_EXT` | immediate value |
| `66` | `GT_S REG_ACC` | register index |
| `67` | `GT_S POP_ACC` | none |
| `68` | `GT_S IMM_SMALL (#0)` | none |
| `69` | `GT_S IMM_EXT` | immediate value |
| `70` | `GE_S REG_ACC` | register index |
| `71` | `GE_S POP_ACC` | none |
| `72` | `GE_S IMM_SMALL (#0)` | none |
| `73` | `GE_S IMM_EXT` | immediate value |
| `74` | `LT_U REG_ACC` | register index |
| `75` | `LT_U POP_ACC` | none |
| `76` | `LT_U IMM_SMALL (#0)` | none |
| `77` | `LT_U IMM_EXT` | immediate value |
| `78` | `LE_U REG_ACC` | register index |
| `79` | `LE_U POP_ACC` | none |
| `80` | `LE_U IMM_SMALL (#0)` | none |
| `81` | `LE_U IMM_EXT` | immediate value |
| `82` | `GT_U REG_ACC` | register index |
| `83` | `GT_U POP_ACC` | none |
| `84` | `GT_U IMM_SMALL (#0)` | none |
| `85` | `GT_U IMM_EXT` | immediate value |
| `86` | `GE_U REG_ACC` | register index |
| `87` | `GE_U POP_ACC` | none |
| `88` | `GE_U IMM_SMALL (#0)` | none |
| `89` | `GE_U IMM_EXT` | immediate value |
| `90` | `NEG` | none |
| `91` | `NOT` | none |
| `92` | `SXTB` | none |
| `93` | `SXTH` | none |
| `94` | `UXTB` | none |
| `95` | `UXTH` | none |
| `96` | `BLOCK_END` | none |
| `97` | `LOOP_PRE` | none |
| `98` | `LOOP_POST` | none |
| `99` | `BR_TABLE #1` | none |
| `100` | `BR_TABLE ext` | case count − 2 |
| `101` | `CALL` | procedure index |
| `102` | `RETURN` | none |
| `103` | `TRAP #0` | none |
| `104` | `TRAP ext` | trap code |
| `105` | `PUSH` | none |
| `106` | `LOAD` | register index |
| `107` | `STORE` | register index |
| `108` | `CONST ext` | immediate value |
| `109` | `CONST #0` | none |
| `110` | `CONST #1` | none |
| `111` | `CONST #2` | none |
| `112` | `CONST #3` | none |
| `113` | `CONST #4` | none |
| `114` | `CONST #5` | none |
| `115` | `CONST #6` | none |
| `116` | `CONST #7` | none |
| `117` | `CONST #8` | none |
| `118` | `CONST #9` | none |
| `119` | `CONST #10` | none |
| `120` | `CONST #11` | none |
| `121` | `CONST #12` | none |
| `122` | `CONST #13` | none |
| `123` | `CONST #14` | none |
| `124` | `CONST #15` | none |
| `125` | `MISC_BINARY` | sub-code |
| `126` | `MISC_UNARY` | sub-code |
| `127` | `MISC_OTHER` | sub-code |

The two escapes with assigned sub-codes, expanded the same way:

| Bytes | Mnemonic | Trailing operand |
|---|---|---|
| `126 0` | `REVBITS` | none |
| `126 1` | `CLZ` | none |
| `127 0` | `FALLTHROUGH` | none |
| `127 1` | `DEFAULT` | none |
| `127 2` | `DROP ext` | count − 5 |
| `127 3` | `DROP #1` | none |
| `127 4` | `DROP #2` | none |
| `127 5` | `DROP #3` | none |
| `127 6` | `DROP #4` | none |

---

## Appendix - Worked Example

`u32 leb128_len(u32 v)` counts the bytes a LEB128 encoding of `v` would
take. Exercises a loop, a shift, a comparison and an increment.

```c
u32 leb128_len(u32 v) {
    u32 n = 1;
    while (v >= 0x80) {
        v = v >> 7;
        n = n + 1;
    }
    return n;
}
```

Lowering (register 0 = `v`, the argument; register 1 = `n`, established by
the `PUSH` — §8.6 only lets a register be named once TOS has grown past it):

```
CONST #1
PUSH                     ; n = 1, in the slot the push establishes
LOOP_PRE                 ; enters at the condition block below
  LOAD 0                 ; body block
  SHR #7                 ; acc = v >> 7 (arithmetic combo #5, immediate/extended)
  STORE 0                ; v = acc
  CONST #1
  ADD 1                  ; acc = 1 + n
  STORE 1                ; n = acc
BLOCK_END                ; continue into the condition
  LOAD 0                 ; condition block
  GE_U #0x80             ; acc = (v >= 0x80)
BLOCK_END                ; acc≠0 → back-edge to the body; acc=0 → exit
LOAD 1
RETURN
```

`n = n + 1` can instead fold to `CONST #1; ADD 1 → 1` (arithmetic combo #2,
register write-back), one instruction shorter: the write-back combo stores
directly into `n`'s register instead of routing through `acc` and a
separate `STORE`. Both are valid; a lowerer picks whichever is cheaper.
