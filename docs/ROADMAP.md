# Roadmap

Ordered by dependency. Sequencing, not design: the referenced files and
docs carry the how. "Known non-blocking issues" at the end sit outside the
dependency chain.

## 1. Procedure identity and composition - Done

`packages/machine/src/ir.ts`. `proc(args, fragment)` and
`declareProc`+`defineProc` give an `IrFragment` an identity, spliceable via
`${proc}` interpolation; `ir()` resolves references by object identity.
`body` (parsed AST) is lazy, so a non-standalone fragment such as a bare
`case N:` can be built and spliced before anything parses it.

## 2. Call dispatch (lowering + VM) - Done

`lower.ts`, `vm.ts`. `CALL` carries a resolved `calleeIndex`, never a bare
name. `lowerProgram(entry)` lowers on demand, assigning each newly-seen
callee the next table index before recursing, which handles self- and
mutual recursion. `vm.ts`'s `CALL` recurses into `runProc` by that index.

## 3. Whole-program validator - Done

`validate.ts`. `validateProgram(program)` checks isa-core.md §8.1-§8.5 and
returns the tight stack-depth bound (per-call-site depth plus the callee's
worst case, not the loose sum of per-procedure maxima) from the same DFS.

## 4. Bytecode ser/des - Done

`bytecode.ts` encodes/decodes a flat `RtlInstr[]` body, checked row for row
against isa-core.md's opcode table, plus extension opcodes (byte ≥128, via
`Extension.codec`).

## 5. `@ppl/machine` package - Done

Generic, protocol-agnostic IR/lowering/VM/bytecode/extension-hook
machinery in its own package. `@ppl/core` does not depend on it.

## 6. Extension mechanism - Done

`extension.ts` (isa-core.md §11). `rules.ts`/`lower.ts`/`validate.ts`/
`vm.ts`/`bytecode.ts` each take an optional `Extension` supplying per-opcode
stack effect, DSL call resolution, VM execution and wire codec. Procedure
extension-header fields stay opaque and are carried through untouched.

## 7. Codec-specific extension - Done

docs/codec-extension.md §1-§3 as `@ppl/codecs`'s own `Extension`:
`engine/opcodes.ts` (the 17 opcode mnemonics, single source of truth),
`engine/codec-extension.ts` (`createCodecExtension` plus `codecRules()`,
the `ir` DSL surface), `engine/resolver.ts` (`createCodecResolver` plus
`buildCodec`), `engine/validate-handles.ts` (§7.1's static checks),
`engine/wire.ts` (§6's byte encoding). Components: `binary-rules.ts`
(default binary wire format, struct union-tag hoisting up to 128 variants),
`delta-leb128.ts`, `json.ts` (encoder-only, proving direction is optional).
Proven against `packages/example`'s independently-authored
`TelemetryPacket` schema.

**Known limit:** a truly self-referential type resolves at build time but
`validateProgram` rejects the resulting recursive call graph (§8.2's
bounded-stack-depth guarantee). Recursive types are not expressible under
this ISA yet, hand-built or DSL-authored.

`engine/` stays in `@ppl/codecs` rather than moving to `@ppl/core`:
`@ppl/core` has zero dependencies and `target-cpp`/`target-js` depend on
only it, so moving `codec-extension.ts` (built on
`Extension`/`ExecState`/`ExtOpEffect`) there would drag `@ppl/machine` in.

## 8. Multi-procedure program envelope - Done

isa-core.md §5.4/§5.5: `CALL`'s numeric encode/decode (byte 99 plus
unbounded LEB128 `proc_idx`) and program framing, in `bytecode.ts`'s
`encodeProgram`/`decodeProgram`. A procedure count, a real offset table (one
header row per procedure: `arg_count` plus body byte length), then every
body concatenated in table order. `Uint8Array.subarray` hands each
procedure's byte range to the existing single-body `decodeBody` as a view,
so single-procedure encoding is unchanged.

Resource-peak stats (max stack depth, max concurrent handles/iterators) are
deliberately not in the envelope: nothing consumes them, and §6 wants
maximum compactness. `validateProgram`'s `ProgramStats` stays available to
any caller that wants them. Same reasoning drops a procedure's own
extension `header` from the wire (isa-core.md §5.5).

The jit-armv6m target does want those stats, and takes them in a wrapper of
its own (`jit-armv6m.ts`, the package's only target-specific module) rather
than in the generic envelope: `max_call_depth`/`total_depth` prepended, plus
a two-byte FNV-1a frame binding a program to the validator that produced it.
jit-armv6m/docs/design.md §1.1.

## 9. Declared default values (`@ppl/core`) - Done

`metamodel.ts`. Motivated by codec-image.md §3.1/§3.3/§4: integer gets a
third constructor parameter (`integer(min, max, default = 0)`, stored as
`IntegerType.default`); union gets an opt-in `defaultVariant?` restricted
to a `unit`-valued variant, validated at construction; unit, list and
struct need none (nothing to default, always empty, always composed).
`defaultValueOf(type)` computes one recursively and throws if it bottoms
out in a union with no declared default, which is a build/codegen-time
failure since which defaults get asked for is knowable once the two trees
are reconciled. `struct()`/`union()` keep building a plain
`Map<string, SemanticType>`; a field wanting its own default constructs its
own `integer(min, max, d)` object, which `type-graph.ts`'s identity-keyed
sharing already gives its own `TypeNode`.

## 10. Codec image - Done

docs/codec-image.md §6 (type tree wire encoding) and §7 (container layout),
implemented as `engine/type-tree-wire.ts` and `engine/codec-image.ts`.
`decodeProgram` now returns `{program, next}`, since a container holding
several encoded programs back to back has no other way to find the
boundary.

`PUSH_REF` dedup keys on a structural *signature* (a pure function of
kind, range and field/variant names, recursively) computed before deciding
whether to recurse into children, not on emitted bytes: a repeated
composite's second occurrence never matches byte-wise, because its children
resolve to short backrefs the first occurrence's construction bytes lack.
The wire format itself is unchanged by this.

## 11. Core shakedown - Done

**`traits.ts` removed.** Every use anywhere read exactly one trait,
`TypeNameTrait`, in exactly one shape; `TraitRegistry.set` was never
exercised. Names are first-class instead: `metamodel.ts`'s
`named()`/`nameOf()` attach and read a name on the type object via one
well-known symbol, and `matcher.ts`'s `pNamed(name, inner?)` matches
against it before any thunk dereferencing (a recursive type's name lives on
the thunk). This also serves a case traits never did: an application author
overriding where their own codec applies can say "the type declared as
`Timestamp`, wherever it occurs" without spelling out its structural shape.
`runRuleset`/`Rule.produce` dropped their `traits` parameter.

A type's own declared name and codec-image.md §6.3's field/variant names
are different namespaces: field/variant names travel in the image because
reconciliation matches by them, a type's own name is a build-time
convenience (codegen labeling, rule matching) that never crosses the wire.

**`WRITE_SEQ`/`READ_SEQ`** (docs/codec-extension.md §3.5): bulk transfer of
`acc` many elements between a stream iterator and a list handle's array
storage, replacing the per-element `call_codec_next` loop for a plain
`List<Integer>`. `binary-rules.ts`'s default codec uses them for every
`List<Integer>` unconditionally, so a target codegen has one op to
recognize and specialize into a raw-buffer/DMA copy instead of a loop.
`exec()`'s own semantics are always the per-element pump loop, so
`validateProgram`/`run` need no target awareness. Implemented across
`opcodes.ts`, `codec-extension.ts`, `validate-handles.ts`, `wire.ts` (the
extension's last 9 codes, 128/128 now assigned) and `binary-rules.ts`.

**Reconciliation** (docs/codec-image.md §2/§3), `packages/core/src/
reconcile.ts`: `reconcile(imageRoot, localRoot)` is a lock-step walk of two
`TypeNode` graphs producing a bidirectional
`"matched"`/`"image-only"`/`"local-only"` tree; `resolve(parent, edge,
direction)` applies §3's rules (`bridge`/`drop`/`default`/`trap`/
`"unreachable"`) to one edge. Split because the tree shape is
direction-independent and only its interpretation is not. Target- and
codec-independent, so it lives in `@ppl/core`;
`packages/codecs/src/engine/codec-extension.ts` re-exports its `Direction` type.
`Correspondence` carries no name of its own: struct fields and union
variants are `{name, correspondence}` edges off `.children`, mirroring
`type-graph.ts`'s `TypeEdge {step, target}` split, which is what preserves
identity-sharing for genuine cycles and for unrelated positions reusing the
same type object.

## 12. Real target codegens - In progress

Depends on 7-10. `target-cpp` is still a rushed stub on the older
`Rule<C>`/`runRuleset` primitive (`@ppl/core/projection.ts`); everything
below is JS/TS.

**JS/TS type codegen - done.** `target-js` rebuilt onto the same
`{pattern, produce}`-with-swappable-rule-list shape `@ppl/codecs`
established, split into `engine/` (`TsRule`/`createTsResolver`/
`projectTSTypes`/`emitTSDeclarations`, no opinion on representation) and
`components/` (concrete rule libraries), mirroring `@ppl/codecs`.
`components/ts-emitter.ts` is the default mapping; `ts-alternative-rules.ts`
adds opt-in alternatives an app author prepends for specific shapes:
unit-as-`undefined`, integer-as-`bigint` past `Number`'s safe range,
byte-list-as-`Uint8Array`, capacity-≤1-list-as-optional,
general-union-as-class-hierarchy, struct-as-class. One `@ppl/core`
primitive fell out: `optional(T)`, sugar for
`union({value: T, empty: unit}, "empty")`, the shape `target-cpp`'s
`std::optional<T>` rule already matches, so a schema authored with
`optional(T)` gets an idiomatic representation on both targets.

**`resolveProcedureTypes` - done.** `packages/codecs/src/engine/
procedure-types.ts`. A raised `ENTER`'s `ref` operand is a bare positional
index into a struct/union's field/variant table, meaningless to a backend
without knowing which type the procedure handles. `createCodecResolver`
stamps that onto `Procedure.header`, but `header` never survives
serialization, so any program round-tripped through `bytecode.ts` or
decoded off the wire comes back with `header: undefined`.
`resolveProcedureTypes(program, rootType)` recovers it by recursive descent
from the externally-supplied root over
`ENTER`/`ENTER_NEXT`/`CALL_CODEC`/`CALL_CODEC_NEXT`, replaying
`computeChild`/`computeNext`'s navigation at the type level. One shared
target-independent primitive for both the compiled-source codegen (fixed
local schema) and the dynamic image-bridging path.

**`raise.ts` verified.** `raiseProgram`/`raiseProc`
(`packages/machine/src/raise.ts`) is the structural inverse of `lower.ts`:
flat `RtlInstr[]` back to a `Stmt`/`Expr` tree both targets walk instead of
independently re-deriving block structure. `packages/machine/test/
raise.test.ts` is a differential check, not a shape check: lower and `run()`
through the real VM for ground truth, then raise and evaluate the same
procedure through a tree-walking evaluator built on `vm.ts`'s exported
`evalBinary`/`evalUnary`, asserting agreement across `e2e.test.ts`'s proven
corpus plus `CALL`/`EXT` fixtures, including hand-built `RtlProgram`s for
`EXT` shapes no DSL syntax reaches. `ExtOpEffect` gained `readsAcc` for the
class of ops (`WRITE`/`STORE_VAL`/`WRITE_SEQ`/`READ_SEQ`) that declare
`tosDelta: 0` yet read whatever is already in `acc`.

`EXT` remains an approximation in one respect: a generic `ExtOpEffect` gives
a net `tosDelta`, not an input/output arity split, so an op with several
discrete inputs decomposes no further than "some inputs, one opaque shape".
Not a gap today, since every real op's inputs are either popped operands or
`readsAcc`'s single implicit one.

**JS compiled-source codec codegen - done.** `generateJsCodecs`/
`generateCodecModule` (`packages/target-js/src/engine/codec-module.ts`, on
`engine/codec-codegen.ts`'s per-procedure tree walk,
`engine/line-builder.ts`'s indenting output and `engine/codec-type-nav.ts`'s
`TypeNode` helpers) turn a `buildCodec`-produced `RtlProgram` pair into
literal TypeScript: one `function` per procedure, real `if`/`while`/
`switch`, direct calls between the generated functions, instead of shipping
the RTL program and interpreting it. Built on `raise.ts` for control-flow
shape and `resolveProcedureTypes`/`resolveHandleTypes` for turning a raised
`ENTER`'s bare `ref` into a real field/variant name at generation time.
`packages/target-js/src/runtime/codec-runtime.ts` holds the genuinely
dynamic primitives the generated code calls (buffer position, byte
read/write, the `(container, key)` indirection a decoder needs); schema-edge
lookup and opcode dispatch resolve once at generation time. Scope is any
program built from the 17 codec-extension opcodes, so
`delta-leb128.ts`/`json.ts`/a user's own `CodecRule`s all compile the same
way.

**Codec-image reconciliation, consumed - done.**
`engine/bridging-codec-module.ts`'s `generateBridgingCodecModule` is the
first consumer of item 11's `reconcile()`/`resolve()`. It parallels
`codec-module.ts` with `TypeNode` swapped for `Correspondence`:
`resolveHandleCorrespondences`/`correspondenceChild`/
`correspondenceElement` (`procedure-types.ts`, the same four-opcode scan as
`resolveHandleTypes`) recover each procedure's boundary `Correspondence`,
and `generateProcedures` roots the projected TS types at the *local*
schema. `codec-codegen-ext.ts`'s `GenCtx` gained an additive
`correspondences?: Map<number, Correspondence>`; absent means today's exact
behavior. Every join point (`emitEnter`/`emitEnterNext`/`emitCallCodec`)
resolves its edge and branches: `"bridge"` routes Accessor calls through
`localAccessorFor`, falling back to `scratchAccessorFor` when a slot has no
local counterpart; `"drop"` suppresses the writeback but still runs the wire
read/call for cursor correctness; `"default"` synthesizes a value via
`emitDefaultValue`, walking the type structure through the real Accessor's
`beginStruct`/`setField`/`finishStruct` protocol rather than literal-izing
`resolve()`'s pre-flattened plain-JS value (wrong for a bigint or class
rule); `"trap"`/`"unreachable"` throw `CodecTrap` at runtime, never at
codegen time, since a dead union switch-case still has to compile to
something. `tagOf` (`codec-runtime.ts`) already threw on an unrecognized
variant name, which implements the union/local-only/encode trap (§3.4) for
free once `TAG`'s codegen splits `activeVariantName` (read via the local
accessor) from the comparison list (kept image-side).

**Still open:** the target-type-mapping composability system (a regular
baseline plus selectively-opted special representations) and the actual
`raise.ts` pattern match recognizing `WRITE_SEQ`/`READ_SEQ` and emitting a
raw-buffer/DMA version for a target that opted in. Item 11 built the snatch
point; choosing what to do with it is real target-codegen work.
`target-cpp` still needs the same rebuild `target-js` got.

## 13. Further ideas

- Crypto extension: new handle space, OpenSSL-like API, covering CRCs,
  fixed and variable length hashes (SHAKE) and AEAD, data I/O via stream
  iterators.
- Better DSL syntax for handle access: `stream[0].read`/`write`, or a
  declaration-like form that also lets the lowerer allocate handle indices.
- Small-**value**-space merging binary codec, e.g. a union tag merged with a
  limited-range number field in one of the variants. Needs annotation or a
  meta-argument to say what merges with what, since it favors some variants
  heavily over others compactness-wise.
- Quantities / units of measurement: docs/quantities.md (design sketch,
  unimplemented). Catches the counts-vs-millivolts class reconciliation is
  currently blind to, and folds the conversion into codegen.

---

## Known non-blocking issues

**Parser, not tiling, is the bottleneck on large expressions.** At 128+
leaves, `grammer.pegjs`'s recursive-descent parser dominates wall-clock
time; `tileExpr` is flat in tree width. Not investigated further.

**`ASR` and signed comparisons (`LT_S`/`LE_S`/`GT_S`/`GE_S`) are real,
VM-implemented, ISA-documented opcodes with no DSL token.** `rules.ts`'s
`OP_TABLE` wires `>>` to `SHR` (logical) only, and `<`/`<=`/`>`/`>=` to
their unsigned counterparts only, so `v < 0` is always false in this DSL: a
real footgun, found via `delta-leb128.ts`'s first draft, which silently
produced wrong output rather than erroring. Bitwise top-bit tests
(`(v & 0x80000000) != 0`) work today; wiring these up is a couple of
`rules.ts` table entries plus grammar tokens, whenever a codec needs true
signed arithmetic instead of a masking workaround.

**`ConditionalExpression` (`?:`) parses but has no lowering rule.** Fails
at lowering time ("Failed to lower expression statement"), not parse time.
Lower priority than the above, since it is a clear error rather than
silently wrong output.
