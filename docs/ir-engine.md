# Embedded IR Engine — Rationale & Architecture (DRAFT)

> Status: iteratable draft. This revision replaces the ISA table (§3) with an
> **abstract operations** list classified by operand-mode constraints — the
> right level for deriving an encoding. The exact byte layout remains deferred
> (§7).

## 1. Purpose

Codecs translate between a **wire format** (bytes on the medium) and a **target
data model** (native host structures). Per the architecture spec, codecs never
allocate and never own memory — they emit procedural instructions to a proxy.

The IR engine provides a **portable, compact representation of those
procedures** so that:

- An embedded endpoint can ship its codec as an opaque blob (or just a hash of
  it) instead of locking both ends into identical compile-time code.
- A resource-rich endpoint can fetch that blob and AOT-compile or JIT-evaluate
  it without any prior knowledge of the wire format.
- Wire format, semantic types, and host memory layout remain independently
  evolvable.

The single overriding design metric is **minimizing the on-wire size of the
portable codec definition** (which bundles the semantic type tree plus a set of
procedures). Backend execution cost is explicitly *not* a constraint — the
target is free to unroll, lower to registers, or interpret however it likes.

## 2. Key design decisions (and why)

### 2.1 Structured control flow, not raw jumps

The DSL already forbids `goto`, so every branch target is well-nested. Encoding
block boundaries with 1-byte `BLOCK_END` markers is more compact than explicit
LEB128 branch offsets, because the constraint "targets must be well-nested"
removes entropy that a generic `br + offset` must carry. Wasm demonstrates this
concretely.

### 2.2 Single branching primitive: `BR_TABLE`

A conditional branch is just a jump table with two targets (one of which may be
empty). We therefore have **one** branching primitive, `BR_TABLE`, rather than
separate `BR_IF` + `BR_TABLE`. Whether the 2-target common case earns a
dedicated compact encoding is a layout-time decision (§7); semantically it is
the same instruction.

### 2.3 No offsets — `BR_TABLE` carries only the case count

The whole point of structured control flow (§2.1) is to avoid carrying branch
offsets. So `BR_TABLE` does **not** encode target offsets or block lengths. It
carries only **N**, the static case count (the runtime selector lives in
`acc`). The construct is a sequence of N case-blocks, each terminated by its
own `BLOCK_END`:

```
BR_TABLE N            ; N = static case count; selector in acc picks block[acc]
  <case 0 block>
BLOCK_END
  <case 1 block>
BLOCK_END
  ...
  <case N-1 block>
BLOCK_END
```

An `if-else` is just N=2; an `if`-without-`else` is N=2 with an empty else
block (a lone `BLOCK_END`, 1 byte). A `switch` is N = variant count.

**The decoder can always find the BLOCK_ENDs** because it parses the construct
as a tree: read N, then parse N case-blocks sequentially. Each case-block is a
statement list parsed until *its own* terminating `BLOCK_END`. Nested
constructs inside a case (inner `if`/`switch`/`loop`) are parsed recursively
and consume their own `BLOCK_END`s internally, so the first `BLOCK_END`
encountered at the case's nesting level closes that case. After N such
closings, the construct is complete. No `ELSE` marker, no offsets — one marker
closes every block shape.

### 2.4 Stream iterators as small literals

A procedure manipulates one or more *stream iterators* (read cursors and/or
write cursors over the wire). Iterators are named by small literal IDs
(typically `< 4`). The codec can fork copies:

- `CLONE_RD <src> <dst>` — fork a readable cursor (e.g. at the start of the
  packet, for checksumming).
- `CLONE_WR <src> <dst>` — fork a writable cursor (e.g. parked at the checksum
  field location, for later fixup).

This handles the checksum/fixup pattern **without any seek instruction**:

1. Fork a readable iterator at packet start (`CLONE_RD 0 1`).
2. Fork a writable iterator at the checksum field location
   (`CLONE_WR 0 2`), then write a placeholder byte with the *original* writer
   and continue serializing the rest with the *original* writer.
3. Walk the reader fork end-to-end, accumulating the checksum.
4. Emit the checksum through writer `2`, which is still parked at the checksum
   location.

If the checksum is at the end of the packet, only the initial reader fork is
needed — no write-side fork at all.

Because iterator IDs are literals, the backend can map each ID to a concrete
local (`uint8_t *rd0`, `uint8_t *wr2`, …) with zero indirection. An extended
encoding handles the rare `> 4` case.

> `SEEK`/`ADVANCE` is *not* required for fixups. It may still be useful for
> skipping unknown/optional fields; treated as optional and revisitable.

### 2.5 TOS-hybrid accumulator + stack-pointer register machine

The execution model is a degenerate (PIC-style) accumulator machine extended
with a "stack pointer into the register file":

- **Accumulator / work register** — implicit operand 1 of every binary op.
- **Infinite register file** — the "other" operand is addressed by index; the
  backend maps indices to real registers or stack slots. Named locals live
  here, so accessing a local needs no separate load/store instruction.
- **TOS pointer** — a register index used as an *indirect* register address
  with three modes:
  - `[tos++]` — push (post-increment) — **write-only**
  - `[--tos]` — pop (pre-decrement) — **read-only**
  - `[tos-1]` — peek (no change) — **read-write**

This lets one procedure freely mix three description styles:

| Style | Use case |
|-------|----------|
| Pure stack (RPN) | Expression-tree traversal — 1 byte per node |
| Register | Named locals, loop counters, running checksums |
| Hybrid | RPN expression that spills intermediate to a local |

### 2.6 Addressing modes and the 7-combo constraint

There are five addressing modes. **Register** and **peek** are read-write
capable. **Pop** and **imm** (immediate literal) are read-only. **Push** is
write-only. This means the output target is *forced* for push, pop, and imm —
those modes carry one fewer bit of freedom than the read-write modes. For a
binary-class instruction (two inputs, one output, accumulator is one input),
the valid (mode × output) combinations are:

| # | Mode | Input from | Output to | Example |
|---|------|-----------|-----------|---------|
| 1 | register | `rN` | `acc` | `acc = acc + rN` |
| 2 | register | `rN` | `rN` | `rN = acc + rN` |
| 3 | peek | `[tos-1]` | `acc` | `acc = acc + peek` |
| 4 | peek | `[tos-1]` | `[tos-1]` | `peek = acc + peek` |
| 5 | pop | `[--tos]` | `acc` | `acc = acc + pop` (pure stack binary) |
| 6 | push | *(none — unary)* | `[tos++]` | `push(op(acc))` (subsumes `DUP`) |
| 7 | imm | `imm` | `acc` | `acc = acc + imm` (subsumes `CONST`) |

That is **7 valid combinations**. Modes that are read-only (pop, imm) or
write-only (push) fix the output target, so the semantically invalid pairings
(pop→pop, push→acc, imm→rN/peek/push) never appear in code and carry no
encoding bits.

> **Naming note.** The mode is called **register** (addressed by index `rN`),
> not "literal", to avoid collision with the **imm** mode which carries an
> integer literal. Earlier drafts conflated the two, which hid the fact that
> there was no immediate operand path at all — the gap that motivated adding
> the `imm` mode (combo 7).
>
> **`DUP` is subsumed.** Combo 6 (`push(op(acc))` with op = identity) *is*
> `DUP`. No dedicated `DUP` opcode is needed; it is the push mode of the
> MOVE/identity instruction.
>
> **`CONST`/`CONST_SMALL` are subsumed.** Combo 7 (MOVE with op = identity,
> imm source, output → `acc`) *is* a constant load. No standalone immediate
> opcodes are needed; the small/extended immediate split becomes a property of
> the `imm` mode sub-encoding (see §3.1), shared by ALU, comparison, and MOVE.
>
> **`SWAP` is dropped.** No DSL-level construct maps directly to a swap (C has
> no tuple exchange; `tmp=a; a=b; b=tmp` lowers to MOVEs). The lowering pass
> can always restructure expression evaluation to avoid swap, or use a temp
> register. A dedicated `SWAP` opcode would consume encoding space for no
> guaranteed benefit.

### 2.7 Prefix code + bounded joint table-lookup (not arithmetic coding)

Backend decode effort is explicitly unconstrained, so the encoding need not be
byte-aligned or fixed-width. But that freedom is deliberately capped at two
mechanisms:

1. **Static prefix code.** Each instruction class has a fixed-width field sized
   to `ceil(log₂(states))` over a *static* prior (a representative codec
   corpus), not per-codec adaptive frequencies. Rare opcodes still consume
   code-space and can push a field wider — they are *not* "free when unused."
2. **Bounded joint table-lookup.** When two adjacent fields each round up past
   a whole-bit boundary but their product fits a whole number of bits, they may
   share a code subspace: pack `(fieldA, fieldB) → flatIndex`, decode via one
   table, store `ceil(log₂(|A|·|B|))` bits instead of
   `ceil(log₂|A|) + ceil(log₂|B|)`. Bounded scope (a pair or small tuple), no
   state, no carry — fully testable. A 4-state comparison field joined with a
   neighbor is a natural candidate.

**Explicitly ruled out:** a true arithmetic-coding layer as the outermost
encoding. An adaptive, stateful, carry-across-opcodes coder would be an
unexhaustable source of gotchas (renormalization, underflow, byte-flush
ordering, end-of-stream) for negligible gain once the prefix code is efficient.
The arithmetic-coding framing in earlier drafts was a figure of speech; the
real commitment is the two mechanisms above. *The opcode is a prefix code, and
its width is a function of the instruction class; adjacent under-full fields
may share a table, but nothing carries fractional bits across instructions.*

### 2.8 Comparisons and ordering via branch inversion

The accumulator is always operand 1, so "reversing operands" to derive `>` /
`>=` is *not* free (it would need a `SWAP`, which we dropped). Instead we
exploit structured control flow: **branch inversion is free**. Negating a
comparison is realized by swapping the then/else blocks, so:

- `LT`  →  `!(a < b)`  =  `a >= b`  =  `GE`
- `LE`  →  `!(a <= b)` =  `a > b`   =  `GT`

We therefore carry only `LT`, `LE`, `EQ`, `NE` and derive `GT`/`GE` by branch
inversion. No operand swap, no extra opcodes.

### 2.9 Target accessors — object handles (one of the two codec interfaces)

A codec has exactly two interfaces to the outside world: the **stream**
(bytes on the wire, §2.4/§2.10) and the **target object** (the host data model:
structs, unions, lists, primitives). Struct fields, union variants, list
elements, and primitive values are all *target accessors* and are unified here.

**Object handles are the symmetric counterpart of stream iterators.** Just as a
codec receives an implicit stream iterator `i0` at entry, it receives an
implicit **object handle `o0`** referring to the object it must encode/decode.
Handles are small literal IDs (typically `< 4`), and the codec **enters** a
field/variant/element of an existing handle to spawn a new handle referencing a
nested construct:

```
ENTER o_src, ref → o_dst   ; navigate from o_src to a child → new handle o_dst
```

`ENTER` is the single navigation primitive. The source handle's type is
**statically known** (derived from the navigation path), so the meaning of `ref`
is disambiguated by that type's **kind** — one `ENTER` instruction, one `ref`
encoding, three meanings:

| `o_src` type kind | `ref` means | effect |
|-------------------|------------|--------|
| struct            | field #    | handle to that field's sub-object |
| union             | variant #  | handle to that variant's payload |

(Entering a **list**-typed struct field yields a handle to the *list as a
whole*; element-by-element iteration is `ENTER_NEXT` — §3.7.)

**This resolves deep navigation** (previously an open question): reaching a
union variant nested inside a struct field is just two `ENTER`s —
`ENTER o0, struct_field → o1; ENTER o1, variant_idx → o2` — followed by
`LOAD_VAL`/`STORE_VAL` on `o2`. No path encode, no runtime lookups in the
instruction stream; the path is the static sequence of `ENTER`s.

#### Navigation then value-access (unfused is the core)

The **natural core operations** are *unfused*: navigate to a child with `ENTER`,
then access the value *at* a handle with `LOAD_VAL`/`STORE_VAL` (no `ref` — the
handle already refers to the target primitive):

- **`ENTER dst, src, ref`** — navigate to ANY child (struct field / union
  variant / list-as-a-whole) → named handle `dst`.
- **`LOAD_VAL [src=o0]`** — `acc` = primitive value *at* the handle (encoder).
  No `ref`; the handle's referent IS the primitive.
- **`STORE_VAL [src=o0]`** — primitive value *at* the handle = `acc` (decoder).

This handles **delegated number codecs** (LEB128, fixed-width): the sub-codec
receives `o0` already pointing at the primitive — it just `LOAD_VAL`s it, no
`ref` needed. It also handles `union({x: number})`: `ENTER o1, o0, variant0`
gives a handle to the number, then `LOAD_VAL o1` reads it.

The **fused** `LOAD_VAL src, ref` (enter+load a primitive child in one op) is an
**irregularization / deferred optimization** — it collapses the common
struct-of-scalars case from `ENTER`+`LOAD_VAL` to a single instruction, but it
is not a natural core operation. It will be reconsidered once opcode space is
measured against real codecs.

#### Delegation — fused, and the only form

Delegation's entire purpose is that the caller does **not** want to deal with
the sub-representation, so the fused form is natural and **sufficient as the
only form**:

- **`CALL_CODEC codec_idx, src, ref`** — invoke `codec[codec_idx]` on
  `child(src, ref)`; the invoked codec's implicit `o0` is that child.
- **`CALL_CODEC_NEXT codec_idx, src`** — fused enter-next + delegate: advance to
  the next list element of `src` and delegate to `codec[codec_idx]` on it. This
  is the list-element delegation form (no separate `ENTER_NEXT`+`CALL_CODEC`).

The two-operand `CALL_CODEC codec_idx, handle` form (delegate on a pre-existing
handle) is **dropped** — if you're delegating, the fused form is always used.
Manual list iteration without delegation still uses `ENTER_NEXT` (§3.7).

#### The type-reference list (kept, and now grounded)

A procedure still carries a **referenced-types list** (the static set of
object-tree node types it navigates among — usually one entry). Each handle's
type is one of these, derivable at build time. The short form (implicit
`type_ref 0`) targets the primary object; an extended form selects others for
multi-layer codecs (e.g. a packed-bitmap codec touching several sibling types).
This keeps field-segmentation (§7) intact: a 3-bit literal offset reaches the
first 8 fields of the handle's referenced type.

#### Two constraint axes (both static, both enable encoding overlap)

1. **Directionality.** Every procedure is **either an encoder or a decoder**,
   transitively through sub-codec invocations — an encoder never invokes a
   decoder. Therefore target accessors are one-directional:
   - **Encoder** → handles are **read-only** (`LOAD_VAL`, `ENTER` to navigate,
     `COUNT`/`TAG` metadata queries).
   - **Decoder** → handles are **write/init-only** (`STORE_VAL`; `ENTER` on a
     union *selects+instantiates* the variant, on a list *opens/appends*;
     `OPEN_LIST` with a capacity hint).
   Because the direction is a single bit in the procedure header, **read and
   write accessor opcodes can overlap** — disambiguated by that bit. `LOAD_VAL`
   and `STORE_VAL` share one opcode slot.

2. **Type-kind disambiguation.** The semantic type of every field/variant/
   element/value is known at build time (captured in the codec's pattern-match
   object). So only the *relevant* accessors are emitted, and **overlapping
   representations** can be used: the same `ref` encoding means field/variant/
   element depending on the source handle's type kind. No per-accessor tags.

#### Lists — sequential, minimal obligation on targets

Lists are entered like any other child, but element access is **sequential**
(`ENTER_NEXT`), mirroring stream cursors. This is the *minimal* obligation on a
target mapping — streaming, ring buffers, DMA descriptors, and fixed-capacity
arrays all support sequential access natively; many cannot do random access at
all, and random access would demand pre-allocation from every target. The list
length is queried by `COUNT` (encoder) for the length prefix; capacity is
supplied to `OPEN_LIST` (decoder) as a hint the target may honor or ignore. The
**target manages all memory** (zero-allocation principle); the codec never
allocates. Out-of-order codecs use the stitching layer to unroll.

#### Initialization

- **List capacity** — `OPEN_LIST` carries the count in `acc`; the target
  pre-allocates if it can, ignores if it can't.
- **Union variant** — implicit in `ENTER` on the decoder side: entering variant
  `k` selects it active and yields a writable handle to its payload. No
  dedicated `SELECT_VARIANT` instruction.

#### Delegation

`CALL_CODEC codec_idx, src, ref` is the **only** delegation form (fused — see
above). The invoked codec's implicit `o0` is `child(src, ref)`, and its
referenced-types list is its own. `CALL_CODEC_NEXT codec_idx, src` delegates to
the next list element. There is no separate "delegate on a handle" form.

> **Resolved questions.** (a) Encoder active-variant access: `TAG` → `BR_TABLE`
> → `ENTER` (with the case's static variant index, read-only) is sufficient; no
> dedicated encoder-side op. A fused `ENTER_ACTIVE` is a deferred optimization
> (§7). (b) Fused vs separated delegation: fused is the only form. (c)
> Read/write opcode overlap: confirmed — no counter-example exists on the target
> side (encoder = read-only source, decoder = write-only sink, transitive); the
> direction bit in the procedure header cleanly separates `LOAD_VAL` from
> `STORE_VAL`. (d) Sequential-only list access: sufficient for now — multipass
> read is possible by entering a list multiple times; random access and other
> target-specific capabilities are deferred to a future **extension-point**
> mechanism (call-out ops + trait processing bound by the type mapper at
> code-gen time — system-wide consequences, out of scope for now).

### 2.10 Stream I/O is byte-granular, not field-granular

Stream iterators read and write **bytes** (or halfwords/words), not fields. Wire
encoding of a field (LEB128, fixed-width, bit-packed, etc.) is expressed *as an
IR procedure* using byte-level `READ`/`WRITE` plus arithmetic. The
metaprogramming/stitching layer generates these sequences from higher-level
codec declarations. This keeps the IR primitive and general — any wire format is
expressible without dedicated per-format opcodes.

### 2.11 Parser emits C-AST; stitching is a separate later layer

TypeScript metaprogramming (unrolling fields, conditional codec selection,
etc.) means a full procedure is typically **stitched together from many small
`ir\`…\`` fragments**, possibly generated inside `for`/`if` at compile time.

The pipeline is therefore split into clean layers:

```
ir`…` ──PEG──▶ C-AST fragment  ┐
                                ├──▶ stitch ──▶ lowered AST ──▶ IR bytecode ──▶ wire blob
ir`…` ──PEG──▶ C-AST fragment  ┘  (resolve labels,
                                    merge scopes)
```

- **PEG parser** — pure syntax → `ast.ts` nodes. No semantic knowledge.
- **`ir` tag** — wraps the parsed fragment in an `IrFragment` so later layers
  can identify and combine it.
- **Stitching layer** — concatenates fragments, resolves jump labels
  across fragment boundaries, deduplicates declarations, merges scopes.
- **Lowering pass** — converts the stitched AST into IR bytecode using the
  semantic type tree and wire-format knowledge.
- **Binary serializer** — packs IR bytecode + semantic type tree + string table
  into the compact portable blob (LEB128, deduplicated field names, etc.).

Step 1 (this milestone) wires only the `ir` tag → PEG parser → `IrFragment`.

## 3. Abstract operations (grouped by operand-mode constraints)

This section replaces the ISA table. Operations are grouped by their "mode
dynamic range" — the set of valid (addressing-mode × output-target)
combinations — because that is what determines the encoding width.

### 3.1 Binary-class (7 mode combos)

Each has the accumulator as one input and an "other operand" addressed by one
of the 7 valid combos from §2.6.

**Binary ALU** — `ADD, SUB, RSUB, MUL, AND, OR, XOR, SHL, SHR`
- Semantics: `result = acc ⟨op⟩ other_operand` (`other ⟨op⟩ acc` for `RSUB`;
  `op(acc)` for combo 6).
- Output target per the combo table (§2.6).
- **No `DIV`/`MOD`.** Many MCUs lack hardware division; these would silently
  emit expensive software loops. Codec arithmetic is dominated by shifts,
  masks, adds, and compares — division essentially never appears. Modulo by a
  power of two (e.g. ring-buffer wrap) is `AND (N-1)`. If a codec truly needs
  division, the lowering pass can emit a call to a software helper; the ISA
  stays minimal.
- **State count:** 9 ops × 7 combos = **63 states = 6 bits**. `RSUB`
  (`other − acc`) is added because it fits the 6-bit budget for free and
  appears in real codecs (checksum complement, `capacity − remaining`,
  `expected − actual`). ARM keeps `RSB` for the same reason.
- **Reverse shifts deliberately omitted.** `RSHL`/`RSHR` (`other ⟨shift⟩ acc`)
  would push the class to 10 × 7 = 70 states = **7 bits**, taxing every binary
  op permanently for a case that is rare in codecs (the value being shifted is
  almost always the freshly-loaded field in `acc`, not a computed expression).
  When it does occur, the lowering pass spills one register
  (`STORE rShift; LOAD_VAL value; SHL rShift`) — 1 extra byte in a rare case,
  strictly cheaper than a permanent +1 bit. `RSUB` is decomposable
  (`NEG; ADD rN`) *and* free, which is why it's kept; `RSHL`/`RSHR` are
  irreducible *and* costly, which is why they're dropped.

**MOVE** — transfer between `acc` and the addressed register/immediate.
- Read-direction (operand → acc): combos 1, 3, 5, 7 (register, peek, pop, imm).
  - `LOAD rN`, `LOAD [tos-1]`, `POP` (pop into acc), `LOAD_IMM imm` (≡ `CONST`).
- Write-direction (acc → operand): combos 2, 4, 6 (register, peek, push).
  - `STORE rN`, `STORE [tos-1]` (overwrite top), `PUSH acc` (≡ DUP).
- Same 7-shape dynamic range as binary ALU → can share a format.
- **`imm` sub-encoding:** small immediate (3–4 bits, inline) or extended
  (trailing LEB128), shared by MOVE/ALU/comparison. This replaces the former
  standalone `CONST`/`CONST_SMALL` opcodes (deleted class, ex §3.5).

> `DUP` is the identity-MOVE in push mode (combo 6). `CONST` is the
> identity-MOVE in imm mode (combo 7, output → acc). No separate opcodes.

### 3.2 Comparison-class (4 mode combos)

The "other operand" is **read-only** (result always → `acc` as a boolean), so
the four read-capable modes apply (register, peek, pop, imm):

| # | Mode | Input from |
|---|------|-----------|
| 1 | register | `rN` |
| 2 | peek | `[tos-1]` |
| 3 | pop | `[--tos]` |
| 4 | imm | `imm` |

**Comparisons** — `LT, LE, EQ, NE` → boolean in `acc`. `GT`/`GE` derived by
branch inversion (§2.8). **4 ops × 4 modes = 16 states = exactly 4 bits** —
a clean field, and a prime candidate for joint table-lookup with a neighbor
(§2.7). The `imm` combo is the workhorse here: tag dispatch, magic-byte
checks, and width comparisons (`EQ_IMM tag`) dominate real codec comparisons
and no longer require a separate `CONST; CMP` pair.

### 3.3 Unary-class (no other operand)

**Unary ALU** — `NEG, NOT` — `acc = op(acc)`. No mode bits, no operands.
Single-byte encodable.

### 3.4 No-operand class

**`RETURN`** — end procedure.
**`BLOCK_END`** — close the enclosing block. Its semantics are determined by the
block's **start marker** (§3.8):
  - closes a `BR_TABLE` case → unconditional fall-through to after the construct
    (subsumes `ELSE`, §2.3);
  - closes a `LOOP` → **unconditional back-edge** to the `LOOP` opener, which
    then re-evaluates the continue-condition.

`LOOP_ITER` is therefore **folded into `BLOCK_END`** — there is one closer for
all block shapes; the start marker declares the end semantics. Note the
uniformity this produces: **the test always lives at the opener, and the closer
is always unconditional** (`BR_TABLE` cases fall through; `LOOP` body
back-edges). `DUP`/`SWAP` are also absent (`DUP` is MOVE push-mode, `SWAP` is
dropped — §2.6).

**`BREAK`** — structured exit from the innermost enclosing `LOOP`: jump to the
instruction after its matching `BLOCK_END`. **`CONTINUE`** — structured
re-test: jump to the innermost `LOOP`'s matching `BLOCK_END` (the back-edge,
which returns to the opener for re-testing). Both are no-operand — the target
is determined statically by the enclosing `LOOP` scope.

> **Why these can't be avoided by nesting.** `continue` could *almost* be
> expressed by putting the rest of the body inside the `else` of a `BR_TABLE`,
> but only when the `continue` is the last statement; in general it must skip
> forward over trailing code = a jump. `break` is worse: no amount of nesting
> can exit an enclosing loop, so it is an irreducible structured jump. Both
> therefore earn their own opcodes.
>
> **No switch-`break` ambiguity.** Because each `BR_TABLE` case is inherently
> break-terminated by its `BLOCK_END` (fall-through), a DSL-level `break` never
> targets a switch — it always unambiguously targets the innermost loop. So
> `BREAK`/`CONTINUE` only ever resolve against a `LOOP`, never a `BR_TABLE`.

All no-operand instructions (`RETURN`, `BLOCK_END`, `BREAK`, `CONTINUE`) are
single-byte encodable. `BREAK`/`CONTINUE` are rare in generated codec code, so
whether they get dedicated single-byte opcodes or ride the extended/escape
mechanism (§7) is a layout-time decision.

### 3.5 Immediate operands (folded into MOVE/ALU/comparison)

~~`CONST imm` / `CONST_SMALL imm`~~ — **deleted as a standalone class.**
Constants now flow through the `imm` addressing mode (combo 7, §2.6):

- `MOVE` + imm (output → `acc`) replaces both `CONST` and `CONST_SMALL`.
- Binary ALU + imm (`ADD_IMM`, `AND_IMM`, …) folds a constant into its
  consumer — the common case, e.g. `ADD_IMM 1`, `SHL_IMM 2`, `AND_IMM 0x0F`.
- Comparison + imm (`EQ_IMM`, `LT_IMM`, …) handles tag/magic-byte/width checks.

The small/extended immediate split (inline 3–4 bits vs trailing LEB128) is a
property of the `imm` mode sub-encoding shared across all three classes — one
immediate mechanism instead of three opcodes. Small constants (`0`, `1`, `2`,
`4`, powers of two) dominate codec arithmetic; the inline form keeps them in
one byte, mirroring Java's `iconst_0`–`iconst_5` and Wasm's `i32.const`
shortcut.

### 3.6 Stream I/O class

**`READ i, w`** — `acc = stream[i].read(w)` where `w ∈ {1,2,4}` bytes.
**`WRITE i, w`** — `stream[i].write(acc, w)`.
**`HAS_NEXT i`** — `acc = (stream[i] has ≥1 more byte)` — the readable-iterator
exhaustion test. This is the stream-side counterpart of the target-side
`COUNT`/`TAG` metadata queries, and is what makes pretest stream loops
expressible (§4.4).
**`CLONE_RD src, dst`** — fork readable iterator.
**`CLONE_WR src, dst`** — fork writable iterator.
**`SEEK i, Δ`** *(optional)* — advance/rewind by LEB128 delta.

Iterator IDs are small literals (typically `< 4`); width `w` fits in 2 bits.
The common case (`i < 4`, `w ∈ {1,2,4}`) can pack into a single byte with the
opcode. `HAS_NEXT`/`CLONE_*` take only an iterator ID (or two), so they pack
even tighter.

### 3.7 Target access class

Core operations are **unfused**: `ENTER` navigates to a child, then value/metadata
ops access the handle directly (no `ref` — the handle already refers to the
target). Delegation is the **only fused** op. The procedure's direction bit
(encoder/decoder) selects read vs write semantics for the overlapping value ops
(§2.9). `[type_ref,]` is the optional multi-type prefix on `ref`-bearing ops.

**Navigation:**
**`ENTER dst, src, [type_ref,] ref`** — navigate child of `src` → handle `dst`.
`ref` = struct field # or union variant # (disambiguated by `src`'s type kind);
decoder-side `ENTER` on a union variant selects+instantiates it.
**`ENTER_NEXT dst, src`** — list element sequential advance → element handle.

**Value access (operate on the handle, no `ref`):**
**`LOAD_VAL [src=o0]`** *(encoder)* — `acc` = primitive value at the handle.
**`STORE_VAL [src=o0]`** *(decoder)* — primitive value at the handle = `acc`.
*(Same opcode slot — direction bit.)*

**Metadata / initialization (operate on the handle, no `ref`):**
**`COUNT [src=o0]`** *(encoder)* — `acc` = list length at the handle.
**`TAG [src=o0]`** *(encoder)* — `acc` = union active variant index at the handle.
**`OPEN_LIST [src=o0]`** *(decoder)* — instantiate the list at the handle;
`acc` = capacity hint (target may honor or ignore).

**Delegation (fused — the only form):**
**`CALL_CODEC codec_idx, [src=o0,] [type_ref,] ref`** — delegate to
`child(src, ref)`. Invoked codec's `o0` is that child.
**`CALL_CODEC_NEXT codec_idx, [src=o0]`** — fused enter-next + delegate: advance
to the next list element of `src` and delegate.

> **Deferred optimizations** (reconsider once opcode space is measured): fused
> `LOAD_VAL src, ref` / `STORE_VAL src, ref` (enter+access a primitive child in
> one op); fused encoder `ENTER_ACTIVE` (enter active union variant in one op).

Handle IDs are small literals (like stream iterators, typically `< 4`). Field
`ref`s (on `ENTER`/`CALL_CODEC`) benefit from the segmentation scheme (§7): a
3-bit literal offset reaches the first 8 fields of the referenced type; larger
the first 8 fields of the referenced type; larger indices escape.

### 3.8 Control flow class

Two block **start markers**, both closed by `BLOCK_END` (§3.4):

**`BR_TABLE N`** — opens an `if`/`switch`; dispatches on `acc` to one of N
case-blocks (N=2 for `if`/`if-else`; N>2 for `switch`). Carries only the static
count N (LEB128, usually 1 byte); the runtime selector is in `acc`. Each
case-block is terminated by `BLOCK_END` (unconditional fall-through); no offsets
or `ELSE` markers (§2.3).

**`LOOP`** — opens a **top-test** loop. The continue-condition is in `acc` at
the opener: `acc = 0` → exit (fall through to after the matching `BLOCK_END`);
`acc ≠ 0` → enter the body. The body is closed by `BLOCK_END` as an
**unconditional back-edge** to the opener (which re-tests). This is the
`while`/`for` form — zero iterations is possible. The loop exit target is the
instruction after `BLOCK_END`.

`do-while` (bottom-test) is **not expressible** and is banned at the DSL level
(no `do` keyword). Its behavior is recoverable when needed by adjusting the
loop variable's initial value (`±1`), or by duplicating the body before a
`while` — but in practice every codec loop (iterate until stream/list exhausted)
is naturally top-test.

`break` inside a loop body → the **`BREAK`** instruction (§3.4): structured jump
to the exit target (after the matching `BLOCK_END`). `continue` → the
**`CONTINUE`** instruction: structured jump to the `LOOP`'s matching
`BLOCK_END` (the back-edge → opener re-test). For a `for` loop, the lowering
pass places the increment just before `BLOCK_END`, so `continue` runs the
increment then re-tests. Both always target the innermost enclosing `LOOP`
(never a `BR_TABLE`, whose case-exit is implicit via `BLOCK_END`), so they
carry no operand.

> **One closer, two openers.** `BLOCK_END` is universal; `BR_TABLE` and `LOOP`
> are the only block starts. This subsumes the earlier `LOOP_ITER`/`ELSE`
> markers — both folded into `BLOCK_END` with start-declared semantics.

## 4. Worked examples

These examples stress the abstractions. The recurring lesson: **fused
delegation (`CALL_CODEC`) is the dominant size win, not fused field access** —
typical generic codecs delegate each child to its resolved sub-codec, so the
struct/union cases (4.1, 4.2) collapse to a few `CALL_CODEC`s, far smaller
than the unfused `ENTER`+`LOAD_VAL`+`WRITE` spelling.

Notation in examples: `LOAD rN` / `STORE rN` are MOVE register-mode;
`OP_IMM imm` is binary-ALU with `imm` mode (result → `acc`);
`OP rN` annotated with its combo when the output isn't `acc`;
`<LEB128>` is a stitching-layer inline macro (the IR of §4.3 spliced in —
exactly the TS-metaprogramming fragment-stitching use case of §2.11).

### 4.1 Generic struct encoder — delegates each field

`{x: u32, y: u16, flag: u8}`, generic encoder. Each field delegates to the
number codec its type resolves to — the *typical* form, and three instructions:

```
CALL_CODEC codec_u32, o0, x
CALL_CODEC codec_u16, o0, y
CALL_CODEC codec_u8,  o0, flag
RETURN
```

> Contrast: the unfused core spelling (`ENTER o1,o0,x` / `LOAD_VAL o1` /
> `WRITE i0,4` ×3) is 9 instructions. So fused **delegation** is the win; fused
> field-access (`LOAD_VAL o0,x`) is only an irregularization on top of an
> atypical spelling, which is why it stays deferred (§2.9) while fused
> delegation is core.

### 4.2 Generic union encoder — delegates active variant

Union of three number payloads. `TAG` reads the active variant index, then
`BR_TABLE` dispatches; each case delegates to its variant's codec:

```
TAG                       ; acc = active variant index (src=o0)
BR_TABLE 3
  CALL_CODEC codec_a, o0, 0
BLOCK_END
  CALL_CODEC codec_b, o0, 1
BLOCK_END
  CALL_CODEC codec_c, o0, 2
BLOCK_END
RETURN
```

### 4.3 LEB128 encoder (u32 → LEB128 bytes) — stresses ALU, imm, loop

Sub-codec for a primitive u32. `o0` is the primitive handle. A u32 always emits
≥1 byte, so the loop must run at least once — recovered as pretest by
initializing the condition to true (§3.8's do-while-recovery note). Bit
manipulation via `AND_IMM`/`SHR_IMM`/`OR_IMM`; continuation-bit set is a
2-case `BR_TABLE`:

```
LOAD_VAL              ; acc = value (src=o0)
STORE r_val
LOAD_IMM 1            ; cond = true (force first entry)
LOOP
  ; byte = r_val & 0x7F
  LOAD r_val
  AND_IMM 0x7F
  STORE r_byte
  ; r_val >>= 7
  LOAD r_val
  SHR_IMM 7
  STORE r_val
  ; if r_val != 0: set continuation bit
  LOAD r_val
  EQ_IMM 0            ; acc = (r_val == 0)
  BR_TABLE 2          ; case 0 (more): set bit; case 1 (done): skip
    LOAD r_byte
    OR_IMM 0x80
    STORE r_byte
  BLOCK_END
    ; case 1: no bit
  BLOCK_END
  ; emit byte
  LOAD r_byte
  WRITE i0, 1
  ; re-test cond: continue while r_val != 0
  LOAD r_val
  NE_IMM 0
BLOCK_END              ; back-edge → LOOP (re-test)
RETURN
```

### 4.4 Checksum with fixup — stresses stream forks + `HAS_NEXT`

The `<compute hasMore>` gap from earlier drafts is filled by `HAS_NEXT i`
(§3.6). Note the **pretest cost**: the runtime condition must be computed once
*before* `LOOP` (initial test, allows zero iterations) **and** once at the end
of the body (so the back-edge re-tests a fresh value). Both occurrences are
genuine — this is the standard price of pretest loops with a runtime condition,
and the reason `do-while` was occasionally nicer before being banned.

```
CLONE_RD 0 1          ; reader fork at packet start (for checksumming)
CLONE_WR 0 2          ; writer fork parked at checksum field
WRITE i0, 1           ; placeholder byte via original writer
; ...serialize rest of packet with original writer i0 (elided)...
LOAD_IMM 0
STORE r_sum           ; r_sum = checksum accumulator
HAS_NEXT 1            ; cond: reader 1 has another byte
LOOP
  READ 1, 1           ; acc = next byte from reader
  ADD r_sum           ; combo 2: r_sum = acc + r_sum  (i.e. r_sum += byte)
  HAS_NEXT 1          ; re-evaluate cond for next test
BLOCK_END             ; back-edge → LOOP (re-test)
LOAD r_sum
WRITE 2, 1            ; emit checksum via parked writer fork
RETURN
```

### 4.5 Presence-bitmap struct — stresses `COUNT`-as-presence + conditional emit

`{base: u8, opt1?: u8, opt2?: u8}`. The semantic model has all struct fields
always present, so **optionality is modeled as `List<u8>` of length 0 or 1** —
`COUNT` then reads as presence (0/1). Wire = `[bitmap][base][opt1?][opt2?]`.
Bitmap built with `SHL_IMM`/`OR`; each optional emitted under a 2-case
`BR_TABLE`, its sole element delegated via `CALL_CODEC_NEXT`:

```
; --- build bitmap ---
LOAD_IMM 0
STORE r_bmp
; opt1 → bit 0
ENTER o1, o0, opt1
COUNT o1              ; acc = len(opt1)
NE_IMM 0              ; acc = present ? 1 : 0
STORE r_bit
LOAD r_bmp
OR r_bit              ; acc = r_bmp | r_bit
STORE r_bmp
; opt2 → bit 1
ENTER o1, o0, opt2
COUNT o1
NE_IMM 0
SHL_IMM 1
STORE r_bit
LOAD r_bmp
OR r_bit
STORE r_bmp
; --- emit bitmap + base ---
LOAD r_bmp
WRITE i0, 1
CALL_CODEC codec_u8, o0, base
; --- emit opt1 if present ---
ENTER o1, o0, opt1
COUNT o1
BR_TABLE 2            ; case 0 (absent): skip; case 1 (present): emit
BLOCK_END
  CALL_CODEC_NEXT codec_u8, o1
BLOCK_END
; --- emit opt2 if present ---
ENTER o1, o0, opt2
COUNT o1
BR_TABLE 2
BLOCK_END
  CALL_CODEC_NEXT codec_u8, o1
BLOCK_END
RETURN
```

> Surfaces a **modeling convention** (optional = 0/1-length List) rather than a
> new op — `COUNT` already gives presence, `CALL_CODEC_NEXT` already consumes
> the sole element. No `IS_PRESENT` opcode needed.

### 4.6 Delta-encoded `List<u32>` — stresses iteration, `RSUB`, inline sub-codec

First element encoded as-is; subsequent as delta from previous; all LEB128.
`o0` is the list handle. The first element delegates cleanly
(`CALL_CODEC_NEXT` would consume it — but we also need its value as the delta
baseline, so it is read explicitly and `<LEB128>`-encoded inline). **Deltas are
computed values in registers, not object handles, so they cannot be delegated**
(`CALL_CODEC` takes a handle) — they are encoded by inlining the LEB128 IR via
the stitching layer. `RSUB` (`r_cur − r_prev`) earns its keep here:

```
COUNT                 ; acc = length (src=o0)
STORE r_left          ; r_left = loop counter
WRITE i0, 1           ; emit count byte (acc still holds count after STORE)
; empty?
EQ_IMM 0
BR_TABLE 2
BLOCK_END             ; case 0 (non-empty): continue
  RETURN              ; case 1 (empty): done
BLOCK_END
; first element: as-is, capture as baseline
ENTER_NEXT o1, o0     ; o1 = first element
LOAD_VAL o1
STORE r_prev          ; r_prev = baseline
LOAD r_prev
<LEB128>              ; inline-encode (stitching macro from §4.3)
LOAD r_left
SUB_IMM 1
STORE r_left
; loop remaining as deltas
LOAD r_left
NE_IMM 0             ; cond: more?
LOOP
  ENTER_NEXT o1, o0   ; o1 = next element
  LOAD_VAL o1
  STORE r_cur
  LOAD r_prev
  RSUB r_cur          ; acc = r_cur − r_prev  (delta)
  <LEB128>            ; inline-encode delta
  LOAD r_cur
  STORE r_prev        ; slide baseline
  LOAD r_left
  SUB_IMM 1
  STORE r_left
  NE_IMM 0           ; re-test cond
BLOCK_END
RETURN
```

> **Gap surfaced:** sub-codec delegation operates on object handles, not
> register values, so a *computed* value (a delta, a checksum, a derived tag)
> cannot be delegated — its encoding must be inlined by the stitching layer
> (which is acceptable: that layer exists precisely to splice fragment IR).
> If computed-value delegation turns out to be common, a register→handle
> "box" op or a `CALL_CODEC_REG` form may be worth revisiting later.

## 7. Encoding strategy (deferred)

The abstract operations above are stable; the **byte layout is not yet
fixed**. Guiding principles gathered so far:

1. **Opcodes are a prefix code, sized to `ceil(log₂(states))` per class.**
   Binary-class is 9 ops × 7 modes = 63 states = 6 bits; comparison-class is
   4 × 4 = 16 states = exactly 4 bits. Adjacent under-full fields may share a
   code subspace via bounded joint table-lookup (§2.7) — the *only* mechanism
   for recovering fractional bits. A true arithmetic-coding outer layer is
   explicitly ruled out (complexity/testability).
2. **No-operand instructions** (`NEG`, `NOT`, `RETURN`, `BLOCK_END`) can be a
   single byte. `LOOP_ITER` is folded into `BLOCK_END` (loop blocks: conditional
   back-edge on `acc`, declared by the `LOOP` start marker — §3.8);
   `DUP`/`SWAP` are absent (§2.6).
   (`DUP` is subsumed by MOVE push-mode; `SWAP` is dropped — §2.6).
3. **Field references** use the segmentation scheme grounded in §2.9: a 3-bit
   literal offset reaches the first 8 fields of the referenced type. Larger
   offsets escape to an extended form. Must be measured against real schemas.
4. **Comparison-class** is 4 ops × 4 modes = 16 states = exactly 4 bits — a
   clean field, and a joint table-lookup candidate when paired with a neighbor.
5. **Stream I/O** common case (`i < 4`, `w ∈ {1,2,4}`) packs opcode + iterator
   + width into a single byte.
6. **Immediates, offsets, field indices, type indices, branch targets** all use
   LEB128 (or a sub-byte-packed variant where a narrow field suffices).
7. **Deduplication** of field/variant names via a string table, and stripping
   of all non-normative info (type names, comments), happens at the binary
   serializer layer, not the IR layer.
8. **Short-form immediate** (§3.5, now the `imm` mode sub-encoding): 3–4-bit
   inline immediate packed with the opcode for the most frequent small
   constants, shared across MOVE/ALU/comparison; extended form escapes to
   trailing LEB128.
9. **Object handle IDs** (§2.9/§3.7) are small literals (`< 4`), packable with
   the opcode like stream iterator IDs; the `(src, ref)` accessor shape defaults
   `src` to `o0` (short form), so the common single-handle case costs no extra
   bits.
10. **Multi-type references** (§2.9): short form `(0, ref)` fits in one byte
    with 3-bit field offset; extended form adds `type_ref_idx`.
11. **Read/write opcode overlap**: because each procedure is statically encoder
    or decoder (§2.9), value accessors (`LOAD_VAL`/`STORE_VAL`) share an opcode
    slot — disambiguated by the procedure's direction bit. No counter-example
    exists on the target side (encoder = read-only source, decoder = write-only
    sink, transitive); the only bidirectional need lives on the stream side.
12. **Fused LOAD_VAL/STORE_VAL** (deferred optimization, §2.9): collapse
    `ENTER`+`LOAD_VAL` into one op for the struct-of-scalars hot path —
    reconsider once opcode space is measured. Note from §4.1: this is an
    irregularization on an *atypical* spelling (typical codecs delegate), so it
    ranks strictly below fused delegation in priority. Fused `ENTER_ACTIVE`
    similarly deferred.
13. **`HAS_NEXT`** (§3.6, added): fills the stream-loop exhaustion gap surfaced
    by §4.4. Like `COUNT`/`TAG`, it is a 1-operand metadata query; packs with
    the iterator ID.

### Open questions (encoding/target access)

- **Sequential-only list access** (§2.9): sufficient for now (multipass read
  via re-entering). Random access and other target-specific capabilities are
  deferred to a future **extension-point** mechanism (call-out ops + trait
  processing bound by the type mapper at code-gen) — system-wide consequences,
  out of scope for now.
- **Fused value access** (§2.9/§3.7): measure whether `LOAD_VAL src, ref` /
  `ENTER_ACTIVE` earn dedicated opcodes once real codecs are counted.
- **Computed-value delegation** (§4.6): sub-codecs take object handles, so a
  computed value (delta, checksum, derived tag) cannot be delegated and must be
  inlined by the stitching layer. If this pattern is common enough, a
  register→handle "box" op or a `CALL_CODEC_REG` form may be worth adding
  later.
- **Optional-field modeling** (§4.5): confirmed that optionality-as-0/1-list +
  `COUNT` works without a dedicated `IS_PRESENT` op. Confirm this holds across
  realistic schemas before locking it in as the convention.

The concrete byte layout will be specified in a follow-up revision once the
abstract operations are exercised against representative codecs.


