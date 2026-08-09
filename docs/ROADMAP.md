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

## 10. Codec image — Designed, not implemented

Depends on (8) and (9) — both Done: the encoder/decoder programs are each
a whole multi-procedure `RtlProgram`, serializable via item 8's envelope,
and the type tree can now carry declared defaults per field/variant, per
codec-image.md §4/§5.

Full design lives in **`docs/codec-image.md`**, not repeated here: why the
semantic type tree needs to travel between two independently-built
parties at all (one builds native code once and ships this as a portable
wire-format description; the other generates its own ser/des code on
demand against it), the name-keyed reconciliation algorithm two
independently-evolved trees need, and the four direction-crossed
relaxation rules that make graceful protocol evolution actually work.

Two things resolved along the way, footnoted here since they were
previously open items on this list: a procedure's `RtlProc.header` (the
`o0` `TypeNode`, item 7) turns out not to need wire encoding at all — it's
a lowering→validation handoff entirely internal to one `buildCodec` call,
resolved before anything is ever serialized (codec-extension.md §2.4/
§7.1). **Still genuinely open:** the image container's own concrete byte
layout (deferred the same "measure real cases first" way §6 was, until
(9) lands and real defaults exist to measure against), and whether
`GENERIC`-ABI helpers (e.g. `leb128_encode`) get their own copy per
direction inside one image, or a shared pool.

## 11. Core shakedown — Not started, no hard dependency

- Reassess `traits.ts` — suspected unused bloat; confirm and justify or
  remove. Purely an audit; doesn't need anything else on this list to
  land first, and could happen anytime.
- Design the "weird" features properly (wishlist-level today): e.g. a
  target type mapping forcing raw packet accessors instead of
  element-by-element codec work.

## 12. Real target codegens

Depends on (7)-(10) for the codec-specific pieces. `target-cpp`/
`target-js` are rushed stubs today.

**Sketched, not verified** (`packages/machine/src/raise.ts`) —
`raiseProgram`/`raiseProc`, the structural inverse of `lower.ts`: flat
`RtlInstr[]` back to a `Stmt`/`Expr` tree both targets can walk instead of
independently re-deriving block structure. Lives in `@ppl/machine` since
it's target-language-agnostic. Every stack write materializes into a named
slot immediately (no deferred/inlined substitution — that needs an
interference analysis this doesn't attempt); trivially correct, costs
nothing a target's own copy propagation won't fold back away.

Two gaps: `EXT` raises only approximately (a generic `ExtOpEffect` gives a
net `tosDelta`, not an input/output arity split); and this is unverified
against real fixtures — reasoned by hand, not yet run against
`packages/machine/test` or any real target consumer.

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
