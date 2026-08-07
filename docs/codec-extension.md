# Codec Extension ISA

> **Status:** Design spec, not yet implemented — ROADMAP.md item 7. Specifies
> the codec extension's opcodes, calling convention, and encoding rules the
> way isa-core.md specifies the generic core, and plugs into the core purely
> through the mechanism isa-core.md §11 defines (opcode range ≥128, effect
> declarations, literal-only operands). Unlike isa-core.md, it carries its
> own rationale inline, section by section, rather than deferring to a
> companion doc — there is no ir-engine.md-style pairing for this document.
> An earlier recovered draft briefly served that role
> (`codec-extension-draft.md`, since retired); its one piece of rationale
> that didn't end up redundant with this document — why abnormal
> termination is a generic-core concern, not a codec-specific one — moved to
> [ir-engine.md](./ir-engine.md), its proper home by topic.
>
> Nothing below exists as code yet. `packages/machine/src/extension.ts`'s
> `Extension` interface is the shape an implementation registers against;
> it belongs in `@ppl/codecs` (`packages/codecs/`) — the generic core stays
> protocol-agnostic by design (ROADMAP.md item 5).

---

## 1. Overview

The codec extension adds two things the generic core has no concept of:

- **Streams** — byte-oriented I/O against the wire, addressed by small
  iterator IDs.
- **Object handles** — navigation over a host data model (structs, unions,
  lists, primitives), addressed by small handle IDs, symmetric to stream
  iterators.

A whole program is either an **encoder** (reads the object, writes the
stream) or a **decoder** (reads the stream, writes the object) — direction
is fixed once, for everything the program's single entry procedure
transitively calls (§2.3). Directionality is what lets read-only and
write-only target-access opcodes share opcode slots (§2.3) — a codec
procedure only ever needs one direction's worth of accessor semantics.

`CALL_CODEC` (§3.3) is the extension's one call-shaped opcode: a fused
"navigate to a child, then invoke its codec" — a true superset of the
generic core's `CALL` (isa-core.md §4.6), carrying the same calling
convention plus one extra entry binding (§4).

---

## 2. Abstract Machine Additions

### 2.1 Stream iterators

A stream iterator is a cursor into a byte sequence. `i0` is the one bound
at program entry, and its capability follows the *program's* direction
(§2.3) — read-only for a decoder, write-only for an encoder — not the
capability of iterators in general: `CLONE_RD`/`CLONE_WR` (§3.1) each fork
an iterator of the capability they name, independent of the source
iterator's own. This is what an encoder's checksum-patchup trick actually
needs (§8.4): `CLONE_RD` on the write-only `i0` yields a *readable* fork
that re-reads bytes the encoder has already emitted, to sum them — the
program is still an encoder throughout, only this one forked cursor reads.
Iterator IDs are small literals, typically `< 4`.

A target's stream implementation can rely on a clean split between
appending and patching: only `i0` (an encoder's entry writer) ever *appends*
— advances the write cursor past previously nonexistent buffer space. Every
`CLONE_WR` fork (e.g. the parked writer in §8.4, later patched with a
checksum) is used exclusively to *overwrite* bytes some earlier `i0` write
already established. Restricting a `CLONE_WR` fork to overwrite-only, and
rejecting an attempted append through one, gives the target a simple
invariant instead of having to support arbitrary interleaved appends across
several live cursors.

### 2.2 Object handles

An object handle refers to a node in the host object tree — a struct, a
union, a list, or a primitive value. `o0` is bound at codec entry to the
object the procedure must encode/decode; `ENTER` (§3.2) spawns a new handle
from an existing one by navigating to a child. Handle IDs are small
literals, like stream iterators, typically `< 4`.

A handle's type is statically known — derived from the navigation path that
produced it — which is what lets one `ENTER` encoding carry three meanings,
disambiguated by the source handle's type *kind*:

| Source kind | `ref` means | Result handle refers to |
|---|---|---|
| struct | field # | the field's sub-object |
| union | variant # | the active variant's payload |
| list | — (`ENTER_NEXT` only) | the next element |

Entering a list-typed *field* yields a handle to the list as a whole, not an
element — element access is always sequential, via `ENTER_NEXT` (§3.2, §3.4).
Reaching a deeply nested value (a union variant inside a struct field inside
another struct) is a static sequence of `ENTER`s, one per level — no path
encoding, no runtime lookup.

### 2.3 Directionality

Direction is a property of the **program**, not of an individual procedure.
A program is built by lowering one entry procedure and everything it
transitively calls (ROADMAP.md item 2, `lowerProgram`) — literal codec
calls, dispatch calls, and plain generic `CALL`s alike — and that closure
is always coherent: the entry point is either "encode `T`" or "decode `T`",
and nothing it ever reaches, directly or through dispatch, can be the other
direction (an encoder for a field's type is never reached from a decoder's
call graph, or the program would decode with an encoder — which the
metaprogramming layer that builds the call graph never does; §5 makes the
same point about dispatch calls staying inside one coherent codec build).

What direction buys is letting the target-access class (§3.2) overlap
read-only and write-only opcodes onto shared slots, since a program only
ever needs one direction's worth of accessor semantics:

| Direction | Handle capability | Opcodes |
|---|---|---|
| Encoder | read-only | `LOAD_VAL`, `ENTER` (navigate), `COUNT`, `TAG` |
| Decoder | write/init-only | `STORE_VAL`, `ENTER` (navigate + instantiate a union variant), `OPEN_LIST` |

`LOAD_VAL`/`STORE_VAL` occupy one opcode slot; which semantics apply is
resolved by the program's direction, never encoded per-instruction.
§4.1 covers what a procedure header still needs to say given direction
itself is not a per-procedure choice.

### 2.4 Handle types need no selector

§2.2 already establishes that a handle's type is fully pinned by its
provenance: `o0`'s type is the procedure's own declared object type, fixed
at build time; every other handle's type is `src`'s type's field/variant
table at index `ref`, and `src`'s type is in turn pinned the same way, all
the way back to `o0`. So at any `ENTER`/`CALL_CODEC` site, `ref`'s meaning
is unambiguous from `src` and `ref` alone — a translator recovers a
handle's type by walking the procedure's structure once, the same way it
recovers TOS depth, never by consulting extra per-instruction data. There
is therefore no `type_ref` operand anywhere in this instruction set, and no
per-procedure "referenced-types list" it would index into.

A procedure header still needs exactly *one* piece of type metadata that
has nothing to do with instruction decoding: the entry procedure's own
object type, the root the walk above starts from. That is the only type a
wire image needs to name explicitly — every other handle's type is
derived, never declared, by the same structural walk a translator already
performs for TOS depth. There is no per-procedure "referenced-types list"
alongside it; ROADMAP.md item 8 sketches where that single root-type
reference and the semantic type tree it points into actually live —
an image-level concern above this procedure header, not per-procedure
metadata.

---

## 3. Instruction Reference

### 3.1 Stream I/O class

| Op | Effect |
|---|---|
| `READ i, w` | `acc = stream[i].read(w)`, `w ∈ {1,2,4}` bytes |
| `WRITE i, w` | `stream[i].write(acc, w)` |
| `HAS_NEXT i` | `acc = (stream[i] has ≥1 more byte)` |
| `CLONE_RD src, dst` | fork a readable iterator |
| `CLONE_WR src, dst` | fork a writable iterator |
| `SEEK i, Δ` | *(optional)* advance/rewind by a signed LEB128 delta |

`HAS_NEXT` is the stream-side counterpart of `COUNT`/`TAG` (§3.2) — it's
what makes a pretest stream loop ("while there are more bytes") expressible
without a separate length count.

### 3.2 Target access class

Core operations are **unfused**: `ENTER` navigates to a child, then a
value/metadata op acts on the resulting handle directly (no `ref` — the
handle already names its target). Delegation (§3.3) is the only fused form.

**Navigation:**

| Op | Effect |
|---|---|
| `ENTER dst, src, ref` | handle to `src`'s child → `dst` (§2.2 disambiguates `ref` by `src`'s type kind; decoder-side `ENTER` on a union selects+instantiates the variant) |
| `ENTER_NEXT dst, src` | handle to `src`'s next list element → `dst` (sequential only — §3.4) |

**Value access** (operates on the handle itself, no `ref`; one opcode slot
per row, direction-selected per §2.3):

| Op | Direction | Effect |
|---|---|---|
| `LOAD_VAL [src=o0]` | encoder | `acc` = primitive value at the handle |
| `STORE_VAL [src=o0]` | decoder | primitive value at the handle = `acc` |

**Metadata / initialization** (operates on the handle, no `ref`):

| Op | Direction | Effect |
|---|---|---|
| `COUNT [src=o0]` | encoder | `acc` = list length at the handle |
| `TAG [src=o0]` | encoder | `acc` = union active-variant index at the handle |
| `OPEN_LIST [src=o0]` | decoder | instantiate the list at the handle; `acc` = capacity hint (target may honor or ignore) |

Deferred (reconsider once opcode space is measured against real codecs, per
isa-core.md §5.3's reserved-code philosophy): a fused `LOAD_VAL src, ref` /
`STORE_VAL src, ref` (enter+access a primitive child in one op), and a fused
encoder `ENTER_ACTIVE` (enter the active union variant in one op, replacing
`TAG` + `BR_TABLE` + `ENTER`).

### 3.3 Delegation

Delegation is the fused, and only, form — a codec that delegates does not
want to deal with the sub-representation, so there is no unfused
`ENTER`-then-`CALL` path onto a handle:

| Op | Effect |
|---|---|
| `CALL_CODEC codec_idx, [src=o0,] ref, [args…]` | invoke `codec[codec_idx]` on `child(src, ref)` — see §4 for the full entry protocol |
| `CALL_CODEC_NEXT codec_idx, [src=o0,] [args…]` | fused enter-next + delegate: advance to `src`'s next list element and invoke `codec[codec_idx]` on it |

**A handle is the only thing `CALL_CODEC` can bind as `o0`.** A *computed*
value — a delta, a running checksum, a derived tag — lives in a register,
not the object tree, and so cannot be delegated this way. It's passed
instead to a plain generic-core `CALL` (isa-core.md §4.6) targeting a
shared procedure (e.g. a `leb128_encode` helper, §8.3), using the standard
calling convention. This is the reason the codec extension needs generic
`CALL` at all rather than only its own `CALL_CODEC`: `CALL_CODEC` operates
on the object-handle axis, `CALL` on the value axis, and a real codec needs
both.

### 3.4 Lists

List elements are accessed **sequentially** (`ENTER_NEXT`/`CALL_CODEC_NEXT`),
mirroring stream cursors — the minimal obligation a target mapping must
support (streaming buffers, ring buffers, DMA descriptors, and fixed arrays
all support sequential access; many support nothing else). Multipass read is
possible by re-entering the list from its parent handle; true random access
is out of scope here, deferred to a future target-capability extension
point (Appendix — Deferred Design Points). `COUNT` gives the length for an
encoder's length prefix; `OPEN_LIST` takes a capacity hint for a decoder's
pre-allocation. The target owns all memory — no codec opcode allocates.

---

## 4. Calling Convention Addition — Codec Entry Protocol

`i0` and direction (§2.1, §2.3) are not per-call bindings — there is exactly
one of each for the whole program, established once at the entry procedure
and unchanged for the run's entire duration. Every procedure the program
ever calls, `CODEC` or `GENERIC`, sees the same `i0` and operates under
the same direction; nothing rebinds either of them at a `CALL` or
`CALL_CODEC` site. The one thing `CALL_CODEC`/`CALL_CODEC_NEXT` actually
bind, on top of the generic core's calling convention (isa-core.md §6), is
the object handle:

`o0 ← child(src, ref)` — the handle computed from the `CALL_CODEC`
operands (or the next list element, for `CALL_CODEC_NEXT`), passed to the
callee out-of-band, not counted in its `arg_count`.

Any runtime value arguments follow immediately after, by the ordinary
calling convention (isa-core.md §6: `arg_count` from the callee's header,
last argument via `acc`, the rest pushed). So `CALL_CODEC` is a strict
superset of `CALL`: "compute the child handle, bind it as `o0`, then
`CALL`." A `CODEC` procedure may take value args exactly like a `GENERIC`
one.

### 4.1 Header ABI selector

Since direction is fixed for the whole program (§2.3), a procedure header
doesn't need to *choose* a direction — only to say whether the procedure
works with object handles at all. The ABI selector this extension adds to
the header (isa-core.md §2.3's opaque extension fields) is therefore a
`{GENERIC, CODEC}` flag, not a three-way `{GENERIC, CODEC_ENCODER,
CODEC_DECODER}` choice: `CODEC` means `o0` is bound on entry and
`LOAD_VAL`/`STORE_VAL` etc. resolve per the program's one direction;
`GENERIC` means there is no `o0` at all. A `GENERIC` procedure (a plain
`CALL` target, e.g. `leb128_encode`, §8.3) is still free to use `i0`
directly — the stream isn't gated by this flag, only the handle is — which
is exactly how `leb128_encode` legitimately does `WRITE i0, 1` despite
never touching an object handle.

Whether the wire format additionally records direction once, at the
program level, or leaves a decoder to derive it from context, is an
encoding choice (§6), not a semantic one — a `CODEC`-flagged procedure's
direction is always the program's; it is never chosen independently.

---

## 5. Recursion and the Call Graph

Codec procedures recurse whenever the semantic type does (`list(T)`,
self-referential structs). Two distinct call mechanisms exist at the
DSL/metaprogramming layer, with different acyclicity properties:

- **Literal codec calls** (a fixed identifier resolved at compile time) —
  the authoring layer rejects cycles over these directly.
- **Dispatch calls** ("the codec the projection resolves for this child
  type") — the target isn't a compile-time literal, so this *can* resolve
  to the same codec again for a recursive type, and is allowed to.

This looks like it conflicts with isa-core.md §8.2's blanket call-graph
acyclicity, but it doesn't reach the validator as recursion at all: the
metaprogramming layer that walks the semantic type graph and emits `ir`
fragments instantiates one distinct, uniquely-identified `Procedure`
(isa-core.md's `ir.ts`) per dispatch site it visits, rather than one
procedure calling itself. The RTL call graph the validator sees is
therefore already a DAG by construction — no special-casing needed. What
actually recurses in every direction is the meta layer's instantiation
walk, an application/build-layer concern above the machine this document
and isa-core.md specify, not a call-graph shape the validator ever has to
accept.

This monomorphization (one procedure per dispatch site, rather than a
shared procedure parametrized over type) trades code size for the DAG
guarantee. Known and deliberate; not revisited here.

The bound this buys: worst-case stack depth is `max_data_depth(type) ×
max_frame_size`, computable at compile time over the dispatch call graph —
consistent with isa-core.md §8.3's tight per-call-site bound, just
evaluated over the monomorphized DAG rather than a literal recursive cycle.

---

## 6. Encoding

The concrete byte layout is not assigned yet — deferred, per isa-core.md
§5.3's philosophy, until real codecs are compiled against this instruction
set and opcode frequency can be measured. This section fixes the layout
*rules*, which don't depend on the final byte assignment.

### 6.1 Opcode-space skew

isa-core.md §5.1 gives the generic core the low 128 codes and reserves the
top 128 for the active extension. Within that top half, this extension's
own ops skew longer on average than the core's: `CALL_CODEC` carries
`codec_idx` + `ref` at minimum, `ENTER` carries `dst, src, ref`. That's an
acceptable trade because delegation dominates real codec bodies (§8.1,
§8.2) — a smaller number of frequent, still-not-tiny ops, rather than the
core's evenly-spread arithmetic/comparison combo space.

### 6.2 Literal-ref segmentation

Handle/field/variant refs on `ENTER`/`CALL_CODEC` are small integers in
practice (few structs have more than a handful of fields) — the same
"segment the common case into the opcode itself" principle isa-core.md
applies to comparison's zero-immediate (§4.2) and `CONST`'s small values
(§4.4) applies here: a short literal-offset form should reach the first `N`
fields of the handle's referenced type directly, escaping to an extended
LEB128 form beyond that. `N` is a byte-budget call for the follow-up
encoding revision, not fixed here.

### 6.3 Effect declarations

Every opcode above must supply the `ExtOpEffect` isa-core.md §11.2 requires
(`packages/machine/src/extension.ts`) before it can be validated or
executed:

| Class | `tosDelta` | `maxTransient` | `terminates` | call-shaped |
|---|---|---|---|---|
| `READ`/`WRITE`/`HAS_NEXT`/`CLONE_*`/`SEEK` | 0 | 0 | no | no |
| `ENTER`/`ENTER_NEXT` | 0 | 0 | no | no |
| `LOAD_VAL`/`STORE_VAL`/`COUNT`/`TAG`/`OPEN_LIST` | 0 | 0 | no | no |
| `CALL_CODEC`/`CALL_CODEC_NEXT` | `−stackArgsOf(argCount)` — pops the pushed argument block, same as `CALL` | 0 | no | **yes** — `calleeOperandIndex` is the `codec_idx` operand, `argCount` from the invoked codec's header |

None of the non-call ops touch TOS at all — they operate entirely on the
handle/iterator ID space and `acc`, never pushing or popping. `CALL_CODEC`'s
`tosDelta` is what makes `validate.ts` account for the pushed-argument block
exactly like a plain `CALL` (`stackArgsOf` in validate.ts, mirroring
isa-core.md §6); the `call` field is what folds the callee into the same
`callSites` bookkeeping for §8.2/§8.3 — the entire point of
`ExtOpEffect.call`.

---

## 7. Static Validation — Open Design

Not yet implemented (ROADMAP.md item 7). Both questions below now have a
concrete mechanism rather than just being open — documented here, not in
isa-core.md, since both ride on codec-extension concepts (handle
provenance, named resources) the generic core has no notion of.

### 7.1 Handle type and bounds checking

§2.4 establishes that every handle's type is statically derivable from its
provenance. That means the validator can reconstruct it too, for free,
during the same call-graph DFS `validate.ts` already runs for isa-core.md
§8.2/§8.3 — threading "current handle's type" through the walk alongside
the existing TOS-depth accumulator. Two checks fall out:

- **Local bounds/kind check** — at every `ENTER`/`CALL_CODEC`/
  `CALL_CODEC_NEXT`, `src`'s type kind (struct/union/list) must support the
  op per §2.2's disambiguation table, and `ref` must be in range for that
  type's field/variant table. This is the concrete answer to "a handle
  must be entered before it's read," and its sharper sibling: entered
  against the right kind, at an index that exists.
- **Cross-procedure consistency** — at every `CALL_CODEC`/
  `CALL_CODEC_NEXT`, the callee's own declared object type (its `o0` type,
  fixed at the callee's build time, pinned the same way as any other
  handle's — §2.4) must equal `child(src, ref)`'s statically-derived type.
  This is the check that actually earns its keep: a struct field typed
  `Foo` delegating to a codec built for `Bar` is a silent-corruption bug,
  not a decode-time error, and nothing about §8.2's acyclicity or §8.3's
  depth bound would ever catch it.

Neither check needs new validator machinery beyond a semantic type tree to
walk against — see ROADMAP.md item 8 for where that tree lives at the wire
level.

### 7.2 Resource-peak statistics

Per-resource peaks (maximum concurrent stream iterators, maximum
concurrent object handles) generalize a mechanism isa-core.md §8.3 now
provides in its own right: maximum call depth, the control-stack sizing
figure isa-core.md §8.3 computes alongside — and distinctly from — its
operand-stack depth bound (see isa-core.md §8.3 for why the two diverge).
Iterator/handle-count peaks are the extension-specific instances of that
same generic pattern, not a parallel mechanism: same bottom-up DFS, one
more named resource tracked alongside call depth and TOS depth, with the
same per-procedure/tight-cross-call-site treatment falling out for free.

---

## Appendix — Worked Examples

Notation: `LOAD rN`/`STORE rN` are move-class register ops; `OP #imm` is a
binary- or comparison-class immediate combo (result → `acc`, per isa-core.md
§4.1/§4.2); `OP rN` is a register combo when the result isn't `acc`. The
recurring lesson: **fused delegation (`CALL_CODEC`) is the size win, not
fused field access** — a real struct/union codec collapses to a handful of
`CALL_CODEC`s, far smaller than the unfused `ENTER`+`LOAD_VAL`+`WRITE`
spelling per field.

### 8.1 Struct encoder — delegates each field

`{x: u32, y: u16, flag: u8}`, encoder. Each field delegates to the number
codec its type resolves to:

```
CALL_CODEC codec_u32, o0, x
CALL_CODEC codec_u16, o0, y
CALL_CODEC codec_u8,  o0, flag
RETURN
```

(The unfused spelling — `ENTER`+`LOAD_VAL`+`WRITE` per field — is 9
instructions instead of 3; fused field access alone, without delegation,
would not have closed that gap.)

### 8.2 Union encoder — delegates the active variant

Union of three number payloads. `TAG` reads the active variant, `BR_TABLE`
dispatches, each case delegates:

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

### 8.3 LEB128 encoder — generic-core loop, invoked as a shared `CALL` target

`leb128_encode(u32 value)` — a `GENERIC`-ABI procedure (§4.1: no `o0`, but
still free to use the program's `i0` directly), invoked by value-arg `CALL`
from codec bodies that need to emit a computed number (§8.6). Register 0
is `value`. A u32 always emits ≥1 byte, so the loop must run once even when
the value starts at zero — the first-iteration-flag idiom (isa-core.md
§7.2):

```
CONST #1
STORE r_first          ; force first pass
LOOP
  LOAD 0                ; condition block: acc = value
  NE #0                 ; acc = (value != 0)
  OR r_first             ; OR'd with the forced first-pass flag
BLOCK_END                 ; acc=0 → exit; acc≠0 → body
  CONST #0
  STORE r_first           ; clear; harmless if repeated
  LOAD 0
  AND #0x7F
  STORE r_byte
  LOAD 0
  SHR #7
  STORE 0                 ; value >>= 7
  LOAD 0
  EQ #0                  ; acc = (value == 0) — done after this byte?
  BR_TABLE 2              ; case 0 (more): set continuation bit; case 1 (done): none
    LOAD r_byte
    OR #0x80
    STORE r_byte
  BLOCK_END
  BLOCK_END
  LOAD r_byte
  WRITE i0, 1
BLOCK_END                 ; back-edge → LOOP
RETURN
```

### 8.4 Checksum with fixup — stream forks + `HAS_NEXT`

A reader fork walks the packet body for checksumming while a writer fork,
parked at the checksum field, is patched once the sum is known. Iterator 1
is `i0` reborn as a reader (§2.1's fork-independent-of-source-capability
point); iterator 2 only ever overwrites the placeholder byte `i0` already
appended — it never advances past it:

```
CLONE_RD 0, 1          ; reader fork at packet start (for checksumming)
CLONE_WR 0, 2          ; writer fork parked at checksum field
WRITE i0, 1            ; placeholder byte via original writer
; ...serialize rest of packet with original writer i0 (elided)...
CONST #0
STORE r_sum            ; r_sum = checksum accumulator
LOOP
  HAS_NEXT 1           ; condition block: does reader 1 have another byte?
BLOCK_END               ; acc=0 → exit; acc≠0 → body
  READ 1, 1            ; acc = next byte from reader
  ADD r_sum            ; r_sum += byte (register combo, result → acc)
BLOCK_END               ; back-edge
LOAD r_sum
WRITE 2, 1              ; emit checksum via parked writer fork
RETURN
```

### 8.5 Presence-bitmap struct — `COUNT`-as-presence

`{base: u8, opt1?: u8, opt2?: u8}`. Struct fields are always present in the
semantic model, so **optionality is modeled as `List<u8>` of length 0 or
1** — `COUNT` then reads directly as presence (0/1), with no dedicated
`IS_PRESENT` opcode. Wire = `[bitmap][base][opt1?][opt2?]`:

```
; --- build bitmap ---
CONST #0
STORE r_bmp
ENTER o1, o0, opt1
COUNT o1               ; acc = len(opt1)
NE #0                  ; acc = present ? 1 : 0
STORE r_bit
LOAD r_bmp
OR r_bit
STORE r_bmp
ENTER o1, o0, opt2
COUNT o1
NE #0
SHL #1
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
BR_TABLE 2             ; case 0 (absent): skip; case 1 (present): emit
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

### 8.6 Delta-encoded `List<u32>` — computed-value delegation via generic `CALL`

First element encoded as-is; subsequent elements as the delta from the
previous one; all LEB128. `o0` is the list handle. Each value passed to
`leb128_encode` (§8.3) is a single argument, so by isa-core.md §6 it goes
via `acc` directly — no `PUSH` needed. `RSUB` (`operand − acc`) computes
the delta in one op:

```
COUNT                   ; acc = length (src=o0)
STORE r_left             ; r_left = loop counter
WRITE i0, 1              ; emit count byte (acc still holds count after STORE)
EQ #0
BR_TABLE 2
BLOCK_END                 ; case 0 (non-empty): continue
  RETURN                  ; case 1 (empty): done
BLOCK_END
ENTER_NEXT o1, o0         ; o1 = first element
LOAD_VAL o1
STORE r_prev              ; r_prev = baseline
LOAD r_prev
CALL leb128_encode        ; single arg, delivered via acc — no PUSH
LOAD r_left
SUB #1
STORE r_left
LOOP
  LOAD r_left
  NE #0                  ; condition block: more?
BLOCK_END                  ; acc=0 → exit; acc≠0 → body
  ENTER_NEXT o1, o0       ; o1 = next element
  LOAD_VAL o1
  STORE r_cur
  LOAD r_prev
  RSUB r_cur              ; acc = r_cur − r_prev  (delta)
  CALL leb128_encode      ; delta already in acc — no PUSH
  LOAD r_cur
  STORE r_prev             ; slide baseline
  LOAD r_left
  SUB #1
  STORE r_left
BLOCK_END                  ; back-edge
RETURN
```

This is the case §3.3 calls out: a delta is a computed register value, not
an object handle, so it can't be delegated via `CALL_CODEC` — but it can be
passed to a shared generic `CALL` target instead of inlining `leb128_encode`
at every call site.

### 8.7 Checksum validation + exhaustive union decoding — `TRAP`

Decoder-side counterpart of §8.4. After reading the body, recompute the
checksum and compare against the received byte; on mismatch, `TRAP`. This
is an `if`-without-`else` (isa-core.md §7.3), so it lowers to `BR_TABLE 1`:
mismatch is `case[0]` (reached when `acc = 0`), and match falls through the
implicit default. `TRAP` is a terminator (isa-core.md §4.5), so it closes
`case[0]` with no `BLOCK_END` and no trailing `RETURN`:

```
; (assume reader fork i1 walked, checksum accumulated in r_sum, as in §8.4)
LOAD r_sum
READ 2, 1              ; acc = received checksum byte from parked writer fork
EQ r_expected           ; acc = (computed == received)
BR_TABLE 1              ; case 0 (mismatch): trap; default (match): continue
  TRAP ERR_CHECKSUM     ; terminator — no BLOCK_END, no RETURN follows
; --- implicit default: match, continue decode ---
; ...rest of decode...
RETURN
```

Exhaustive-union decoding uses the same implicit default as the home for an
out-of-range tag. A union decoder dispatches on the received tag via
`BR_TABLE N` over all `N` valid variants; `acc ≥ N` falls through to the
trailing `TRAP`. Each variant case delegates to its variant's decoder and
`RETURN`s (`RETURN` closes the case, so no `BLOCK_END` follows it either):

```
READ i0, 1              ; acc = variant tag
BR_TABLE 3               ; cases 0..2 valid; acc≥3 → implicit default
  CALL_CODEC codec_0, o0, 0
  RETURN
  CALL_CODEC codec_1, o0, 1
  RETURN
  CALL_CODEC codec_2, o0, 2
  RETURN
TRAP ERR_BAD_TAG          ; implicit default (acc≥3, invalid tag) — terminator
```

`ERR_CHECKSUM`/`ERR_BAD_TAG` are codec-defined high error codes
(isa-core.md §4.5) — opaque to the ISA, reported to the host, which owns
stream/handle teardown and decides the response.

---

## Appendix — Deferred Design Points

- **Fused value access.** `LOAD_VAL src, ref` / `STORE_VAL src, ref`
  (enter+access a primitive child in one op) and a fused encoder
  `ENTER_ACTIVE` (§3.2). Reconsider once opcode space is measured against
  real codecs.
- **List access.** Sequential-only (§3.4) is sufficient for now; multipass
  read works by re-entering. Random access and other target-specific
  capabilities are deferred to a future target-capability extension point
  (call-out ops + trait processing bound by the type mapper at codegen
  time) — out of scope here.
- **Recursion depth bound.** §5's `max_data_depth(type) × max_frame_size`
  bound is derived conceptually; confirm the actual figures once concrete
  recursive schemas (e.g. self-referential structs) are run through
  `validateProgram`'s tight §8.3 figure.
- **Optional-field convention.** §8.5's 0/1-length-`List` + `COUNT`
  modeling is sufficient for the cases considered; confirm it holds across
  more realistic schemas before locking it in as the only convention.
- **Validator/resource-peak generalization.** See §7 — not yet designed.
