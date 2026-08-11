# Roadmap

Ordered by dependency, not priority. Sequencing, not design — see the
referenced files/docs for how, not just what. "Known non-blocking issues"
at the end don't fit the dependency chain.

## 1. Procedure identity and composition — Done

`packages/machine/src/ir.ts`. `proc(args, fragment)` / `declareProc`+
`defineProc` give an `IrFragment` an identity, spliceable via `${proc}`
interpolation; `ir()` resolves references by object identity, not name.
`body` (parsed AST) is lazy, so a non-standalone fragment (e.g. a bare
`case N:`) can be built and spliced before anything parses it.

## 2. Call dispatch (lowering + VM) — Done

`lower.ts`, `vm.ts`. `CALL` carries a resolved `calleeIndex`, never a bare
name. `lowerProgram(entry)` lowers on demand, assigning each newly-seen
callee the next table index before recursing (handles self-/mutual
recursion). `vm.ts`'s `CALL` recurses into `runProc` by that index.

## 3. Whole-program validator — Done

`validate.ts`. `validateProgram(program)` checks isa-core.md §8.1-§8.5
(TOS balance, call-graph acyclicity, stack-depth bound, dead-code
rejection, header/block well-formedness) and returns the *tight*
stack-depth bound (actual per-call-site depth + callee's worst case, not
the loose per-procedure-maxima sum) as a byproduct of the same DFS.

## 4. Bytecode ser/des — Done

`bytecode.ts` encodes/decodes a flat `RtlInstr[]` body, checked row-for-row
against isa-core.md's opcode table, plus extension opcodes (byte ≥128, via
`Extension.codec`). `CALL`'s own numeric encoding and the multi-procedure
program envelope landed as item 8.

Building this surfaced a real bug (since fixed): comparisons have no
`PEEK_PEEK` addressing mode (§4.2), but `rules.ts` generated one anyway and
the coverage suite accepted it — an encodable-looking node with no valid
wire form. `stackOperandRules` now gates `PEEK_PEEK` to ALU ops only;
`bytecode.ts` independently rejects it too.

## 5. `@ppl/machine` package — Done

Generic, protocol-agnostic IR/lowering/VM/bytecode/extension-hook
machinery, landed as its own package. `@ppl/core` doesn't depend on it.

## 6. Extension mechanism — Done

`extension.ts` (isa-core.md §11). `rules.ts`/`lower.ts`/`validate.ts`/
`vm.ts`/`bytecode.ts` all take an optional `Extension`: per-opcode stack
effect, DSL call resolution, VM execution, wire codec. Procedure
extension-header fields are opaque, carried through untouched.

## 7. Codec-specific extension — Done

`docs/codec-extension.md` §1-§3 implemented as `@ppl/codecs`'s own
`Extension`:

- **`engine/opcodes.ts`** — single source of truth for all 15 opcode
  mnemonics (`CodecOpcode` union + `assertNever`), so `EFFECTS`/`exec`/
  `validate-handles.ts` can't silently drift out of sync with each other.
- **`engine/codec-extension.ts`** — `createCodecExtension` implements all
  15 ops: target access (`ENTER`/`ENTER_NEXT`/`LOAD_VAL`/`STORE_VAL`/
  `COUNT`/`TAG`/`OPEN_LIST`), delegation (`CALL_CODEC`/`CALL_CODEC_NEXT`),
  and stream I/O including forks (`READ`/`WRITE`/`HAS_NEXT`/`CLONE_RD`/
  `CLONE_WR`/`SEEK`, §3.1 — a `CLONE_WR` fork may only overwrite bytes
  `i0` already wrote, never append, per §2.1). `codecRules()` is the same
  set's `ir\`...\`` DSL surface, a flat literal rule table by design (not
  data-driven — each op's own argument shape stays directly readable).
  `seek(iter, -N)`'s negative delta needed a small `@ppl/machine` addition:
  `rules.ts`'s `fold:unary:-`, an ordinary Rule producing a `Literal`
  instead of an `RtlNode`, reusing the same matcher/tiling machinery rather
  than a hand-rolled tree walk. `matcher.ts`'s new `pConst()` pattern (vs.
  plain `pLiteral()`) resolves a non-literal shape like `-4`
  (`UnaryExpression("-", Literal(4))`) through it on demand — any
  `pConst()`-typed argument benefits, not just `seek`'s. Since generalized
  to binary folding too: one `fold:binary:${ast}` rule per `OP_TABLE`
  entry (not `/`/`%` — `OP_TABLE` has no lowering for either yet at all).
  This did regress `test/coverage-sweep.test.ts`'s "flip" combo probes
  exactly as predicted (a literal-literal subexpression like `8 + 9` no
  longer keeps its compound shape, so it stopped forcing the stack-combo
  tie-break those probes exist to exercise) — fixed by switching the
  probes to a literal-op-*identifier* shape (`x + 100`), which keeps the
  same acc/tos cost delta without being foldable.
- **`engine/resolver.ts`** — `createCodecResolver` (generic, on-demand,
  memoized, cycle-safe `SemanticType -> Procedure` resolution over an
  ordered `CodecRule<Ctx>[]`) plus `buildCodec`, the thin driver over it.
  `Ctx` isn't "the direction" — direction is which rule *list* a caller
  passes (`binaryEncodeRules` vs `binaryDecodeRules`), never a threaded
  runtime flag.
- **`engine/validate-handles.ts`** — §7.1's static checks, entirely in
  `@ppl/codecs` (`validate.ts` needed no new capability — just
  `RtlProc.header` carrying each `CODEC`-ABI procedure's declared `o0`
  type, a `TypeNode`; this is a real, load-bearing use of the generic
  `header?: unknown` extension mechanism, not vestigial). `validateCodecHandles(program)`
  throws on wrong-kind/out-of-range handle access or a delegation site
  whose callee was built for the wrong type. Iterator validation is
  conservatively same-procedure-only — the runtime actually allows sharing
  a fork across a `CALL_CODEC` boundary, but nothing built needs that yet.
  §7.2's per-resource peak-usage stats (`computeHandlePeaks`/
  `computeStreamIteratorPeaks`) were built, then removed — see
  codec-extension.md §7.2 and item 8 below for why.
- **`engine/wire.ts`** — the wire-level `codec` byte encoding
  (codec-extension.md §6): `Extension.codec` (`encode`/`decode`), wired
  into `createCodecExtension`'s returned `Extension`; `bytecode.ts`'s
  `encodeInstr`/`decodeInstr` delegate to it for every `CODEC`-family
  opcode ≥128. Per-opcode compact/extended bands (isa-core.md §5.3's
  "segment the common case" philosophy) — a small handle/iterator index
  (`< 4`, §2.1/§2.2's own threshold, confirmed against `packages/example`'s
  `TelemetryPacket` schema) folds into the opcode byte itself, with
  `ENTER`/`ENTER_NEXT`/`CLONE_RD`/`CLONE_WR` additionally exploiting the
  "fresh handle/iterator lands one slot past its source" pattern real
  generated bodies actually have (`dst = src + 1` implied, only `src`
  encoded); `codec_idx` (unbounded) and `SEEK`'s `delta` (signed,
  zigzag-LEB128'd) never get a compact form. 119 of 128 codes assigned;
  codec-extension.md §6.4 has the full band table. Verified via
  `packages/codecs/test/wire.test.ts` (a representative-byte table per
  band, mirroring `bytecode.test.ts`'s own style, plus an end-to-end round
  trip of a real `buildCodec`-generated program).
- **Components**: `binary-rules.ts` (default binary wire format;
  struct union-tag hoisting up to 128 variants — the real byte/bitmap
  break-even point, see `HOIST_MAX_VARIANTS`'s comment; note "optional"
  modeled as `union({empty: unit, value: T})` gets hoisting's presence-bit
  economy for free, no separate mechanism needed), `delta-leb128.ts`
  (opt-in delta+zigzag-LEB128 `List<Integer>`), `json.ts` (encoder-only
  pretty-printer, proving direction is genuinely optional).

Proven against `packages/example`'s independently-authored
`TelemetryPacket` schema, not just hand-picked types.

**Known limit, not a bug**: a truly self-referential type resolves fine at
build time but `validateProgram` rejects the resulting recursive call
graph (§8.2's bounded-stack-depth guarantee) — recursive types aren't
expressible under this ISA yet, hand-built or DSL-authored.

**Considered and declined**: promoting `engine/` out of `@ppl/codecs`
(into `@ppl/core` or a new sibling package). `@ppl/core` has zero
dependencies and `target-cpp`/`target-js` depend on *only* it, never
`@ppl/machine`'s `Extension` machinery — moving `codec-extension.ts` (built
on `Extension`/`ExecState`/`ExtOpEffect`) into `@ppl/core` would drag that
dependency in. A new sibling package is sound in principle but premature:
`@ppl/codecs` is still the only consumer.

## 8. Multi-procedure program envelope — Done

`CALL`'s numeric encode/decode (isa-core.md §5.4: byte 99 + unbounded
LEB128 `proc_idx`, the same treatment `codec_idx` gets in codec-extension.md
§6.4) plus program-level framing — isa-core.md §5.5,
`bytecode.ts`'s `encodeProgram`/`decodeProgram`. Purely `@ppl/machine`-
generic, no codec-specific piece at all: a procedure count, then a header
row per procedure (`arg_count` + that procedure's own body byte length) up
front — a real offset table, not bodies self-framing via bracket-matching
as originally speculated — then every body concatenated in table order.
`Uint8Array.subarray` slices each procedure's exact byte range as a view
(no copy) before handing it to the existing single-body `decodeBody`, so
nothing about single-procedure encoding needed to change.

Verified via `packages/machine/test/bytecode.test.ts`'s new "program
framing" suite: exact round-trip (including an empty program), the
round-tripped program still passing `validateProgram` and actually running
correctly through a real cross-procedure `CALL`, and a direct byte-layout
check that the header table precedes every body byte, not just an
incidental result of slicing by length.

**Considered and declined:** baking resource-peak stats (max stack depth,
max concurrent handles/iterators) into this envelope, for a target that
trusts pre-validation and wants to pre-size its resource tables without
re-deriving them. Declined because nothing this project builds needs it,
and `@ppl/codecs`'s own use case (§6) wants maximum compactness — not a
few extra bytes per program for a capability with no reader.
`validateProgram`'s own `ProgramStats` stays available generically either
way; a consumer that does need pre-sized stats can pull them from there
(or derive its own codec-specific ones) and fold them into its own
application-level image instead. Same reasoning is why
`computeHandlePeaks`/`computeStreamIteratorPeaks` (item 7's
`validate-handles.ts`) were built, then removed — and the same reasoning
this envelope also applies to a procedure's own `header` (its extension
fields, isa-core.md §2.3/§11.4): dropped, never wire-encoded, since
nothing has ever needed one to survive serialization (item 10's own
finding about the codec extension's `o0` `TypeNode` specifically).

## 9. Declared default values (`@ppl/core`) — Done

Doesn't depend on (7) or (8) — this is a `@ppl/core`-only type-system
change, and item 10 depends on *this* landing, not the other way around.
Motivated by codec-image.md §3.1/§3.3 (a consumer's on-demand codegen
sometimes has no source value at all for a field only one of the two
independently-versioned schemas declares, on either the encode or the
decode path, and needs a value that travels with whichever tree does
declare it) and, per §3.2, a union with no declared default now traps on
an unrecognized incoming variant instead of silently dropping it.

Per-kind mechanism, decided (codec-image.md §4):

- **Integer** — a third constructor parameter, `integer(min, max, default
  = 0): IntegerType`, stored as `IntegerType.default: number`. `u8`/`i16`/
  etc. get default `0` for free — they already call `integer(min, max)`
  with no third argument. A field needing a non-zero default doesn't
  reuse a shared constant, it constructs its own `integer(min, max, d)`
  value — `type-graph.ts`'s own sharing model is already keyed by
  type-*object* identity, not structure, so a field wanting its own
  default already gets its own `TypeNode` for free by not sharing the
  object; no new per-slot wrapper needed. The `SemanticField = {name,
  type}` shape previously floated as a candidate for a third `default`
  member is *not* the direction taken — `struct()`/`union()` keep
  building a plain `Map<string, SemanticType>`, unchanged.
- **Unit** — none; carries no data, never needed.
- **List** — none, ever. An unfilled list is empty — not a declared
  default, the only value absence can coherently have for a list. No
  `ListType` change.
- **Struct** — none authored. Always the composition of its own fields'
  declared defaults, recursively.
- **Union** — opt-in `defaultVariant?: string` on `UnionType`, set via
  `union(def, defaultVariant?)`, restricted to naming a `unit`-valued
  variant of `def` (validated at construction — throws otherwise). Not
  mandatory: an instruction-opcode-style union (every variant `unit`, no
  natural fallback) should trap rather than silently default, and that's
  the type-tree author's own per-union decision.

`defaultValueOf(type: SemanticType): unknown` is the new recursive
function (`metamodel.ts`) that computes one: `undefined` for `unit`, the
type's own `default` for an integer, `[]` for a list, field-by-field
composition for a struct, `{variant: defaultVariant, value: undefined}`
for a union that declared one. A union that didn't, reached mid-
composition, throws — and since which defaults will ever be asked for is
fully knowable once the two trees are reconciled (codec-image.md §2), that
failure belongs at build/codegen time, not deferred to a per-message
runtime trap the way a real out-of-range value (codec-image.md §3.4) has
to be.

No shape change to `StructType.fields`/`UnionType.variants` (still plain
`Map<string, SemanticType>`) and no change to `IntegerPattern`/
`matchInteger` (a default doesn't affect matchability) — the only
metamodel surface changes are the additive `IntegerType.default` and
`UnionType.defaultVariant?`, both landed in `metamodel.ts` exactly as
designed above, plus `defaultValueOf`. Verified via
`packages/core/test/metamodel.runtime.test.ts` (default-value coverage per
kind, `union`'s construction-time validation, and composite composition
through nested structs/unions).

This did surface two real call sites that only needed an integer's
`{min, max}`, not the whole `IntegerType` (so didn't need — and, once
`default` became required, couldn't cheaply fake — a `default` they never
read): `codec-extension.ts`'s `intWireSize` (called with a bare
`IntegerMatch` witness, `binary-rules.ts`), and `target-cpp`'s
`cIntType`/`integerRef` (called with the same). All three narrowed their
parameter to `{min: number, max: number}` — a real "required more than it
used" fix the new field exposed, not a workaround.

## 10. Codec image — Done

Depends on (8) and (9) — both Done: the encoder/decoder programs are each
a whole multi-procedure `RtlProgram`, serializable via item 8's envelope,
and the type tree can now carry declared defaults per field/variant, per
codec-image.md §4/§5.

**§6/§7 (the container's own byte encoding) are implemented** —
`engine/type-tree-wire.ts` (`encodeTypeTree`/`decodeTypeTree`, §6's
postorder stack machine, quarter-split opcode space, range-list name
specification, opt-in `PUSH_REF` dedup) and `engine/codec-image.ts`
(`encodeCodecImage`/`decodeCodecImage`, §7's three-section concatenation).
One thing found only by writing the encoder, not by the design pass: §6.4
originally keyed `PUSH_REF` dedup by the *emitted bytes* of a candidate
subtree — which never matches a repeated composite's second occurrence,
since its children resolve to short backrefs the first occurrence's real
construction bytes don't have, so the two never look byte-identical even
though they're the same shape. Fixed by keying on a structural *signature*
(a pure function of shape — kind, range, field/variant names, recursively)
computed *before* deciding whether to recurse into children at all, not on
what got emitted — the wire format and `PUSH_REF`'s own encoding are
unchanged; this is purely how the encoder decides to use it. Verified via
`packages/codecs/test/type-tree-wire.test.ts` (representative exact-byte
checks per opcode family, the `_EXT` escapes, both dedup cases — same
object reused and independently-written-but-identical — and a real
TelemetryPacket-shaped schema) and `packages/codecs/test/codec-image.test.ts`
(a real `buildCodec`-built encoder/decoder pair, round-tripped through the
image container and actually *run* through the VM afterward — same rigor
item 8's own tests applied to the program envelope alone). Also needed a
small `@ppl/machine` change: `decodeProgram` now returns `{program, next}`
instead of just the program, since a container holding more than one
encoded program back-to-back has no other way to know where one ends and
the next begins — nothing about a single program is self-delimiting from
the *outside*.

Reconciliation itself (codec-image.md §2/§3 — matching a received image's
type tree against a consumer's own, independently-built one, and the four
relaxation rules that make graceful evolution work) is *not* this item's
job to implement: it has no meaning independent of a codegen that
consumes its output, so it belongs with item 12 (real target codegens),
not here — this item's own scope is the artifact itself (the type tree
it carries, and the container it sits in), which is now fully done.

Full design lives in **`docs/codec-image.md`**, not repeated here: why the
semantic type tree needs to travel between two independently-built
parties at all (one builds native code once and ships this as a portable
wire-format description; the other generates its own ser/des code on
demand against it), the name-keyed reconciliation algorithm two
independently-evolved trees need, and the four direction-crossed
relaxation rules that make graceful protocol evolution actually work.

Three things resolved along the way, footnoted here since they were
previously open items on this list:

- A procedure's `RtlProc.header` (the `o0` `TypeNode`, item 7) turns out
  not to need wire encoding at all — it's a lowering→validation handoff
  entirely internal to one `buildCodec` call, resolved before anything is
  ever serialized (codec-extension.md §2.4/§7.1).
- `GENERIC`-ABI helpers (e.g. `leb128_encode`) get their own copy per
  direction, never a shared pool — each direction's copy is doing
  genuinely different work (one encodes, the other decodes), so there
  was never much real sharing on the table; not worth the complexity for
  what little there might be. Not for now, revisit if it ever is.
- The image container's own concrete byte layout — codec-image.md §6 (a
  postorder stack machine for the type tree, with an opt-in `PUSH_REF` for
  structural dedup) and §7 (the three sections — type tree, encoder
  program, decoder program — just concatenate; each already self-frames).

**Still genuinely open:** none of the design — §2/§3/§6/§7 are all
decided, and §6/§7's implementation is this item's own remaining work,
now done. §2/§3's implementation is item 12's job, not this one's.

## 11. Core shakedown — Done

### `traits.ts` — removed

Audited, not just suspected: every concrete use anywhere in the repo
(`target-cpp`'s two emitters, `target-js`'s emitter) read exactly one
trait, `TypeNameTrait`, in exactly one shape — `traits.get(TypeNameTrait,
nodeId) ?? "T" + nodeId`. The write side (`TraitRegistry.set`, pitched as
a "cross-projection communication" channel) was never exercised by any
rule anywhere. A second planned use — coordinating a header/type-
definition generator with the actual code generator for a target — turned
out unneeded: those two are far more tightly coupled than a decoupled
annotation channel would help with. `packages/core/src/traits.ts` is gone.

Names are first-class instead, for a reason beyond what traits ever
served: an application author overriding *where* their own custom codec
applies needs to say "the type declared as `Timestamp`, wherever it
occurs" without spelling out that type's full structural shape as a
pattern. `metamodel.ts`'s `named()`/`nameOf()` attach/read a name directly
on the type object (one well-known symbol, no bag, no `extractTraits`
pass); `matcher.ts` gained one new pattern, `pNamed(name, inner?)`,
matched against that same name — checked before any thunk dereferencing,
since a recursive type's name lives on the thunk itself. `runRuleset`/
`Rule.produce` dropped their `traits: TraitRegistry` parameter entirely —
nothing else in the whole codebase ever read or wrote one; a `produce`
callback that wants a node's name now reads
`nameOf(graph.nodes.get(nodeId)!.source)` directly. `target-cpp`'s two
emitters and `target-js`'s emitter were updated to the same pattern.
Tests: `packages/core/test/projection.runtime.test.ts`'s "First-class
names" section (`named`/`nameOf`, `pNamed` matching with and without an
inner pattern, the override-ahead-of-a-generic-rule case).

Confirms something already suspected but worth stating plainly: a type's
own declared name and codec-image.md §6.3's *field/variant* names are
different namespaces. Field/variant names travel in the image because
reconciliation matches by them (§2.1). A type's own name is a pure local,
build-time convenience — codegen labeling, and now rule-matching — and
never needs to cross the wire. No change to §6/§7 followed from this.

### Direct-access target mapping for primitive arrays — `WRITE_SEQ`/`READ_SEQ` implemented

The one "weird feature" with a concrete case behind it, not just a
wishlist entry: when a protocol carries raw binary data or a sample
stream (a `List<Integer>`), the ability to hand a target's own buffer
management system a raw slice — enabling zero-copy or DMA access — can
make or break a high-performance system.

**The mechanism: two new codec opcodes**, `WRITE_SEQ`/`READ_SEQ`
(docs/codec-extension.md §3.5) — a bulk transfer of `count` elements
between a stream iterator and a list handle's storage, replacing the
per-element `call_codec_next` loop `binary-rules.ts`'s generic list rule
otherwise generates even for a plain `List<Integer>`.

- `write_seq(iter, handle, width, count)` — encode. `count` elements,
  each `width` bytes, taken from `handle`'s own array storage (index
  `0..count-1`) and written to `iter`. No sign handling needed, same as
  plain `WRITE` — masking a JS number's low bytes already produces the
  correct wire pattern regardless of sign.
- `read_seq(iter, handle, width, signed, count)` — decode. `count`
  elements read from `iter`, sign-extended per `signed` via a
  `signExtend(bits, raw)` helper factored out of `STORE_VAL`'s own
  `toHostNumber` (codec-extension.ts) — that op only ever has
  `width`/`signed`, never a full `IntegerType`, to work with — appended
  into `handle`'s array storage.

Both `width` and `signed` are plain operands, computed once at codegen
time from the element's declared range — same choice `WRITE`/`READ`
already made.

**`count` is read from `acc`, deliberately not baked into the
instruction's own operands** — two reasons, not one: it keeps the op
itself convention-agnostic about *how* a list's length is encoded on the
wire (fixed-width prefix, LEB128, delta-coded, whatever a given codec rule
wants), and it guarantees the stream iterator is sitting at exactly the
first element's byte when the op runs — nothing about length-prefix I/O
is bundled into it. That second property is what makes it usable as a
snatch point at all. `OPEN_LIST` still runs first on the decode side —
`read_seq` only fills an already-opened list, it doesn't allocate one. In
the DSL, `count` is the one dynamic argument (`codecRules()`'s
`pRtl("acc")` demand, mirroring `write`'s own value argument, *not* a
`pConst()` literal like every other argument here) — `ExtInstr.operands`
for `WRITE_SEQ`/`READ_SEQ` is `[iter, handle, width]`/`[iter, handle,
width, signed]` only, `count` never included. `wire.ts`'s own encode/decode
`Band`s originally assumed a 4th/5th `count` operand that never actually
exists — a real bug (`encodeLeb128: undefined is not a u32` the moment a
real program's `WRITE_SEQ`/`READ_SEQ` instruction was wire-encoded, caught
by item 12's `resolveProcedureTypes` shakedown, which was the first thing
to round-trip such a program through `bytecode.ts`) — fixed alongside
item 12's own writeup.

**Generic semantics first, native specialization only at codegen time.**
`exec()`'s own implementation of these two ops (`codec-extension.ts`) is
always "count plain element transfers, in a loop" — always correct, so
`validateProgram`/`run` need no target-codegen awareness at all, and a
program using these ops is fully interpretable and testable exactly like
every other op. Recognition/specialization into a raw-buffer/DMA copy is
`raise.ts`'s job (item 12, still "sketched, not verified" — unaffected by
this addition, since the fallback path for an op nothing recognizes *is*
the dumb pump loop these ops already implement).

Also benefits the non-exotic case: `binary-rules.ts`'s default codec
now uses `write_seq`/`read_seq` for every `List<Integer>` unconditionally
(`listOfIntegerEncodeRule`/`listOfIntegerDecodeRule`, preempting the
generic `pList(pStar())` rule for this one element shape) — one op to
recognize and specialize instead of a per-element `call_codec_next` loop,
even before any target opts a field into the exotic direct-access
representation.

**Implemented**: `opcodes.ts` (vocabulary), `codec-extension.ts`
(`EFFECTS`, `exec()`, `codecRules()`'s `write_seq`/`read_seq` DSL rules,
the `signExtend` helper), `validate-handles.ts` (list-typed handle check,
iterator capability check), `wire.ts` (`writeSeqBand`/`readSeqBand` — `w`
alone folds into the opcode byte for `WRITE_SEQ` (3 codes), `w × signed`
for `READ_SEQ` (6 codes), filling the extension's last 9 reserved codes
exactly — 128/128 now assigned; `iter`/`handle`/`count` always LEB128'd,
no compact form, since this op's cost already amortizes across a whole
list rather than paying per element), `binary-rules.ts` (the default
`List<Integer>` rule). Tests:
`packages/codecs/test/write-seq-read-seq.test.ts` (DSL + VM execution,
sign extension, `validateCodecHandles` checks, the default-codec
integration and its struct-element fallback), plus `wire.test.ts`'s
extended byte table and full-128-codes budget check.

**Still item 12's job, not this one**: the target-type-mapping
composability system itself (the "regular baseline + selectively-opted
special representations" vision) and the actual `raise.ts` pattern match
that would recognize `WRITE_SEQ`/`READ_SEQ` and emit a raw-buffer/DMA
version for a target that's opted in. This item only built the snatch
point; choosing what to do with it is real target-codegen work.

### Reconciliation algorithm (docs/codec-image.md §2/§3) — implemented

Previously scoped under item 12 on the reasoning that it "has no meaning
independent of a codegen consuming it." Revisited: that's true of its
*output*, not of the algorithm computing it — exactly the same relationship
`raise.ts` has to a target's own emitter. It's target-independent (pure
spec: kind checks, name-matching, the four relaxation rules), so it lives
here, next to `type-tree-wire.ts`/`codec-image.ts`, not deferred into item
12.

`packages/codecs/src/engine/reconcile.ts` — `reconcile(imageRoot,
localRoot): Correspondence`, a lock-step walk of two ordinary `TypeNode`
graphs (the decoded image tree's own graph, and the consumer's local one)
producing a bidirectional `"matched"`/`"image-only"`/`"local-only"` tree;
`resolve(parent, edge, direction): Resolution`, the separate, direction-
*aware* step applying §3's rules (`bridge`/`drop`/`default`/`trap`) to one
edge. Kept apart because the tree shape doesn't depend on direction, only
its interpretation does (docs/codec-image.md §2.4 has the full design,
including the one real correctness subtlety found while building this: a
union variant is *not* an always-present slot the way a struct field is,
so only two of `resolve`'s four (extra-side × direction) combinations for
a variant are ever reachable — the other two get a fifth `Resolution`
case, `"unreachable"`, rather than a silently-fabricated `drop`/`default`
for a codegen branch that can never execute).

`Correspondence` deliberately carries no name of its own — struct fields
and union variants are `{name, correspondence}` edges hanging off
`.children`, mirroring `type-graph.ts`'s own `TypeEdge {step, target}`
split. Caught by a test before it shipped: an earlier draft put `.name`
directly on `Correspondence`, which silently broke identity-sharing for
both genuine cycles *and* unrelated positions that happen to reuse the
same shared type object — a cyclic back-edge (or a second sibling field
typed as the same constant) returned the ancestor's own name instead of
the edge's own. Moving name off the node, onto the edge — exactly why
`TypeNode` itself carries no name — fixed it without losing the identity-
sharing that makes a cyclic/shared position return the same
`Correspondence` object a caller may already have elsewhere (useful for a
codegen wanting to monomorphize one procedure per distinct pair, the same
way `resolver.ts` already does via `TypeNode` identity).

Tests: `packages/codecs/test/reconcile.test.ts` — matched/image-only/
local-only walks, §2.2's kind-mismatch rejection, cycle safety on the
local side, the image side, and both sides mutually, the sibling-sharing
regression above, and all eight cells of §2.4's resolve() table (six real
rules, two `unreachable`).

## 12. Real target codegens

Depends on (7)-(10) for the codec-specific pieces. `target-cpp`/
`target-js` are rushed stubs today.

### JS/TS type codegen — composable, engine/components split — implemented

`target-js` rebuilt onto the same `{pattern, produce}`-with-swappable-rule-
list shape `@ppl/codecs` established, and split into `engine/` (the
generic `TsRule`/`createTsResolver`/`projectTSTypes`/`emitTSDeclarations`
primitive, no opinion on representation) vs `components/` (the concrete,
swappable rule libraries), mirroring `@ppl/codecs/src/engine` vs
`src/components` exactly. `target-cpp` still runs on the older `Rule<C>`/
`runRuleset` primitive (`@ppl/core/projection.ts`), unchanged — this item
is JS/TS only so far.

`components/ts-emitter.ts` is the default mapping (`tsTypeRules`);
`components/ts-alternative-rules.ts` adds opt-in alternatives an app author
can prepend for specific shapes: unit-as-`undefined`, integer-as-`bigint`
past `Number`'s safe range, byte-list-as-`Uint8Array`, capacity-≤1-list-as-
optional, general-union-as-class-hierarchy, struct-as-class. One new
`@ppl/core` primitive fell out of this: `optional(T)`
(`metamodel.ts`) — sugar for `union({value: T, empty: unit}, "empty")`,
the exact shape `target-cpp/cpp-emitter.ts`'s existing `std::optional<T>`
rule already matches by name; `optionalUnionRule` in
`ts-alternative-rules.ts` matches the same shape, so a schema authored with
`optional(T)` gets a matching idiomatic representation on both targets for
free. Codec (encoder/decoder) generation for JS/TS was still the
`generateJsCodecs` stub at this point — see the compiled-codegen section
below, where it stops being one.

### `resolveProcedureTypes` — recovering per-procedure types without `header`

Groundwork for the still-pending real codec codegen (below): a raised
(`raise.ts`) `ENTER`'s `ref` operand is a bare positional index into a
struct/union's field/variant table — meaningless to a target backend
without knowing *which* type that procedure handles. `createCodecResolver`
stamps that onto each `Procedure.header`, but `header` doesn't survive a
program that didn't come from a fresh, in-process `buildCodec` call — a
codec image decoded off the wire, or any program round-tripped through
`bytecode.ts`, always comes back with `header: undefined`
(bytecode.ts §5.5). `packages/codecs/src/engine/procedure-types.ts`'s
`resolveProcedureTypes(program, rootType)` recovers it anyway: a recursive
descent from the known root (always supplied externally, regardless of
where the `RtlProgram` itself came from) over `ENTER`/`ENTER_NEXT`/
`CALL_CODEC`/`CALL_CODEC_NEXT`, replaying `computeChild`/`computeNext`'s
own navigation at the type level. One shared, target-independent
primitive — needed by both the compiled-source codegen (a fixed local
schema) and the dynamic image-bridging path (reconcile/resolve, item 11),
not two independently-derived mechanisms.

Building this (and its test suite, which round-trips real programs
through `bytecode.ts` to prove header-independence) surfaced two real,
pre-existing bugs, unrelated to raise.ts and caught only because nothing
had exercised these specific combinations before:

- **`binary-rules.ts`'s `classifyHoistableFields` broke on a
  self-referential hoistable union field.** It called
  `derefType`/`concreteKindOf` directly on a struct field's raw
  (possibly-thunk) type; for a recursive schema, that re-invokes the
  thunk fresh, producing variant-payload objects never registered in
  `TypeGraph`'s cycle-safe identity map, so a later `resolve()` on one of
  them threw "not reachable." Fixed by reading the field's type off
  `resolve(f.type, ctx).header` (the real `TypeNode`, resolver.ts) instead
  of re-deriving it — the same class of bug, and the same fix shape
  (route through the graph's own canonical nodes, never re-invoke a
  thunk directly), `resolveProcedureTypes` itself needed one level down
  (see its own file header).
- **`wire.ts`'s `WRITE_SEQ`/`READ_SEQ` `Band`s wire-encoded a `count`
  operand that was never real.** `count` is a `pRtl("acc")` DSL demand
  (item 11's own writeup, now corrected) — never part of
  `ExtInstr.operands` — but `writeSeqBand`/`readSeqBand` assumed a 4th/5th
  operand slot for it, throwing `encodeLeb128: undefined is not a u32`
  the moment a real program's `WRITE_SEQ`/`READ_SEQ` instruction was
  actually wire-encoded. `wire.test.ts`'s own hand-written fixtures
  shared the same wrong assumption, self-consistently, which is how this
  stayed hidden — nothing had round-tripped a *real*, `buildCodec`-built
  program containing one of these opcodes through `bytecode.ts` before.

A target codegen that consumes a codec image (item 10) also needs
codec-image.md §2/§3 — the name-keyed reconciliation algorithm and its
four relaxation rules — since that's precisely what turns "here's an
image" into "here's the native accessor code bridging it to my own
schema." That algorithm is now implemented (item 11's
`packages/codecs/src/engine/reconcile.ts`, target-independent — see item
11's own writeup) — what's still this item's own job is a real codegen
actually *calling* `reconcile()`/`resolve()` and turning the result into
native accessor code for a specific target.

### `raise.ts` shakedown — verified, two bugs found and fixed

`raiseProgram`/`raiseProc` (`packages/machine/src/raise.ts`) — the
structural inverse of `lower.ts`: flat `RtlInstr[]` back to a `Stmt`/`Expr`
tree both targets can walk instead of independently re-deriving block
structure. Had zero consumers and zero tests before now — "sketched, not
verified." `packages/machine/test/raise.test.ts` is a differential check,
not a shape check: lower + `run()` via the real VM (ground truth), then
raise + evaluate the same procedure via a tiny tree-walking evaluator built
on `vm.ts`'s own exported opcode semantics (`evalBinary`/`evalUnary`, newly
exported for exactly this reuse), asserting the two agree — across most of
`e2e.test.ts`'s own proven (source, expected) corpus plus dedicated `CALL`/
`EXT` fixtures, including hand-built `RtlProgram`s for `EXT` shapes no DSL
syntax reaches.

Two real bugs surfaced and fixed, not just documented:
- **Top-level fall-off crash**: a procedure body that's *entirely* an
  if/else where both branches return (nothing follows, and lower.ts
  correctly omits any trailing instruction since the VM never falls
  through a terminating case) made `blockBody()`'s loop try to read past
  the true end of the instruction array and throw. Every *nested* block
  always gets a real closing `BLOCK_END` (confirmed by inspecting actual
  lowered bytecode) — only the outermost procedure body can legitimately
  run off the end, so that case is now a clean block-end, not an error.
- **Multi-result `EXT` ran its side effect N times instead of once**: the
  `tosDelta > 0` branch modeled "one call producing N stack results" as N
  separate same-shaped `Expr["ext"]` nodes — correct only if the op is a
  pure function of its inputs, wrong for anything with a real side effect.
  First fixed with a new `Stmt` variant, `extMulti`, that called once and
  landed all N results directly — then, once the codec codegen work
  (below) made clear that `tosDelta > 0` is unreachable by *any* real
  extension (rules.ts's `leafNode`/`unaryNode`, and every extension's own
  `rules()`, only ever build a call-like node with one `output` location —
  there's no DSL surface for "this call names two new locals at once"),
  `extMulti` was removed outright: `raise.ts` now throws on
  `tosDelta > 0` instead of carrying a second `Stmt` shape to represent a
  case nothing can construct.

`EXT` is still an approximation in one sense: a generic `ExtOpEffect` gives
a net `tosDelta`, not a full input/output arity split, so an op with
multiple discrete *inputs* still can't be decomposed further than "some
inputs, one opaque shape" — not a real gap today (every real op's inputs
are either popped operands or `readsAcc`'s single implicit one).

### JS compiled-source codec codegen — implemented, three more `raise.ts` bugs found

`generateJsCodecs`/`generateCodecModule`
(`packages/target-js/src/engine/codec-module.ts`, on top of
`engine/codec-codegen.ts`'s per-procedure tree walk, `engine/line-builder.ts`'s
indenting output, and `engine/codec-type-nav.ts`'s `TypeNode` helpers) turns
a `buildCodec`-produced `RtlProgram` pair into literal TypeScript source —
one real `function` per procedure, real `if`/`while`/`switch`, direct
calls between the generated functions — instead of shipping the RTL
program and interpreting it. Built directly on `raise.ts` (control-flow
shape) and `resolveProcedureTypes`/`resolveHandleTypes` (turning a raised
`ENTER`'s bare `ref` into a real field/variant *name*, statically, at
generation time). `packages/target-js/src/runtime/codec-runtime.ts` is the
small set of genuinely-dynamic primitives the generated code calls into
(buffer position, byte read/write, the `(container, key)` indirection a
decoder needs) — everything else `codec-extension.ts`'s interpreter does
at runtime (schema-edge lookup, opcode dispatch) is resolved once, at
generation time, and baked into the call site directly. Scope is any
program built from the 17 codec-extension opcodes, not just the binary
family — `delta-leb128.ts`/`json.ts`/a user's own `CodecRule`s all compile
to the same opcode vocabulary via `codecRules()`.

`procedure-types.ts` gained `resolveHandleTypes`/`childNode`/`nextNode`
(exported, previously private to `resolveProcedureTypes`'s own walk) —
the codegen needs the same per-instruction navigation, but interleaved
with its own code emission over the *raised* tree rather than run once
over the flat pre-raise body, so it couldn't just call
`resolveProcedureTypes` and reuse the result.

Building this — specifically, actually running the generated code against
real schemas and diffing against the interpreted path
(`target-js/test/codec-codegen.runtime.test.ts`) — surfaced three more
real `raise.ts` bugs, none caught by item 12's own shakedown because none
of its fixtures had these specific shapes:

- **A whole class of EXT ops that read pre-existing `acc` as an implicit
  extra input lost that input entirely.** `WRITE`/`STORE_VAL`/`WRITE_SEQ`/
  `READ_SEQ` (codec-extension.ts) all declare `tosDelta: 0` but actually
  read whatever's already in `acc` at `exec()` time — e.g.
  `write(0, N, load_val(0))` lowers to `LOAD_VAL` then `WRITE` with
  nothing in between, `state.acc` carrying the value across. `raise.ts`'s
  EXT case modeled an op's real inputs as *only* its `-tosDelta` popped
  stack values, so this implicit read was silently dropped — confirmed by
  raising a real integer-encode leaf and finding `WRITE`'s `args` empty.
  Fixed with a new `ExtOpEffect.readsAcc` flag (`extension.ts`): when set,
  raise.ts captures the pending acc value as the op's own trailing `args`
  entry instead of killing it, and the four codec ops that need it are
  now marked. `run()` itself was never affected (it reads the real
  register directly) — this only mattered for a tree-based consumer.
- **A truly empty procedure body crashed instead of returning 0.** A bare
  `return;` with nothing before it (`unitRule`'s own generated procedure —
  an empty `ir\`\`` fragment, `return;` appended by `resolver.ts`'s
  `ensureTerminated`) is legal: `vm.ts`'s `runProc` seeds `let acc = 0` at
  the start of every call, so a bare return there really does return 0.
  `raise.ts` modeled "no value tracked yet" as `undefined` and threw on
  reading it. Fixed by seeding the Raiser's initial acc to a pure `const 0`
  instead.
- **A pending, unflushed side-effecting value right before a `LOOP` was
  silently dropped.** `listEncodeRule`'s own body is
  `write(0, W, left); while (left != 0) { ... }` — the `WRITE` call
  produces a pending (impure) acc value that nothing consumes before the
  loop starts. Every *other* "acc is about to become untrustworthy" point
  in `raise.ts` goes through `killAcc()` (flush first if impure); `LOOP`'s
  own handling did a raw `this.acc = undefined` instead, discarding the
  pending `WRITE` statement outright — confirmed by a generated
  `encode_proc` missing its list length-prefix write entirely. Fixed by
  routing it through `killAcc()` like everywhere else.

Both bugs from item 12's own writeup plus these three now bring `raise.ts`
to five found-by-actually-using-it fixes total — each one a real gap no
amount of re-reading the code surfaced, only exercising it against real
programs did.

## 13. Futher ideas

- crypto extension: new handle space, openssl like api, could cover CRCs, fixed and variable length hashes (shake) and aead as well, data I/O via stream iterators
- better dsl syntax for accessing handles: like stream[0].read/write or some declaration-like syntax (could also allow handle index allocations to be delegated to the lowerer, would be nice)
- small **value** space merging binary codec, e.g. union tag merged with limited range number field in one of the variants, might need some annotation/hinting/some kind of meta-argument to specify what to merge with what, becasue it favors some against the others heavily compactness-wise.
- target side transformation (unit of measurement)
- MCU JIT compiler (Generic Core → ARMv6-M, runtime-injected fragments, on-demand compile/evict/compact) — see docs/jit-armv6m.md

---

## Known non-blocking issues

**Parser, not tiling, is the bottleneck on large expressions.** At 128+
leaves, `grammer.pegjs`'s recursive-descent parser dominates wall-clock
time, not `tileExpr` (which is flat in tree width). Not investigated
further.

**`ASR` and signed comparisons (`LT_S`/`LE_S`/`GT_S`/`GE_S`) are real,
VM-implemented, ISA-documented opcodes with no DSL token.** `rules.ts`'s
`OP_TABLE` wires `>>` to `SHR` (logical) only and `<`/`<=`/`>`/`>=` to
their unsigned counterparts only — so `v < 0` is *always false* in this
DSL, a real footgun (discovered via `delta-leb128.ts`'s first draft, which
silently produced wrong output rather than erroring). Bitwise top-bit
tests (`(v & 0x80000000) != 0`) work today; wiring these up is a couple of
`rules.ts` table entries plus grammar tokens whenever a codec actually
needs true signed arithmetic instead of a masking workaround.

**`ConditionalExpression` (`?:`) parses but has no lowering rule.** Fails
at lowering time ("Failed to lower expression statement"), not parse time.
Lower priority than the above since it's a clear error, not silently wrong
output.
