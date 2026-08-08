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

## 4. Bytecode ser/des — Partially done

`bytecode.ts` encodes/decodes a flat `RtlInstr[]` body, checked row-for-row
against isa-core.md's opcode table, plus extension opcodes (byte ≥128, via
`Extension.codec`). `CALL`'s numeric encoding and the multi-procedure
program envelope moved to item 8.

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

## 7. Codec-specific extension — Mostly done

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
  `pConst()`-typed argument benefits, not just `seek`'s. Deliberately
  unary-only, not general binary constant folding (`8 + 9` staying a
  `Binary` node): `test/coverage-sweep.test.ts`'s "flip" combo probes rely
  on a literal-literal *subexpression* keeping its compound shape for a
  cost-based tie-break, so folding it away would regress 16 rule names for
  no current need.
- **`engine/resolver.ts`** — `createCodecResolver` (generic, on-demand,
  memoized, cycle-safe `SemanticType -> Procedure` resolution over an
  ordered `CodecRule<Ctx>[]`) plus `buildCodec`, the thin driver over it.
  `Ctx` isn't "the direction" — direction is which rule *list* a caller
  passes (`binaryEncodeRules` vs `binaryDecodeRules`), never a threaded
  runtime flag.
- **`engine/validate-handles.ts`** — §7.1/§7.2's static checks, entirely
  in `@ppl/codecs` (`validate.ts` needed no new capability — just
  `RtlProc.header` carrying each `CODEC`-ABI procedure's declared `o0`
  type, a `TypeNode`). `validateCodecHandles(program)` throws on
  wrong-kind/out-of-range handle access or a delegation site whose callee
  was built for the wrong type. `computeHandlePeaks`/
  `computeStreamIteratorPeaks` give per-resource peak-usage stats
  (object handles: additive across `CALL_CODEC`'s fresh frames; stream
  iterators: a flat whole-program max, since `i0`/its forks are global,
  never frame-scoped). Iterator validation is conservatively
  same-procedure-only — the runtime actually allows sharing a fork across
  a `CALL_CODEC` boundary, but nothing built needs that yet.
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

**Still open**: the wire-level `codec` byte encoding (§6) — deferred to
item 8, on purpose, until real codecs exist to measure against (they now
do).

## 8. Remaining wire framing and codec-referenced-type serdes

Two independent halves:

- **Multi-procedure program envelope** — `CALL`'s numeric encode/decode
  plus program-level framing (procedure count/offset table). Not blocked
  on anything; procedure bodies are already self-framing (bracket
  matching), so this is plausibly just a count + concatenated bodies.
  Stays `@ppl/machine`-generic.
- **Procedure header encoding + codec-referenced semantic types** —
  depends on (7) for a concrete extension header shape to encode against.
  Sketch, not a design: a **codec image** — semantic type tree, encoder
  program, decoder program (never one call graph between them, per §2.3's
  directionality rule) — living above both `@ppl/machine` and
  `@ppl/codecs`. Open question: do `GENERIC`-ABI helpers (e.g.
  `leb128_encode`) get their own copy per direction, or a shared pool?
  Not decided.

## 9. Core shakedown

Depends on (7)/(8) landing.
- Reassess `traits.ts` — suspected unused bloat; confirm and justify or
  remove.
- Design the "weird" features properly (wishlist-level today): e.g. a
  target type mapping forcing raw packet accessors instead of
  element-by-element codec work.

## 10. Real target codegens

Depends on (7)-(9) for the codec-specific pieces. `target-cpp`/
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
