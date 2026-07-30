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

> **Status:** First draft, 128/128 revision. The byte layout below is a
> concrete, decodable specification. The prefix-code structure (§18.1) is
> stable; per-class field assignments are revision candidates (§17.7) once
> measured against a representative codec corpus.

### 17. Encoding Strategy

#### 17.1 Core / Extension split (128 / 128)

The single highest-confidence fact about codec byte distribution is that
**domain-specific I/O and delegation ops dominate by emitted-byte count**:
generic struct and union encoders are short sequences of `CALL_CODEC`, and
these scale with the schema's type count. Arithmetic concentrates in a few
reusable primitive codecs (LEB128, fixed-width, delta).

The first byte is therefore split **evenly** at bit 7:

| Bit 7 | Domain | Codes | § |
|-------|--------|-------|---|
| `0` | Generic Core | 128 | §18.1–§18.5 |
| `1` | Extension (Codec Spec) | 128 | §18.6 |

Both halves get first-class single-byte encoding capacity. This gives the
Codec Specification's stream I/O, target access, and codec-invocation ops
the same encoding density as core ALU — the struct/union delegation hot path
stays in one byte.

#### 17.2 Core sub-split: ALU 64 / non-ALU 64

Within the core half, bit 6 splits again:

| Bits 7:6 | Class | Codes | § |
|----------|-------|-------|---|
| `00` | ALU | 64 | §18.2 |
| `01` | Comparison + Unary + Control | 64 | §18.3–§18.4 |

ALU gets exactly 64 codes: 3 bits for 8 ops × 3 bits for 8 modes (6 register/
stack combos + imm-extended + imm-inline). This is a zero-waste fit — every
code in the sub-space is reachable.

The non-ALU core half further splits at bit 5: comparison gets 32 codes
(§18.3), unary + control get 32 codes (§18.4).

#### 17.3 Per-op ALU inline literal

The ALU has exactly **one** inline-literal mode code (not a field of values).
The literal value it represents is **per-operator** — a small lookup table
keyed on the op field selects the one constant each operation most frequently
needs:

| Op | Inline literal | Rationale |
|----|---------------|-----------|
| `ADD` | `1` | increment (loop counters, pointers) |
| `SUB` | `1` | decrement |
| `SHL` | `1` | shift-by-one (bit manipulation) |
| `SHR` | `1` | shift-by-one |
| `MOVE` | `0` | load zero (accumulator init, zero-compare) |
| `AND` | `0xFF` | byte mask (LEB128, width truncation) |
| `OR` | `0x80` | set continuation bit (LEB128) |
| `XOR` | `0xFF` | toggle low byte (checksum complement) |

The bitwise values (`0xFF`, `0x80`) are codec-domain defaults; they are the
most tunable entry in this table (§17.7) and may be revised per corpus. The
non-bitwise values (`0`, `1`) are high-confidence.

All other literal values use the imm-extended mode (trailing LEB128).

#### 17.4 Comparison: 6 compact ops, imm-zero only

Comparison carries **6 compact ops** — `EQ`, `NE`, `LT_S`, `LT_U`, `LE_S`,
`LE_U` — consistent with the branch-inversion principle (§2.8 of the Rationale,
§14.1 of this spec): `GT ≡ !LE` and `GE ≡ !LT`, so both are derived by
swapping then/else blocks rather than carried as dedicated ops.

The inline literal for comparison is **zero only** (`#0`). This covers the
single most common comparison pattern — zero-test (`EQ #0`, `NE #0`) and
sign-test (`LT_S #0`, `LE_S #0`) — in one byte. All other comparison
literals use imm-extended (trailing LEB128).

State count: 6 ops × 5 modes (imm-zero, imm-ext, register, peek, pop) = 30
codes in a 32-code sub-space. 2 reserved.

#### 17.5 Rare ops via core escape

Rare operations — `RSUB`, `MUL`, `ASR` (ALU); `GT_S`, `GT_U`, `GE_S`, `GE_U`
(comparison); `CLZ`, `REVBITS` (unary) — are semantically first-class (§8–§10)
but do not fit in the compact tier. They share a single **core escape** code
in the unary+control sub-space; the byte following the escape code is a
secondary opcode selecting the rare op and its mode. This costs 2 bytes
minimum — the same as the extension escape — but keeps them within the core
prefix so the Generic Core spec remains self-contained.

#### 17.6 Extension encoding

The upper 128 codes (bit 7 = `1`) are owned entirely by the active extension.
The Codec Specification defines their layout; the Generic Core does not
interpret them beyond noting the prefix bit. With 7 payload bits, the
extension has ample room for single-byte encodings of its most common ops
(stream `READ`/`WRITE` with small iterator IDs, `LOAD_VAL`/`STORE_VAL`,
`CALL_CODEC` with small codec/ref indices).

#### 17.7 Revision criteria

The layout is sized for a static frequency prior. Once a corpus is available,
the following may be revised without restructuring the prefix tree:

- **Per-op ALU literal values** (§17.3): the bitwise defaults are the most
  likely adjustment.
- **Comparison compact tier**: promoting `GT`/`GE` back if branch-inversion
  proves costly in practice.
- **BR_TABLE inline range**: currently {1,2,3,4}; may widen or narrow.
- **Register-index encoding**: currently a trailing byte; could be packed
  inline for r0–r7 using reserved codes in the ALU mode field.

The prefix structure (§18.1) is stable across such revisions.

---

### 18. Byte Layout

#### 18.1 First-byte dispatch

```
Bits 7:5
  00          → ALU                  (§18.2)   bits 5:0 payload (64 codes)
  010         → Comparison           (§18.3)   bits 4:0 payload (32 codes)
  011         → Unary + Control      (§18.4)   bits 4:0 payload (32 codes)
  1           → Extension            (§18.6)   bits 6:0 payload (128 codes)
```

The decoder reads bit 7 (core vs extension), then bit 6 (ALU vs non-ALU
core), then bit 5 (comparison vs unary+control). A valid prefix code — no
ambiguity.

Trailing bytes (register index, extended immediate, LEB128 parameters) follow
the first byte as specified per format.

---

#### 18.2 ALU (prefix `00`)

Bits 7:6 = `00`, leaving a **6-bit payload** (bits 5:0) split into a 3-bit op
field and a 3-bit mode field.

```
 7  6  5  4  3  2  1  0
 0  0 ──op── ──mode──
       (3)    (3)
```

**Op field (3 bits):**

| Code | Op |
|------|----|
| `000` | `ADD` |
| `001` | `SUB` |
| `010` | `AND` |
| `011` | `OR` |
| `100` | `XOR` |
| `101` | `SHL` |
| `110` | `SHR` |
| `111` | `MOVE` |

**Mode field (3 bits):**

| Code | Mode | Combo | Size | Trailing |
|------|------|-------|------|----------|
| `000` | imm-inline | 7 | 1 byte | none (literal from per-op table, §17.3) |
| `001` | imm-extended | 7 | 2+ bytes | LEB128 `u32` |
| `010` | register → acc | 1 | 2 bytes | register index (`u8`) |
| `011` | register → register | 2 | 2 bytes | register index (`u8`) |
| `100` | peek → acc | 3 | 1 byte | none |
| `101` | peek → peek | 4 | 1 byte | none |
| `110` | pop → acc | 5 | 1 byte | none |
| `111` | peek → push (RPN) | 6 | 1 byte | none |

State count: 8 ops × 8 modes = **64 codes**, filling the ALU sub-space exactly.
For `MOVE` (op `111`): mode `000` is load-zero, mode `111` is `DUP`, mode
`110` is `POP` — all subsumed, no dedicated opcodes. Rare ALU ops (`RSUB`,
`MUL`, `ASR`) use the core escape (§18.5).

---

#### 18.3 Comparison (prefix `010`)

Bits 7:5 = `010`, leaving a **5-bit payload** (bits 4:0). The payload is a
flat index: `flat = op × 5 + mode` (op 0–5, mode 0–4). 30 used, 2 reserved.

**Op (flat / 5):** 0=`EQ`, 1=`NE`, 2=`LT_S`, 3=`LT_U`, 4=`LE_S`, 5=`LE_U`.
**Mode (flat % 5):** 0=imm-zero, 1=imm-ext(+LEB128), 2=register(+u8),
3=peek, 4=pop.

All results → `acc` as boolean. `GT`/`GE` derived by branch inversion (§14.1)
or core escape (§18.5).

---

#### 18.4 Unary + Control (prefix `011`)

Bits 7:5 = `011`, **5-bit payload** (bits 4:0) as flat opcode:

| Idx | Op | Trailing | Idx | Op | Trailing |
|-----|----|----------|-----|----|----------|
| 0 | `NEG` | — | 9 | `BR_TABLE #1` | — |
| 1 | `NOT` | — | 10 | `BR_TABLE #2` | — |
| 2 | `CLZ` | — | 11 | `BR_TABLE #3` | — |
| 3 | `REVBITS` | — | 12 | `BR_TABLE #4` | — |
| 4 | `RETURN` | — | 13 | `BR_TABLE` ext | LEB128 |
| 5 | `BLOCK_END` | — | 14 | `TRAP #0` | — |
| 6 | `BREAK` | — | 15 | `TRAP` ext | LEB128 |
| 7 | `CONTINUE` | — | 16 | `CALL` | LEB128 |
| 8 | `LOOP` | — | 17 | `CORE_ESCAPE` | §18.5 |

Indices 18–31 reserved. `BR_TABLE` inline covers N ∈ {1,2,3,4}; `TRAP #0` is
unreachable/panic.

---

#### 18.5 Core escape (opcode 17)

Rare ops via `CORE_ESCAPE` + secondary `u8`:

| Secondary range | Category |
|-----------------|----------|
| `0x00`–`0x17` | `RSUB`/`MUL`/`ASR` × 8 ALU modes each |
| `0x18`–`0x27` | `GT_S`/`GT_U`/`GE_S`/`GE_U` × 4 CMP modes each |
| `0x28`–`0xFF` | reserved (216) |

Rare-ALU modes mirror §18.2's 3-bit mode encoding. Rare-CMP use 2-bit mode
(reg, peek, pop, imm-ext). 40 of 256 secondary codes used.

---

#### 18.6 Extension (prefix `1`)

Bit 7 = `1`, **7-bit payload** = 128 codes owned by the Codec Specification.
Single-byte encodings for common domain ops; extended forms for rare combos.
The Generic Core does not interpret these beyond the prefix bit.

---

#### 18.7 Immediate operand encoding

Immediates appear in two roles: as the `imm`-mode operand (ALU mode 000/001,
Comparison mode 0/1) and as instruction parameters (`BR_TABLE N`, `TRAP
#code`, `CALL proc_idx`).

**Inline immediate (0 bits, per-op or fixed):**
- ALU mode `000`: literal value from per-op table (§17.3). Implicit in op.
- Comparison mode `0`: always `#0`.
- `BR_TABLE` indices 9–12: `N` ∈ {1,2,3,4}, implicit in opcode index.
- `TRAP #0` (index 14): `code` = 0, implicit.

**Extended immediate (trailing LEB128):** any `u32`, standard unsigned LEB128
(1–5 bytes). Used by ALU mode `001`, Comparison mode `1`, `BR_TABLE` ext
(index 13), `TRAP` ext (index 15), `CALL` (index 16).

---

#### 18.8 Register index encoding

Register indices appear in ALU register modes (`010`, `011`) and Comparison
register mode (mode 2). A **raw `u8` trailing byte**, covering `r0`–`r255`.
A future revision may pack small indices (r0–r7) inline using reserved mode
codes (§17.7).

---

## Part VI — Textual DSL

> **Status:** First draft. This Part specifies the authoring form. Rather than
> normatively redefining a grammar from scratch, it specifies a **subset of
> C99** plus the single extension hook (function-call resolution). A
> conforming PEG parser exists at `packages/core/grammer.pegjs`; this Part
> normatively defines what that parser must accept and reject, and how its
> output lowers to IR.

### 19. DSL Overview

#### 19.1 A subset of C99

The DSL is a strict subset of C99. The DSL merely omits most of C's surface area.
This Part does not re-specify C's expression grammar, statement grammar, or
operator precedence — those are inherited unchanged. It specifies only:

- The **subset** (what is included and excluded) — §20.
- The **single type rule** (`u32` everywhere) — §20.
- The **extension hook**: function calls resolve through an injected table,
  not through a fixed opcode set — §21.
- The **lowering rules** to IR — §22.

This keeps the spec short for both author and reader: a competent programmer needs only the delta.

#### 19.2 The `ir\`...\`` tagged-template form

The authoring entry point is a TypeScript tagged-template literal:

```
ir` <C-subset source> `
```

The tag parses the string into an `IrFragment` (an AST node from
`ast.ts`). No further interpretation happens at parse time. Subsequent
layers (stitching, lowering) consume fragments and combine them; see the
[IR Engine Rationale][ir-engine] §2.11 for the pipeline diagram.

A complete procedure is typically stitched from many small `ir\`...\``
fragments, often generated inside `for`/`if` at the TS metaprogramming
layer (field unrolling, conditional codec selection, etc.). The metaprogramming
surface is kept minimal — see §21.4.

---

### 20. The C subset

#### 20.1 Included

The DSL includes the common heritage of C, C++, Java, JavaScript, C#, Rust,
Go, and every other C-based language:

- **Expressions**: all of C's unary, binary, and ternary operators with C's
  precedence and associativity; assignment (`=`), compound assignment
  (`+=` `-=` `*=` `/=` `%=` `<<=` `>>=` `&=` `|=` `^=`), prefix and postfix
  `++`/`--`; integer literals (decimal, hex `0x…`, binary `0b…`); function
  calls; parenthesization.
- **Statements**: expression statements; block statements `{ … }`;
  `if`/`else`; `while`; `for`; `switch`/`case`/`default`; `break`;
  `continue`; `return` (see §20.2 for what is *not* included).
- **Declarations**: `u32` local variables, optionally with an initializer.
- **Comments**: `//` line and `/* … */` block comments.

#### 20.2 Excluded

The DSL omits:

- **Pointers and arrays** — no `*`, no `&`, no `[]`, no pointer arithmetic.
- **Compound types** — no `struct`, `union`, `enum`, `typedef`.
- **Function definitions** — procedures are defined out-of-band; the DSL
  body is one procedure's body (a statement sequence), not a function
  definition. Function *calls* are allowed (§21).
- **`goto` and labels** — replaced by structured control flow (§22.2).
  (Excluded even though it's valid C; the DSL's structured-control model
  has no target for a `goto`.)
- **`do`/`while`** — banned (the IR's `LOOP` is pre-test only, §11.1).
  A bottom-test loop is recovered by initializing the loop condition to
  true.
- **Comma operator**, **casts**, **`sizeof`**, **`?:` chained declarations**,
  **designated initializers**, **function-pointer syntax**.
- **Non-integer literals**: no `float`, `char`, or string literals. The
  DSL operates on `u32` exclusively (§20.3).
- **Storage qualifiers**: no `const`, `static`, `extern`, `volatile`,
  `register`, `auto`.
- **Preprocessor**: no `#include`, `#define`, etc. (the DSL is parsed as
  a single source string; metaprogramming happens in the TS host, not in C
  preprocessor form).

#### 20.3 The single type rule

All values are `u32`. A local declaration must use the type name `u32`:

```
u32 x;            // ok
u32 y = 5;        // ok
u32 a, b, c;      // ok (declarator list, all u32)
u32 z = x + 1;    // ok
int x;            // rejected — not u32
x = 5;            // rejected if x is undeclared — no implicit decl
```

Requiring the explicit `u32` type name keeps DSL source files as valid C
syntactically (any C syntax highlighter colors them correctly without
configuration) and signals intent to the reader. There is exactly one
type, but it is named.

Function parameters are also `u32`, declared out-of-band in the procedure
header (§5.2), not in the DSL body. The DSL body sees them as named locals
visible from the first statement.

---

### 21. Function calls

Function calls are parsed identically as `Identifier ( arglist )`. The
Generic Core defines the lowering of exactly three **core built-in**
functions (§21.1). The resolution of any other call — procedure-table
entries, extension ops, codec invocations — is an **application-specific
mechanism** handled by the integration layer (§21.2), not specified by this
ISA.

#### 21.1 Core built-in functions

The Generic Core defines three built-in functions with fixed lowering:

| Name | Lowers to | Notes |
|------|-----------|-------|
| `trap(code)` | `TRAP #code` (§11.3) | `code` is a constant expression |
| `clz(x)` | escape-tier `CLZ` (§10.1, §18.5) | `acc = clz(acc)` |
| `revbits(x)` | escape-tier `REVBITS` (§10.1, §18.5) | `acc = revbits(acc)` |

`trap` is a function, not a keyword — this keeps the DSL a strict C subset
(no new keywords) and lets `return` (a real C keyword) be the only
procedure-exit keyword. `clz` and `revbits` have no C operator equivalents;
keeping them as core built-ins lets a pure-core program be written without
any extension.

These three are the entirety of the core's call-lowering contract.

#### 21.2 Application-specific call resolution (out of scope)

Beyond the three core built-ins, call resolution is **out of scope** for the
Generic Core. Specifically:

- **Procedure definition** — how the `IrFragment`s produced by `ir\`...\``
blocks are assembled into a procedure (stitching, scope merging, ABI
selection) is domain-specific and handled by the integration layer. Different
applications may use different ABIs and procedure-definition conventions.
- **Extension ops** — an extension (e.g. the Codec Specification) registers
its own call names (`read`, `write`, `call_codec`, …) and defines how each
lowers. Arguments to such calls may be runtime expressions or compile-time
constants (often injected via template interpolation `${…}` rather than
literal source text); the contract is the extension's to define.
- **Resolution mechanism** — the integration layer may expose a resolution
table, a framework, or utilities for managing name-to-emitter bindings. The
shape of that mechanism is an implementation detail, not a normative part
of this ISA.

The Generic Core's contract ends at: the three built-ins lower as specified
in §21.1. Everything else is the integration layer's responsibility.

---

### 22. Lowering rules

This section normatively specifies how a parsed DSL fragment lowers to IR
instructions.

#### 22.1 Expressions

An expression lowers to a sequence of IR instructions that computes the
value into `acc`, using the TOS for intermediate values when needed.
Operator precedence and associativity follow C exactly; the lowerer emits
instructions in evaluation order.

Operand forms map to addressing modes: literal constants use `imm` mode;
local variables use register mode; sub-expression results use the TOS
(peek/pop/push per evaluation order). The lowerer may choose any valid
addressing-mode combination (§6.3) for a given operand — the specific
selection is an implementation detail, not normatively fixed.

#### 22.2 Control flow

| DSL construct | Lowers to |
|---------------|-----------|
| `if (c) T` | compute `c`; emit complementary comparison so `acc=0` means "true"; `BR_TABLE 1` with `T` as case 0; implicit default = skip (§14.1) |
| `if (c) T else E` | compute `c` into `acc ∈ {0,1}`; `BR_TABLE 2` with `E` as case 0, `T` as case 1 |
| `switch (v) { case k: … }` | `v` into `acc`; `BR_TABLE N` with N cases; out-of-range falls to implicit default (a following `trap()` if desired) |
| `while (c) B` | compute `c` into `acc`; `LOOP`; `B`; re-compute `c` before `BLOCK_END` (back-edge) |
| `for (init; c; inc) B` | `init`; compute `c`; `LOOP`; `B`; `inc`; re-compute `c`; `BLOCK_END` |
| `break;` | `BREAK` |
| `continue;` | (for loops) emit `inc` inline if the enclosing loop is a `for`; then `CONTINUE` |
| `return e;` | compute `e` into `acc`; `RETURN` |
| `return;` | `RETURN` (acc value unspecified) |
| `trap(c);` | `TRAP #c` |

**Complementary comparison for `if`-without-`else`.** When the DSL writes
`if (a < b) body`, the lowerer emits the *complementary* comparison (`GE`)
so that `acc = 0` selects the body. The full table is in §14.1. This
exploits the implicit-default semantics of `BR_TABLE` (§11.1): no separate
"skip" branch is emitted.

**`for`-increment placement.** `CONTINUE` jumps to the `BLOCK_END`
back-edge. For a `for` loop, the increment must run on every iteration,
including after a `continue`. The lowerer emits the increment inline at each
`continue` site *before* the `CONTINUE` instruction (or equivalently,
restructures the body so the increment is reachable from both the body
fall-through and the `continue` path).

#### 22.3 Declarations

A `u32` local declaration allocates a slot in the procedure's frame
(register file, §4.4). The lowerer assigns register indices; DSL source
does not name indices. An initializer `u32 x = e;` lowers to: evaluate `e`
into `acc`, then `MOVE acc → rX` (store to the allocated slot).

A declarator list `u32 a, b, c;` allocates three slots in order. Initializers
apply per-declarator: `u32 a = 1, b = 2;` is two separate allocate-and-init.

#### 22.4 Function calls

The three core built-in functions lower as specified in §21.1 (`trap` →
`TRAP`; `clz`/`revbits` → escape-tier unary). The lowering of any other call
is defined by the integration layer (§21.2) — the Generic Core does not
normatively specify it.

---

## Appendices

### Appendix A — Worked Examples

> Non-normative. These examples show the DSL → IR lowering and annotate the
> efficiency mechanisms each exercises. Codec-domain examples (struct/union
> encoders, stream I/O, checksum, presence bitmap) live in the Codec
> Specification.

**Notation.** IR listings use these shorthand mnemonics for readability:

| Shorthand | Meaning | ISA form |
|-----------|---------|----------|
| `LOAD rN` | acc ← rN | MOVE, register→acc (combo 1) |
| `STORE rN` | rN ← acc | MOVE, acc→register (combo 2) |
| `PUSH` | push acc | MOVE, peek→push (combo 6, ≡ DUP) |
| `OP rN` | acc = acc OP rN | ALU, register→acc (combo 1) |
| `OP rN → rN` | rN = acc OP rN | ALU, register→register (combo 2) |
| `OP #k` | acc = acc OP k | ALU, imm-inline (per-op literal) or imm-extended |
| `OP [--tos]` | acc = acc OP pop | ALU, pop→acc (combo 5) |

Byte counts in comments assume the encoding of Part V: ALU stack/imm-inline
ops are 1 byte; register ops are 2 bytes (opcode + reg); imm-extended ops
are 2+ bytes (opcode + LEB128). Comparisons are 1 byte (peek/pop/imm-zero)
or 2 bytes (register/imm-ext). `BR_TABLE #N` for N ∈ {1,2,3,4} is 1 byte;
extended N is 2+. `RETURN`, `BREAK`, `BLOCK_END`, `TRAP #0` are 1 byte each.

---

### A.1 `min(a, b)` — comparison, BR_TABLE, CALL convention

**DSL source:**

```c
u32 min(u32 a, u32 b) {
    if (a < b) {
        return a;
    } else {
        return b;
    }
}
```

**Lowered IR** (`a = r0`, `b = r1`):

```
LOAD r0               ; acc = a                              2 bytes
LT_U r1               ; acc = (a < b)                        2 bytes (cmp+reg)
BR_TABLE 2            ; case 0 = else, case 1 = then         1 byte (inline N=2)
  LOAD r1             ; case 0 (a ≥ b): acc = b              2 bytes
  RETURN              ; return b; closes case 0              1 byte
  LOAD r0             ; case 1 (a < b): acc = a              2 bytes
  RETURN              ; return a; closes case 1              1 byte
TRAP 0                ; implicit-default home; unreachable   1 byte (inline)
```

**Total: 12 bytes.** Mechanisms exercised:

- **Compact unsigned comparison** `LT_U` (2 bytes with register operand). Since
  this is `if-else` (both branches present), the comparison is used directly
  — no complementary form is needed (that's only for `if`-without-`else`).
  `LT_U` happens to be in the compact tier; `GE_U` would have been escape-tier
  (3 bytes).
- **Terminator closes block** (§14.3): both cases end in `RETURN`; no
  `BLOCK_END` is emitted.
- **`TRAP 0`** as the unreachable implicit-default terminator (1 byte inline).

**Caller side** — calling `min(x, y)` from another procedure:

```
LOAD r_x              ; acc = x                             2 bytes
PUSH                  ; push arg0                           1 byte (MOVE combo 6)
LOAD r_y              ; acc = y                             2 bytes
PUSH                  ; push arg1                           1 byte
CALL <proc_min>       ; invoke; callee sees r0=x, r1=y      2 bytes (ext LEB128)
                      ; acc = result on return; args popped
```

Arguments are pushed in order (§13.2); the callee's frame base is the
caller's TOS at the `CALL`. On return, TOS is rewound (args discarded) and
`acc` holds the result.

---

### A.2 Expression evaluation — TOS-hybrid stack vs register

**DSL expression** `(a + b) * (c + d)` where `a = r0, b = r1, c = r2, d = r3`.

The lowerer can choose between a **stack (RPN)** strategy and a **register**
strategy. Both produce the same result in `acc`.

**Stack strategy** — 1 byte per ALU node, intermediate values on TOS:

```
LOAD r0               ; acc = a                             2 bytes
PUSH                  ; stack: [a]                          1 byte
LOAD r1               ; acc = b                             2 bytes
ADD [--tos]           ; acc = a + b; stack: []              1 byte (combo 5)
PUSH                  ; stack: [a+b]                        1 byte
LOAD r2               ; acc = c                             2 bytes
PUSH                  ; stack: [a+b, c]                     1 byte
LOAD r3               ; acc = d                             2 bytes
ADD [--tos]           ; acc = c + d; stack: [a+b]           1 byte
MUL [--tos]           ; acc = (c+d) * (a+b); stack: []      3 bytes (escape)
```

**Total: 16 bytes.** The `MUL` is escape-tier (3 bytes); every other ALU
op is 1 byte. The TOS-hybrid model lets the expression tree unfold in pure
RPN — each binary node is one `OP [--tos]` (pop → acc, combo 5).

**Register strategy** — avoids push/pop, reuses a dead register slot:

```
LOAD r0               ; acc = a                             2 bytes
ADD r1 → r1           ; r1 = a + b (r1 held b, now dead)    2 bytes (combo 2)
LOAD r2               ; acc = c                             2 bytes
ADD r3                ; acc = c + d                         2 bytes (combo 1)
MUL r1                ; acc = (c+d) * r1                    3 bytes (escape)
```

**Total: 11 bytes.** Fewer instructions, no stack manipulation. The temp
reuses `r1` (the slot that held `b`) once `b` is consumed by the add — the
backend's register allocator does this automatically. The TOS-hybrid model
gives the lowerer both options freely — they share the same opcode space
(§18.2).

---

### A.3 LEB128 encode — the flagship example

**DSL source** (pure core; the `emit` call is an extension op, elided):

```c
u32 leb128_encode(u32 value) {
    u32 byte;
    while (1) {                    /* do-while recovery (§11.1): u32 ≥ 1 byte */
        byte = value & 0xFF;
        value = value >> 7;
        if (value != 0) {
            byte = byte | 0x80;
        }
        /* emit(byte); -- extension call */
        if (value == 0) {
            break;
        }
    }
    return 0;
}
```

**Lowered IR** (`value = r0`, `byte = r1`):

```
; --- while (1) ---
MOVE #1               ; acc = 1 (force entry)                2 bytes (imm-ext)
LOOP
  ; byte = value & 0xFF
  LOAD r0             ; acc = value                          2 bytes
  AND #0xFF           ; acc = value & 0xFF                   1 byte (per-op inline!)
  STORE r1            ; byte = acc                           1 byte (MOVE combo 2)

  ; value = value >> 7
  LOAD r0             ; acc = value                          2 bytes
  SHR #7              ; acc >>= 7                            2 bytes (imm-ext)
  STORE r0            ; value = acc                          1 byte

  ; if (value != 0) byte |= 0x80
  LOAD r0             ; acc = value                          2 bytes
  EQ #0               ; acc = (value==0). acc=0 ⟼ value≠0   1 byte (imm-zero!)
  BR_TABLE 1          ; case 0 (value≠0, cond true): set bit 1 byte (inline N=1)
    LOAD r1           ; acc = byte                           2 bytes
    OR #0x80          ; acc = byte | 0x80                    1 byte (per-op inline!)
    STORE r1          ; byte = acc                           1 byte
  BLOCK_END           ; default (value==0): skip             1 byte

  ; /* emit(byte) */ -- extension call, elided

  ; if (value == 0) break
  LOAD r0             ; acc = value                          2 bytes
  NE #0               ; acc = (value≠0). acc=0 ⟼ value==0   1 byte (imm-zero!)
  BR_TABLE 1          ; case 0 (value==0, cond true): break  1 byte
    BREAK             ; closes case + exits loop             1 byte
  BLOCK_END           ; default (value≠0): continue          1 byte

  ; re-evaluate while(1) condition
  MOVE #1             ; acc = 1 (always continue)            2 bytes (imm-ext)
BLOCK_END             ; back-edge → LOOP re-test             1 byte

RETURN                ; return 0 (acc happens to be 1 here;  1 byte
                      ; the caller checks byte count, not acc)
```

**Total: ~35 bytes** for the entire procedure. Mechanisms exercised:

- **Per-op inline literals are exactly right for LEB128.** `AND #0xFF` (extract
  7 bits + mask to byte) and `OR #0x80` (set continuation bit) are each 1 byte
  — the per-op table (§17.3) was designed around this codec. `SHR #7` is
  imm-extended (2 bytes) because 7 is not in any inline set.
- **Comparison imm-zero.** Both `EQ #0` and `NE #0` are 1 byte (§17.4).
  Zero-tests dominate this loop — the loop condition and both `if` guards
  compare against zero.
- **Complementary comparison for `if`-without-`else`.** `if (value != 0)` emits
  `EQ #0` (the complement) so that `acc=0` means "condition true" → `BR_TABLE 1`
  dispatches to case 0 (the body). The complementary form is compact here
  because `EQ` is in the compact comparison tier; the non-complementary `NE`
  would also be compact, but the lowerer uses the complementary form per §22.2
  to get `N=1` (1 byte) instead of `N=2`.
- **Do-while recovery.** A u32 always emits ≥ 1 byte, so the loop must execute
  at least once. The DSL uses `while (1)` with a `break` at the end (§11.1).
  The cost: `MOVE #1` before `LOOP` and before `BLOCK_END` (2+2 bytes for the
  constant condition). This is the standard pre-test tax for a must-run-once
  loop.
- **Terminator closes block.** `BREAK` closes the inner `BR_TABLE` case with no
  `BLOCK_END` after it (§14.3); the following `BLOCK_END` closes the `BR_TABLE`
  default, not the `BREAK`.

---

### A.4 Popcount — loop with bit manipulation

**DSL source:**

```c
u32 popcount(u32 x) {
    u32 count = 0;
    while (x != 0) {
        count = count + (x & 1);
        x = x >> 1;
    }
    return count;
}
```

**Lowered IR** (`x = r0`, `count = r1`):

```
; count = 0
MOVE #0               ; acc = 0                              1 byte (per-op inline)
STORE r1              ; count = 0                            1 byte

; while (x != 0)  — condition is a zero-test, no complementary needed
LOAD r0               ; acc = x                              2 bytes
NE #0                 ; acc = (x ≠ 0)                        1 byte (imm-zero!)
LOOP
  ; count += x & 1
  LOAD r0             ; acc = x                              2 bytes
  AND #1              ; acc = x & 1                          2 bytes (imm-ext: 1 ∉ AND's inline set)
  ADD r1 → r1         ; count += acc                         2 bytes (combo 2)

  ; x >>= 1
  LOAD r0             ; acc = x                              2 bytes
  SHR #1              ; acc >>= 1                            1 byte (per-op inline!)
  STORE r0            ; x = acc                              1 byte

  ; re-evaluate condition
  LOAD r0             ; acc = x                              2 bytes
  NE #0               ; acc = (x ≠ 0)                        1 byte
BLOCK_END             ; back-edge → LOOP                     1 byte

LOAD r1               ; acc = count                          2 bytes
RETURN                ; return count                         1 byte
```

**Total: ~24 bytes.** Mechanisms exercised:

- **`MOVE #0`** (1 byte) for the counter init — zero is MOVE's per-op inline
  literal, the most common constant in codec code.
- **`SHR #1`** (1 byte) — one is SHR's per-op inline literal. The loop's
  dominant shift is by exactly one.
- **`AND #1`** (2 bytes, imm-extended) — one is NOT AND's inline literal
  (that's `0xFF`); the lowerer falls back to imm-extended. This is the
  trade-off of a single inline value per op: it can't cover every case.
- **Register write-back** (`ADD r1 → r1`, combo 2) for the running count — no
  separate load/add/store; the ALU op writes directly to the register.
- **Comparison imm-zero** (`NE #0`) for both the loop test and the pre-loop
  evaluation (required by the pre-test model).

---

### A.5 `ceil_pow2(x)` — CLZ escape, single-shot shift

**DSL source:**

```c
u32 ceil_pow2(u32 x) {
    if (x == 0) {
        return 1;
    }
    u32 shift = 31 - clz(x - 1);
    return 1 << shift;
}
```

**Lowered IR** (`x = r0`, `shift = r1`):

```
; if (x == 0) return 1
LOAD r0               ; acc = x                              2 bytes
EQ #0                 ; acc = (x == 0). acc=0 ⟼ x≠0         1 byte
BR_TABLE 1            ; case 0 (x==0, cond true): return 1  1 byte
  MOVE #1             ; acc = 1                              2 bytes (imm-ext)
  RETURN              ; return 1; closes case                1 byte
BLOCK_END             ; default (x≠0): continue              1 byte

; shift = 31 - clz(x - 1)
LOAD r0               ; acc = x                              2 bytes
SUB #1                ; acc = x - 1                          1 byte (per-op inline!)
clz()                 ; acc = clz(x-1)                       3 bytes (core escape)
RSUB #31              ; acc = 31 − acc = 31 − clz(x-1)       3 bytes (escape + imm-ext)
STORE r1              ; shift = acc                          1 byte

; return 1 << shift
MOVE #1               ; acc = 1                              2 bytes (imm-ext)
SHL r1                ; acc = 1 << shift                     2 bytes (combo 1)
RETURN                ; return acc                           1 byte
```

**Total: ~27 bytes.** Mechanisms exercised:

- **Core escape for `clz()`** (§21.1) — `CLZ` has no C operator and no compact
  encoding; it costs 3 bytes (escape prefix + secondary opcode). This is the
  price of a rare op in the tiered encoding (§17.5).
- **`RSUB #31`** (escape-tier + imm-extended) — `31 − acc` needs reversed
  subtraction. The escape form supports all ALU modes including imm-extended,
  so the entire expression `31 − clz(x−1)` is two ops after the `SUB #1`.
- **`SUB #1`** (1 byte) — one is SUB's per-op inline literal, used here for the
  `x − 1` canonical power-of-two trick.
- **`SHL r1`** (2 bytes, register mode) — shift by a runtime value (not an
  inline constant). The shift amount comes from `r1`, masked to 5 bits (§8.3).
