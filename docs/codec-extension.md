# Codec Extension ISA

> **Status:** implemented, ROADMAP.md item 7, including §6's byte encoding
> and item 11's `WRITE_SEQ`/`READ_SEQ` bulk-array pair (§3.5). Specifies
> the codec extension's opcodes, calling convention and encoding rules the
> way isa-core.md specifies the generic core, plugging in purely through
> the mechanism isa-core.md §11 defines (opcode range ≥128, effect
> declarations, literal-only operands). Rationale is inline here, section by
> section, rather than in a companion document.
>
> Lives in `@ppl/codecs` (`packages/codecs/src/engine/`), registered
> against `packages/machine/src/extension.ts`'s `Extension` interface;
> the generic core stays protocol-agnostic.

---

## 1. Overview

The codec extension adds two things the generic core has no concept of:

- **Streams**: byte-oriented I/O against the wire, addressed by small
  iterator IDs.
- **Object handles**: navigation over a host data model (structs, unions,
  lists, primitives), addressed by small handle IDs, symmetric to stream
  iterators.

A whole program is either an **encoder** (reads the object, writes the
stream) or a **decoder** (reads the stream, writes the object). Direction is
fixed once, for everything the program's single entry procedure
transitively calls (§2.3), which is what lets read-only and write-only
target-access opcodes share opcode slots: a codec procedure only ever needs
one direction's worth of accessor semantics.

`CALL_CODEC` (§3.3) is the extension's one call-shaped opcode: a fused
"navigate to a child, then invoke its codec", a strict superset of the
generic core's `CALL` (isa-core.md §4.6) carrying the same calling
convention plus one extra entry binding (§4).

---

## 2. Abstract Machine Additions

### 2.1 Stream iterators

A stream iterator is a cursor into a byte sequence. `i0` is the one bound
at program entry, and its capability follows the *program's* direction
(§2.3): read-only for a decoder, write-only for an encoder. That is not the
capability of iterators in general. `CLONE_RD`/`CLONE_WR` (§3.1) each fork
an iterator of the capability they name, independent of the source
iterator's own, which is exactly what an encoder's checksum patch-up needs
(§8.4): `CLONE_RD` on the write-only `i0` yields a readable fork that
re-reads bytes the encoder already emitted, to sum them. The program stays
an encoder throughout; only this one forked cursor reads. Iterator IDs are
small literals, typically `< 4`.

A target's stream implementation can rely on a clean split between
appending and patching. Only `i0`, an encoder's entry writer, ever appends,
advancing the write cursor past previously nonexistent buffer space. Every
`CLONE_WR` fork (the parked writer in §8.4, later patched with a checksum)
exclusively overwrites bytes some earlier `i0` write already established.
Restricting a `CLONE_WR` fork to overwrite-only, and rejecting an attempted
append through one, gives the target a simple invariant instead of support
for arbitrary interleaved appends across several live cursors.

### 2.2 Object handles

An object handle refers to a node in the host object tree: a struct, a
union, a list, or a primitive value. `o0` is bound at codec entry to the
object the procedure must encode or decode; `ENTER` (§3.2) spawns a new
handle from an existing one by navigating to a child. Handle IDs are small
literals, typically `< 4`.

A handle's type is statically known, derived from the navigation path that
produced it, which lets one `ENTER` encoding carry three meanings
disambiguated by the source handle's type *kind*:

| Source kind | `ref` means | Result handle refers to |
|---|---|---|
| struct | field # | the field's sub-object |
| union | variant # | the active variant's payload |
| list | (`ENTER_NEXT` only) | the next element |

Entering a list-typed *field* yields a handle to the list as a whole.
Element access is always sequential, via `ENTER_NEXT` (§3.2, §3.4).
Reaching a deeply nested value (a union variant inside a struct field
inside another struct) is a static sequence of `ENTER`s, one per level: no
path encoding, no runtime lookup.

### 2.3 Directionality

Direction is a property of the **program**, not of an individual procedure.
A program is built by lowering one entry procedure and everything it
transitively calls (`lowerProgram`), literal codec calls, dispatch calls
and plain generic `CALL`s alike, and that closure is always coherent: the
entry point is either "encode `T`" or "decode `T`", and nothing it reaches
can be the other direction. An encoder for a field's type is never reached
from a decoder's call graph, because the metaprogramming layer that builds
the call graph never does that (§5 makes the same point about dispatch
calls).

What direction buys is letting the target-access class (§3.2) overlap
read-only and write-only opcodes onto shared slots:

| Direction | Handle capability | Opcodes |
|---|---|---|
| Encoder | read-only | `LOAD_VAL`, `ENTER` (navigate), `COUNT`, `TAG` |
| Decoder | write/init-only | `STORE_VAL`, `ENTER` (navigate + instantiate a union variant), `OPEN_LIST` |

`LOAD_VAL`/`STORE_VAL` occupy one opcode slot; which semantics apply is
resolved by the program's direction, never encoded per instruction. §4.1
covers what a procedure header still needs to say.

### 2.4 Handle types need no selector

§2.2 establishes that a handle's type is fully pinned by its provenance:
`o0`'s type is the procedure's declared object type, fixed at build time,
and every other handle's type is `src`'s type's field/variant table at
index `ref`, with `src`'s type pinned the same way all the way back to
`o0`. So at any `ENTER`/`CALL_CODEC` site, `ref`'s meaning follows from
`src` and `ref` alone: a translator recovers a handle's type by walking the
procedure's structure once, the same way it recovers TOS depth. There is no
`type_ref` operand anywhere in this instruction set and no per-procedure
referenced-types list.

A procedure header needs exactly one piece of type metadata unrelated to
instruction decoding: the entry procedure's own object type, the root that
walk starts from. That is the only type a wire image names explicitly.
docs/codec-image.md specifies where that root-type reference and the
semantic type tree it points into live, an image-level concern above this
procedure header.

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
| `SEEK i, Δ` | advance/rewind by a signed LEB128 delta (optional) |

`HAS_NEXT` is the stream-side counterpart of `COUNT`/`TAG` (§3.2): it makes
a pretest stream loop ("while there are more bytes") expressible without a
separate length count.

### 3.2 Target access class

Core operations are **unfused**: `ENTER` navigates to a child, then a
value/metadata op acts on the resulting handle directly, with no `ref`
since the handle already names its target. Delegation (§3.3) is the only
fused form.

**Navigation:**

| Op | Effect |
|---|---|
| `ENTER dst, src, ref` | handle to `src`'s child → `dst` (§2.2 disambiguates `ref` by `src`'s type kind; decoder-side `ENTER` on a union selects and instantiates the variant) |
| `ENTER_NEXT dst, src` | handle to `src`'s next list element → `dst` (sequential only, §3.4) |

**Value access** (operates on the handle itself, no `ref`; one opcode slot
per row, direction-selected per §2.3):

| Op | Direction | Effect |
|---|---|---|
| `LOAD_VAL [src=o0]` | encoder | `acc` = primitive value at the handle |
| `STORE_VAL [src=o0]` | decoder | primitive value at the handle = `acc` |

**Metadata and initialization** (operates on the handle, no `ref`):

| Op | Direction | Effect |
|---|---|---|
| `COUNT [src=o0]` | encoder | `acc` = list length at the handle |
| `TAG [src=o0]` | encoder | `acc` = union active-variant index at the handle |
| `OPEN_LIST [src=o0]` | decoder | instantiate the list at the handle; `acc` = capacity hint (target may honor or ignore) |

Deferred until opcode space is measured against real codecs (isa-core.md
§5.3's reserved-code philosophy): a fused `LOAD_VAL src, ref` /
`STORE_VAL src, ref` (enter and access a primitive child in one op), and a
fused encoder `ENTER_ACTIVE` (enter the active union variant in one op,
replacing `TAG` + `BR_TABLE` + `ENTER`).

### 3.3 Delegation

Delegation is fused only: a codec that delegates does not want to deal with
the sub-representation, so there is no unfused `ENTER`-then-`CALL` path
onto a handle.

| Op | Effect |
|---|---|
| `CALL_CODEC codec_idx, [src=o0,] ref, [args…]` | invoke `codec[codec_idx]` on `child(src, ref)`; §4 has the full entry protocol |
| `CALL_CODEC_NEXT codec_idx, [src=o0,] [args…]` | fused enter-next plus delegate: advance to `src`'s next list element and invoke `codec[codec_idx]` on it |

**A handle is the only thing `CALL_CODEC` can bind as `o0`.** A *computed*
value (a delta, a running checksum, a derived tag) lives in a register, not
the object tree, and cannot be delegated this way. It goes instead to a
plain generic-core `CALL` (isa-core.md §4.6) targeting a shared procedure
such as a `leb128_encode` helper (§8.3), using the standard calling
convention. This is why the codec extension needs generic `CALL` at all:
`CALL_CODEC` operates on the object-handle axis, `CALL` on the value axis,
and a real codec needs both.

### 3.4 Lists

List elements are accessed **sequentially** (`ENTER_NEXT`/
`CALL_CODEC_NEXT`), mirroring stream cursors: the minimal obligation a
target mapping must support, since streaming buffers, ring buffers, DMA
descriptors and fixed arrays all support sequential access and many support
nothing else. Multipass read works by re-entering the list from its parent
handle. True random access is out of scope, deferred to a future
target-capability extension point. `COUNT` gives the length for an
encoder's length prefix; `OPEN_LIST` takes a capacity hint for a decoder's
pre-allocation. The target owns all memory; no codec opcode allocates.

### 3.5 Bulk sequential transfer

`ENTER_NEXT`/`CALL_CODEC_NEXT` (§3.4) cost one nested procedure call per
list element, fine for a struct or union element and wasteful for a plain
`List<Integer>`, where every element is otherwise just a `READ`/`WRITE`
plus sign extension. `WRITE_SEQ`/`READ_SEQ` fuse the whole element run into
one op:

| Op | Direction | Effect |
|---|---|---|
| `WRITE_SEQ iter, handle, w` | encoder | `acc` many elements, `w` bytes each, copied from `handle`'s array storage (index `0..acc-1`) to `stream[iter]` |
| `READ_SEQ iter, handle, w, signed` | decoder | `acc` many elements read from `stream[iter]`, sign-extended per `signed` exactly as `STORE_VAL` (§3.2) does, appended into `handle`'s array storage |

`acc` (the element count) is deliberately not a fixed operand of the op. It
arrives the same way `WRITE`'s own value does (§3.2): computed however the
surrounding codec body likes (fixed-width prefix, LEB128, anything), then
handed in via `acc` right before the call. Two consequences follow. The op
stays agnostic to length-encoding convention. And by the time it runs,
`stream[iter]` sits at exactly the first element's byte, with nothing about
length-prefix I/O bundled in, which is what makes it a usable **snatch
point**: a target codegen recognizing this op knows precisely where the raw
element run starts and ends, with nothing op-internal left to account for.
`OPEN_LIST` still runs first on the decode side (§3.2); this op fills an
already-opened list rather than allocating one.

`exec()`'s semantics are always the per-element pump loop, correct on its
own, so `validateProgram`/`run` need no target-codegen awareness and a
program using these ops is fully interpretable and testable like any other.
Recognition and specialization (a raw-buffer or DMA copy for a target that
opted a field into that representation) happens only at a target's own
`raise.ts` pass, entirely optional and local to one instruction; a target
that hasn't opted in gets the same loop. `binary-rules.ts`'s default
`List<Integer>` rule already uses this pair in place of the generic
per-element loop, so even a target's idiomatic
`std::vector<uint16_t>`/JS array benefits once that target chooses to
specialize the bulk copy.

---

## 4. Calling Convention Addition: codec entry protocol

`i0` and direction (§2.1, §2.3) are not per-call bindings. There is exactly
one of each for the whole program, established at the entry procedure and
unchanged for the run's duration; every procedure the program calls,
`CODEC` or `GENERIC`, sees the same `i0` under the same direction, and
nothing rebinds either at a `CALL` or `CALL_CODEC` site. The one thing
`CALL_CODEC`/`CALL_CODEC_NEXT` bind on top of the generic core's calling
convention (isa-core.md §6) is the object handle:

`o0 ← child(src, ref)`, the handle computed from the `CALL_CODEC` operands
(or the next list element, for `CALL_CODEC_NEXT`), passed to the callee
out of band and not counted in its `arg_count`.

Any runtime value arguments follow immediately after by the ordinary
calling convention (isa-core.md §6: `arg_count` from the callee's header,
last argument via `acc`, the rest pushed). So `CALL_CODEC` is exactly
"compute the child handle, bind it as `o0`, then `CALL`", and a `CODEC`
procedure may take value args exactly like a `GENERIC` one.

### 4.1 Header ABI selector

Direction is fixed for the whole program (§2.3), so a procedure header does
not choose one; it only says whether the procedure works with object
handles at all. The ABI selector this extension adds to the header
(isa-core.md §2.3's opaque extension fields) is therefore a
`{GENERIC, CODEC}` flag: `CODEC` means `o0` is bound on entry and
`LOAD_VAL`/`STORE_VAL` resolve per the program's direction, `GENERIC` means
there is no `o0` at all. A `GENERIC` procedure (a plain `CALL` target such
as `leb128_encode`, §8.3) is still free to use `i0` directly, since the
flag gates the handle, not the stream. That is how `leb128_encode`
legitimately does `WRITE i0, 1` without ever touching an object handle.

Whether the wire format additionally records direction once at program
level, or leaves a decoder to derive it from context, is an encoding choice
(§6), not a semantic one.

---

## 5. Recursion and the Call Graph

Codec procedures recurse whenever the semantic type does (`list(T)`,
self-referential structs). Two call mechanisms exist at the
DSL/metaprogramming layer, with different acyclicity properties:

- **Literal codec calls**, a fixed identifier resolved at compile time: the
  authoring layer rejects cycles over these directly.
- **Dispatch calls**, "the codec the projection resolves for this child
  type": the target is not a compile-time literal, so this can resolve to
  the same codec again for a recursive type, and is allowed to.

This never reaches the validator as recursion. The metaprogramming layer
that walks the semantic type graph and emits `ir` fragments instantiates
one distinct, uniquely-identified `Procedure` (`ir.ts`) per dispatch site
it visits, rather than one procedure calling itself, so the RTL call graph
the validator sees is a DAG by construction and needs no special casing
against isa-core.md §8.2. What recurses is the meta layer's instantiation
walk, an application/build-layer concern above the machine this document
and isa-core.md specify.

This monomorphization (one procedure per dispatch site, rather than a
shared procedure parametrized over type) trades code size for the DAG
guarantee, deliberately.

The bound it buys: worst-case stack depth is
`max_data_depth(type) × max_frame_size`, computable at compile time over
the dispatch call graph, consistent with isa-core.md §8.3's tight
per-call-site bound evaluated over the monomorphized DAG.

---

## 6. Encoding

`packages/codecs/src/engine/wire.ts`, the `Extension.codec` (`ExtCodec`)
that `createCodecExtension` registers. `bytecode.ts`'s
`encodeInstr`/`decodeInstr` delegate to it for every byte ≥128, as
isa-core.md §5.1 requires. This section fixes the layout *rules*; `wire.ts`
is the source of truth for the derived byte values, whose bases are
computed from band widths rather than hand-copied here (§6.4).

### 6.1 Opcode-space skew

isa-core.md §5.1 gives the core the low 128 codes and the extension the top
128. Within that half, this extension's ops skew longer on average than the
core's: `CALL_CODEC` carries `codec_idx` plus `ref` at minimum, `ENTER`
carries `dst, src, ref`. That trade is acceptable because delegation
dominates real codec bodies (§8.1, §8.2): a smaller number of frequent,
still-not-tiny ops, rather than the core's evenly-spread
arithmetic/comparison combo space. The original 15 opcodes assigned 119 of
128 codes; `WRITE_SEQ`/`READ_SEQ` (§3.5) spend the remaining 9, so all 128
are assigned with nothing left to economize.

### 6.2 Literal-ref segmentation

Handle/field/variant refs on `ENTER`/`CALL_CODEC` are small integers in
practice, since few structs have more than a handful of fields. The same
"segment the common case into the opcode itself" principle isa-core.md
applies to comparison's zero-immediate (§4.2) and `CONST`'s small values
(§4.4) applies here: a short literal-offset form reaches the first `N`
fields of the handle's referenced type directly, escaping to an extended
LEB128 form beyond that.

`N = 4`, the same threshold §2.1/§2.2 use for "typically < 4" handle and
iterator IDs. Every struct and union in `packages/example`'s
`TelemetryPacket` schema, the one real schema this project measures
against, has ≤4 fields or variants. A wider corpus could justify raising
`N` later; nothing about the compact/extended split requires it stay 4.

### 6.3 Effect declarations

Every opcode above supplies the `ExtOpEffect` isa-core.md §11.2 requires
(`packages/machine/src/extension.ts`) before it can be validated or
executed:

| Class | `tosDelta` | `maxTransient` | `terminates` | call-shaped |
|---|---|---|---|---|
| `READ`/`WRITE`/`HAS_NEXT`/`CLONE_*`/`SEEK` | 0 | 0 | no | no |
| `ENTER`/`ENTER_NEXT` | 0 | 0 | no | no |
| `LOAD_VAL`/`STORE_VAL`/`COUNT`/`TAG`/`OPEN_LIST` | 0 | 0 | no | no |
| `CALL_CODEC`/`CALL_CODEC_NEXT` | `−stackArgsOf(argCount)`, popping the pushed argument block as `CALL` does | 0 | no | **yes**: `calleeOperandIndex` is the `codec_idx` operand, `argCount` from the invoked codec's header |
| `WRITE_SEQ`/`READ_SEQ` (§3.5) | 0 | 0 | no | no |

None of the non-call ops touch TOS: they operate on the handle/iterator ID
space and `acc`, never pushing or popping. `CALL_CODEC`'s `tosDelta` is
what makes `validate.ts` account for the pushed-argument block exactly like
a plain `CALL` (`stackArgsOf`, mirroring isa-core.md §6), and the `call`
field folds the callee into the same `callSites` bookkeeping for §8.2/§8.3.

`WRITE`/`STORE_VAL`/`WRITE_SEQ`/`READ_SEQ` additionally set
`ExtOpEffect.readsAcc`: they declare `tosDelta: 0` yet read whatever is
already in `acc` at `exec()` time (`write(0, N, load_val(0))` lowers to
`LOAD_VAL` then `WRITE` with nothing between, `state.acc` carrying the
value across). A tree-based consumer such as `raise.ts` needs that flag to
capture the pending acc value as the op's trailing argument; `run()` reads
the real register and never needed it.

Each op also declares isa-core.md §11.2's accumulator effect.
`LOAD_VAL`/`COUNT`/`TAG`/`READ`/`HAS_NEXT` and both `CALL_CODEC` forms
*write* it. `ENTER`/`ENTER_NEXT`/`OPEN_LIST`/`CLONE_RD`/`CLONE_WR`/`SEEK`
*destroy* it: `exec()` leaves `state.acc` alone, but all six are
handle/stream work a target reaches through a helper call, where the
accumulator's own register is an argument register. Declaring it is what
keeps a lowering from carrying a value across one.

### 6.4 Byte assignment

Bands are laid out in `CODEC_OPCODES`' declared order (§3's table order),
one band per opcode, each reserving as many codes as its compact/extended
split needs. A band's base offset is the running sum of every earlier
band's width, computed once at module load in `wire.ts`. (isa-core.md's own
Appendix is hand-derived instead, because its formulas are simple enough to
re-derive by eye and its bytes are hand-assigned constants in
`bytecode.ts`; duplicating a computed base table here would just be a
second place to drift.) `N` is §6.2's threshold, 4; `WIDTHS` is
`READ`/`WRITE`'s fixed 3-way enum `{1, 2, 4}`.

One recurring shape: `ENTER`/`ENTER_NEXT`/`CLONE_RD`/`CLONE_WR` each
allocate a *fresh* handle or iterator, and every real body (§8's worked
examples, and `binary-rules.ts`'s generated code) allocates it one slot
past its source: `enter(1, 0, ref)`, `CLONE_RD 0, 1`. Each of these four
ops' compact form exploits that, encoding only `src` and deriving
`dst = src + 1`; an actual `dst != src + 1`, or `src >= N`, falls back to an
extended form with both operands spelled out.
`CALL_CODEC`/`CALL_CODEC_NEXT`'s `codec_idx` (a procedure-table index,
growing with how many distinct codecs a program has) and `SEEK`'s `delta`
(a signed offset, encoded zigzag since §5.4's LEB128 is unsigned-only)
never get a compact form; only the handle/iterator-ID operands beside them
do.

| Opcode | Width | Compact form | Extended form |
|---|---|---|---|
| `ENTER` | `N² + 1` = 17 | 1 code per `(src, ref)` pair, `src,ref < N`, `dst = src+1` implied | `dst, src, ref` all LEB128 |
| `ENTER_NEXT` | `N + 1` = 5 | 1 code per `src < N`, `dst = src+1` implied | `dst, src` both LEB128 |
| `LOAD_VAL` / `STORE_VAL` / `COUNT` / `TAG` / `OPEN_LIST` / `HAS_NEXT` | `N + 1` = 5 (each) | 1 code per `idx < N` | `idx` LEB128 |
| `READ` / `WRITE` | `N·`\|`WIDTHS`\|` + `\|`WIDTHS`\| = 15 (each) | 1 code per `(iter, width)`, `iter < N` | 1 code per `width` + `iter` LEB128; `width` is never LEB128'd |
| `CLONE_RD` / `CLONE_WR` | `N + 1` = 5 (each) | 1 code per `src < N`, `dst = src+1` implied | `src, dst` both LEB128 |
| `SEEK` | `N + 1` = 5 | 1 code per `iter < N` + `delta` zigzag-LEB128 | `iter` LEB128 + `delta` zigzag-LEB128 |
| `CALL_CODEC` | `N² + 1` = 17 | 1 code per `(src, ref)` pair + `codec_idx` LEB128 | `codec_idx, src, ref` all LEB128 |
| `CALL_CODEC_NEXT` | `N + 1` = 5 | 1 code per `src < N` + `codec_idx` LEB128 | `codec_idx, src` both LEB128 |
| `WRITE_SEQ` (§3.5) | \|`WIDTHS`\| = 3 | none | 1 code per `w`; `iter, handle` both LEB128 |
| `READ_SEQ` (§3.5) | \|`WIDTHS`\|`·2` = 6 | none | 1 code per `(w, signed)`; `iter, handle` both LEB128 |

The original 15 opcodes total 119 codes (bytes 128-246), and
`WRITE_SEQ`/`READ_SEQ` spend the remaining 9 (3 + 6), filling bytes
128-255 with nothing reserved. Neither gets a compact `iter`/`handle` form:
this op already replaces a whole per-element loop, so its per-*list* cost
of a few LEB128 bytes amortizes across every element it transfers, unlike
`READ`/`WRITE`'s per-*element* cost, and there was no codespace left for
one anyway. `count` is never an operand at all (§3.5), only `acc`.

`test/wire.test.ts` cross-checks a representative byte for every
compact/extended variant, mirroring `bytecode.test.ts`'s literal-table
approach, plus one end-to-end round trip of a real `buildCodec`-generated
program's full instruction stream.

---

## 7. Static Validation

`packages/codecs/src/engine/validate-handles.ts`. Documented here rather
than in isa-core.md because these checks ride on handle provenance, a
concept the generic core has no notion of.

### 7.1 Handle type and bounds checking

§2.4 establishes that every handle's type is statically derivable from its
provenance, so the validator reconstructs it for free during the same
call-graph DFS `validate.ts` already runs for isa-core.md §8.2/§8.3, by
threading "current handle's type" through the walk alongside the TOS-depth
accumulator. Two checks fall out:

- **Local bounds and kind check.** At every
  `ENTER`/`CALL_CODEC`/`CALL_CODEC_NEXT`, `src`'s type kind
  (struct/union/list) must support the op per §2.2's table, and `ref` must
  be in range for that type's field/variant table. This is the concrete
  form of "a handle must be entered before it's read", and its sharper
  sibling: entered against the right kind, at an index that exists.
  `WRITE_SEQ`/`READ_SEQ` (§3.5) get the same treatment for their `handle`
  operand, which must resolve to a list-kind handle, exactly as
  `COUNT`/`OPEN_LIST` do.
- **Cross-procedure consistency.** At every
  `CALL_CODEC`/`CALL_CODEC_NEXT`, the callee's declared object type (its
  `o0` type, fixed at the callee's build time and pinned like any other
  handle's, §2.4) must equal `child(src, ref)`'s statically-derived type.
  This is the check that earns its keep: a struct field typed `Foo`
  delegating to a codec built for `Bar` is silent corruption, not a
  decode-time error, and neither §8.2's acyclicity nor §8.3's depth bound
  would catch it.

Iterator validation is conservatively same-procedure-only. The runtime
allows sharing a fork across a `CALL_CODEC` boundary, but nothing built
needs that yet.

Neither check needs validator machinery beyond a semantic type tree to walk
against; docs/codec-image.md covers where that tree lives at the wire
level.

### 7.2 Resource-peak statistics: not carried

Per-resource peaks (maximum concurrent stream iterators, maximum concurrent
object handles) would generalize isa-core.md §8.3's maximum call depth, the
control-stack sizing figure computed alongside and distinctly from the
operand-stack depth bound. The premise was a target that trusts
pre-validation and pre-sizes its resource tables from published stats
alone. `computeHandlePeaks`/`computeStreamIteratorPeaks` were built and
removed once it was clear no consumer wants pre-sized iterator/handle
tables, leaving the numbers with no reader. The generic
`@ppl/machine`-level figure this would have generalized,
`validateProgram`'s `ProgramStats`, is unaffected and still available. A
future consumer needing codec-specific peaks can derive them the same way
(walking `RtlProc.header`/`ExtInstr` directly) and keep them at its own
application layer, rather than this package carrying unused surface in a
domain (§6) where compactness is the overriding goal.

---

## Appendix - Worked Examples

Notation: `LOAD rN`/`STORE rN` are move-class register ops; `OP #imm` is a
binary- or comparison-class immediate combo (result → `acc`, isa-core.md
§4.1/§4.2); `OP rN` is a register combo when the result isn't `acc`. The
recurring lesson: **fused delegation (`CALL_CODEC`) is the size win, fused
field access is not.** A real struct or union codec collapses to a handful
of `CALL_CODEC`s, far smaller than the unfused
`ENTER`+`LOAD_VAL`+`WRITE` spelling per field.

### 8.1 Struct encoder, delegating each field

`{x: u32, y: u16, flag: u8}`, encoder. Each field delegates to the number
codec its type resolves to:

```
CALL_CODEC codec_u32, o0, x
CALL_CODEC codec_u16, o0, y
CALL_CODEC codec_u8,  o0, flag
RETURN
```

The unfused spelling (`ENTER`+`LOAD_VAL`+`WRITE` per field) is 9
instructions instead of 3; fused field access alone, without delegation,
would not have closed that gap.

### 8.2 Union encoder, delegating the active variant

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
BLOCK_END                 ; the default case: no such variant
CONST #0                  ; the empty default case leaves acc dead (§8.7)
RETURN
```

The shared `RETURN` needs that producer of its own: acc crosses a dispatch
merge only when *every* case reaching it leaves it live (§8.7), and the
empty default case does not. §8.7's variant-decoder shape avoids the
question entirely by closing every case with `RETURN`.

### 8.3 LEB128 encoder: generic-core loop as a shared `CALL` target

`leb128_encode(u32 value)`, a `GENERIC`-ABI procedure (§4.1: no `o0`, still
free to use the program's `i0`), invoked by value-arg `CALL` from codec
bodies needing to emit a computed number (§8.6). Register 0 is `value`. A
u32 always emits at least one byte, so the loop must run once even when the
value starts at zero, hence the first-iteration-flag idiom (isa-core.md
§7.2):

```
CONST #1
STORE r_first          ; force first pass
LOOP
  LOAD 0                ; condition block: acc = value
  NE #0                 ; acc = (value != 0)
  OR r_first            ; OR'd with the forced first-pass flag
BLOCK_END               ; acc=0 → exit; acc≠0 → body
  CONST #0
  STORE r_first         ; clear; harmless if repeated
  LOAD 0
  AND #0x7F
  STORE r_byte
  LOAD 0
  SHR #7
  STORE 0               ; value >>= 7
  LOAD 0
  EQ #0                 ; acc = (value == 0): done after this byte?
  BR_TABLE 2            ; case 0 (more): set continuation bit; case 1 (done): none
    LOAD r_byte
    OR #0x80
    STORE r_byte
  BLOCK_END
  BLOCK_END
  LOAD r_byte
  WRITE i0, 1
BLOCK_END               ; back-edge → LOOP
RETURN
```

### 8.4 Checksum with fixup: stream forks plus `HAS_NEXT`

A reader fork walks the packet body for checksumming while a writer fork,
parked at the checksum field, is patched once the sum is known. Iterator 1
is `i0` reborn as a reader (§2.1's fork-independent-of-source-capability
point); iterator 2 only ever overwrites the placeholder byte `i0` already
appended, never advancing past it:

```
CLONE_RD 0, 1          ; reader fork at packet start (for checksumming)
CLONE_WR 0, 2          ; writer fork parked at checksum field
WRITE i0, 1            ; placeholder byte via original writer
; ...serialize rest of packet with original writer i0 (elided)...
CONST #0
STORE r_sum            ; r_sum = checksum accumulator
LOOP
  HAS_NEXT 1           ; condition block: does reader 1 have another byte?
BLOCK_END              ; acc=0 → exit; acc≠0 → body
  READ 1, 1            ; acc = next byte from reader
  ADD r_sum            ; r_sum += byte (register combo, result → acc)
BLOCK_END              ; back-edge
LOAD r_sum
WRITE 2, 1             ; emit checksum via parked writer fork
RETURN
```

### 8.5 Presence-bitmap struct: `COUNT` as presence

`{base: u8, opt1?: u8, opt2?: u8}`. Struct fields are always present in the
semantic model, so **optionality is modeled as `List<u8>` of length 0 or
1**, and `COUNT` reads directly as presence (0/1) with no dedicated
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

A union modeled as `union({empty: unit, value: T})` gets the same presence
economy from `binary-rules.ts`'s struct union-tag hoisting, with no
separate mechanism.

### 8.6 Delta-encoded `List<u32>`: computed-value delegation via generic `CALL`

First element as-is, subsequent elements as the delta from the previous one,
all LEB128. `o0` is the list handle. Each value passed to `leb128_encode`
(§8.3) is a single argument, so by isa-core.md §6 it travels via `acc` with
no `PUSH`. `RSUB` (`operand − acc`) computes the delta in one op:

```
COUNT                   ; acc = length (src=o0)
STORE r_left            ; r_left = loop counter
WRITE i0, 1             ; emit count byte (acc still holds count after STORE)
EQ #0
BR_TABLE 2
BLOCK_END               ; case 0 (non-empty): continue
  RETURN                ; case 1 (empty): done
BLOCK_END
ENTER_NEXT o1, o0       ; o1 = first element
LOAD_VAL o1
STORE r_prev            ; r_prev = baseline
LOAD r_prev
CALL leb128_encode      ; single arg, delivered via acc, no PUSH
LOAD r_left
SUB #1
STORE r_left
LOOP
  LOAD r_left
  NE #0                 ; condition block: more?
BLOCK_END               ; acc=0 → exit; acc≠0 → body
  ENTER_NEXT o1, o0     ; o1 = next element
  LOAD_VAL o1
  STORE r_cur
  LOAD r_prev
  RSUB r_cur            ; acc = r_cur − r_prev  (delta)
  CALL leb128_encode    ; delta already in acc, no PUSH
  LOAD r_cur
  STORE r_prev          ; slide baseline
  LOAD r_left
  SUB #1
  STORE r_left
BLOCK_END               ; back-edge
RETURN
```

This is the case §3.3 calls out: a delta is a computed register value, not
an object handle, so `CALL_CODEC` cannot delegate it, but a shared generic
`CALL` target can take it instead of inlining `leb128_encode` at every call
site.

### 8.7 Checksum validation and exhaustive union decoding: `TRAP`

Decoder-side counterpart of §8.4. After reading the body, recompute the
checksum and compare against the received byte; on mismatch, `TRAP`. This
is an `if`-without-`else`, so it lowers to `BR_TABLE 1` with the mismatch in
`case[0]` — the case `acc = 0` selects (isa-core.md §4.5) — and the match in
`case[1]`. `TRAP` is a terminator (§4.5), so it closes `case[0]` with no
`BLOCK_END` and no trailing `RETURN`:

```
; (assume reader fork i1 walked, checksum accumulated in r_sum, as in §8.4)
LOAD r_sum
READ 2, 1              ; acc = received checksum byte from parked writer fork
EQ r_expected          ; acc = (computed == received)
BR_TABLE 1             ; case 0 (mismatch): trap; case 1 (match): continue
  TRAP ERR_CHECKSUM    ; terminator: no BLOCK_END, no RETURN follows
; --- case 1: match, continue decode ---
; ...rest of decode...
RETURN
```

Exhaustive-union decoding puts an out-of-range tag in the default case. A
union decoder dispatches on the received tag via `BR_TABLE N` over all `N`
valid variants; `acc ≥ N` runs `case[N]`, which is the `TRAP`. Each variant
case delegates to its variant's decoder and `RETURN`s, which closes the case
so no `BLOCK_END` follows:

```
READ i0, 1             ; acc = variant tag
BR_TABLE 3             ; cases 0..2 valid; acc >= 3 selects the default case
  CALL_CODEC codec_0, o0, 0
  RETURN
  CALL_CODEC codec_1, o0, 1
  RETURN
  CALL_CODEC codec_2, o0, 2
  RETURN
  TRAP ERR_BAD_TAG     ; the default case: invalid tag, terminator
```

`ERR_CHECKSUM`/`ERR_BAD_TAG` are codec-defined high error codes
(isa-core.md §4.5), opaque to the ISA and reported to the host, which owns
stream and handle teardown and decides the response.

---

## Appendix - Deferred Design Points

- **Fused value access.** `LOAD_VAL src, ref` / `STORE_VAL src, ref`
  (enter and access a primitive child in one op) and a fused encoder
  `ENTER_ACTIVE` (§3.2). Reconsider once opcode space is measured against
  real codecs.
- **List access.** Sequential-only (§3.4) suffices for now; multipass read
  works by re-entering. `WRITE_SEQ`/`READ_SEQ` (§3.5) cover the one
  concrete call-out case so far, a bulk primitive-array transfer a target
  codegen can specialize into a raw-buffer/DMA representation. True random
  access, and any other target-specific capability, stay deferred to a
  future target-capability extension point.
- **Recursion depth bound.** §5's `max_data_depth(type) × max_frame_size`
  is derived conceptually; confirm the actual figures once concrete
  recursive schemas run through `validateProgram`'s tight §8.3 figure.
- **Optional-field convention.** §8.5's 0/1-length-`List` plus `COUNT`
  modeling suffices for the cases considered; confirm it holds across more
  realistic schemas before locking it in as the only convention.
