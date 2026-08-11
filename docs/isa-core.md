# Generic Core ISA

> **Status:** Normative spec — the *what*. For the *why* behind any
> non-obvious choice below, see [ir-engine.md](./ir-engine.md). This
> document specifies the *mechanism* by which a domain extension plugs into
> the core (§11) — the extension opcode space it owns (§5.1), and what the
> core requires an extension to declare about its own opcodes to keep §8's
> guarantees intact. What any concrete extension's opcodes actually *do*
> (codec stream I/O, target access, codec invocation) is out of scope here
> and specified separately, when written.

---

## 1. Overview

The Generic Core is a small, statically analyzable instruction set for a
TOS-hybrid accumulator machine. It is:

- **Portable** — a procedure is a byte blob any conforming target can
  AOT-compile, JIT-evaluate, or interpret, including microcontrollers.
- **Compact** — on-wire procedure size is the overriding metric. Execution
  cost on the backend is not a constraint.
- **Statically analyzable** — stack depth, termination of the call graph,
  and resource footprint are all computable ahead of execution.
- **Zero-allocation** — no instruction allocates heap memory; all storage
  is statically bounded.
- **Extensible** — half the opcode space is reserved for a domain
  extension (§5.1); the extension declares each of its opcodes' stack
  effect (§11.2) so the core's validator and VM stay ignorant of what any
  extension opcode actually does while still proving every guarantee in §8
  over programs that use them.

It contains no domain-specific concepts. A program is a **procedure
table** — an indexed array of procedures, each a fixed header plus a body
of instructions. The machine has one accumulator (`acc`), one logical
register file indexed from zero, and one TOS pointer that indirects into
that same register file. Control flow is fully structured: no arbitrary
jumps, no `break`/`continue`. Two block constructs (`BR_TABLE`, `LOOP`) and
two terminators (`RETURN`, `TRAP`) cover everything the source DSL can
express.

---

## 2. Abstract Machine

### 2.1 Values

The only value type is the **word**: a 32-bit pattern, interpreted as
unsigned or signed depending on the operation. A **boolean** is a word
`0`/`1`. Control-flow constructs use the **lenient test**: any non-zero
word means "true" / "continue", so a comparison result (or a plain count,
or a tag) can drive a branch with no normalization step.

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

`arg_count` is the number of value arguments, visible as `r0..r(arg_count-1)`
in the procedure's frame. The body must end in a terminator (`RETURN` or
`TRAP`); falling off the end is a validation error. `CALL` (§4.6)
references procedures by a literal index into the procedure table — there
is no indirect call.

### 2.4 TOS pointer

| Mode | Notation | Effect | Capability |
|---|---|---|---|
| Push | `[tos++]` | write `r[tos]`, then `tos += 1` | write-only |
| Pop | `[--tos]` | `tos -= 1`, then read `r[tos]` | read-only |
| Peek | `[tos-1]` | read/write `r[tos-1]`, `tos` unchanged | read-write |

Because TOS indexes the register file directly, a pushed value can later
be read by its register index once the backend allocates one, and a
register can be pushed/popped/peeked if it sits at the current TOS. TOS is
per-frame: every invocation gets its own entry point (§2.5).

### 2.5 Frames

A procedure's frame is the region `F .. ` of the register file, where `F`
is the frame base:

```
r0 .. r(N-1)   : arguments   (N = arg_count)
rN ..          : local scratch, TOS starts here
```

The caller's and callee's frames are disjoint; a procedure never addresses
storage outside its own frame (§6 gives the exact frame-base computation
across a `CALL`).

### 2.6 Static guarantees

Every valid program satisfies:

1. **TOS balance** — every block and every procedure body exits at the
   same TOS depth it entered with (§8.1).
2. **Bounded stack depth** — the call graph's worst-case register-file
   depth is statically computable (§8.3); no runtime stack overflow is
   possible.
3. **Acyclic calls** — the call graph over literal procedure indices has
   no cycles (§8.2). How the authoring layer ensures this is out of scope;
   the IR is accepted or rejected on the property alone.
4. **No heap allocation.**

---

## 3. Addressing Modes

An addressing mode specifies where an instruction's second operand (the
one that isn't `acc`) comes from, and where the result goes.

| Mode | Operand source | Can read? | Can write? |
|---|---|---|---|
| Register | `rN` | yes | yes |
| Peek | `[tos-1]` | yes | yes |
| Pop | `[--tos]` | yes | no |
| Push | `[tos++]` | no | yes (result only) |
| Immediate | inline or trailing literal | yes | no |

Read-only modes (pop, immediate) and the write-only mode (push) force the
result destination, eliminating semantically invalid pairings before they
can be encoded. Each instruction class (§4) lists exactly which mode ×
destination combinations it supports — arithmetic, comparison, and the
move class each support a different subset, for reasons given in
ir-engine.md.

---

## 4. Instruction Reference

### 4.1 Arithmetic (binary-class)

Ten operations, all sign-agnostic unless noted, all `result = acc ⟨op⟩ operand`:

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

`SHL`/`SHR`/`ASR` take the shift amount as the operand, masked to 5 bits
(mod 32). There is no `DIV`/`MOD` (division essentially never appears in
codec arithmetic, and many microcontrollers lack hardware support for it;
a program needing true division calls a software helper).

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

All eight relational comparisons are first-class — there is no derivation
of `GT`/`GE` from `LT`/`LE` by branch inversion; every comparison encodes
directly (see ir-engine.md for why this stopped being a space-saving
concern).

Four addressing combinations, result always to `acc`:

| # | Mode | Operand | Example (`LT_S`) |
|---|---|---|---|
| 1 | register | `rN` | `acc = (acc < rN)` |
| 2 | pop | `[--tos]` | `acc = (acc < [--tos])` |
| 3 | immediate, small | `#0` only | `acc = (acc < 0)` |
| 4 | immediate, extended | trailing LEB128 | `acc = (acc < imm)` |

State count: 10 ops × 4 modes = **40 states**. The small-immediate form is
zero-only, covering zero-test and sign-test — the single most common
comparison idiom — in one byte; every other comparison constant uses the
extended form.

### 4.3 Unary-class

Operate on `acc` in place, no addressing-mode bits:

| Op | Semantics |
|---|---|
| `NEG` | two's-complement negation |
| `NOT` | bitwise complement |
| `CLZ` | count leading zeros (0–32) |
| `REVBITS` | reverse bit order (32-bit width) |

`CTZ` has no dedicated op: `CTZ(x) = CLZ(REVBITS(x))`.

### 4.4 Move-class

Plain data movement, with no ALU combining. These exist for the *unfused*
case — moving a value with no accompanying arithmetic. An arithmetic op
that also needs a register operand uses its own register-mode combo
(§4.1 #1/#2) directly; it does not need a `LOAD` first.

| Op | Effect | Trailing |
|---|---|---|
| `PUSH` | `[tos++] = acc` | none |
| `POP` | `acc = [--tos]` | none |
| `LOAD` | `acc = rN` | LEB128 register index |
| `STORE` | `rN = acc` | LEB128 register index |
| `CONST #k` (small) | `acc = k`, `k ∈ 0..15` | none (`k` inline in opcode) |
| `CONST #imm` (extended) | `acc = imm` | LEB128 `u32` |

`PUSH` is how a call's non-last arguments (§4.6, §6) and expression
temporaries reach the stack (§4.1 has no push-mode combo of its own — see
ir-engine.md for why).
`CONST` is the only way to get an arbitrary constant into `acc`; there is
no move-with-immediate-mode ALU combo standing in for it.

Four codes in this class's range (§5.2) are reserved rather than assigned
to `CONST #16..#19` — see ir-engine.md for why.

### 4.5 Control-flow ops

Two block openers, one universal closer, two terminators. No operand
carries a branch offset; every target is determined by static block
nesting.

**`BR_TABLE N`** — dispatch on `acc`. `acc < N` executes `case[acc]`;
`acc ≥ N` executes no case (the **implicit default**). Falls through to
after the construct either way. `N` is a literal case count, not an
offset. `if`/`if-else`/`switch` all lower to this (§7.1).

**`LOOP`** — opens **two** nested sub-blocks in fixed order, each closed by
its own `BLOCK_END`:

```
LOOP
  <condition block>      ; leaves a continue/exit decision in acc
BLOCK_END                ; acc=0 → exit past the next BLOCK_END; acc≠0 → body
  <body block>
BLOCK_END                ; unconditional back-edge → LOOP
```

Pre-test only: the condition block always runs at least once, so zero
body iterations is possible. There is no bottom-test (`do-while`) form
(§7.2 shows the recovery idiom).

**`BLOCK_END`** — closes the innermost open block. Meaning depends on what
it closes: unconditional fall-through for a `BR_TABLE` case; conditional
exit-or-continue for a `LOOP` condition block; unconditional back-edge for
a `LOOP` body block. One opcode, three meanings, disambiguated purely by
block nesting.

**`RETURN`** — end the procedure; `acc` is the return value; frame popped.

**`TRAP #code`** — end the procedure abnormally with an opaque error code
(`0` = unreachable/panic by convention; the rest of the space is
host-defined). Both terminators are procedure-exiting: no `BLOCK_END`
after either is needed or valid, and no instruction may follow one within
the same block (§8.4).

There is no `break`, `continue`, or any other in-procedure re-target. The
only way out of a running `LOOP` early is a terminator reached from
inside it, or the condition block testing false on a later iteration.

### 4.6 Procedure invocation

**`CALL proc_idx`** — invoke `procedure[proc_idx]`. Let `N =
procedure[proc_idx].arg_count`. The caller pushes (via `PUSH`, §4.4) the
first `N-1` arguments, in order; the *last* argument (if `N ≥ 1`) is left
in `acc` instead of pushed — `acc` is clobbered by the call regardless (the
callee's return value overwrites it), so passing the last argument through
it costs nothing. Together these become `r0..r(N-1)` in the callee's frame
(§6). The return value comes back in `acc`; the caller's TOS is rewound to
discard the pushed argument block, if any, on return.

---

## 5. Encoding

### 5.1 First byte

```
byte < 128  → Generic Core, dispatched by the ranges in §5.2
byte ≥ 128  → Extension (upper 128 codes), owned by the active extension
```

No bit-field masking: the core's 128 codes are assigned as contiguous
numeric ranges, one per instruction class, sized to that class's exact
state count (§4). A decoder is a handful of range comparisons or a static
128-entry table — see ir-engine.md for why this replaced a nested
bit-prefix scheme.

### 5.2 Range assignment

| Range | Class | Decode |
|---|---|---|
| `0–49` | Arithmetic (§4.1) | `op = code / 5`, `mode = code % 5` |
| `50–89` | Comparison (§4.2) | `op = (code−50) / 4`, `mode = (code−50) % 4` |
| `90–93` | Unary (§4.3) | `code − 90` selects `NEG, NOT, CLZ, REVBITS` |
| `94–98` | Local flow control | `code − 94` selects `BLOCK_END, LOOP, BR_TABLE#1, BR_TABLE#2, BR_TABLE-ext` |
| `99–102` | Global flow control | `code − 99` selects `CALL, RETURN, TRAP#0, TRAP-ext` |
| `103–123` | Move/const (§4.4) | `code − 103` selects `PUSH, POP, LOAD, STORE, CONST-ext, CONST#0..CONST#15` |
| `124–127` | Reserved | unassigned (§5.3) |

Op ordering within a class, for the arithmetic and comparison flat
indices: arithmetic — `ADD, SUB, RSUB, MUL, AND, OR, XOR, SHL, SHR, ASR`
(0–9); comparison — `EQ, NE, LT_S, LE_S, GT_S, GE_S, LT_U, LE_U, GT_U,
GE_U` (0–9). Mode ordering: arithmetic — `REG_ACC, REG_REG, PEEK_PEEK,
POP_ACC, IMM_EXT` (0–4); comparison — `REG_ACC, POP_ACC, IMM_SMALL,
IMM_EXT` (0–3).

This assignment uses 124 of the 128 core codes, deliberately — see §5.3.
The full 128-entry table this derives — one row per byte value, no
arithmetic required — is in the Appendix.

### 5.3 Reserved codes

Four codes (`124–127`) are unassigned. This is the only headroom this
layout keeps: everywhere else, class sizes are exactly the op×mode count
that class needs (§5.2), with nothing set aside on spec. The four reserved
codes exist so a single, narrowly-scoped, *measured* addition — e.g. a
constant-synthesis op for a specific low-entropy value shape (power-of-two
masks and the like) — has somewhere to go without renumbering the rest of
the layout. They are not a general hedge against future growth; if more
than four codes' worth of addition is ever justified, that is a new
revision of this spec, not an extension of this pocket.

### 5.4 Trailing operands

| Field | Encoding |
|---|---|
| Extended immediate (`ADD`/comparison ext form, `CONST` ext form) | unsigned LEB128, 1–5 bytes |
| Register index (`LOAD`, `STORE`, and both classes' `REG_ACC`/`REG_REG` combos) | unsigned LEB128 |
| `BR_TABLE` extended case count, `TRAP` extended code, `CALL` procedure index | unsigned LEB128 |

Register indices use LEB128 rather than a fixed-width byte uniformly
across every instruction that carries one — one rule, no special case for
small frames. (Comparison's `REG_ACC` mode carries one too, same as
arithmetic's — both classes' register mode reads an operand from `rN`.)

See the Appendix — Opcode Table for the full literal expansion of this
section's formula, one row per byte value.

### 5.5 Program framing

A whole program (§2.3: a procedure table, entry at index 0) serializes as
one procedure count, one fixed-shape header row per procedure (`arg_count`
plus that procedure's own body byte length), then every procedure's
encoded body concatenated in table order:

```
program := proc_count:LEB128
           (arg_count:LEB128  body_length:LEB128){proc_count}
           (body_bytes){proc_count}
```

Header rows come first, as one block — not interleaved with bodies — so a
decoder computes every procedure's exact byte range from `body_length`
alone, without touching a single body byte until it actually wants one.
Lengths, not absolute offsets: an offset is only ever the prefix sum of
the lengths before it, so storing both would be redundant, and lengths
are what a decoder needs anyway to size a buffer or skip a body outright.

Only `arg_count` is a wire-level, core-mandated field. A procedure
header's extension fields (§2.3, §11.4) are *not* wire-encoded here, on
purpose: they're opaque to the generic core by design, and the one real
consumer measured so far (the codec extension's `o0` `TypeNode`,
docs/codec-image.md) turned out to be a build/validate-time-only value
that never needs to survive being serialized at all — nothing has ever
asked for extension header data to persist across a wire boundary. If
that changes, it's a new, symmetric hook (an `Extension.header` codec,
mirroring `Extension.codec` for opcodes) added when a real need appears,
not something reserved against speculatively here.

`CALL`'s own trailing operand (§5.4) is exactly `proc_idx` — a plain,
unbounded LEB128 procedure-table index, the same treatment `codec_idx`
gets in the codec extension's own opcodes (docs/codec-extension.md §6.4):
a procedure-table index has no small natural ceiling worth a compact form.

---

## 6. Calling Convention

On `CALL proc_idx`, let `N = procedure[proc_idx].arg_count` and `K =
max(N-1, 0)` — the number of arguments actually passed via the stack, the
last one (if `N ≥ 1`) going through `acc` instead (§4.6). The callee's
**frame base** is the caller's TOS value at the moment of the call:

```
F_callee = caller_tos_at_call
r0 .. r(K-1)   : arguments 0..(K-1)   (= caller's top K stack slots)
r(N-1)         : argument N-1         (= acc at the moment of the call, if N ≥ 1)
rN ..          : local scratch, callee's TOS starts here
```

The caller computes each of `arg0 .. arg(K-1)` into `acc` and executes
`PUSH`, in order; the top `K` slots of its stack are exactly the callee's
first `K` arguments. It then computes `arg(N-1)` into `acc` and executes
`CALL` directly, with no `PUSH` for that last argument. The caller's frame
below `F_callee` is untouched by the callee and reappears at its original
indices after the call returns.

On `RETURN`: the callee's TOS must be at its entry point (`F_callee + K`)
— otherwise a validation error (§8.1). The frame is popped, the caller's
TOS rewinds to its pre-call value (discarding the pushed argument block, if
any), and the caller resumes after the `CALL` with `acc` holding the return
value. Return is single-word; there is no multi-value return.

---

## 7. Control-Flow Semantics

### 7.1 `BR_TABLE` lowering forms

| DSL construct | `N` | Case placement |
|---|---|---|
| `if-else` | 2 | then = `case[0]`, else = `case[1]`; default unreachable |
| `if` (no else) | 1 | body = `case[0]`, reached when `acc = 0` (see complementary comparison, §7.3); default = skip |
| `switch` | variant count | each variant a case; default is the natural home for an out-of-range `trap()` |

### 7.2 `LOOP` and the do-while gap

There is no bottom-test loop. A codec that must run its body at least once
even when the condition is initially false recovers it with an explicit
first-iteration flag, OR'd into the condition block and cleared inside the
body once consumed:

```
CONST #1
STORE r_first          ; forces the first pass
LOOP
  LOAD r0               ; condition block: acc = value != 0
  NE #0
  OR r_first
BLOCK_END                ; acc=0 → exit; acc≠0 → body
  CONST #0
  STORE r_first          ; clear; harmless if repeated
  ; ...body...
BLOCK_END                ; back-edge → LOOP
```

A lowering pass may instead **peel** the first iteration (emit the body
once, unconditionally, ahead of the `LOOP`) when that trades better —
either recovery is a lowering choice, not an ISA construct.

A `LOOP`'s body block may also be closed by a terminator instead of
`BLOCK_END` — a loop that tests its condition once, then either runs its
body once and exits (via `RETURN`/`TRAP`) or falls through, never taking
the back-edge. This is a legitimate, non-cyclic use of `LOOP` purely to
host a pre-test.

### 7.3 Complementary comparison

`if`-without-`else` lowers to `BR_TABLE 1` with the body at `case[0]`,
reached when `acc = 0`. To land there, the lowerer emits the
**complementary** comparison:

| DSL condition | Emit | `acc = 0` when |
|---|---|---|
| `a < b` | `GE` | `a < b` |
| `a <= b` | `GT` | `a <= b` |
| `a > b` | `LE` | `a > b` |
| `a >= b` | `LT` | `a >= b` |
| `a == b` | `NE` | `a == b` |
| `a != b` | `EQ` | `a != b` |

(Signedness suffix per the source type.)

---

## 8. Static Validation

A conforming validator rejects a program unless all of the following hold:

### 8.1 TOS balance

At every `BLOCK_END` and `RETURN`, any TOS surplus above the enclosing
block's entry depth is implicitly dropped — the producer never emits
explicit cleanup pops; the block boundary handles it. TOS may never go
*below* the entry depth (that would mean popping a value owned by an
enclosing scope).

### 8.2 Call-graph acyclicity

The graph over literal procedure indices referenced by `CALL` must be
acyclic.

### 8.3 Stack-depth bound

Per procedure, the maximum TOS depth reached on any path — its **local
peak** — is statically computable. Across the call graph, the worst-case
total is the tight bound: at each call site, its contribution is that
site's own TOS depth at the moment of the call (relative to the callee's
frame base, §6) plus the callee's own worst-case total; the whole-program
bound is the maximum of every procedure's local peak and every call site's
contribution, computed bottom-up over the (acyclic, §8.2) call graph. This
is tighter than summing per-procedure local peaks along the longest call
chain, since a given call's own depth is frequently less than the caller's
unrelated local peak reached elsewhere in its body. A program whose bound
exceeds a target's resources is rejected by the backend (the ISA imposes no
numeric limit itself).

A second figure falls out of the same bottom-up DFS: **maximum call
depth** — the largest number of simultaneously active frames on any path,
computed the same way (each call site's depth is 1 + the callee's own
worst-case depth; the whole-program figure is the max over the acyclic
call graph). This is a different quantity from the stack-depth bound
above: a long, shallow call chain (many frames, each pushing little) has a
small TOS bound but a large call-depth figure, and a short chain with one
operand-heavy frame is the reverse. The stack-depth bound sizes a
backend's *operand* storage; call depth sizes whatever a backend uses to
remember "resume here" across a call — irrelevant to one that implements
`CALL`/`RETURN` via native recursion (the host call stack does that job
for free), but load-bearing for one that threads procedure invocation
through an explicit, non-recursive loop instead, where an array of return
records has to be sized up front. Both figures are validator return values
computed once per validation run; neither is written into the wire-format
program image.

### 8.4 Dead-code rejection

Any instruction unreachable on every control-flow path is a validation
error — in particular, anything immediately following a terminator within
the same block with no intervening control target.

### 8.5 Header and block well-formedness

For every `CALL proc_idx`: the procedure must exist, and the TOS depth
pushed since the callee's entry point must equal `max(arg_count - 1, 0)`
(§6 — the callee's last argument, if any, comes from `acc`, not the
stack). Every `BR_TABLE` opener must have exactly `N` case-closers; every `LOOP` opener
must have exactly two sub-block closers, the first always `BLOCK_END`, the
second either `BLOCK_END` or a terminator. Every `BLOCK_END` must close
some open block.

---

## 9. Resource Guarantees

A validated program is guaranteed: no heap allocation (§2.6); no runtime
stack overflow, given a backend whose resources meet the computed bound
(§8.3); no infinite recursion (the call graph is acyclic, §8.2).
**Termination is not guaranteed** — a `LOOP` whose condition block never
tests false runs indefinitely. Bounded resource usage and termination are
different guarantees; the ISA only promises the former.

---

## 10. Textual DSL

### 10.1 Overview

The DSL is a strict subset of C99: this section specifies only the delta
from C, not C's expression/statement grammar or precedence, which are
inherited unchanged. The authoring entry point is a TypeScript tagged
template: `` ir`<C-subset source>` ``, parsed by the PEG grammar at
`packages/machine/grammer.pegjs` into an AST (`ast.ts`).

### 10.2 Included

Expressions: all of C's operators with C's precedence; `=` and compound
assignment; prefix/postfix `++`/`--`; integer literals (decimal, `0x…`,
`0b…`); function calls; parenthesization. Statements: expression
statements; `if`/`else`, `while`, `for`, `switch`/`case`/`default`,
`return`; block statements `{ … }` — but *only* as the direct body of
`if`/`else`/`while`/`for` (the grammar's `ControlBody` production), never
standalone. Declarations: `u32` locals, optionally initialized. `//` and
`/* */` comments.

### 10.3 Excluded

- Pointers, arrays, `struct`/`union`/`enum`/`typedef`.
- Function *definitions* (a DSL body is one procedure's statement
  sequence; function *calls* are allowed, §10.5).
- `goto`/labels, `break`/`continue` — the ISA carries no opcode for
  irregular exit (§4.5); a loop that would `break` early folds the
  early-exit test into its condition instead.
- `do`/`while` — `LOOP` is pre-test only (§4.5, §7.2).
- **Bare block statements** — a standalone `{ ... }` not attached to a
  branch or loop. Every block the DSL can write is therefore backed by a
  real `BR_TABLE` case or `LOOP` sub-block, and so always closes via a
  real `BLOCK_END` that resets TOS (§8.1) — see ir-engine.md for why this
  matters to register allocation.
- Comma operator, casts, `sizeof`, non-integer literals, storage
  qualifiers, the preprocessor.

### 10.4 The single type rule

All values are `u32`; a declaration must spell the type name:

```
u32 x;            // ok
u32 y = 5;        // ok
u32 a, b, c;      // ok — declarator list, all u32
int x;            // rejected
```

Function parameters are also `u32`, declared out-of-band in the procedure
header (§2.3), visible as named locals from the body's first statement.

### 10.5 Function calls

Calls parse as `Identifier ( arglist )`. Three core built-ins have fixed
lowering:

| Call | Lowers to |
|---|---|
| `trap(code)` | `TRAP #code` |
| `clz(x)` | `CLZ` |
| `revbits(x)` | `REVBITS` |

`trap` is a function rather than a keyword so `return` stays the only
procedure-exit keyword. Resolution of any other call name — procedure
table entries, extension ops, codec invocations — is an application-layer
mechanism, out of scope for this document.

### 10.6 Lowering rules

| DSL construct | Lowers to |
|---|---|
| expression | instructions computing the value into `acc`, using TOS for intermediates as needed; operand addressing mode is an implementation choice, not fixed by this spec |
| `if (c) T` | `c` into `acc` (complementary comparison, §7.3); `BR_TABLE 1`, `T` at `case[0]` |
| `if (c) T else E` | `c` into `acc ∈ {0,1}`; `BR_TABLE 2`, `E` at `case[0]`, `T` at `case[1]` |
| `switch (v) { case k: … }` | `v` into `acc`; `BR_TABLE N`; out-of-range falls to the implicit default |
| `while (c) B` | `LOOP`; condition block = `c` into `acc`; `BLOCK_END`; body block = `B`; `BLOCK_END` |
| `for (init; c; inc) B` | `init`; `LOOP`; condition block = `c`; `BLOCK_END`; body block = `B` then `inc`; `BLOCK_END` |
| `return e;` / `return;` | `e` into `acc` (or unspecified); `RETURN` |
| `trap(c);` | `TRAP #c` |
| `u32 x = e;` | `e` into `acc`; `STORE` into `x`'s allocated slot |

The `for` increment always lowers to a single copy at the end of the body
block, immediately before its `BLOCK_END` — there being no `continue` to
jump around it, every path through the body reaches it exactly once per
iteration.

---

## 11. Extension Mechanism

### 11.1 The `EXT` instruction

Every byte ≥128 (§5.1) encodes one **extension opcode**: an opaque name
(owned entirely by whichever extension is active) plus a fixed-arity list
of operands. The generic core never interprets the name or the operands;
it only needs to know each opcode's *effect* (§11.2) to keep validating and
executing programs that contain them.

### 11.2 Effect declarations

For the core's own static guarantees (§8) to hold over a program containing
extension opcodes, without the validator or VM needing to know what any
particular opcode *does*, every extension opcode declares:

| Field | Meaning |
|---|---|
| TOS delta | Net TOS depth change contributed by the opcode itself. |
| Peak transient depth | The deepest TOS gets above its own entry depth while the opcode executes, even if it nets back to the same depth by the time the opcode is done. |
| Terminates? | Whether the opcode ends its enclosing block on its own, the way `RETURN`/`TRAP` do (§4.5, §8.4). |
| Call-shaped? | Whether the opcode invokes a procedure — and if so, which operand carries the resolved procedure-table index, and the callee's logical argument count, `N`. |

A call-shaped extension opcode follows the same convention as `CALL`
(§4.6, §6): only `max(N-1, 0)` of its arguments are expected on the stack,
the last (if any) having already been placed in `acc`. Its call target is
folded into the same call-graph accounting as an ordinary `CALL` for §8.2's
acyclicity check and §8.3's stack-depth bound.

A program containing an extension opcode with no matching effect
declaration is rejected — an opcode the validator has no effect
information for cannot be assumed to preserve §8's guarantees.

### 11.3 Literal operands only

Every extension opcode's operands are literal constants, resolved ahead of
execution — register indices, procedure-table indices, small handle
literals — never a value computed at runtime. This is what lets an
ahead-of-time translator implement whatever an extension opcode abstracts
away (a struct field access, a `*ptr++` read, a checksum-field patch-up)
using ordinary target-native code, rather than requiring an interpreter
loop: every operand it needs is already known at translation time.

### 11.4 Header extension fields

A procedure header's extension fields (§2.3) are opaque to the generic
core — never read or interpreted by it — and carried through unchanged for
whichever extension put them there to read back (e.g. selecting between an
encoder and a decoder ABI for the same procedure shape).

### 11.5 Call-name resolution

Resolving a call-like syntax to a specific extension opcode (as opposed to
a procedure-table `CALL`, §10.5) is an application-layer mechanism, out of
scope for this document — the same way procedure-table resolution itself
is.

---

## Appendix — Opcode Table

The complete, literal expansion of §5.2/§5.3's range assignment — every
byte value 0–127, derived mechanically from the formulas and orderings
given there (arithmetic: `op*5 + mode`; comparison: `50 + op*4 + mode`;
everything else a fixed offset). Exists so implementing an encoder/decoder
never requires re-deriving a byte value from the formulas by hand — this
table is not a separate source of truth, it's §5.2/§5.3 with the algebra
already done. Every "trailing operand" entry, when not `—`, is unsigned
LEB128 (§5.4) — no instruction's trailing data is encoded any other way.

| Byte | Mnemonic | Trailing operand |
|---|---|---|
| `0` | `ADD REG_ACC` | register index |
| `1` | `ADD REG_REG` | register index |
| `2` | `ADD PEEK_PEEK` | — |
| `3` | `ADD POP_ACC` | — |
| `4` | `ADD IMM_EXT` | immediate value |
| `5` | `SUB REG_ACC` | register index |
| `6` | `SUB REG_REG` | register index |
| `7` | `SUB PEEK_PEEK` | — |
| `8` | `SUB POP_ACC` | — |
| `9` | `SUB IMM_EXT` | immediate value |
| `10` | `RSUB REG_ACC` | register index |
| `11` | `RSUB REG_REG` | register index |
| `12` | `RSUB PEEK_PEEK` | — |
| `13` | `RSUB POP_ACC` | — |
| `14` | `RSUB IMM_EXT` | immediate value |
| `15` | `MUL REG_ACC` | register index |
| `16` | `MUL REG_REG` | register index |
| `17` | `MUL PEEK_PEEK` | — |
| `18` | `MUL POP_ACC` | — |
| `19` | `MUL IMM_EXT` | immediate value |
| `20` | `AND REG_ACC` | register index |
| `21` | `AND REG_REG` | register index |
| `22` | `AND PEEK_PEEK` | — |
| `23` | `AND POP_ACC` | — |
| `24` | `AND IMM_EXT` | immediate value |
| `25` | `OR REG_ACC` | register index |
| `26` | `OR REG_REG` | register index |
| `27` | `OR PEEK_PEEK` | — |
| `28` | `OR POP_ACC` | — |
| `29` | `OR IMM_EXT` | immediate value |
| `30` | `XOR REG_ACC` | register index |
| `31` | `XOR REG_REG` | register index |
| `32` | `XOR PEEK_PEEK` | — |
| `33` | `XOR POP_ACC` | — |
| `34` | `XOR IMM_EXT` | immediate value |
| `35` | `SHL REG_ACC` | register index |
| `36` | `SHL REG_REG` | register index |
| `37` | `SHL PEEK_PEEK` | — |
| `38` | `SHL POP_ACC` | — |
| `39` | `SHL IMM_EXT` | immediate value |
| `40` | `SHR REG_ACC` | register index |
| `41` | `SHR REG_REG` | register index |
| `42` | `SHR PEEK_PEEK` | — |
| `43` | `SHR POP_ACC` | — |
| `44` | `SHR IMM_EXT` | immediate value |
| `45` | `ASR REG_ACC` | register index |
| `46` | `ASR REG_REG` | register index |
| `47` | `ASR PEEK_PEEK` | — |
| `48` | `ASR POP_ACC` | — |
| `49` | `ASR IMM_EXT` | immediate value |
| `50` | `EQ REG_ACC` | register index |
| `51` | `EQ POP_ACC` | — |
| `52` | `EQ IMM_SMALL (#0)` | — |
| `53` | `EQ IMM_EXT` | immediate value |
| `54` | `NE REG_ACC` | register index |
| `55` | `NE POP_ACC` | — |
| `56` | `NE IMM_SMALL (#0)` | — |
| `57` | `NE IMM_EXT` | immediate value |
| `58` | `LT_S REG_ACC` | register index |
| `59` | `LT_S POP_ACC` | — |
| `60` | `LT_S IMM_SMALL (#0)` | — |
| `61` | `LT_S IMM_EXT` | immediate value |
| `62` | `LE_S REG_ACC` | register index |
| `63` | `LE_S POP_ACC` | — |
| `64` | `LE_S IMM_SMALL (#0)` | — |
| `65` | `LE_S IMM_EXT` | immediate value |
| `66` | `GT_S REG_ACC` | register index |
| `67` | `GT_S POP_ACC` | — |
| `68` | `GT_S IMM_SMALL (#0)` | — |
| `69` | `GT_S IMM_EXT` | immediate value |
| `70` | `GE_S REG_ACC` | register index |
| `71` | `GE_S POP_ACC` | — |
| `72` | `GE_S IMM_SMALL (#0)` | — |
| `73` | `GE_S IMM_EXT` | immediate value |
| `74` | `LT_U REG_ACC` | register index |
| `75` | `LT_U POP_ACC` | — |
| `76` | `LT_U IMM_SMALL (#0)` | — |
| `77` | `LT_U IMM_EXT` | immediate value |
| `78` | `LE_U REG_ACC` | register index |
| `79` | `LE_U POP_ACC` | — |
| `80` | `LE_U IMM_SMALL (#0)` | — |
| `81` | `LE_U IMM_EXT` | immediate value |
| `82` | `GT_U REG_ACC` | register index |
| `83` | `GT_U POP_ACC` | — |
| `84` | `GT_U IMM_SMALL (#0)` | — |
| `85` | `GT_U IMM_EXT` | immediate value |
| `86` | `GE_U REG_ACC` | register index |
| `87` | `GE_U POP_ACC` | — |
| `88` | `GE_U IMM_SMALL (#0)` | — |
| `89` | `GE_U IMM_EXT` | immediate value |
| `90` | `NEG` | — |
| `91` | `NOT` | — |
| `92` | `CLZ` | — |
| `93` | `REVBITS` | — |
| `94` | `BLOCK_END` | — |
| `95` | `LOOP` | — |
| `96` | `BR_TABLE (1 case)` | — |
| `97` | `BR_TABLE (2 cases)` | — |
| `98` | `BR_TABLE-ext` | case count |
| `99` | `CALL` | procedure index |
| `100` | `RETURN` | — |
| `101` | `TRAP (#0)` | — |
| `102` | `TRAP-ext` | code |
| `103` | `PUSH` | — |
| `104` | `POP` | — |
| `105` | `LOAD` | register index |
| `106` | `STORE` | register index |
| `107` | `CONST-ext` | value |
| `108` | `CONST #0` | — |
| `109` | `CONST #1` | — |
| `110` | `CONST #2` | — |
| `111` | `CONST #3` | — |
| `112` | `CONST #4` | — |
| `113` | `CONST #5` | — |
| `114` | `CONST #6` | — |
| `115` | `CONST #7` | — |
| `116` | `CONST #8` | — |
| `117` | `CONST #9` | — |
| `118` | `CONST #10` | — |
| `119` | `CONST #11` | — |
| `120` | `CONST #12` | — |
| `121` | `CONST #13` | — |
| `122` | `CONST #14` | — |
| `123` | `CONST #15` | — |
| `124` | reserved | — |
| `125` | reserved | — |
| `126` | reserved | — |
| `127` | reserved | — |

---

## Appendix — Worked Example

`u32 leb128_len(u32 v)` — count the bytes a LEB128 encoding of `v` would
take. Exercises a loop, shift, comparison, and increment.

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

Lowering (register 0 = `v`, register 1 = `n`):

```
CONST #1
STORE 1                  ; n = 1
LOOP
  LOAD 0                 ; condition block
  GE_U #0x80              ; acc = (v >= 0x80)
BLOCK_END                  ; acc=0 → exit; acc≠0 → body
  LOAD 0
  SHR #7                   ; acc = v >> 7 (arithmetic combo #5, immediate/extended)
  STORE 0                  ; v = acc
  CONST #1
  ADD 1                    ; acc = 1 + n
  STORE 1                  ; n = acc
BLOCK_END                  ; back-edge
LOAD 1
RETURN
```

`n = n + 1` could instead fold to `CONST #1; ADD 1 → 1` (arithmetic combo
#2, register write-back) — one instruction shorter, since the write-back
combo lets the ALU op store directly into `n`'s own register instead of
routing back through `acc` and a separate `STORE`. Both are valid; a
lowerer picks whichever is cheaper.

```
	[tos] (isa R0): r4 
	[tos] (isa R1): r1, [tos - 1] (isa R0): r4
	[tos] (isa R2): r6, [tos - 1] (isa R1): r5, [tos - 2] (isa R0): r4
	[tos] (isa R3): r7, [tos - 1] (isa R2): r6, [tos - 2] (isa R1): r5, [tos - 3] (isa R0): r4
	[tos] (isa R4): r4, [tos - 1] (isa R3): r7, [tos - 2] (isa R2): r6, [tos - 3] (isa R1): r5, [tos - 4] (isa R0): op stack top
    ...
```