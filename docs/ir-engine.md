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

### 2.6 Addressing modes and the 6-combo constraint

Of the four addressing modes, only **literal** and **peek** are read-write
capable. **Push** is write-only; **pop** is read-only. This means the output
target is *forced* for push and pop — those modes carry one fewer bit of
freedom. For a binary-class instruction (two inputs, one output, accumulator is
one input), the valid (mode × output) combinations are:

| # | Mode | Input from | Output to | Example |
|---|------|-----------|-----------|---------|
| 1 | literal | `rN` | `acc` | `acc = acc + rN` |
| 2 | literal | `rN` | `rN` | `rN = acc + rN` |
| 3 | peek | `[tos-1]` | `acc` | `acc = acc + peek` |
| 4 | peek | `[tos-1]` | `[tos-1]` | `peek = acc + peek` |
| 5 | pop | `[--tos]` | `acc` | `acc = acc + pop` (pure stack binary) |
| 6 | push | *(none — unary)* | `[tos++]` | `push(op(acc))` (subsumes `DUP`) |

That is **6 valid combinations** — not 8. The two eliminated combos (pop with
output-to-pop; push with output-to-acc) are semantically invalid and must never
appear in code, so carrying bits for them is wasted space.

> **`DUP` is subsumed.** Combo 6 (`push(op(acc))` with op = identity) *is*
> `DUP`. No dedicated `DUP` opcode is needed; it is the push mode of the
> MOVE/identity instruction.
>
> **`SWAP` is dropped.** No DSL-level construct maps directly to a swap (C has
> no tuple exchange; `tmp=a; a=b; b=tmp` lowers to MOVEs). The lowering pass
> can always restructure expression evaluation to avoid swap, or use a temp
> register. A dedicated `SWAP` opcode would consume encoding space for no
> guaranteed benefit.

### 2.7 Arithmetic-encoding-like packing (decode cost is irrelevant)

Since backend decode effort is explicitly unconstrained, the encoding need not
be byte-aligned or fixed-width. A **6-combo space fits in ~2.58 bits** (log₂6),
so an arithmetic-coding-style scheme could pack binary-class opcodes across bit
boundaries and recover the wasted fractional bits. Whether this complexity pays
off depends on the frequency distribution of instruction classes in real codecs
— it must be measured before committing. The principle stands: *the opcode is a
prefix code, and its width is a function of the instruction class, not a
constant.*

### 2.8 Comparisons and ordering via branch inversion

The accumulator is always operand 1, so "reversing operands" to derive `>` /
`>=` is *not* free (it would need a `SWAP`, which we dropped). Instead we
exploit structured control flow: **branch inversion is free**. Negating a
comparison is realized by swapping the then/else blocks, so:

- `LT`  →  `!(a < b)`  =  `a >= b`  =  `GE`
- `LE`  →  `!(a <= b)` =  `a > b`   =  `GT`

We therefore carry only `LT`, `LE`, `EQ`, `NE` and derive `GT`/`GE` by branch
inversion. No operand swap, no extra opcodes.

### 2.9 Object access — multi-type procedure references

~~Each codec procedure is compiled for a single target type~~ — **codecs can
match multiple layers or irregular sections of the semantic type tree.** A
packed-bitmap codec for a struct with optional fields touches multiple fields
across the struct. A codec for a union-variant-inside-a-struct touches both the
struct's tag field and the variant's data fields. Static restriction to a
single type is too narrow.

**Solution: each procedure carries a list of referenced types.** Usually this
list has one entry (the codec's primary target type). Field references are 2D
coordinates: `(type_ref_idx, field_idx)`.

- **Short form**: `type_ref_idx = 0` (implicit) — accesses the first (primary)
  referenced type. This covers the common single-type case.
- **Extended form**: explicit `type_ref_idx` — accesses any type in the
  procedure's reference list.

The referenced-types list is part of the procedure header, not per-instruction.
The short form keeps the common case compact (1 field index instead of 2).

This also grounds the field segmentation idea (§7): since field indices are
scoped to one type's field list, a 3-bit literal offset reaches the first 8
fields of any referenced type.

`CALL_CODEC codec_idx, field_idx` selects `object[field_idx]` and invokes
`codec[codec_idx]`, which has its own referenced-types list. The invoked
codec's primary type (index 0) becomes the child object's type.

> **Open question — deep navigation.** When a codec references a child type
> deep in the object tree (e.g. a union variant selected by a runtime tag
> inside a struct field), the type_ref list must encode not just *which* type
> but *how to reach it* (the path through the object tree, possibly involving
> runtime lookups). The simple `(type_ref_idx, field_idx)` model handles
> multiple types at the same level, but deep navigation may require either
> explicit object-selection instructions or delegation via `CALL_CODEC`.
> This needs concrete codec examples to resolve — left open for now.

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

### 2.12 List access — sequential cursor, mirroring stream iterators

Lists require runtime-indexed element access, which `LOAD_FIELD`/
`STORE_FIELD` (literal field indices) cannot express. The natural pattern for
codecs is **sequential** — elements are consumed/emitted in order. This mirrors
the stream iterator pattern (§2.4):

- `OPEN_LIST_RD [type_ref,] field_idx, cursor` — open read cursor; `acc` =
  element count. Target must support iteration.
- `OPEN_LIST_WR [type_ref,] field_idx, cursor` — open write cursor; `acc` =
  capacity hint (target may pre-allocate or ignore). Target must support
  append.
- `LOAD_NEXT_ELT cursor` — `acc` = next element from list (read).
- `STORE_NEXT_ELT cursor` — next list slot = `acc` (append/write).
- `CLOSE_LIST cursor` — finalize list (commit, set length, etc.).

**Why sequential, not indexed?** Requiring iterate/append is the *minimal*
obligation on target mappings — strictly less than requiring random access.
Streaming targets, ring buffers, DMA descriptors, and fixed-capacity arrays all
support sequential access natively; many cannot support random access at all.
Random access would also demand pre-allocation from every target, which is
"too much to ask." Codecs that truly need out-of-order access can use the
metaprogramming/stitching layer to unroll into individual field accesses.

The cursor ID is a small literal (like stream iterator IDs, typically `< 4`).

### 2.13 Initialization — capacity and variant selection

Two write-side initialization concerns:

1. **List capacity**: handled by `OPEN_LIST_WR` — the capacity hint (in `acc`)
   tells the target how many elements to expect. The target decides whether to
   pre-allocate, use a fixed buffer, or ignore the hint. The zero-allocation
   principle means the *target* manages memory, not the codec.

2. **Union variant selection**: when writing to a union, the codec must select
   which variant is active before writing variant fields. This is **implicit**
in the multi-type reference mechanism (§2.9): the procedure's referenced-types
   list includes both the union type (for the tag field) and the variant type
   (for variant data fields). `STORE_FIELD` on the union's tag field sets the
   active variant; subsequent field references to the variant type access the
   variant's data. The target mapping knows its union representation and handles
   the underlying storage — no dedicated `SELECT_VARIANT` instruction is needed.
   *(Caveat: this assumes the deep-navigation question in §2.9 is resolved
   favorably; if not, an explicit variant-selection instruction may be required.)*

## 3. Abstract operations (grouped by operand-mode constraints)

This section replaces the ISA table. Operations are grouped by their "mode
dynamic range" — the set of valid (addressing-mode × output-target)
combinations — because that is what determines the encoding width.

### 3.1 Binary-class (6 mode combos)

Each has the accumulator as one input and an "other operand" addressed by one
of the 6 valid combos from §2.6.

**Binary ALU** — `ADD, SUB, MUL, AND, OR, XOR, SHL, SHR`
- Semantics: `result = acc ⟨op⟩ other_operand` (or `op(acc)` for combo 6).
- Output target per the combo table (§2.6).
- **No `DIV`/`MOD`.** Many MCUs lack hardware division; these would silently
  emit expensive software loops. Codec arithmetic is dominated by shifts,
  masks, adds, and compares — division essentially never appears. Modulo by a
  power of two (e.g. ring-buffer wrap) is `AND (N-1)`. If a codec truly needs
  division, the lowering pass can emit a call to a software helper; the
  ISA stays minimal. This also shrinks the binary-class set to 8 ops × 6 combos
  = 48 states (≈5.58 bits), a cleaner fit for arithmetic-encoding packing (§2.7).

**MOVE** — transfer between `acc` and the addressed register.
- Read-direction (operand → acc): combos 1, 3, 5 (literal, peek, pop).
  - `LOAD rN`, `LOAD [tos-1]`, `POP` (pop into acc).
- Write-direction (acc → operand): combos 2, 4, 6 (literal, peek, push).
  - `STORE rN`, `STORE [tos-1]` (overwrite top), `PUSH acc` (≡ DUP).
- Same 6-shape dynamic range as binary ALU → can share a format.

> `DUP` is the identity-MOVE in push mode (combo 6). No separate opcode.

### 3.2 Comparison-class (3 mode combos)

The "other operand" is **read-only** (result always → `acc` as a boolean), so
only the three read-capable modes apply:

| # | Mode | Input from |
|---|------|-----------|
| 1 | literal | `rN` |
| 2 | peek | `[tos-1]` |
| 3 | pop | `[--tos]` |

**Comparisons** — `LT, LE, EQ, NE` → boolean in `acc`. `GT`/`GE` derived by
branch inversion (§2.8). **3 valid combos.**

### 3.3 Unary-class (no other operand)

**Unary ALU** — `NEG, NOT` — `acc = op(acc)`. No mode bits, no operands.
Single-byte encodable.

### 3.4 No-operand class

**`RETURN`** — end procedure.
**`BLOCK_END`** — close the enclosing `if` / `loop` / `block` (subsumes `ELSE`,
see §2.3).
**`LOOP_ITER`** — structured loop iteration check (advance/continue or exit).

All single-byte encodable.

### 3.5 Immediate class

**`CONST imm`** — `acc = LEB128 immediate`. No mode bits; the immediate follows.

**`CONST_SMALL imm`** *(short form)* — `acc = imm` where `imm ∈ {0..7}` (or
`{0..15}`), packed into a single byte with the opcode. Small constants dominate
codec arithmetic: `0` (accumulator init, zero-compare), `1` (increments,
flags), `2`/`4` (byte widths), powers of two (masks, shift amounts). The
short form saves one byte per occurrence for the most frequent immediates.
Java's `iconst_0`–`iconst_5` and Wasm's `i32.const 0` shortcut demonstrate
the value of this optimization.

### 3.6 Stream I/O class

**`READ i, w`** — `acc = stream[i].read(w)` where `w ∈ {1,2,4}` bytes.
**`WRITE i, w`** — `stream[i].write(acc, w)`.
**`CLONE_RD src, dst`** — fork readable iterator.
**`CLONE_WR src, dst`** — fork writable iterator.
**`SEEK i, Δ`** *(optional)* — advance/rewind by LEB128 delta.

Iterator IDs are small literals (typically `< 4`); width `w` fits in 2 bits.
The common case (`i < 4`, `w ∈ {1,2,4}`) can pack into a single byte with the
opcode.

### 3.7 Object access class

**`LOAD_FIELD [type_ref,] f`** — `acc = object[f]` (struct field access; `f`
relative to referenced type `type_ref`, default 0 — §2.9).
**`STORE_FIELD [type_ref,] f`** — `object[f] = acc`.
**`CALL_CODEC codec_idx, field_idx`** — invoke `codec[codec_idx]` on
`object[field_idx]`; the invoked codec has its own referenced-types list (§2.9).

Short form: `type_ref` omitted (implicit 0) — the common single-type case.
Extended form: explicit `type_ref` index for multi-layer codecs (§2.9).
Field index `f` benefits from the segmentation scheme (§7): a 3-bit literal
offset reaches the first 8 fields of the referenced type; larger indices escape.

### 3.8 Control flow class

**`BR_TABLE N`** — dispatch on `acc` to one of N case-blocks (N=2 for
`if`/`if-else`; N>2 for `switch`). Carries only the static count N (LEB128,
usually 1 byte); the runtime selector is in `acc`. Each case-block is
terminated by `BLOCK_END`; no offsets or `ELSE` markers (§2.3).

### 3.9 List cursor class

**`OPEN_LIST_RD [type_ref,] field_idx, cursor`** — open read cursor; `acc` =
count (§2.12).
**`OPEN_LIST_WR [type_ref,] field_idx, cursor`** — open write cursor; `acc` =
capacity hint (§2.12).
**`LOAD_NEXT_ELT cursor`** — `acc` = next element (read).
**`STORE_NEXT_ELT cursor`** — append `acc` to list (write).
**`CLOSE_LIST cursor`** — finalize list.

Cursor IDs are small literals (like stream iterators, typically `< 4`).
See §2.12 for rationale on sequential-only access.

## 4. Worked example — struct `{x: u32, y: u16, flag: u8}` encoder

Little-endian fixed-width wire format:

```
LOAD_FIELD x          ; acc = obj.x
WRITE i0, 4           ; emit 4 bytes LE
LOAD_FIELD y
WRITE i0, 2
LOAD_FIELD flag
WRITE i0, 1
RETURN
```

## 5. Worked example — union with 3 variants

```
LOAD_FIELD tag        ; acc = union tag (selector)
BR_TABLE 3            ; 3 case-blocks follow
  LOAD_FIELD a;  WRITE i0, 4
BLOCK_END
  LOAD_FIELD b;  WRITE i0, 2
BLOCK_END
  LOAD_FIELD c;  WRITE i0, 1
BLOCK_END
RETURN
```

> Note: `CALL_CODEC` would replace the per-variant body if `a`, `b`, `c` are
> themselves non-trivial types — each variant delegates to its own codec, and
> field indices inside those codecs are relative to the variant's type.

## 6. Worked example — checksum with fixup

```
CLONE_RD 0 1            ; reader fork at packet start
CLONE_WR 0 2            ; writer fork parked at checksum field
WRITE i0, 1             ; placeholder byte via original writer
; ... serialize rest of packet with original writer i0 ...
CONST 0
LOOP                     ; checksum loop over reader fork
  READ 1, 1              ; acc = next byte from reader
  ADD chksum_reg         ; chksum_reg += acc  (combo 2: literal, out=rN)
  LOOP_ITER
WRITE 2, 1               ; emit checksum via parked writer fork
RETURN
```

## 7. Encoding strategy (deferred)

The abstract operations above are stable; the **byte layout is not yet
fixed**. Guiding principles gathered so far:

1. **Opcodes are a prefix code, not a fixed width.** The `5|1|2` layout is
   attractive *for binary-class ops only* (6 combos fit in ~2.58 bits; an
   arithmetic-coding-like scheme could recover the fractional bits since decode
   cost is irrelevant — §2.7). Other instruction classes should use the format
   that minimizes *their* expected size.
2. **No-operand instructions** (`NEG`, `NOT`, `RETURN`, `BLOCK_END`,
   `LOOP_ITER`) can be a single byte. `DUP`/`SWAP` are no longer in this set
   (`DUP` is subsumed by MOVE push-mode; `SWAP` is dropped — §2.6).
3. **Field references** use the segmentation scheme grounded in §2.9: a 3-bit
   literal offset reaches the first 8 fields of the current codec's target
   type. Larger offsets escape to an extended form. Must be measured against
   real schemas.
4. **Comparison-class** has only 3 mode combos — potentially a narrower format
   than binary-class (6 combos).
5. **Stream I/O** common case (`i < 4`, `w ∈ {1,2,4}`) packs opcode + iterator
   + width into a single byte.
6. **Immediates, offsets, field indices, type indices, branch targets** all use
   LEB128 (or a sub-byte-packed variant where a narrow field suffices).
7. **Deduplication** of field/variant names via a string table, and stripping
   of all non-normative info (type names, comments), happens at the binary
   serializer layer, not the IR layer.
8. **Short-form `CONST_SMALL`** (§3.5): 3-bit immediate (0–7 or 0–15) packed
   into the opcode byte for the most frequent small constants.
9. **List cursor IDs** (§3.9) are small literals (`< 4`), packable with the
   opcode like stream iterator IDs.
10. **Multi-type field references** (§2.9): short form `(0, field_idx)` fits in
    one byte with 3-bit field offset; extended form adds `type_ref_idx`.

### Open questions (encoding)

- **Deep navigation** (§2.9): how to encode object-tree paths for type_refs
  that reach child types selected by runtime values (e.g. union variant by tag)?
  Needs concrete codec examples.
- **List cursor vs. indexed access**: is sequential-only truly sufficient for
  all realistic codecs, or will some need random list access as a first-class
  IR feature?
- **Union variant initialization**: is implicit tag-write + type_ref access
  sufficient, or does the target need an explicit "select variant" signal?

The concrete byte layout will be specified in a follow-up revision once the
abstract operations are exercised against representative codecs.
