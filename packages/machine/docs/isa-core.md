# Generic Core ISA

> **Status:** normative spec, the *what*. Rationale for the non-obvious
> choices: [isa-rationale.md](./isa-rationale.md). §11 specifies how a
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
(`BR_TABLE`, `LOOP`) and two terminators (`RETURN`, `TRAP`) cover
everything the source DSL can express. There are no arbitrary jumps and no
`break`/`continue`.

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

`SHL`/`SHR`/`ASR` take the shift amount as the operand, masked to 5 bits
(mod 32). There is no `DIV`/`MOD`: division essentially never appears in
codec arithmetic and many microcontrollers lack hardware support, so a
program needing it calls a software helper procedure.

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
| `CLZ` | count leading zeros (0-32) |
| `REVBITS` | reverse bit order (32-bit width) |

`CTZ` has no dedicated op: `CTZ(x) = CLZ(REVBITS(x))`.

### 4.4 Move-class

Plain data movement, no ALU combining, for the *unfused* case. An
arithmetic op that also needs a register operand uses its own register-mode
combo (§4.1 #1/#2) and needs no `LOAD` first.

| Op | Effect | Trailing |
|---|---|---|
| `PUSH` | `[tos++] = acc` | none |
| `POP` | `acc = [--tos]` | none |
| `LOAD` | `acc = rN` | LEB128 register index |
| `STORE` | `rN = acc` | LEB128 register index |
| `CONST #k` (small) | `acc = k`, `k ∈ 0..15` | none (`k` inline in opcode) |
| `CONST #imm` (extended) | `acc = imm` | LEB128 `u32` |

`PUSH` is how a call's non-last arguments (§4.6, §6) and expression
temporaries reach the stack; §4.1 has no push-mode combo of its own.
`CONST` is the only way to get an arbitrary constant into `acc`.

Four codes in this class's range (§5.2) are reserved rather than assigned
to `CONST #16..#19` (§5.3).

### 4.5 Control-flow ops

Two block openers, one universal closer, two terminators. No operand
carries a branch offset; every target follows from static block nesting.

**`BR_TABLE N`** dispatches on `acc`. `acc < N` executes `case[acc]`;
`acc ≥ N` executes no case (the **implicit default**). Either way control
falls through to after the construct. `N` is a literal case count.
`if`/`if-else`/`switch` all lower to this (§7.1).

**`LOOP`** opens **two** nested sub-blocks in fixed order, each closed by
its own `BLOCK_END`:

```
LOOP
  <condition block>      ; leaves a continue/exit decision in acc
BLOCK_END                ; acc=0 → exit past the next BLOCK_END; acc≠0 → body
  <body block>
BLOCK_END                ; unconditional back-edge → LOOP
```

Pre-test only: the condition block always runs at least once, so zero body
iterations is possible. There is no bottom-test (`do-while`) form; §7.2
gives the recovery idiom.

**`BLOCK_END`** closes the innermost open block. Its meaning depends on
what it closes: unconditional fall-through for a `BR_TABLE` case,
conditional exit-or-continue for a `LOOP` condition block, unconditional
back-edge for a `LOOP` body block. One opcode, three meanings,
disambiguated purely by block nesting.

**`RETURN`** ends the procedure; `acc` is the return value; the frame is
popped.

**`TRAP #code`** ends the procedure abnormally with an opaque error code
(`0` is unreachable/panic by convention; the rest of the space is
host-defined). Both terminators exit the procedure: no `BLOCK_END` after
either is needed or valid, and no instruction may follow one within the
same block (§8.4).

There is no `break`, `continue` or other in-procedure re-target. The only
early way out of a running `LOOP` is a terminator reached from inside it,
or the condition block testing false on a later iteration.

### 4.6 Procedure invocation

**`CALL proc_idx`** invokes `procedure[proc_idx]`. Let
`N = procedure[proc_idx].arg_count`. The caller pushes (via `PUSH`, §4.4)
the first `N-1` arguments in order; the *last* argument (if `N ≥ 1`) stays
in `acc`, which the call clobbers anyway with the return value. Together
these become `r0..r(N-1)` in the callee's frame (§6). The return value
comes back in `acc`; the caller's TOS rewinds to discard the pushed
argument block on return.

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
| `90-93` | Unary (§4.3) | `code − 90` selects `NEG, NOT, CLZ, REVBITS` |
| `94-98` | Local flow control | `code − 94` selects `BLOCK_END, LOOP, BR_TABLE#1, BR_TABLE#2, BR_TABLE-ext` |
| `99-102` | Global flow control | `code − 99` selects `CALL, RETURN, TRAP#0, TRAP-ext` |
| `103-123` | Move/const (§4.4) | `code − 103` selects `PUSH, POP, LOAD, STORE, CONST-ext, CONST#0..CONST#15` |
| `124-127` | Reserved | unassigned (§5.3) |

Op ordering within the two flat-indexed classes: arithmetic is `ADD, SUB,
RSUB, MUL, AND, OR, XOR, SHL, SHR, ASR` (0-9); comparison is `EQ, NE,
LT_S, LE_S, GT_S, GE_S, LT_U, LE_U, GT_U, GE_U` (0-9). Mode ordering:
arithmetic `REG_ACC, REG_REG, PEEK_PEEK, POP_ACC, IMM_EXT` (0-4);
comparison `REG_ACC, POP_ACC, IMM_SMALL, IMM_EXT` (0-3).

This uses 124 of 128 core codes; see §5.3. The Appendix expands the
formulas into one row per byte value.

The formulas above describe the numbering, not a required algorithm — §5.1's
static table is equally normative, and on a target without a hardware
divider it is the only sane choice: `jit-armv6m` decodes through a
108-entry table precisely because `code / 5` and `code % 5` otherwise
compile to two libgcc `__udivsi3` calls per instruction decoded. A decoder
is free to pick either; `jit-armv6m/compiler/test/host/test_decode_encode.cpp`
checks its table against these formulas for every assigned opcode.

### 5.3 Reserved codes

Codes `124-127` are unassigned, the only headroom in this layout:
everywhere else a class is exactly its op × mode count. They exist so one
narrowly-scoped, *measured* addition (a constant-synthesis op for
low-entropy value shapes such as power-of-two masks, say) can land without
renumbering. Anything larger than four codes' worth is a new revision of
this spec, not an extension of this pocket.

### 5.4 Trailing operands

| Field | Encoding |
|---|---|
| Extended immediate (arithmetic/comparison ext form, `CONST` ext form) | unsigned LEB128, 1-5 bytes |
| Register index (`LOAD`, `STORE`, both classes' `REG_ACC`/`REG_REG` combos) | unsigned LEB128 |
| `BR_TABLE` extended case count, `TRAP` extended code, `CALL` procedure index | unsigned LEB128 |

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
terminator seen back at nesting depth zero is guaranteed to be the body's
own last byte — a decoder derives that boundary by tracking open
`LOOP`/`BR_TABLE` nesting the same way any consumer already has to
(§7.1/§7.2), never from a stored length. §7.2's own allowance — a `LOOP`
body block closed by a bare terminator instead of `BLOCK_END` — is the one
wrinkle: that terminator closes its enclosing `loopBody` frame too, so a
decoder tracks frame *kind*, not just a nesting count, to tell "this ends
the procedure" apart from "this closes an inner loop; the outer scope's
own bytes continue right after it."

`arg_count` is the only core-mandated wire-level header field. A
procedure header's extension fields (§2.3, §11.4) are not wire-encoded:
they are opaque to the core, and the one real consumer so far (the codec
extension's `o0` `TypeNode`) is a build/validate-time value resolved before
serialization. Persisting extension header data would take a symmetric
`Extension.header` codec hook mirroring `Extension.codec`, added when a
real need appears.

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

| DSL construct | `N` | Case placement |
|---|---|---|
| `if-else` | 2 | then = `case[0]`, else = `case[1]`; default unreachable |
| `if` (no else) | 1 | body = `case[0]`, reached when `acc = 0` (complementary comparison, §7.3); default = skip |
| `switch` | variant count | each variant a case; default is the natural home for an out-of-range `trap()` |

### 7.2 `LOOP` and the do-while gap

There is no bottom-test loop. A codec whose body must run at least once
even when the condition is initially false uses an explicit
first-iteration flag, OR'd into the condition block and cleared inside the
body:

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

A lowering pass may instead **peel** the first iteration, emitting the
body once unconditionally ahead of the `LOOP`. Either recovery is a
lowering choice, not an ISA construct.

A `LOOP`'s body block may also be closed by a terminator instead of
`BLOCK_END`: a loop that tests its condition once, then either runs its
body once and exits via `RETURN`/`TRAP` or falls through, never taking the
back-edge. This is a legitimate non-cyclic use of `LOOP` purely to host a
pre-test.

### 7.3 Complementary comparison

`if`-without-`else` lowers to `BR_TABLE 1` with the body at `case[0]`,
reached when `acc = 0`. To land there the lowerer emits the
**complementary** comparison:

| DSL condition | Emit | `acc = 0` when |
|---|---|---|
| `a < b` | `GE` | `a < b` |
| `a <= b` | `GT` | `a <= b` |
| `a > b` | `LE` | `a > b` |
| `a >= b` | `LT` | `a >= b` |
| `a == b` | `NE` | `a == b` |
| `a != b` | `EQ` | `a != b` |

Signedness suffix per the source type.

---

## 8. Static Validation

A conforming validator rejects a program unless all of the following hold.

### 8.1 TOS balance

At every `BLOCK_END` and `RETURN`, any TOS surplus above the enclosing
block's entry depth is implicitly dropped: the producer emits no explicit
cleanup pops, the block boundary handles it. TOS may never go *below* the
entry depth, which would mean popping a value owned by an enclosing scope.

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

Any instruction unreachable on every control-flow path is a validation
error, in particular anything following a terminator within the same block
with no intervening control target.

### 8.5 Header and block well-formedness

For every `CALL proc_idx`: the procedure must exist, and the TOS depth
pushed since the callee's entry point must equal `max(arg_count - 1, 0)`
(§6). Every `BR_TABLE` opener must have exactly `N` case-closers. Every
`LOOP` opener must have exactly two sub-block closers, the first always
`BLOCK_END`, the second either `BLOCK_END` or a terminator. Every
`BLOCK_END` must close some open block.

### 8.6 Register liveness

A register index is valid to reference via `LOAD`, `STORE` or a
`REG_ACC`/`REG_REG` register operand only once TOS has grown past it:
`target < tos` at that instruction, where `tos` counts both the frame's
`arg_count` initial slots (valid from procedure entry) and whatever
`PUSH`es have run since.

§8.1's TOS balance does not imply this: it bounds
`PUSH`/`POP`/peek/pop-combo/`CALL` against a block's entry depth and never
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

---

## 9. Resource Guarantees

A validated program is guaranteed no heap allocation (§2.6), no runtime
stack overflow given a backend meeting the computed bound (§8.3), and no
infinite recursion (§8.2). **Termination is not guaranteed**: a `LOOP`
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

Expressions: all of C's operators with C's precedence; `=` and compound
assignment; prefix/postfix `++`/`--`; integer literals (decimal, `0x…`,
`0b…`); function calls; parenthesization. Statements: expression
statements; `if`/`else`, `while`, `for`, `switch`/`case`/`default`,
`return`; block statements `{ … }` as the direct body of
`if`/`else`/`while`/`for` (the grammar's `ControlBody` production).
Declarations: `u32` locals, optionally initialized. `//` and `/* */`
comments.

### 10.3 Excluded

- Pointers, arrays, `struct`/`union`/`enum`/`typedef`.
- Function *definitions* (a DSL body is one procedure's statement
  sequence); function *calls* are allowed (§10.5).
- `goto`/labels, `break`/`continue`: the ISA carries no opcode for
  irregular exit (§4.5), so a loop that would `break` early folds the
  early-exit test into its condition.
- `do`/`while`: `LOOP` is pre-test only (§4.5, §7.2).
- **Bare block statements**, a standalone `{ ... }` not attached to a
  branch or loop. Every block the DSL can write is therefore backed by a
  real `BR_TABLE` case or `LOOP` sub-block, and always closes via a real
  `BLOCK_END` that resets TOS (§8.1). isa-rationale.md covers why this
  matters to register allocation.
- Comma operator, casts, `sizeof`, non-integer literals, storage
  qualifiers, the preprocessor.

### 10.4 The single type rule

All values are `u32`; a declaration must spell the type name:

```
u32 x;            // ok
u32 y = 5;        // ok
u32 a, b, c;      // ok, declarator list, all u32
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
procedure-exit keyword. Resolving any other call name (procedure table
entries, extension ops, codec invocations) is an application-layer
mechanism, out of scope here.

### 10.6 Lowering rules

| DSL construct | Lowers to |
|---|---|
| expression | instructions computing the value into `acc`, using TOS for intermediates as needed; operand addressing mode is an implementation choice |
| `if (c) T` | `c` into `acc` (complementary comparison, §7.3); `BR_TABLE 1`, `T` at `case[0]` |
| `if (c) T else E` | `c` into `acc ∈ {0,1}`; `BR_TABLE 2`, `E` at `case[0]`, `T` at `case[1]` |
| `switch (v) { case k: … }` | `v` into `acc`; `BR_TABLE N`; out-of-range falls to the implicit default |
| `while (c) B` | `LOOP`; condition block = `c` into `acc`; `BLOCK_END`; body block = `B`; `BLOCK_END` |
| `for (init; c; inc) B` | `init`; `LOOP`; condition block = `c`; `BLOCK_END`; body block = `B` then `inc`; `BLOCK_END` |
| `return e;` / `return;` | `e` into `acc` (or unspecified); `RETURN` |
| `trap(c);` | `TRAP #c` |
| `u32 x = e;` | `e` into `acc`; `STORE` into `x`'s allocated slot |

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
| `92` | `CLZ` | none |
| `93` | `REVBITS` | none |
| `94` | `BLOCK_END` | none |
| `95` | `LOOP` | none |
| `96` | `BR_TABLE (1 case)` | none |
| `97` | `BR_TABLE (2 cases)` | none |
| `98` | `BR_TABLE-ext` | case count |
| `99` | `CALL` | procedure index |
| `100` | `RETURN` | none |
| `101` | `TRAP (#0)` | none |
| `102` | `TRAP-ext` | code |
| `103` | `PUSH` | none |
| `104` | `POP` | none |
| `105` | `LOAD` | register index |
| `106` | `STORE` | register index |
| `107` | `CONST-ext` | value |
| `108` | `CONST #0` | none |
| `109` | `CONST #1` | none |
| `110` | `CONST #2` | none |
| `111` | `CONST #3` | none |
| `112` | `CONST #4` | none |
| `113` | `CONST #5` | none |
| `114` | `CONST #6` | none |
| `115` | `CONST #7` | none |
| `116` | `CONST #8` | none |
| `117` | `CONST #9` | none |
| `118` | `CONST #10` | none |
| `119` | `CONST #11` | none |
| `120` | `CONST #12` | none |
| `121` | `CONST #13` | none |
| `122` | `CONST #14` | none |
| `123` | `CONST #15` | none |
| `124` | `reserved` | none |
| `125` | `reserved` | none |
| `126` | `reserved` | none |
| `127` | `reserved` | none |

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

Lowering (register 0 = `v`, register 1 = `n`):

```
CONST #1
STORE 1                  ; n = 1
LOOP
  LOAD 0                 ; condition block
  GE_U #0x80             ; acc = (v >= 0x80)
BLOCK_END                ; acc=0 → exit; acc≠0 → body
  LOAD 0
  SHR #7                 ; acc = v >> 7 (arithmetic combo #5, immediate/extended)
  STORE 0                ; v = acc
  CONST #1
  ADD 1                  ; acc = 1 + n
  STORE 1                ; n = acc
BLOCK_END                ; back-edge
LOAD 1
RETURN
```

`n = n + 1` can instead fold to `CONST #1; ADD 1 → 1` (arithmetic combo #2,
register write-back), one instruction shorter: the write-back combo stores
directly into `n`'s register instead of routing through `acc` and a
separate `STORE`. Both are valid; a lowerer picks whichever is cheaper.
