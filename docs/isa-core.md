# Embedded IR Engine — Generic Core ISA

> **Status:** Normative draft. Defines the reusable Generic Core instruction
> set. Domain-specific extensions (codec stream I/O, target accessors, codec
> invocation) are defined in the companion Codec Specification. The
> [IR Engine Rationale][ir-engine] documents the *why* behind these decisions;
> this document is the *what*.

[ir-engine]: ./ir-engine.md

---

## Part I — Overview

### 1. Introduction

#### 1.1 Purpose

The Generic Core defines a small, statically analyzable instruction set for a
TOS-hybrid accumulator machine. It is designed to be:

- **Portable** — encodes procedures that can be AOT-compiled, JIT-evaluated, or
  interpreted on any conforming target, including resource-constrained
  microcontrollers.
- **Compact** — the on-wire size of a procedure is the overriding design
  metric; backend execution cost is explicitly *not* a constraint.
- **Statically analyzable** — every procedure's stack depth, termination, and
  resource footprint is computable at compile time.
- **Zero-allocation** — conforming code never allocates heap memory at run
  time; all storage is bounded by statically known sizes.

The Generic Core contains **no domain-specific concepts**. It is a reusable
substrate for any domain that compiles to its abstract operations.

#### 1.2 Extensions and companions

The Generic Core is deliberately incomplete as a serialization tool. Two
mechanisms layer domain-specific capability on top, without modifying the core:

- **Instruction extensions** add new opcodes in a reserved opcode-space region
  (see §17.3). Each extension opcode publishes a declared-effect summary so the
  core's verifier, allocator, and codegen treat it as an opaque-with-effects
  leaf.
- **Procedure-header extensions** add new fields to the procedure header. The
  core header is fixed (§5.2); extensions MAY append further fields. One such
  extension is the **ABI-kind field** defined by the Codec Specification, which
  selects between encoder-side and decoder-side instruction interpretations.

The Codec Specification is the primary companion document. It defines stream
I/O, target object access, codec invocation, and the codec ABI. A
Generic-Core-only implementation claims conformance to this document alone; a
codec implementation claims conformance to both.

#### 1.3 Architectural summary

A program is a **procedure table**: an indexed array of **procedures**, each
with a fixed header and a body of instructions. Execution begins at a
designated entry procedure and proceeds sequentially, modified by structured
control-flow constructs.

The machine has a single implicit **accumulator** (`acc`), an **infinite
logical register file** addressed by index, and a **top-of-stack (TOS)
pointer** that indirects into the register file to provide push/pop/peek
access. All storage is statically bounded per procedure; the worst-case stack
depth across a call graph is computable at compile time.

Control flow is **structured**: there are no arbitrary jumps. Two block
constructs (`BR_TABLE`, `LOOP`) and four terminators (`RETURN`, `TRAP`,
`BREAK`, `CONTINUE`) cover all control flow expressible in the source DSL.

---

### 2. The Abstract Machine

#### 2.1 Execution model

A procedure executes sequentially from its first instruction. The only
deviations from sequential flow are:

- **Block constructs** (`BR_TABLE`, `LOOP`) conditionally dispatch or iterate
  over a body of nested instructions (§14).
- **Procedure invocation** (`CALL`) transfers control to another procedure and
  resumes the caller when the callee returns (§13).
- **Terminators** (`RETURN`, `TRAP`) end the procedure; `BREAK`/`CONTINUE`
  re-target control within the enclosing `LOOP` (§11, §14).

There is no instruction pointer exposed to programs; branch targets are
determined statically by block nesting.

#### 2.2 Storage

The machine has the following storage. All are logical; the backend maps them
to physical registers, stack slots, or memory as it chooses.

| Storage | Description |
|---------|-------------|
| **`acc`** | The accumulator. Implicit operand-1 of every binary operation; implicit source/destination of most operations. Word-sized (§3.1). |
| **Register file** | A logical array `r0, r1, r2, …` indexed from 0. Holds named locals and intermediate values. Word-sized entries. Addressed by index in register-mode operands. |
| **TOS pointer** | A logical index into the register file, used as an indirect address with three modes: push `[tos++]`, pop `[--tos]`, peek `[tos-1]` (§4.3). |

The register file and TOS pointer share a single logical address space: TOS
operations are indirect accesses into the register file. There is no separate
operand stack.

A **frame** (§4.4) is a contiguous region of the register file owned by one
procedure invocation. A procedure's view of the register file is its frame;
register indices in instructions are frame-relative.

#### 2.3 Programs

A program is a **procedure table** — an indexed array of procedures. Each
procedure has the structure:

```
procedure = header + body
header    = { arg_count, ...extension-fields }
body      = instruction*
```

- **`arg_count`** (§5.2): the number of value arguments the procedure expects,
  visible as `r0..r(N-1)` in its frame.
- **Body**: a sequence of instructions forming the procedure's control flow.
  The body must end with a terminator (`RETURN` or `TRAP`); execution reaching
  the end without a terminator is a validation error.

Procedure invocations (`CALL`) reference procedures by **procedure index** —
a literal into the procedure table. Indices are statically resolvable; there
is no dynamic dispatch.

#### 2.4 Static guarantees

Every conforming program satisfies:

1. **TOS balance.** Every block construct and every procedure body enters and
   exits with the same TOS depth (§15.1).
2. **Bounded stack depth.** The call graph's worst-case register-file depth is
   statically computable (§16.2). No run-time stack overflow is possible in a
   validated program.
3. **Termination.** The call graph (over literal procedure indices) is
   acyclic. A cyclic call graph is a validation error. How the authoring
   layer guarantees this is out of scope for the ISA; the IR is accepted or
   rejected on the property, not on its provenance.
4. **No heap allocation.** No core instruction allocates memory.

A validator that accepts a program certifies all four. Implementation-defined
runtime limits (e.g. physical register count) are the backend's concern, not
the ISA's.

---

## Part II — Concepts

This part introduces the vocabulary used throughout the rest of the
specification.

### 3. Values and Types

The Generic Core operates on a single value type: the **word**.

#### 3.1 Integers

A word is a **32-bit unsigned integer** (`u32`). All storage — the
accumulator, the register file, and immediate operands — holds words.

The 32-bit pattern may be interpreted as **signed** (two's complement) or
**unsigned** depending on the operation. Operations that are sensitive to
signedness come in signed and unsigned variants; operations that are not
(bitwise logic, addition, subtraction, multiplication's low word) are
sign-agnostic. The specific variants are defined in the Instruction Reference
(Part III).

> 32 bits is a fixed design choice for this ISA, not a parameter. The niche
> target domain does not require wider integers.

#### 3.2 Booleans

A boolean is represented as a word with value `0` (false) or `1` (true).
Comparison operations (§9) produce booleans; control-flow constructs (§14)
that test the accumulator interpret any non-zero value as true and zero as
false (the **lenient test**).

The lenient test means a comparison result can feed a control-flow construct
directly, without a normalization step. A non-boolean value (e.g. a count, a
tag) may also feed a control-flow construct directly when "non-zero means
continue" is the desired semantics.

#### 3.3 Immediates

An **immediate** is a literal integer encoded inline in the instruction stream.
Immediates are `u32` values. They appear in two roles:

- As the **source operand** of an `imm`-mode operation (§6.1), providing a
  constant to ALU, comparison, or MOVE operations without a separate load.
- As a **parameter** of certain instructions (e.g. `TRAP`'s error code,
  `BR_TABLE`'s case count, `CALL`'s procedure index).

The immediate encoding has two forms:

| Form | Range | Encoding |
|------|-------|----------|
| **Small** | a narrow range centered on the most common constants (`0, 1, 2, 4, …`) | Packed inline with the opcode (3–4 bits). The exact range is a layout-time decision (§17). |
| **Extended** | any `u32` | Trailing LEB128 immediately after the opcode/operand fields. |

The small form exists because small constants dominate: zero (accumulator
init, zero-compare), one (increments, flags), two and four (byte widths),
powers of two (masks, shift amounts). The inline encoding keeps these in a
single byte.

---

### 4. Storage Model

#### 4.1 Accumulator (`acc`)

The accumulator is the implicit operand-1 of every binary operation and the
implicit source or destination of most other operations. It holds a word.

Every binary ALU and comparison operation has the form:

```
result = acc ⟨op⟩ other_operand
```

where `other_operand` is supplied by the instruction's addressing mode (§6).
The result's destination is also determined by the addressing mode.

Unary operations operate on `acc` in place: `acc = op(acc)`.

#### 4.2 Register file

The register file is a logical array of word-sized slots, indexed from zero:
`r0, r1, r2, …`. There is no fixed upper bound on the number of registers a
procedure may address; the backend maps logical indices to physical registers
or stack slots.

Register indices in instructions are **frame-relative** (§4.4): `r0` in a
procedure refers to the first slot of that procedure's frame, not a global
register.

Named locals, loop counters, and intermediate values all live in the register
file. There is no separate load/store instruction for locals — the
register-mode operand addresses them directly (§6.1).

#### 4.3 TOS pointer

The **top-of-stack pointer** (`tos`) is a logical index into the register
file. It provides three indirect addressing modes:

| Mode | Notation | Effect | Capability |
|------|----------|--------|------------|
| **Push** | `[tos++]` | Write to `r[tos]`, then increment `tos` | Write-only |
| **Pop** | `[--tos]` | Decrement `tos`, then read from `r[tos]` | Read-only |
| **Peek** | `[tos-1]` | Read/write `r[tos-1]` without changing `tos` | Read-write |

Push and pop manipulate the same logical stack; peek accesses the top element
in place. Because TOS lives inside the register file, a pushed value can later
be accessed by its register index (once the backend allocates one), and a
register-stored value can be peeked or popped if it is at the current TOS.

The TOS pointer is per-frame (§4.4): each procedure invocation has its own
TOS entry point.

#### 4.4 Frames

A **frame** is the region of the register file visible to one procedure
invocation. When a procedure begins execution (whether the program entry or a
called procedure), it is given a frame whose layout is:

```
r0 .. r(N-1)    : arguments (N = arg_count from the procedure header)
rN ..           : local scratch (allocated by the backend)
```

The frame base `F` is the logical index at which the frame begins. The TOS
entry point for the frame is `F + N` — the first free slot above the arguments.
The procedure pushes and pops above this point.

The caller's frame and the callee's frame occupy disjoint regions of the
register file. The exact frame-base computation is part of the calling
convention (§13); the key invariant is that a procedure never addresses
storage outside its own frame.

---

### 5. Procedures

#### 5.1 Structure

A procedure consists of a **header** and a **body**:

```
header = { arg_count, ...extension-fields }
body   = instruction*
```

The body is a linear sequence of instructions. Control flow within the body is
structured: block constructs (`BR_TABLE`, `LOOP`) nest; every block has a
determined closer (§14). The body must end with a procedure-exiting
terminator (`RETURN` or `TRAP`).

#### 5.2 Header fields

The Generic Core defines one header field:

| Field | Type | Description |
|-------|------|-------------|
| `arg_count` | `u32` | Number of value arguments. Arguments are visible as `r0..r(arg_count−1)` in the procedure's frame (§4.4). |

The header is **extensible**: extensions MAY append additional fields. The
Generic Core does not interpret extension fields. One such extension is the
ABI-kind field defined by the Codec Specification, which selects how
extension opcodes in the body are interpreted.

#### 5.3 Procedure table and indices

Procedures are collected in a **procedure table** — an indexed array. The
`CALL` instruction (§12) takes a **procedure index**: a literal `u32` that
selects an entry from the table.

Procedure indices are statically resolvable. There is no indirect call, no
function pointer, and no dynamic dispatch in the Generic Core.

---

### 6. Addressing Modes

Addressing modes specify how an instruction locates its "other operand" (the
operand that is not the accumulator) and where the result is written. The
mode determines both the operand source and the result destination.

#### 6.1 The five modes

| Mode | Operand source | Notation |
|------|---------------|----------|
| **Register** | Register file slot `rN` | `rN` |
| **Peek** | Top-of-stack in place | `[tos-1]` |
| **Pop** | Pop from TOS (pre-decrement) | `[--tos]` |
| **Push** | Push to TOS (post-increment) | `[tos++]` |
| **Immediate** | Inline literal | `imm` |

The **register** mode carries a register index `N` as an operand. The
**immediate** mode carries an inline literal (small or extended — §3.3). The
peek, pop, and push modes take no explicit operand; they implicitly address
the TOS.

#### 6.2 Read/write capability

Each mode has a fixed capability:

| Mode | Can read? | Can write? | Result destination forced? |
|------|-----------|------------|---------------------------|
| Register | Yes | Yes | No — result can go to `acc` or back to `rN` |
| Peek | Yes | Yes | No — result can go to `acc` or back to `[tos-1]` |
| Pop | Yes | No | Yes — result cannot target the popped slot |
| Push | No | Yes (result only) | Yes — result goes to `[tos++]` |
| Immediate | Yes | No | Yes — result goes to `acc` |

Modes that are read-only (pop, immediate) or write-only (push) force the
result destination. This eliminates semantically invalid combinations and
saves encoding bits.

#### 6.3 The seven valid combinations

For a binary-class instruction (two inputs: `acc` and the addressed operand;
one output), the valid (mode × result-destination) combinations are:

| # | Mode | Operand from | Result to | Example |
|---|------|-------------|-----------|---------|
| 1 | register | `rN` | `acc` | `acc = acc + rN` |
| 2 | register | `rN` | `rN` | `rN = acc + rN` |
| 3 | peek | `[tos-1]` | `acc` | `acc = acc + peek` |
| 4 | peek | `[tos-1]` | `[tos-1]` | `peek = acc + peek` |
| 5 | pop | `[--tos]` | `acc` | `acc = acc + pop` |
| 6 | peek+push | `[tos-1]` | `[tos++]` | `[tos++] = acc + [tos-1]` (RPN) |
| 7 | immediate | `imm` | `acc` | `acc = acc + imm` |

That is **seven combinations**. The eliminated cases — pop with result-to-pop,
push with result-to-acc, immediate with result-to-register — are semantically
invalid and carry no encoding bits.

> **Combination 6 is the pure-stack RPN form.** It reads the top of stack
> (`[tos-1]`) as the second operand and pushes the result (`[tos++]`),
> yielding `[tos++] = acc ⟨op⟩ [tos-1]`. This consumes the top of stack in
> place (the old `[tos-1]` is now below the new top) and is the natural
> building block for RPN expression evaluation — one byte per node. For
> `MOVE` (the identity), combination 6 degenerates to unary-push of `acc`
> (≡ `DUP`): no second operand is read, `acc` is simply pushed.

Two subsumptions follow from the table:

- **`DUP`** (push the accumulator) is combination 6 with the identity
  operation (`MOVE`) — the degenerate no-second-operand case.
- **Constant load** (`acc = imm`) is combination 7 with the identity
  operation (`MOVE`). No dedicated opcode.

Comparison-class instructions use only the **read-capable** modes (register,
peek, pop, immediate — four modes), because the result always goes to `acc`
as a boolean. Their valid combinations are a subset of the above: #1, #3, #5,
#7.

---

## Part III — Instruction Reference

This part normatively defines each instruction class: its operations, valid
addressing-mode combinations, and semantics. Concrete byte layout is deferred
to Part V; here we specify only the abstract operations and their operand
shapes.

### 7. Instruction Format

#### 7.1 Class organization

Instructions are grouped into classes by their operand-mode shape. A class
shares an opcode-space region and a result-destination encoding:

* Binary (§8)
* Comparison (§9)
* Unary (§10)
* Control (§11)
* Procedure invocation (§12)

The encoding into byte sequences is specified in Part V.

#### 7.2 Operand notation

Throughout this part, operands are written as:

```
OP ⟨mode⟩⟨operand⟩ [→ result-destination]
```

- **`OP`** is the operation mnemonic.
- **⟨mode⟩⟨operand⟩** specifies the "other operand" via one of the five
  addressing modes (§6): `rN` (register), `[tos-1]` (peek), `[--tos]` (pop),
  `[tos++]` (push), `#imm` (immediate — `#` prefix denotes a literal).
- **`→ result-destination`** specifies where the result goes, when not
  implicit. `→ acc` is the default and is usually omitted. `→ rN` or
  `→ [tos-1]` are the in-place write-back forms.

The accumulator (`acc`) is always an implicit operand and the implicit default
result destination; it is not written in the operand list.

---

### 8. Binary-Class

Binary-class instructions have two inputs (`acc` and the addressed operand) and
one output. They use all seven addressing-mode combinations (§6.3).

#### 8.1 Operations

| Mnemonic | Semantics | Sign |
|----------|-----------|------|
| `ADD` | `acc + operand` | agnostic |
| `SUB` | `acc − operand` | agnostic |
| `RSUB` | `operand − acc` | agnostic |
| `MUL` | `(acc × operand) mod 2³²` (low word) | agnostic |
| `AND` | `acc & operand` (bitwise) | n/a |
| `OR` | `acc \| operand` (bitwise) | n/a |
| `XOR` | `acc ^ operand` (bitwise) | n/a |
| `SHL` | `acc << operand` (left shift; vacated bits zero) | n/a |
| `SHR` | `acc >> operand` (logical right shift; vacated bits zero) | unsigned |
| `ASR` | `acc >>> operand` (arithmetic right shift; vacated bits sign-fill) | signed |
| `MOVE` | `acc` (identity — moves `acc` to the result destination) | n/a |

That is **eleven binary-class operations**. `MOVE` is the identity operation;
its purpose is to transfer `acc` to the addressed destination. `DUP` (push
`acc`) and constant-load (`acc = imm`) are special cases of `MOVE` in push and
immediate modes respectively.

**`DIV` and `MOD` are absent.** Many microcontrollers lack hardware division;
including them would silently emit expensive software loops on such targets.
Codec arithmetic is dominated by shifts, masks, adds, and compares — division
essentially never appears. Modulo by a power of two is expressible as
`AND (N−1)`. A program requiring true division lowers it to a call to a
software helper procedure.

#### 8.2 Mode combinations

All seven combinations from §6.3 are valid for every binary-class operation.
The combination determines where the operand comes from and where the result
goes:

| Combo | Mnemonic | Example (`ADD`) |
|------:|----------|-----------------|
| 1 | `OP rN` | `ADD rN` — `acc = acc + rN` |
| 2 | `OP rN → rN` | `ADD rN → rN` — `rN = acc + rN` |
| 3 | `OP [tos-1]` | `ADD [tos-1]` — `acc = acc + peek` |
| 4 | `OP [tos-1] → [tos-1]` | `ADD [tos-1] → [tos-1]` — peek = acc + peek |
| 5 | `OP [--tos]` | `ADD [--tos]` — `acc = acc + pop` |
| 6 | `OP [tos-1] → [tos++]` | `ADD [tos-1] → [tos++]` — push `acc + peek` (RPN) |
| 7 | `OP #imm` | `ADD #5` — `acc = acc + 5` |

For ALU operations, combination 6 is the RPN node: it reads `[tos-1]` as the
second operand and pushes the result. For `MOVE` (identity), combination 6
degenerates: no second operand is read, and `acc` is simply pushed (this is
`DUP`).

State count: 11 binary-class ops × 7 combos = **77 states = 7 bits**.

#### 8.3 Shift operands

`SHL`, `SHR`, and `ASR` take the shift amount as the "other operand." The
shift amount is **masked to 5 bits** (taken modulo 32): amounts 0–31 shift by
that amount; amount 32 is equivalent to 0; amount 33 to 1; etc. This matches
the convention of ARM and x86 (mask to log₂(word_width) bits) and keeps the
operation a single-cycle hardware op on typical MCUs.

---

### 9. Comparison-Class

Comparison-class instructions have two inputs (`acc` and the addressed operand)
and produce a boolean result (0 or 1) in `acc`. They use only the
**read-capable** modes — register, peek, pop, immediate — because the result
always goes to `acc`.

#### 9.1 Operations

Signed and unsigned variants are carried as first-class operations:

| Mnemonic | Semantics | Sign |
|----------|-----------|------|
| `LT_S` | `acc < operand` (signed) | signed |
| `LE_S` | `acc ≤ operand` (signed) | signed |
| `GT_S` | `acc > operand` (signed) | signed |
| `GE_S` | `acc ≥ operand` (signed) | signed |
| `LT_U` | `acc < operand` (unsigned) | unsigned |
| `LE_U` | `acc ≤ operand` (unsigned) | unsigned |
| `GT_U` | `acc > operand` (unsigned) | unsigned |
| `GE_U` | `acc ≥ operand` (unsigned) | unsigned |
| `EQ` | `acc == operand` (bit-pattern equal) | agnostic |
| `NE` | `acc != operand` (bit-pattern unequal) | agnostic |

That is **ten comparison-class operations**. `EQ` and `NE` are sign-agnostic
(bit-pattern comparison). The four signed and four unsigned relational
comparisons are all carried as first-class, avoiding the need for
operand-swapping or bit-twiddling workarounds when lowering relational
conditions.


#### 9.2 Mode combinations

The four read-capable combinations from §6.3 apply:

| Combo | Mnemonic expansion | Example (`LT_S`) |
|------:|--------------------|------------------|
| 1 | `OP rN` | `LT_S rN` — `acc = (acc < rN)` signed |
| 3 | `OP [tos-1]` | `LT_S [tos-1]` — `acc = (acc < peek)` signed |
| 5 | `OP [--tos]` | `LT_S [--tos]` — `acc = (acc < pop)` signed |
| 7 | `OP #imm` | `LT_S #10` — `acc = (acc < 10)` signed |

The result always goes to `acc`; there is no write-back variant.

---

### 10. Unary-Class

Unary-class instructions operate on `acc` in place. They have no other operand
and no addressing-mode bits.

#### 10.1 Operations

| Mnemonic | Semantics |
|----------|-----------|
| `NEG` | `acc = (−acc) mod 2³²` (two's complement negation) |
| `NOT` | `acc = ~acc` (bitwise complement) |
| `CLZ` | `acc =` count leading zeros of `acc` (result in 0–32) |
| `REVBITS` | `acc =` bit-reverse of `acc` (32-bit width) |

All four operate on `acc` in place; no other operand, no addressing-mode
bits. `NOT` is bitwise; `NEG` is arithmetic. `CLZ` and `REVBITS` cover
bit-inspection and bit-reversal needs in bit-packed formats and length-prefix
decoding (mirroring ARM `CLZ`/`RBIT`, RISC-V `CLZ`/`CTZ`, x86 `LZCNT`/`BSWAP`).
`CTZ` is not a dedicated op: `CTZ(x) = CLZ(REVBITS(x))` (two ops). These are
rare operations; at the encoding level (Part V) they live in the
extended/escape tier rather than the compact first-byte tier.

All four are single-byte encodable (no operand fields).

---

### 11. Control-Flow Ops

Control-flow operations open and close block constructs, terminate procedures,
and re-target control within loops. They carry no addressing-mode fields.

#### 11.1 Block openers

Two instructions open block constructs. Each block construct is closed by a
matching `BLOCK_END`, or by an enclosing terminator (§11.3, §14.3).

**`BR_TABLE N`** — open a dispatch block. The runtime selector is in `acc`.
Semantics:

- `acc < N` → execute `case[acc]`.
- `acc ≥ N` → execute none of the cases (**implicit default**).

After any executed case falls through (or the implicit default is taken),
control continues at the instruction following the construct. The operand `N`
is a literal (immediate, §3.3): the static case count.

The construct consists of `N` case-blocks, parsed sequentially. Each
case-block ends at its closing `BLOCK_END` or at a terminator (§11.3).
Case-blocks do **not** fall through into each other; each is independently
terminated.

The implicit default gives the natural home for an out-of-range selector: a
`TRAP` placed immediately after the construct is reached only when
`acc ≥ N`. This collapses `switch`-with-default into a single construct with
no validate-then-dispatch preamble.

Lowering forms:

| DSL construct | `N` | Body placement |
|---------------|-----|----------------|
| `if-else` | 2 | then-block at `case[0]`, else-block at `case[1]`; default unreachable (comparisons yield 0/1) |
| `if` (no else) | 1 | body at `case[0]`, reached when `acc = 0` (complementary comparison — see §14.1); default = skip |
| `switch` | variant count | each variant a case; default = trap home for out-of-range selectors |

**`LOOP`** — open a pre-test loop block. The continue-condition is in `acc` at
the opener:

- `acc = 0` → exit (fall through to after the matching closer).
- `acc ≠ 0` → enter the body.

The body is closed by `BLOCK_END` as an **unconditional back-edge** to the
opener, which then re-tests `acc`. The loop exit target is the instruction
after the closer. This is the `while` / `for` form: zero iterations is
possible.

There is **no bottom-test (`do-while`) form**. Codecs requiring bottom-test
behavior (e.g. a loop that must execute at least once) recover it by
initializing the loop condition to true.

#### 11.2 Control re-targeting

Two instructions re-target control within the innermost enclosing `LOOP`. They
have no operand; the target is determined statically by the enclosing loop
scope.

**`BREAK`** — exit the innermost enclosing `LOOP`. Control transfers to the
instruction after that loop's matching closer.

**`CONTINUE`** — re-test the innermost enclosing `LOOP`. Control transfers to
that loop's matching closer (the back-edge), which returns to the opener for
re-testing.

`BREAK` and `CONTINUE` never target a `BR_TABLE`; they resolve only against
`LOOP` scope. (A `BR_TABLE` case has no `break` analogue because its
case-exit is implicit via `BLOCK_END` or a terminator.)

> **`for`-loop increment placement.** `CONTINUE` jumps to the back-edge
> (`BLOCK_END`). For a `for`-lowered loop where an increment must run on
> every iteration (including after a `continue`), the lowering layer is
> responsible for making the increment reachable from both the body
> fall-through and the `CONTINUE` path. Inline the increment
> at each `CONTINUE` site before the `CONTINUE` instruction.

#### 11.3 Terminators

Terminators end control flow at the current point. Two are procedure-exiting;
two re-target within a loop.

**`RETURN`** — end the procedure. The return value is the current `acc`. The
frame is popped (TOS rewound to the frame entry point; see §13).

**`TRAP #code`** — end the procedure abnormally with error code `code`. The
code is an immediate (§3.3). `TRAP` is a procedure-exiting terminator: control
does not continue past it, and no `RETURN` or `BLOCK_END` after it is needed
or valid.

The error code is opaque to the ISA. Convention partitions the space:

| Code | Meaning |
|------|---------|
| `0` | unreachable / panic — a verifier-provable assertion of unreachability |
| `1 .. K` | reserved generic codes (overflow, bounds, stack-depth) |
| `K+1 .. 255` | extension-defined codes (e.g. codec validation failures) |

The partition is by convention; the ISA treats `code` as an opaque value
reported to the host, which owns resource cleanup and decides the response.

#### 11.4 Block closer

**`BLOCK_END`** — close the enclosing block construct. Its semantics are
determined by the construct's opener (§11.1):

- Closing a `BR_TABLE` case → unconditional fall-through to after the
  construct.
- Closing a `LOOP` body → unconditional back-edge to the `LOOP` opener, which
  re-tests `acc`.

`BLOCK_END` is the universal closer: there is one closer for every block
shape.

---

### 12. Procedure Invocation

**`CALL proc_idx`** — invoke `procedure[proc_idx]` from the procedure table.

Operand:

- **`proc_idx`** — a literal `u32` indexing into the procedure table.

The callee's `arg_count` (declared in its header, §5.2) determines how many
arguments the caller must push before the call. The caller pushes exactly
`arg_count` values onto its TOS (§13.2); those become `r0 .. r(arg_count−1)`
in the callee's frame. The `CALL` instruction itself does not carry
`arg_count` — it is redundant with the callee's header and would waste
encoding bits on every call.

The return value comes back in `acc`. On return, the caller's TOS is rewound
to discard the argument block (§13.3).

`CALL` is a Generic Core instruction: it carries no notion of streams, object
handles, or any extension-defined resource. Extension-defined invocation forms
(such as the Codec Specification's `CALL_CODEC`) are defined by those
extensions; `CALL_CODEC` is `CALL` plus the codec entry protocol, defined in
the Codec Specification.

---

## Part IV — Semantics and Validation

This part specifies the dynamic semantics of procedure invocation and
control-flow constructs, and the static rules a program must satisfy to be
valid.

### 13. Calling Convention

The calling convention fixes how a `CALL` partitions the register file between
caller and callee, how arguments are passed, and how return works.

#### 13.1 Frame layout

When a caller executes `CALL proc_idx`, a new frame is established for the
callee. Let `N = procedure[proc_idx].arg_count` (from the callee's header).
The **frame base** `F_callee` is defined as the caller's current TOS value at
the moment of the call:

```
F_callee = caller_tos_at_call
```

The callee's view of the register file is the region starting at `F_callee`:

```
r0 .. r(N-1)    : arguments  (= caller's TOS slots [F_callee .. F_callee+N-1])
rN ..           : local scratch (backend-allocated)
```

Register indices in the callee's instructions are frame-relative: `r0` refers
to `F_callee`, `r1` to `F_callee+1`, etc. The callee's TOS entry point is
`F_callee + N` — the first free slot above the arguments.

The caller's frame — everything below `F_callee` — is untouched by the callee.
The backend maps logical frame-relative indices to physical registers or stack
slots; the convention is about *visibility*, not storage.

#### 13.2 Argument passing

The caller computes each argument into `acc` and pushes it (MOVE in push mode,
§8.2 combo 6) in argument order: `arg0` first, `arg1` next, …, `arg(N-1)`
last. After the `N` pushes, the top `N` slots of the caller's TOS are exactly
the argument block the callee will see as `r0 .. r(N-1)`. The caller then
executes `CALL proc_idx`.

In short: **arguments are the top of the caller's stack, and the frame
boundary is that stack top.**

The number of arguments the caller pushes must equal
`procedure[proc_idx].arg_count`. A mismatch is a validation error (§15.5).

#### 13.3 Return

A procedure returns via `RETURN`. The return value is the current `acc`.

On return:

1. The callee's TOS must be at its entry point (`F_callee + N`). A TOS-depth
   other than this at `RETURN` is a validation error (§15.1).
2. The frame is popped: the register-file view returns to the caller, with
   `F_callee` and everything above discarded.
3. The caller's TOS is rewound to its pre-call value, discarding the argument
   block (the `N` slots that held the arguments).
4. The caller resumes at the instruction after the `CALL`, with `acc` holding
   the return value.

The return value is a single word. Multi-value return is not supported by the
core convention.

#### 13.4 TOS discipline

The TOS is per-frame. A procedure enters with its TOS at the entry point
(`F_callee + N`) and must return with its TOS back at that point. Within the
procedure, pushes and pops may freely use the region above the entry point;
the verifier statically checks that every control-flow path restores the TOS
to the entry depth (§15.1).

The caller's TOS contents below `F_callee` are never addressed by the callee
and are visible again at their original indices after the call returns.

---

### 14. Control-Flow Construct Semantics

#### 14.1 `BR_TABLE`

**Syntax:**

```
BR_TABLE N
  <case 0>
  ...
  <case N-1>
; <- implicit-default fall-through target
```

**Semantics:**

1. Read the selector from `acc`.
2. If `acc < N`, dispatch to `case[acc]`. The selected case executes until its
   closing `BLOCK_END` or a terminator (§14.3).
3. If `acc ≥ N`, no case executes (the **implicit default**).
4. After the selected case (or the implicit default), control continues at the
   instruction immediately following the construct.

**Case parsing.** The construct is parsed as a tree: read `N`, then parse `N`
case-blocks sequentially. Each case-block is a statement list ending at its
own closing `BLOCK_END` or at a terminator (§14.3). Nested constructs inside
a case are parsed recursively and consume their own closers; the first closer
at the case's nesting level closes that case. After `N` closings, the
construct is complete.

**Lowering forms.** The `if`, `if-else`, and `switch` forms of the source DSL
all lower to `BR_TABLE`:

- **`if-else`** → `N = 2`. The then-block is `case[0]`; the else-block is
  `case[1]`. The implicit default is unreachable because comparisons yield
  `0` or `1`.
- **`if` (no else)** → `N = 1`. The body is `case[0]`, reached when `acc = 0`.
  The lowering emits the **complementary comparison** so that `acc = 0` means
  "condition true": for example, `if (a < b) body` emits `GE` (yielding
  `acc = 0` when `a < b`). The implicit default (`acc ≠ 0`) is the skip path.
- **`switch`** → `N = variant count`. Each variant is a case. The implicit
  default is the natural home for an out-of-range trap (e.g. a `TRAP`
  instruction placed immediately after the construct).

The complementary-comparison table for `if`-without-`else` lowering:

| DSL condition | Emit | `acc = 0` when |
|---------------|------|----------------|
| `a < b`  | `GE`  | `a < b`  |
| `a <= b` | `GT`  | `a <= b` |
| `a > b`  | `LE`  | `a > b`  |
| `a >= b` | `LT`  | `a >= b` |
| `a == b` | `NE`  | `a == b` |
| `a != b` | `EQ`  | `a != b` |

(The signedness suffix `_S`/`_U` is chosen per the source type.)

#### 14.2 `LOOP`

**Syntax:**

```
LOOP
  <body>
BLOCK_END
```

**Semantics:**

1. Read the continue-condition from `acc` (lenient test: `acc ≠ 0` →
   continue, `acc = 0` → exit).
2. If exiting, fall through to the instruction after `BLOCK_END`.
3. If continuing, execute the body.
4. `BLOCK_END` is an **unconditional back-edge**: control returns to the
   `LOOP` opener, which re-tests `acc`.

The loop is pre-test: zero iterations is possible. There is no bottom-test
(`do-while`) form.

`BREAK` inside the body transfers control to the instruction after the
matching `BLOCK_END`. `CONTINUE` transfers control to the matching
`BLOCK_END` (which is the back-edge to the opener for re-testing). Both target
the innermost enclosing `LOOP` only; they never target a `BR_TABLE`.

#### 14.3 Block termination rules

A case-block (inside a `BR_TABLE`) or a loop body (inside a `LOOP`) is closed
by either:

- **`BLOCK_END`** — the universal closer. Always valid as a closer for the
  innermost open block.
- **Any terminator** (`RETURN`, `TRAP`, `BREAK`, `CONTINUE`) — closes the
  enclosing block as a side effect of ending or re-targeting control.

When a terminator closes a block, no separate `BLOCK_END` is required after
it. **Dead code following a terminator is a validation error** (§15.4): the
validator rejects any instruction that cannot be reached.

This means a `BR_TABLE` case that ends in `RETURN` or `TRAP` needs no
`BLOCK_END`, and a `TRAP` at the implicit-default position needs no following
`RETURN`. Cases that fall through to a shared post-construct instruction
(e.g. a single trailing `RETURN`) still use `BLOCK_END`.

#### 14.4 `LOOP` closed by a terminator (no `BLOCK_END`)

A `LOOP` body is normally closed by `BLOCK_END` (the back-edge, §14.2). But a
loop body may also be closed by any terminator — `RETURN`, `TRAP`, `BREAK`, or
`CONTINUE` — with **no `BLOCK_END`**. This is the loop analogue of a
`BR_TABLE` case closed by a terminator (§14.3).

The non-obvious case is when the loop body's terminator is **`RETURN` or
`TRAP`** — a procedure-exiting terminator. Such a loop is **non-cyclic**: it
executes its body once, then exits the procedure directly. The back-edge is
never taken, because control never reaches a `BLOCK_END`. This is a legitimate
and useful shape — it expresses "do something conditionally, then either
return or trap, never iterate":

```
; decode exactly one element, then either return the result or trap on error
HAS_NEXT 1
LOOP                      ; pre-test (acc = has_next)
  READ 1, 1
  LT_U_IMM 0x80           ; valid range?
  BR_TABLE 1              ; acc=0 (invalid): trap; default (valid): fall through
    TRAP ERR_BAD_BYTE     ; closes BR_TABLE case 0
  LOAD_IMM 1              ; signal "decoded ok"
  RETURN                  ; <- closes the LOOP body; no BLOCK_END follows
; <- after the (terminator-closed) loop: unreachable, since RETURN exits
LOAD_IMM 0                ; would be "no element" — dead, validator-rejected
RETURN
```

Here the `LOOP` exists only to host the `HAS_NEXT` pre-test (so an empty
stream traps cleanly via the implicit fall-through below), but the body never
iterates — it either traps or returns on the first pass. The `RETURN` closes
both the `BR_TABLE` case (if it falls through) *and* the `LOOP` body, and
exits the procedure.

**Parsing implication.** The decoder parses a `LOOP` body as a statement
list ending at the first `BLOCK_END` *or* terminator at the loop's nesting
level. If a terminator closes the loop, no `BLOCK_END` is emitted; the
instruction following the loop is the loop's exit target (which, for
`RETURN`/`TRAP`, is unreachable — see §15.4).

For `BREAK` and `CONTINUE`, the situation differs: they close the loop body
but do **not** exit the procedure, so they are cyclic (the loop may execute
the `BREAK`/`CONTINUE` path, then either exit via `BREAK` or re-test via
`CONTINUE`). The body still needs no trailing `BLOCK_END` if every path
terminates with `BREAK` or `CONTINUE`.

---

### 15. Static Validation

A program is **valid** if it satisfies all of the following. A validator that
accepts a program certifies conformance; rejection is mandatory on any
failure.

#### 15.1 TOS balance and auto-cleanup

**Block boundaries restore TOS to the block's entry depth.** At every
`BLOCK_END`, `BREAK`, `CONTINUE`, and `RETURN`, any TOS surplus above the
enclosing block's entry depth is **implicitly dropped**. The producer never
needs to emit explicit cleanup pops before a block exit; the block boundary
handles it.

This means the TOS-balance invariant arises from the block structure itself,
not from explicit cleanup ops:

- At `BLOCK_END` closing a `BR_TABLE` case: TOS is restored to the depth at
  the `BR_TABLE` opener.
- At `BLOCK_END` closing a `LOOP` body: TOS is restored to the depth at the
  `LOOP` opener.
- At `BREAK` / `CONTINUE`: TOS is restored to the `LOOP` opener's depth.
- At `RETURN`: TOS is restored to the procedure's entry depth (the frame is
  discarded anyway, but the invariant is stated for uniformity).

The validator computes the TOS depth at each point by static CFG traversal
and checks that the surplus at each boundary is non-negative (i.e. the block
never leaves TOS *below* its entry depth — that would indicate a pop of a
value that belongs to an enclosing scope, which is a validation error). The
implicit drop of non-negative surplus is a semantic guarantee; the backend
implements it by rewinding the TOS pointer at each boundary.

#### 15.2 Call-graph acyclicity

The call graph — over literal procedure indices referenced by `CALL`
instructions — must be **acyclic**. A cyclic call graph is a validation error.

The ISA does not constrain how the authoring layer produces acyclic graphs;
it validates the property on the IR as given.

#### 15.3 Stack-depth bound

For each procedure, the maximum TOS depth reached on any path (above the entry
point) is statically computable. Across the call graph, the worst-case
register-file depth is the sum of per-procedure maxima along the longest call
chain.

This bound must fit within the implementation's resources. A program whose
computed worst-case depth exceeds the target's available storage is rejected
by the backend (the ISA itself imposes no numerical limit; backends have
implementation-defined limits).

#### 15.4 Dead-code rejection

Any instruction that cannot be reached on any control-flow path is a
validation error. In particular:

- An instruction immediately following a terminator (`RETURN`, `TRAP`,
  `BREAK`, `CONTINUE`) within the same block, without an intervening control
  target, is dead and must be rejected.
- An instruction after a `BR_TABLE` construct that is unreachable (because
  every case and the implicit default transfer control elsewhere) is dead.

#### 15.5 Header consistency

For every `CALL proc_idx`:

- `procedure[proc_idx]` must exist.
- The TOS depth at the `CALL` minus the procedure's entry TOS depth must
  equal `procedure[proc_idx].arg_count`. (I.e. the caller must have pushed
  exactly the right number of arguments.)

A mismatch is a validation error.

#### 15.6 Block well-formedness

Every `BR_TABLE` and `LOOP` opener must have a matching closer (a `BLOCK_END`
or a terminator that closes it). Every `BLOCK_END` must close some open
block. Every `BREAK` and `CONTINUE` must be within at least one enclosing
`LOOP`.

Mismatches (unclosed openers, dangling closers, `BREAK`/`CONTINUE` outside a
loop) are validation errors.

---

### 16. Resource Guarantees

A validated program satisfies the following guarantees at run time.

#### 16.1 Zero-allocation invariant

No Generic Core instruction allocates heap memory. All storage — `acc`, the
register file, the TOS — is statically bounded per procedure and per call
chain. Extension instructions must declare `allocates: false` in their effect
summary (Part V) to preserve this invariant.

#### 16.2 Worst-case stack depth

The worst-case register-file depth across any execution of a validated
program is bounded by the static stack-depth computation (§15.3). No run-time
stack overflow is possible in a validated program executed on a backend whose
resources meet the computed bound.

#### 16.3 Termination

**Not guaranteed.** The ISA guarantees bounded *resource usage* (§16.1,
§16.2) but does **not** guarantee termination. A `LOOP` whose condition
remains non-zero on every iteration runs indefinitely (e.g. a loop where the
increment is zero, or the condition is a constant). The acyclic call graph
(§15.2) guarantees no infinite recursion, but loops are the program's
responsibility — as in any general-purpose structured language.


---

<!--
  ════════════════════════════════════════════════════════════════════════════
  BELOW THIS LINE: OUTLINE ONLY.
  Parts I–IV above are drafted (normative). Parts V, VI, and the Appendices
  below are permanent outlines retained in-repo so a future session can draft
  them in place. Each outline section is a stub: heading structure is fixed,
  body is to be written.
  ════════════════════════════════════════════════════════════════════════════
-->

## Part V — Encoding

> **Status: Outline only.** Strategy is largely agreed (see
> [ir-engine §2.7][ir-engine]); concrete byte layout is deferred pending
> measurement against representative codecs.

### 17. Encoding Strategy

*To be drafted. Expected content:*

- **17.1 Prefix code.** Each instruction class occupies a fixed-width field
  sized to `ceil(log₂(states))` over a static prior (representative corpus).
  Rare opcodes consume code-space and may push a field wider; they are not
  "free when unused."
- **17.2 Bounded joint table-lookup.** Adjacent under-full fields may share a
  code subspace: pack `(fieldA, fieldB) → flatIndex`, decode via one table,
  store `ceil(log₂(|A|·|B|))` bits instead of `ceil(log₂|A|) + ceil(log₂|B|)`.
  Bounded scope (a pair or small tuple), no state, no carry — fully testable.
- **17.3 Opcode-space split.** The Generic Core occupies the bulk of opcode
  space (lower portion) because its instructions are short and
  high-variability. The codec extension occupies the top portion; its
  instructions are mostly long anyway and tolerate extended encodings for rare
  forms. Exact split ratio deferred.
- **17.4 Tiered encoding.** Frequent ops (ADD, SUB, AND, OR, XOR, SHL, SHR,
  MOVE, EQ, NE, LT_S/U, etc.) get compact first-byte encodings, jointly packed
  with their most-common modes and small literals (0, 1). Rare ops (ASR, MUL,
  CLZ, REVBITS, RSUB, GT/GE variants) escape to a longer encoding via a
  reserved escape code in the first byte. Semantically first-class;
  encoding-wise second-class.
- **17.5 Explicitly ruled out.** A true arithmetic-coding layer as the
  outermost encoding — adaptive, stateful, carry-across-opcodes — is ruled
  out (complexity/testability).
- **17.6 Effect declarations for extension ops.** Each extension opcode
  publishes a declared-effect summary `{reads, writes, allocates:false}` so
  core tooling (verifier, allocator, codegen) treats it as an
  opaque-with-effects leaf.

### 18. Byte Layout

*To be drafted. Placeholder per the carry-forward-deferred decision. Expected
content, per class:*

- **18.1 Binary-class** (11 ops × 7 combos = 77 states; compact tier + escape
  tier for rare ops; small-literal sub-encoding for `imm` mode).
- **18.2 Comparison-class** (10 ops × 4 modes = 40 states; compact tier + escape
  tier).
- **18.3 Unary-class** (4 ops; single-byte).
- **18.4 Control-flow ops** (7 ops; immediate operands for `BR_TABLE N`,
  `TRAP #code`; single-byte for no-operand forms).
- **18.5 Procedure invocation** (`CALL proc_idx`; LEB128 procedure index).
- **18.6 Immediate sub-encoding** (small inline 3–4 bits / extended LEB128;
  shared across `imm` mode and immediate parameters).
- **18.7 Reserved / escape region** (codec extension + future expansion).

---

## Part VI — Textual DSL

> **Status: Outline only.** Covers the `ir\`...\`` authoring form and its
> lowering to IR. Grammar to be normatively specified here.

### 19. DSL Overview

*To be drafted. Expected content:*

- The `ir\`...\`` tagged-template form as one valid authoring path.
- Relationship between DSL text, parsed AST fragments, stitched AST, and
  lowered IR bytecode (pipeline diagram from [ir-engine §2.11][ir-engine]).
- Statement/expression subset of pseudo-C supported inside `ir\`...\``.

### 20. Lexical Structure

*To be drafted. Expected content:*

- Character set, comments, identifiers, integer literals (decimal, hex, binary).
- Reserved keywords (`if`, `else`, `while`, `for`, `break`, `continue`,
  `return`, `trap`, etc.).
- Punctuation and operators.

### 21. Grammar

*To be drafted. Expected content:*

- Normative PEG grammar (reference `packages/core/grammer.pegjs`).
- Production rules for statements, expressions, control-flow constructs,
  procedure and codec declarations.
- Lexical rules (tokens, whitespace, comments).

### 22. Lowering Rules

*To be drafted. Expected content:*

- DSL statement → IR instruction mapping.
- Expression evaluation order and TOS discipline (RPN lowering).
- `if` / `if-else` / `switch` → `BR_TABLE` (complementary comparison for
  if-without-else; implicit default for switch).
- `while` / `for` → `LOOP` (pre-test; `for` increment placement).
- `break` / `continue` → `BREAK` / `CONTINUE` (increment placement note).
- `return` / `trap` → `RETURN` / `TRAP`.
- Procedure calls → `CALL` / `CALL_CODEC` (codec form defined in Codec Spec).

---

## Appendices

> **Status: Outline only.** Non-normative.

### Appendix A — Worked Examples

*To be drafted. Expected content (Generic-Core-only):*

- A.1 Arithmetic helper procedures (min, max, abs).
- A.2 LEB128 encode/decode (exercises ALU, imm, loop, CALL).
- A.3 Bit-packed field extraction (exercises CLZ, REVBITS, shifts).
- A.4 Search-and-return loop (exercises RETURN-closes-loop).
- A.5 Validate-and-trap loop (exercises TRAP-closes-loop).

Codec-domain examples (struct encoder, union encoder, checksum, presence
bitmap, delta-encoded list) live in the Codec Specification.

### Appendix B — Open Questions

*To be drafted. Carries forward open questions from [ir-engine §7][ir-engine]
relevant to the Generic Core:*

- Concrete byte-layout decisions (Part V).
- Whether the small-literal inline range is 0–7 or 0–15.
- Exact opcode-space split ratio between Generic Core and codec extension.
- Whether the effect-declaration interface gains a normative shape.

### Appendix C — Change Log

*To be drafted. Expected content:*

- Revision history of this document.
- Cross-references to [ir-engine.md][ir-engine] evolution.

---

*Document status: Parts I–IV drafted (normative). Parts V, VI, Appendices
retained as permanent outlines for future drafting.*
