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
`concat(...fragments)` combines independently-built fragments (e.g. one
per element of a compile-time-computed collection) since names are
identity-derived and never collide.

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
generic and protocol-agnostic by design (5).

Also worth designing once there's a real extension to design it against,
deferred from (6) for exactly that reason: whether the validator should let
an extension delegate custom, non-peak-shaped invariants (e.g. a handle
must be entered before it's read) into the same walk it already does, and
whether per-extension resource-peak statistics (e.g. maximum concurrent
stream/object-handle counts) should generalize the existing stack-depth
(§8.3) machinery to track named resources beyond the real TOS, getting the
same per-procedure/tight-cross-call-site treatment for free.

## 8. Remaining wire framing and codec-referenced-type serdes

Everything left over from (4), consolidated into one item for tracking
convenience rather than because it's all one dependency — the two halves
below don't actually share a prerequisite:

- **The multi-procedure program envelope** — `CALL`'s own numeric
  encode/decode (needs a procedure table to check indices against), and
  program-level framing (a procedure count? a table of offsets? decode-by-
  structural-bracket-matching, the way the VM itself finds a procedure's
  end?). Not blocked on anything above; ready to design now that (1)–(2)
  give it a real multi-procedure program to frame.
- **Procedure header encoding, and codec-referenced semantic types.**
  §2.3's procedure header is `{arg_count, ...extension fields}`; encoding
  those extension fields needs a concrete extension's header shape to
  encode *against* (isa-core.md §11.4 keeps them opaque to the generic
  core on purpose), so this half depends on (7). Once there is one, codec
  procedure headers will also need to reference semantic types from the
  metamodel (`metamodel.ts`/`type-graph.ts`) — those need their own
  serialization format, not yet designed either.

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

Depends on everything above. `packages/target-cpp` and `packages/target-js`
currently contain rushed example stubs, not production codegen — redo
them once the platform underneath them (procedures, validation,
extensions, codecs) is actually stable.

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
