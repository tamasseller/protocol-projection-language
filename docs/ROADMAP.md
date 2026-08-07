# Roadmap

Ordered by dependency, not by priority — each numbered phase blocks the
ones after it unless marked otherwise. This is a sequencing document, not
a design doc: each item names the concrete gap and what it depends on: it
does not commit to *how* it'll be solved. Known non-blocking issues that
don't fit the dependency chain are listed separately at the end.

## 1. Procedure identity and composition

**Done** (`packages/machine/src/ir.ts`). A `Procedure` (`proc(args,
fragment)`) gives an `IrFragment` the identity needed to be referenced —
via `${otherProc}` interpolation — as a call target from another
`ir\`...\`` fragment; `ir()` splices the reference by its pre-minted
synthetic name and records it in the fragment's `calls` map, resolved by
object identity rather than a name the author keeps in sync by hand.
`ir\`...\`` also splices an `IrFragment` or `IrFragment[]` value directly —
inlining its `source` (recursively) and merging its `calls` — which is how
independently-built fragments (e.g. one per element of a compile-time-
computed collection) combine; names are identity-derived and never
collide regardless of how many fragments end up referencing the same
`Procedure`. `body` (the parsed AST) is computed lazily, on first access,
specifically so a sub-fragment that isn't valid Program text on its own
(e.g. a bare `case N: ...` clause, only meaningful once embedded in a
`switch`) can still be built and spliced before anything tries to parse it
standalone.

## 2. Call dispatch (lowering + VM)

**Done** (`packages/machine/src/lower.ts`, `vm.ts`). `RtlInstr`'s `CALL`
carries a resolved `calleeIndex: number`, never a bare name.
`lowerProgram(entry)` lowers `entry` and every `Procedure` it transitively
calls in one on-demand pass — the first time a `CALL` to a not-yet-seen
`Procedure` is hit, that procedure is assigned the next free table index
and lowered right there, recursively, with the index reserved before
recursing so a self-/mutually-recursive reference resolves rather than
re-entering. `vm.ts`'s `CALL` case is a nested recursive call to `runProc`
against the resolved index.

## 3. Whole-program validator

**Done** (`packages/machine/src/validate.ts`). `validateProgram(program)`
checks all five of isa-core.md §8's static guarantees — TOS balance
(§8.1), call-graph acyclicity (§8.2), the stack-depth bound (§8.3),
dead-code rejection (§8.4), header/block well-formedness (§8.5) — over an
assembled multi-procedure program, and returns the per-procedure local
peak and whole-program stack-depth figures (§8.3) as a byproduct of the
same DFS that proves §8.2 acyclicity. The bound returned is the *tight*
one (each call site's actual depth plus the callee's own worst case, not
the loose sum of per-procedure maxima along the longest chain) — see §8.3
for why that distinction matters for a "dumb" MCU JIT consuming the
figure. These figures are a validator return value only, never written
into the wire-format program image.

## 4. Bytecode ser/des

**The instruction-stream body codec is done** (`bytecode.ts`,
`test/bytecode.test.ts`) — `encodeBody`/`decodeBody` turn a flat
`RtlInstr[]` into bytes and back, checked against isa-core.md's Appendix —
Opcode Table row for row (all 124 assigned + 4 reserved byte values),
plus LEB128 round-trips and every small/extended boundary (`CONST`,
comparison `#0`, `BR_TABLE` 1/2-case, `TRAP` code-0). `encoding.ts` is
unrelated and unchanged — a relative cost estimate for the lowerer's own
candidate comparison, not a real codec. Extension opcodes (byte ≥128) are
also done, dispatching to `Extension.codec` (§11) when one is registered.

`CALL`'s own numeric encode/decode and the multi-procedure program
envelope (header framing, procedure-table framing) remain unimplemented —
tracked under (8) now, not here; see (8) for why, and for what's actually
left.

Building this now (rather than waiting) is what surfaced a real
correctness bug, since fixed: §4.2 gives comparisons exactly 4 addressing
combos (register/pop/immediate-small/immediate-extended, all → `acc`)
with no peek mode, but `rules.ts` generated a `PEEK_PEEK` candidate for
comparisons unconditionally, and the rule-coverage suite asserted it as
correct — an RtlNode with no valid wire encoding, that nothing would have
caught until an encoder was actually written against it. `stackOperandRules`
now gates `PEEK_PEEK` to `kind === "alu"`, matching how `REG_REG`
write-back was already gated; comparisons needing `"tos"` for two
compound operands fall back to `POP_ACC` (→ acc) plus an explicit `PUSH`,
the same two-instruction shape `immOperandRules`' own `"tos"` variant
already uses. `bytecode.ts` also independently re-checks this at encode
time (throws on a comparison with `REG_REG`/`PEEK_PEEK`) rather than
trusting the rule generator never to regress it.

## 5. Name and relocate the ir-lowerer-vm machinery

**Done** — landed as `@ppl/machine` (`packages/machine/`), ahead of (6)
rather than strictly before it (see (6)'s own note). Contains the full
generic, protocol-agnostic bytecode compiler and VM: `ir.ts` (IR
authoring), `ast`/`east` (AST/EAST layers), `matcher`/`orchestrator`/
`rules`/`builders` (pattern-rewrite lowering), `rtl`/`lower` (RTL +
statement lowering), `validate` (whole-program validator), `vm` (the
interpreter), `bytecode`/`encoding` (wire codec + cost model), `extension`
(the generic extension hook), and the PEG grammar (`grammer.pegjs`).
`@ppl/core` no longer references any of it — the only cross-package
consumer, `@ppl/codecs`'s `ir-builder.ts`, now depends on `@ppl/machine`
directly rather than transitively through `@ppl/core`.

## 6. Extension mechanism design

**Done** (isa-core.md §11; `extension.ts`) — ahead of (5), which turned
out not to be a hard prerequisite in practice. The core opcode set
(`rtl.ts`), lowering ruleset (`rules.ts`), lowerer (`lower.ts`), validator
(`validate.ts`), VM (`vm.ts`), and bytecode codec (`bytecode.ts`) all take
an `Extension` as an optional parameter, defaulting to none. An extension
declares, per opcode: its stack effect for the validator (§11.2 — TOS
delta, peak transient depth, terminates?, call-shaped?), its DSL-side call
resolution (reusing the same mechanism `clz`/`revbits`/`trap` already use),
its VM execution, and its wire codec; a procedure's extension header
fields (§2.3) are opaque data carried through `lowerProgram` untouched.
`test/extension.test.ts` exercises the whole hook end to end with a toy
opcode. Also landed alongside this: the calling convention now passes a
callee's last argument in `acc` rather than the stack (isa-core.md §4.6,
§6) — a call-shaped extension opcode follows the same rule.

## 7. Codec-specific extension implementation

Depends on (6). The actual codec stream-I/O and codec-invocation opcodes,
likely implemented as an `Extension` (§11) inside `@ppl/codecs` — codec
semantics have no business living inside `@ppl/machine`, which stays
generic and protocol-agnostic by design (5). Specified in
`docs/codec-extension.md`. It carries its own rationale inline rather than
deferring to a companion doc; `docs/codec-extension-draft.md`, the
recovered early draft that briefly served that role, has been retired now
that its one non-redundant piece of content (the "abnormal termination
belongs to the generic core, not codec semantics" rationale) moved to
ir-engine.md, its proper home by topic — the rest of the draft's content
had been superseded by codec-extension.md without remainder.

**Partially implemented.** Two prerequisite gaps in `@ppl/machine` itself,
needed by any extension with multi-operand or call-shaped opcodes, not
codec-specific: `matcher.ts`'s builtin-call pattern generalized from
exactly one argument to N positional arguments plus an optional variadic
real-calling-convention tail (`pBuiltinCallN`); `ExecState.callProc`
(extension.ts) lets a call-shaped extension op actually invoke its
resolved callee — `vm.ts`'s `EXT` case had no such capability before.
Also fixed: `ExtOpEffect.call` carried a static per-opcode-name `argCount`,
which couldn't describe call sites invoking callees of different arity;
`validate.ts` now derives it from the resolved callee's own `argCount`
header instead, matching §6.3's "argCount from the invoked codec's header"
(this was always the documented intent, just not what the code did).

`packages/codecs/src/engine/codec-extension.ts` now implements 10 of §3's
opcodes — everything except the stream-fork class (`HAS_NEXT`/
`CLONE_RD`/`CLONE_WR`/`SEEK`, still open; nothing built so far needs more
than one straight-through `i0`) — plus `codecRules()`, that same opcode
set's `rules()` DSL surface (`Extension["rules"]`, extension.ts:107), so
codec bodies are authored as real `ir\`...\`` text instead of hand-built
`RtlInstr[]` arrays. That surface only became viable once `@ppl/machine`
gained two-phase `Procedure` construction (`declareProc`/`defineProc`,
ir.ts) — minting a `Procedure`'s identity before its fragment exists, so a
self- or mutually-recursive reference can be spliced into `ir\`...\`` text
before the thing it refers to is fully built — and a `leafRules` fix
(rules.ts) making the generic `identifier:acc`/`identifier:tos` tiling
rules decline gracefully instead of throwing when a bare identifier isn't
a local at all (reachable via any call-shaped node's unconstrained
argument-tiling, matcher.ts:283-300, not just a codec callee reference).

`packages/codecs/src/engine/builders.ts`'s `buildCodec(root, rules,
initialCtx)` is the metamodel-to-bytecode generation layer §5 always
assumed would exist — and, per review, genuinely *rule-driven* now rather
than a closed per-kind switch: an ordered `CodecRule<Ctx>[]`
(`./resolver.ts`, pattern + producer, reusing `@ppl/core`'s
`TypePattern`/`matchType` vocabulary), with the rule list itself passed in
by the caller rather than an implicit default `buildCodec` applies on its
behalf — see below and docs/ARCHITECTURE.md's "Mappings" section for why
that changed. Resolution — on-demand, memoized, cycle-safe — is one small
generic driver (`createCodecResolver`) both `buildCodec` and
`components/json.ts` are built on, not two independently hand-rolled ones;
`runRuleset` (`@ppl/core/projection.ts`)
was considered and passed over for this, since it fills its result map in
one eager top-down pass with no way to hand a not-yet-finished child a
reserved slot before a sibling embeds it into its own instruction stream —
a materially different execution model from what codec generation needs,
not a superset `runRuleset` could be stretched to cover. One real generic
optimization lives in the default struct rule — a union-typed field with
few enough variants gets its tag *hoisted* into a shared leading bitmap
instead of paying for a standalone tag byte.

`Ctx` is not "the direction" — a rule's `produce` no longer takes a
`TypeNode` or a direction value at all, and `resolve` takes a raw
`SemanticType` (resolved by its own object identity, via
`TypeGraph.nodeOf` internally) rather than a `TypeNode`. Per review: a
resolver run already commits to one direction for its *entire* walk, so a
single rule threading a runtime direction flag through every call and
re-branching on it internally was pure ceremony; `components/binary-rules.ts`
is two flat rule lists (`binaryEncodeRules`/`binaryDecodeRules`), not one
list plus a threaded value, and no rule body branches on direction
anywhere. `Ctx` stays generic because not every rule family is
direction-shaped — `components/json.ts` uses it for nesting depth instead,
where binary's rules use `void`.

Two further codecs sit alongside the defaults, both real `CodecRule`s now
rather than one-off top-level functions: `components/delta-leb128.ts`
(§8.6's delta+LEB128 `List<Integer>` encoder/decoder, as two rules —
`deltaLeb128EncodeRule`/`deltaLeb128DecodeRule` — same split as
binary-rules.ts, not one rule branching on direction) composes by being
listed ahead of the defaults in `buildCodec`'s `rules` argument — it can
preempt the generic list rule for one specific field nested inside a
larger struct, not just a standalone root — and `components/json.ts` (an
encoder-only pretty-printed JSON serializer, proving direction is
genuinely optional — nothing pairs it with a decoder) is regularized onto
the same `createCodecResolver`, just with nesting depth as its `Ctx`
instead of `void`. A dedicated test (`iso8601-demo.test.ts`) demonstrates
the rule mechanism can override representation entirely, not just add a
leaf kind: a `Timestamp`-shaped struct field inside an otherwise
length-prefixed/hoisted-tag binary wire format comes out as an embedded
ASCII string instead of two raw integers.

All of it proven against `packages/example`'s pre-existing,
independently-authored `TelemetryPacket` schema (nested struct, a
capacity-16 list of structs, a 3-variant all-unit union the hoisting
optimization picks up automatically), not just hand-picked demo types —
see `packages/example/test/codec.test.ts` and its rewritten `compose.ts`,
which generates real codecs where the retired `wire-format.ts` placeholder
used to sit.

One deliberate, discovered-not-designed limit: a genuinely self-referential
`TypeNode` graph resolves fine at generation time (the two-phase
`Procedure` split handles it), but `validateProgram` correctly rejects the
resulting recursive call graph (isa-core.md §8.2's static, bounded-stack-
depth guarantee) — a codec for a truly recursive type was never
expressible under this ISA, hand-built or DSL-authored; `codec-extension.md`
§5's "dispatch calls... can resolve to the same codec again for a
recursive type" describes a different, not-yet-built indirect-call
mechanism, not what `call_codec`'s literal-operand calls (§3.3) do today.

`@ppl/codecs` was reorganized (post-review) to keep this item's own
three-way distinction — core, components, application,
docs/ARCHITECTURE.md's "Mappings" section — visible at the package's
module boundary instead of only in prose: `src/engine/` holds the codec
`Extension` and the on-demand resolver (both layer 1, despite living here
only because nothing else needs them yet); `src/components/` holds
`binary-rules.ts` (the renamed default rule set, now two lists —
`binaryEncodeRules`/`binaryDecodeRules`, see above), `delta-leb128.ts`, and
`json.ts`, none privileged over another. `buildCodec` no longer applies
`binary-rules.ts` implicitly — a caller passes the rule set it wants, e.g.
`buildCodec(root, binaryEncodeRules, undefined)` or
`[deltaLeb128EncodeRule, ...binaryEncodeRules]` — so a different binary
format is a straightforward swap, not a patch on top of a permanent
default. A further pass (also post-review) then dropped `direction`/`node`
from every rule's `produce` and `TypeNode` from `resolve` entirely, per the
`Ctx` note above — `buildCodec`'s own signature moved from `(root:
TypeNode, direction, rules)` to `(root: SemanticType, rules, initialCtx)`
accordingly, and `@ppl/core` gained `TypeGraph.nodeOf` plus richer match
witnesses (`matcher.ts`'s `StructFieldsMatch`/`UnionFieldsMatch`/`ListMatch`
etc. now carry each child's own `SemanticType`, not just its match) to make
that possible without reimplementing `buildTypeGraph`'s own cycle-breaking
a second time inside `@ppl/codecs`.

Still open: the wire-level `codec` byte encoding (§6); §7.1/§7.2's
validator extensions, below; and, within the builder itself, anything
beyond a basic hoisting heuristic (≤4-variant unions, one shared bitmap,
no cross-optimization with e.g. presence-bitmap-style optionality, §8.5).

The validator-extension question deferred from (6) for exactly this reason
now has a concrete shape (`codec-extension.md` §7.1–§7.2, still not
implemented): reconstructing a handle's type during the same call-graph
DFS `validate.ts` already runs, to check `ENTER`/`CALL_CODEC` accesses
against the right type kind and in-bounds refs, plus cross-procedure type
consistency at delegation sites; and generalizing isa-core.md §8.3's new
call-depth figure to other named resources (stream-iterator/object-handle
peaks).

## 8. Remaining wire framing and codec-referenced-type serdes

Everything left over from (4), consolidated into one item for tracking
convenience rather than because it's all one dependency — the two halves
below don't actually share a prerequisite:

- **The multi-procedure program envelope** — `CALL`'s own numeric
  encode/decode (needs a procedure table to check indices against), and
  program-level framing (a procedure count? a table of offsets? decode-by-
  structural-bracket-matching, the way the VM itself finds a procedure's
  end?). Not blocked on anything above; ready to design now that (1)–(2)
  give it a real multi-procedure program to frame. Procedure bodies are
  already self-framing (structured control flow means bracket-matching
  finds a body's end with no length prefix needed), so this envelope is
  plausibly just a count plus concatenated bodies — it stays
  `@ppl/machine`-generic scope regardless of how the second bullet below
  resolves, since it has no notion of semantic types.
- **Procedure header encoding, and codec-referenced semantic types.**
  §2.3's procedure header is `{arg_count, ...extension fields}`; encoding
  those extension fields needs a concrete extension's header shape to
  encode *against* (isa-core.md §11.4 keeps them opaque to the generic
  core on purpose), so this half depends on (7). Once there is one, codec
  procedure headers will also need to reference semantic types from the
  metamodel (`metamodel.ts`/`type-graph.ts`) — those need their own
  serialization format, not yet designed either.

  Current sketch (not a design yet, just a shape to refine): a **codec
  image** — the actual application-facing artifact, living above
  `@ppl/machine`'s bare procedure-list envelope and probably above
  `@ppl/codecs` too, since neither layer currently owns "one shared type
  tree plus two directional programs built against it" — with three
  sections:
  - the **semantic type tree**: a single type definition (the root type)
    plus everything it transitively references, walked both by the
    validator (codec-extension.md §7.1) and by any target-mapping/codegen
    step that needs a handle's real shape to emit or validate accessor
    code against it;
  - an **encoder program** section and a **decoder program** section, each
    independently a complete multi-procedure program per the bullet above
    (own stats, own procedure list, procedure 0 = the entry codec for the
    root type) — never one call graph between them, since
    codec-extension.md §2.3's directionality rule forbids an encoder and a
    decoder from ever sharing one.

  Open sub-question this sketch doesn't resolve: `GENERIC`-ABI helpers
  (codec-extension.md §4.1's `leb128_encode`) are direction-agnostic by
  construction. If both directional programs need one, does each carry its
  own copy (simplest — every program section stays fully self-contained),
  or is there a third, shared `GENERIC`-only procedure pool between them?
  Not decided.

## 9. Core shakedown

Depends on (7)/(8) landing — do this once there's a real codec extension
to shake out issues against, not before.
- **Reassess the trait mechanism** (`traits.ts`). Currently suspected to
  be unused bloat; confirm and either justify or remove it.
- **Design in the "weird" features properly.** These are wishlist-level
  today, not designed: e.g. letting a target type mapping force direct
  raw packet accessors instead of element-by-element codec work,
  optionally triggered by the target mapping alone, without requiring the
  codec to explicitly opt in.

## 10. Real target codegens

Depends on everything above for the codec-specific pieces — `packages/
target-cpp` and `packages/target-js` currently contain rushed example
stubs, not production codegen, and redoing those for real needs (7)-(9)
stable underneath them. The generic reconstruction layer both targets sit
on doesn't share that dependency, though, so it's sketched ahead of the
rest below, same pattern as (5)/(6).

**Sketched, not yet verified** (`packages/machine/src/raise.ts`) —
`raiseProgram`/`raiseProc`, the structural inverse of `lower.ts`: turns a
flat `RtlProc.body` back into a nested `Stmt`/`Expr` tree (`dispatch`/
`loop`/`assign`/`return`/`trap` statements; `const`/`slot`/`binary`/
`unary`/`call`/`ext` expressions) that `target-cpp` and `target-js` can
both walk instead of each independently re-deriving block structure from
the flat instruction stream. Lives in `@ppl/machine`, not either target
package, because none of it is target-language-specific — it only
consumes fields `RtlInstr` already exposes generically (`op`/`combo`/
`target`/`imm`/`calleeIndex`), so reconstructing the tree once here means
a bug found fixing it doesn't need independently rediscovering in the
other target. What's left to each target individually is purely
rendering (operator/declaration syntax, integer signedness/wraparound,
procedure signatures/ABI) plus the buffer/extension glue neither target
shares with the other anyway. The reconstruction is total over any
validated program for the same reason `lower.ts`'s own output is
well-formed to begin with — the ISA's no-`goto` invariant (ir-engine.md)
means every `BR_TABLE`/`LOOP` shape maps back to exactly one `dispatch`/
`loop` shape, never an ambiguous one.

The one substantive design decision: every stack write (`PUSH`, or the
write side of a register combo) is materialized into a named slot
immediately, never forwarded/inlined at its eventual use site — a
deferred textual substitution is only sound if nothing between the write
and its use mutates a slot the deferred expression reads, and proving
that generically is a real interference analysis this module doesn't
attempt. Materializing every write uniformly is trivially correct (it's
the array-of-slots machine's own snapshot semantics, just named instead
of indexed) and costs nothing a target compiler's own copy propagation
won't fold back away wherever it's actually safe to.

Two gaps, not yet resolved:
- `EXT` can only be raised approximately, from a generic `ExtOpEffect`:
  it declares a net `tosDelta`, not an input/output arity split, so an op
  with multiple discrete inputs *and* outputs at once can't be
  decomposed correctly — only the common one-value-in-or-out shapes raise
  exactly right. Doing better needs a richer per-op contract than
  `extension.ts` currently declares.
- Unverified against real fixtures — written and reasoned through by
  hand against `rtl.ts`/`vm.ts`'s own semantics, not yet run against
  `packages/machine/test`'s existing lowering fixtures or exercised by
  any actual `target-cpp`/`target-js` consumer.

---

## Known non-blocking issues

Don't fit the dependency chain above; worth knowing about, not worth
blocking on.

**The grammar's parser, not tiling, is the bottleneck on large
expressions.** Tiling itself is effectively flat in tree width (see
ir-engine.md's Pareto-pruning rationale) — but at around 128+ leaves in a
wide expression, `test/bench.ts`'s wall-clock time is dominated by
*parsing*: the generated recursive-descent parser (`grammer.pegjs`) takes
seconds to tens of seconds well before `tileExpr` is ever called.
Unrelated to `@ppl/machine`'s tiling algorithm itself, not investigated
further.
