# Codec Extension — Draft Notes (recovered, historical)

> **Status: historical draft, non-normative.** This is not new writing — it's
> the codec-extension-specific portion of an early `docs/ir-engine.md`
> revision, recovered from git history (the "object handles" design landed in
> commit `a80b35d`; the whole file was removed in the documentation cleanup at
> `e4f4da0`, along with the rest of that draft's now-superseded generic-core
> rationale, which current `isa-core.md`/`ir-engine.md` already cover more
> precisely). It's reproduced here verbatim because the codec extension itself
> (ROADMAP.md items 6–8) was never re-specified after the cleanup, and this is
> the most detailed record of that design that exists. Section numbers are
> unchanged from the original document — they're internal cross-references
> within this excerpt, not pointers into current docs.
>
> **Known discrepancy vs. the current implementation:** this draft's `CALL`
> carries `proc_idx, arg_count` as two operands. The ISA as actually built
> (isa-core.md §4.6, `packages/machine/src/rtl.ts`) carries only
> `calleeIndex` — `arg_count` is looked up from the callee's own header
> instead of repeated at every call site. Read every `CALL`/`CALL_CODEC`
> example below with that adjustment in mind; nothing else about the
> object-handle/stream-iterator design depends on which form `CALL` takes.
>
> Treat this as input to the ROADMAP.md item 6/7 design discussion, not as
> something to implement as-is — it predates the actual procedure-identity
> and call-dispatch mechanism (ROADMAP.md items 1–2) and the validator (item
> 3), both of which now exist and constrain how this would actually plug in.

---

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

### 2.12 ISA split — generic core + codec extension

The instruction set is split into two parts, in the style of an ISA extension
(rather than a literal coprocessor — there is one execution engine and one
decoder; the extension operations are leaf nodes the base treats as
opaque-with-declared-effects):

- **Generic core** — ALU/MOVE/comparison/unary/control-flow, including a
  general **`CALL`** for non-codec procedure invocation with argument passing
  (§3.8, §2.14). This is the reusable substrate: a TOS-hybrid accumulator
  machine with structured control flow, applicable to filter expressions,
  packet matchers, small state machines — anything that compiles to its
  abstract operations. It contains **zero** codec-domain concepts.
- **Codec extension** — stream I/O (§3.6), target accessors (§3.7), and
  **`CALL_CODEC`** (§3.7). These are the domain-specific operations.

The split is what makes the generic core reusable for other domains and what
makes the codec extension swappable. The discipline that holds the line:
*nothing codec-specific is baked into the generic core's semantics, encoding,
or tooling.*

**Procedure header carries an ABI selector, not a domain tag.** The header
field selects *how the instructions in the body are interpreted* — currently
`{GENERIC, CODEC_ENCODER, CODEC_DECODER}` — and is the natural extension
point for future ABIs (e.g. a packet-filter ABI) without inventing a parallel
mechanism. `CODEC_ENCODER` vs `CODEC_DECODER` are genuinely different ABIs:
they sit on opposite sides of the codec interface (encoder reads object,
writes stream; decoder reads stream, writes object) and that direction bit is
what disambiguates the `LOAD_VAL`/`STORE_VAL` opcode-slot overlap (§2.9). The
field is an *ABI/ISA selector*, not a "codec vs generic" tag — and `CODEC_*`
procedures may take runtime value args exactly like `GENERIC` ones, so
**`CALL_CODEC` is a true superset of `CALL`** (§2.14, §3.7).

**Opcode-space skew (toward generic).** Generic ops are short and
high-variability (binary-ALU is 9 × 7 = 63 states; comparison is 6 × 4 = 24;
both want inline-immediate single-byte forms). Domain ops are mostly long
anyway (`CALL_CODEC` carries `codec_idx + ref`; `ENTER` carries `dst, src,
ref`) and the codec extension has a better prior on per-op likelihood, so it
can use **extended encodings for the less-frequent domain ops** without
hurting density. The split is therefore skewed: the generic core occupies the
bulk of opcode space (lower portion), the codec extension occupies the rest
(top portion). The exact ratio is a §7 layout-time call; the principle is that
generic gets the dense space because that's where the per-instruction size
leverage is. A true arithmetic-coding outer layer remains ruled out (§2.7).

**Abnormal termination is generic, not codec-specific.** A codec may need to
signal failure — checksum mismatch, invalid variant tag, malformed length,
etc. The *reasons* are domain-specific, but the *action* (stop execution,
report an error code, unwind) is identical and domain-neutral: it is a property
of the execution engine, not of codecs. Every VM needs an abnormal-termination
path, and encoding "abort" as a degenerate loop or jump-to-nowhere would
violate the structured-control-flow invariant (§2.1) for no benefit. So the
generic core provides a single **`TRAP imm`** opcode (§3.4); codec validation
uses it with high error codes, generic code with low codes. There are no
codec-specific semantics to layer on (no stream cleanup, no handle teardown —
the host owns both and decides the response), so adding a parallel codec-
domain trap would be redundant. Precedent is uniform: x86 `INT`, ARM
`BKPT`/`SVC`, RISC-V `EBREAK`, Wasm `unreachable`, eBPF exit-with-non-zero are
all generic. The error-code space is opaque to the ISA; partitioning (`0` =
unreachable/panic, low = reserved generic, high = codec-defined, reported to
the host) is by convention — see §3.4.

### 2.13 Recursion and termination

The semantic type system is recursive by nature (`list(T)`, structs that
reference each other, etc.), so codec procedures **must** be able to recurse —
a flat ban would make generically encoding `list(T)` impossible. Recursion is
therefore allowed, with one structural restriction that preserves static
termination and a bounded stack depth:

- **Direct codec calls (by literal codec name) form an acyclic graph.** A
  pseudo-C `ir\`…\`` block may invoke a codec by a literal identifier resolved
  at compile time; the AST stitching layer rejects any cycle over these.
- **Dispatch codec calls (target resolved by the ruleset projection) may be
  recursive.** When a codec delegates to "the codec the projection picks for
  this child type," the target is not a literal (at compile time) — it's whatever
  the projection resolves to, which can be the same codec again (e.g. `list(T)`
  where `T` is itself a list).

The invariant this buys: **the codec call graph is at most as recursive as the
data itself is.** Recursion depth at runtime is bounded by the depth of the
data structure being encoded, which is statically known per type. Therefore
the worst-case stack depth is `max_data_depth(type) × max_frame_size`, computed
at compile time over the dispatch call graph — preserving the zero-allocation /
bounded-resource guarantee. The DSL restriction that enforces this: *recursive
calls appear only via projection dispatch, never via literal codec ids in
`ir\`…\`` blocks.*

> Written before ROADMAP.md item 3's validator existed, and initially flagged
> as an open tension: that validator rejects *all* recursion outright
> (isa-core.md §8.2, call-graph acyclicity over literal procedure indices),
> which looked incompatible with "dispatch calls may recurse" above.
>
> Resolved: this conflates two different layers, not two kinds of `CALL`/
> `CALL_CODEC` the validator would need to distinguish. Projection dispatch
> is resolved at compile time, by the metaprogramming (TS-execution-time)
> layer that walks the semantic type graph and emits `ir\`…\`` fragments —
> for a recursive type like `list(T)`, that layer instantiates one distinct,
> uniquely-identified `Procedure` (isa-core.md's ir.ts) per site it visits,
> rather than one procedure calling itself. The resulting RTL call graph is
> therefore a proper DAG by construction, satisfying the current validator's
> blanket acyclicity rule with no special-casing needed. What can genuinely
> recurse in every direction is the meta layer doing that instantiation
> walk — but that's an application-level concern belonging to the (as yet
> unnamed) platform/build layer sitting above the machine/ISA this validator
> operates on, not a call-graph shape the RTL or the validator ever sees.
>
> This monomorphization (a fresh procedure per dispatch site, rather than
> one shared, parametrized-over-type procedure) trades code size for the
> DAG guarantee — a known redundancy, flagged as a separate, deferred design
> concern, not resolved here.

### 2.14 Calling convention

The machine already has the right primitives — infinite register file with
named locals, TOS as a pointer into it, `acc` as implicit operand. The calling
convention fixes how a `CALL` partitions that space.

**Frame layout.** Logically the register file is a flat array indexed from 0.
Each `CALL proc_idx, arg_count` opens a new frame whose base `F_callee` is
**defined as the caller's TOS at call time** — i.e. the frame boundary is the
top of the caller's live stack, not an arbitrary static boundary. The callee
sees:

- `r0 .. r(N-1)` — the `N` args (`N = arg_count`, declared in the target's
  header). These *are* the top `N` slots of the caller's TOS, pushed by the
  caller immediately before the call (see Argument passing below). `r0` is the
  deepest (first pushed), `r(N-1)` the shallowest (last pushed, just below
  `F_callee + N`).
- `rN ..` — callee-local scratch (backend-allocated), starting at the slot
  above the last arg.
- TOS entry point = `rN` = `F_callee + N` (first free slot above args); callee
  pushes/pops from there.

Everything the caller had live *below* its call-time TOS (its own locals, its
own deeper pushed values) sits below `F_callee` and is untouched. The backend
maps logical indices to physical registers/stack slots — the convention is
purely about *visibility*, not storage.

**Argument passing.** The caller computes each arg into `acc` and `PUSH`es it
(MOVE in combo-6 push mode, §2.6/§3.1) — arg0 first, then arg1, …, arg(N-1)
last — so that after the N pushes the top of the caller's TOS is exactly the
arg block the callee will see as `r0..r(N-1)`. Then `CALL proc_idx, N` sets
`F_callee` to the current TOS and transfers control. In short: **args are the
top of the caller's stack, and the frame boundary is that stack top.**

**Return.** Single value, in `acc` — already the implicit work register and
where every procedure naturally leaves its result. On `RETURN` the frame is
popped (TOS rewound to `F_callee`, discarding the arg block and any callee
scratch), and the caller resumes with `acc` holding the result. Multi-value
return is deferred (would need either a struct-handle return or a TOS-based
convention; no use case yet).

**TOS discipline.** Per-frame. Callee enters with empty TOS (entry pointer =
`rN` = `F_callee + N`) and the verifier statically requires balanced
pushes/pops — the same discipline that makes structured control flow work
(§2.1). On `RETURN`, TOS must be back at `rN`. The caller's TOS contents
below `F_callee` were never touched and are visible again at their original
indices after the call returns (the arg block, having lived in the top N
slots, is consumed by the call and is no longer on the caller's TOS — this
matches stack calling conventions where args are caller-popped or
callee-popped at return).

**Codec entry protocol (the ABI addition).** For `CODEC_*` procedures, the
entry protocol layers on top of the generic frame:

- `i0` ← caller's `i0` (stream iterator inherited across delegation — both
  ends of a codec share the wire).
- `o0` ← the child handle (from `CALL_CODEC`'s `src, ref`).
- Direction bit ← from the procedure's ABI kind (`CODEC_ENCODER` vs
  `CODEC_DECODER`).
- Any runtime args follow the generic convention (slots `r0..r(N-1)`), with
  `o0` bound separately from the arg slots.

So `CALL_CODEC codec_idx, src, ref, [args…]` ≡ "compute `child(src, ref)`,
bind it to callee's `o0`, bind caller's `i0` to callee's `i0`, set direction
bit, then `CALL`." The codec ABI is the generic ABI plus three entry
bindings — `CALL_CODEC` is a true superset of `CALL`, not a parallel mechanism.

**Static verification (preserved).** All statically checkable: TOS balance per
procedure; direct-call-graph acyclicity (literal codec indices only — §2.13);
stack-depth bound `max_data_depth(type) × max_frame_size` over the dispatch
call graph. No dynamic dispatch, no function pointers, no variadic — any of
those would break the bound.

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

**Delegation (fused — the only form; a true superset of `CALL`):**
**`CALL_CODEC codec_idx, [src=o0,] [type_ref,] ref, [arg_count]`** — delegate
to `child(src, ref)`. Semantically `CALL + codec entry protocol` (§2.14):
compute the child handle, bind callee's `o0` to it, bind callee's `i0` to
caller's `i0`, set the direction bit from the invoked codec's ABI kind, then
`CALL`. Optional runtime value args follow the generic calling convention
(slots `r0..r(N-1)`), so a codec may take value args exactly like a generic
procedure — `CALL_CODEC` is a true superset of `CALL`, not a parallel form.
**`CALL_CODEC_NEXT codec_idx, [src=o0,] [arg_count]`** — fused enter-next +
delegate: advance to the next list element of `src` and delegate.

> **Deferred optimizations** (reconsider once opcode space is measured): fused
> `LOAD_VAL src, ref` / `STORE_VAL src, ref` (enter+access a primitive child in
> one op); fused encoder `ENTER_ACTIVE` (enter active union variant in one op).

Handle IDs are small literals (like stream iterators, typically `< 4`). Field
`ref`s (on `ENTER`/`CALL_CODEC`) benefit from the segmentation scheme (§7): a
3-bit literal offset reaches the first 8 fields of the referenced type; larger
indices escape to an extended form.

### 3.8 Control flow class (excerpt — `CALL` only; `BR_TABLE`/`LOOP` are generic-core and already current in isa-core.md)

**Procedure invocation (generic core):**
**`CALL proc_idx, arg_count`** — invoke `procedure[proc_idx]`. Args have been
placed by the caller in the slots that become `r0..r(N-1)` in the callee's
frame (`N = arg_count`, declared in the target's header); return value comes
back in `acc`. See §2.14 for the full calling convention. `CALL` is a generic-
core instruction: it knows nothing about streams or object handles. The codec
extension's `CALL_CODEC` (§3.7) is `CALL + codec entry protocol` — same
calling convention, plus the `i0`/`o0`/direction bindings. Recursion rules
(§2.13): direct calls (by literal procedure/codec index) form an acyclic
graph; dispatch-resolved calls may recurse, bounded by data depth.

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

Sub-codec for a primitive u32. `o0` is the primitive handle. A u32 always
emits ≥1 byte, so the loop must run at least once even when `r_val` starts
at zero — recovered with the first-iteration-flag idiom (§3.8's
do-while-recovery note), since the two-block `LOOP`'s single condition block
can't special-case "first entry" on its own. Bit manipulation via
`AND_IMM`/`SHR_IMM`/`OR_IMM`; continuation-bit set is a 2-case `BR_TABLE`:

```
LOAD_VAL              ; acc = value (src=o0)
STORE r_val
LOAD_IMM 1
STORE r_first          ; r_first = 1 (force first entry)

LOOP
  ; --- condition block: r_first | (r_val != 0) ---
  LOAD r_val
  NE_IMM 0            ; acc = (r_val != 0)
  OR r_first          ; acc |= r_first (forced true on pass 1)
BLOCK_END              ; acc=0 → exit past next BLOCK_END; acc≠0 → body

  ; --- body block ---
  LOAD_IMM 0
  STORE r_first        ; clear the flag; harmless if repeated

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
BLOCK_END              ; back-edge → LOOP (re-enters condition block)
RETURN
```

### 4.4 Checksum with fixup — stresses stream forks + `HAS_NEXT`

The `<compute hasMore>` gap from earlier drafts is filled by `HAS_NEXT i`
(§3.6). Under the two-block `LOOP` (§3.8), the runtime condition is written
**once**, as the condition block — it runs both on initial entry (allowing
zero iterations) and, via the back-edge, before every subsequent pass. No
separate pre-loop and tail computation is needed.

```
CLONE_RD 0 1          ; reader fork at packet start (for checksumming)
CLONE_WR 0 2          ; writer fork parked at checksum field
WRITE i0, 1           ; placeholder byte via original writer
; ...serialize rest of packet with original writer i0 (elided)...
LOAD_IMM 0
STORE r_sum           ; r_sum = checksum accumulator
LOOP
  HAS_NEXT 1          ; condition block: cond = reader 1 has another byte
BLOCK_END             ; acc=0 → exit past next BLOCK_END; acc≠0 → body
  READ 1, 1           ; acc = next byte from reader
  ADD r_sum           ; combo 2: r_sum = acc + r_sum  (i.e. r_sum += byte)
BLOCK_END             ; back-edge → LOOP (re-enters condition block)
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
baseline, so it is read explicitly and `CALL`s the shared `leb128_encode`
generic procedure with the value as its arg). **Deltas are computed values in
registers, not object handles, so they cannot be delegated via `CALL_CODEC`**
(which binds `o0` to a child handle) — but they *can* be passed to a generic
`CALL` as a value arg. This is exactly the gap §2.12's ISA split was added to
close: the LEB128 IR lives once in the procedure table and is invoked
everywhere, instead of being inlined by the stitching layer at every call
site. `RSUB` (`r_cur − r_prev`) earns its keep here:

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
PUSH                  ; arg0 = value (top of caller TOS → callee's r0)
CALL leb128_encode, 1 ; encode r_prev via shared generic procedure
LOAD r_left
SUB_IMM 1
STORE r_left
; loop remaining as deltas
LOOP
  LOAD r_left
  NE_IMM 0            ; condition block: more?
BLOCK_END              ; acc=0 → exit past next BLOCK_END; acc≠0 → body
  ENTER_NEXT o1, o0   ; o1 = next element
  LOAD_VAL o1
  STORE r_cur
  LOAD r_prev
  RSUB r_cur          ; acc = r_cur − r_prev  (delta)
  PUSH                ; arg0 = delta (top of caller TOS → callee's r0)
  CALL leb128_encode, 1 ; encode delta via shared procedure
  LOAD r_cur
  STORE r_prev        ; slide baseline
  LOAD r_left
  SUB_IMM 1
  STORE r_left
BLOCK_END              ; back-edge → LOOP (re-enters condition block)
RETURN
```

> **Gap closed by §2.12.** Sub-codec delegation (`CALL_CODEC`) operates on
> object handles, not register values, so a *computed* value (a delta, a
> checksum, a derived tag) cannot be delegated that way. But the generic
> `CALL` added by the ISA split takes value args by the standard calling
> convention (§2.14) — so a computed value is encoded by calling a shared
> generic procedure (`leb128_encode` here) instead of inlining its IR via the
> stitching layer at every call site. This is a real wire-size win (the
> overriding metric of §1) *and* a real codegen-footprint win, and it's what
> makes the ISA split pay for itself rather than being pure architectural
> tidiness.

### 4.7 Checksum validation + exhaustive union — stresses `TRAP` (decoder side)

The decoder-side counterpart of §4.4. After reading the body, recompute the
checksum over the reader fork and compare against the received byte; on
mismatch `TRAP ERR_CHECKSUM`. `ERR_CHECKSUM` is a codec-defined high error code
(§3.4) — opaque to the ISA, reported to the host. This is an `if-without-else`
(trigger the trap only on mismatch), so it lowers to **N=1**: the trap is
`case[0]` (reached when `acc=0`, i.e. mismatch — `EQ` naturally yields 0 on
mismatch), and the implicit default is the "match, continue decode" path.
Because `TRAP` is a terminator it closes `case[0]`; no `BLOCK_END` after it,
and no `RETURN` — control does not continue past a trap:

```
; (assume reader fork i1 walked, checksum accumulated in r_sum, as in §4.4)
LOAD r_sum
READ 2, 1            ; acc = received checksum byte from parked writer fork
EQ r_expected        ; acc = (computed == received)   [expected in a reg]
BR_TABLE 1           ; case 0 (acc=0 → mismatch): trap; default (acc=1 → match): continue
  TRAP ERR_CHECKSUM  ; terminator: closes case 0; no BLOCK_END, no RETURN follows
; --- implicit default: match, continue decode ---
; ...rest of decode...
RETURN
```

Exhaustive-union decoding uses the **implicit default** as the out-of-range
trap home (§2.3). A union decoder dispatches on the received tag via
`BR_TABLE N` over all `N` valid variants; an out-of-range tag (`acc ≥ N`)
falls through to the implicit default after the last case, which is a `TRAP`.
Each variant case delegates to its variant's decoder and then `RETURN`s
(`RETURN` closes the case — §3.4); the trap-default is itself a terminator, so
nothing follows it:

```
READ i0, 1           ; acc = variant tag
BR_TABLE 3           ; cases 0..2 valid; acc≥3 → implicit default (fall through)
  CALL_CODEC codec_0, o0, 0   ; case 0: delegate to variant 0's decoder
  RETURN                      ; done — RETURN closes case 0 (no BLOCK_END)
  CALL_CODEC codec_1, o0, 1   ; case 1
  RETURN
  CALL_CODEC codec_2, o0, 2   ; case 2
  RETURN
TRAP ERR_BAD_TAG     ; implicit default (acc≥3, invalid tag) — terminator; nothing follows
```

> **Three mechanisms compose cleanly here.** (1) The implicit `BR_TABLE`
> default (§2.3) gives the trap a home with no validate-then-dispatch
> preamble. (2) Terminators close blocks (§3.4), so each `RETURN`-ended case
> and the final `TRAP` need no trailing `BLOCK_END`, and there is no redundant
> `RETURN` after the trap. (3) `TRAP` is the generic abnormal-termination path
> (§2.12) — the host owns stream/handle teardown and decides the response
> (retry, drop packet, log, …); the high error-code range is reserved for
> codec-defined reasons by convention only.

### Open questions (encoding/target access)

- **Sequential-only list access** (§2.9): sufficient for now (multipass read
  via re-entering). Random access and other target-specific capabilities are
  deferred to a future **extension-point** mechanism (call-out ops + trait
  processing bound by the type mapper at code-gen) — system-wide consequences,
  out of scope for now.
- **Fused value access** (§2.9/§3.7): measure whether `LOAD_VAL src, ref` /
  `ENTER_ACTIVE` earn dedicated opcodes once real codecs are counted.
- **Computed-value delegation** (§4.6, *resolved by §2.12*): sub-codec
  delegation (`CALL_CODEC`) operates on object handles, so a computed value
  (delta, checksum, derived tag) cannot be delegated that way — but the
  generic `CALL` added by the ISA split takes value args by the standard
  calling convention, so a shared generic procedure (`leb128_encode`) is
  invoked instead of inlining IR at every call site. No register→handle "box"
  op or `CALL_CODEC_REG` form is needed.
- **Recursion depth** (§2.13, *resolved* — see the note there): dispatch
  resolution happens at compile time, in the metaprogramming layer, which
  instantiates one distinct `Procedure` per site rather than one procedure
  calling itself — so the RTL call graph the validator sees is always a DAG,
  with no special-casing needed for "recursive" dispatch calls. The
  `max_data_depth(type) × max_frame_size` bound still describes how deep
  that DAG gets for a recursive type like `list(T)`; confirm the actual
  numbers once concrete recursive schemas (e.g. self-referential structs)
  are encoded and run through `validateProgram`'s tight §8.3 figure.
- **`BR_TABLE` default-case semantics** (§4.7, *resolved*): `BR_TABLE` now has
  an **implicit default** — `acc ≥ N` falls through after the last case (§2.3).
  This gives the exhaustive-switch trap-default a home with no
  validate-then-dispatch preamble, and lets `if-without-else` lower to N=1
  (body at `case[0]`, default = skip) with no empty trailing block. Coupled
  with terminators closing blocks (§3.4), the §4.7 exhaustive-union example
  collapses to one `RETURN`-terminated case per variant plus a final `TRAP`.
- **Optional-field modeling** (§4.5): confirmed that optionality-as-0/1-list +
  `COUNT` works without a dedicated `IS_PRESENT` op. Confirm this holds across
  realistic schemas before locking it in as the convention.

The concrete byte layout will be specified in a follow-up revision once the
abstract operations are exercised against representative codecs.
