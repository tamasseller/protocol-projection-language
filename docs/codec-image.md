# Codec Image

> **Status:** Design spec, not yet implemented — ROADMAP.md item 10.
> Depends on item 8 (multi-procedure program envelope — done) and item 9
> (declared default values — done). Specifies the
> artifact one party's build produces and another, independently-built
> party's on-demand code generator consumes — the semantic type tree
> reconciliation this requires is the actual reason this item's wire
> encoding of that tree couldn't just be designed by counting bytes (isa-core.md
> §5.3's usual "measure real codecs first" approach doesn't help here; the
> open question was never a byte-budget question). Builds directly on
> docs/codec-extension.md, which this document assumes throughout —
> `TypeNode`/`edges`/`Step` (§2.2/§2.4), `CALL_CODEC`'s `ref` addressing
> (§2.4), the entry procedure's declared object type (§2.4's "the only type
> a wire image needs to name explicitly").

---

## 1. Overview

A **codec image** is the artifact one build produces so a second,
independently-built party can generate its own native ser/des code against
the same wire format — without that second party ever seeing the first
party's source schema, and without both parties being redeployed in
lockstep when the protocol changes. It bundles:

- the semantic type tree rooted at the entry procedure's own object type
  (codec-extension.md §2.4 — the one type a wire image needs to name
  explicitly; everything else is derived structurally by walking it),
- an encoder program and a decoder program (never one call graph between
  them, per codec-extension.md §2.3's directionality rule),
- and, per §4 below, a declared default value at each of its own struct
  fields and union variants that might need one (the consumer's own tree
  carries its own separately, never shipped in the image — §5).

The motivating shape: an embedded device builds once, generates native
code directly from its own schema at build time, and ships a codec image
as a portable description of the wire format it actually speaks — either
embedded in firmware or published to an artifact store the other party can
fetch from. The other party (a cloud service, a desktop or mobile client —
anything with the resources to defer codegen to runtime) has its *own*
schema, baked into *its* own build from the same nominal protocol
definition, and generates its own ser/des code on demand, per device it
talks to, from that device's published image.

The reason this needs its own document rather than folding into
codec-extension.md: everything in that document describes one coherent
program built from one schema. A codec image is consumed by a *second*
build, with its *own*, independently-versioned schema — and those two
schemas are not guaranteed to be the same tree, because the protocol can
legitimately evolve between when the image's origin was built and when the
consumer generates code against it. Reconciling two structurally-similar
but not-necessarily-identical trees, gracefully, is a distinct concern from
anything the codec bytecode ISA itself needs to know about.

Throughout, **origin** is the party whose build produced the image (owns
the *image tree* — the schema the bytecode was actually compiled against,
which is authoritative for the wire format in both directions); **consumer**
is the party generating native code from a received image, reconciling it
against its own, independently-built **local tree**.

---

## 2. Reconciliation

Reconciliation is a lock-step walk of the image tree and the local tree,
starting at each one's root, matching corresponding nodes and computing,
per node, how the consumer's generated code should bridge "what the
bytecode navigates in the image tree" to "where the corresponding value
actually lives in the consumer's own object model."

### 2.1 Matching key: name, not position

`TypeGraph`'s `edges` (`@ppl/core/type-graph.ts`) are ordered — a struct's
`Map<string, SemanticType>` iterates in declaration order, and `ENTER`/
`CALL_CODEC`'s `ref` operand addresses that order positionally
(codec-extension.md §2.4). That positional order is fixed, forever, for
the *image* tree — it's what the shipped bytecode already navigates by,
and nothing about reconciliation changes it.

But two independently-evolved trees are not guaranteed to agree on
position: a field added after the image was built lands wherever its own
author's `struct({...})` call put it, which need not be the position it'll
occupy in a later or earlier snapshot of the same nominal schema.
Reconciliation therefore matches struct fields and union variants by
**name** (`Step`'s `{field: string}`/`{variant: string}`, codec-
extension.md §2.2's own disambiguation vocabulary) — never by `ref`
index. A list has exactly one element edge (codec-extension.md §3.4), so
it needs no name to match by at all.

The output of this walk, per node the two trees share, is exactly the
mapping a native codegen needs: "image edge `#K` (named `foo`) corresponds
to local storage location `L`." That mapping is what gets baked into the
*generated* accessor code (e.g. `myStruct.foo`, a computed field offset) —
the bytecode's own `ref` operands are never rewritten; they stay positional
into the image tree exactly as shipped. Reconciliation is a codegen-time
bridge, not a transformation of the image.

### 2.2 What must match exactly

A node's *kind* (struct/union/list/integer/unit, `SemanticTypeKinds`) must
agree between image and local tree wherever both exist. Kind-changing
evolution — a field that was an integer becoming a struct, say — is out of
scope: reconciliation rejects it rather than attempting to define what it
would even mean. This mirrors the project's existing "known limit, not a
bug" posture (ROADMAP.md item 7's recursive-type limit) rather than a gap
to fill later.

An integer's *range* is allowed to differ, in one direction per side (§3):
consumer-decode needs `imageRange ⊆ localRange` (whatever width the wire
actually carries must fit in local storage); consumer-encode needs the
actual value being sent to fit `imageRange` (checked at generation time
where possible, at runtime otherwise — a value genuinely out of range is a
real error, not a reconciliation question). The wire *width* `WRITE`/`READ`
actually use is always the image's own (`intWireSize` of the image's
declared range) — the local range only bounds what the consumer does with
the value on its own side, never what goes on the wire, since the wire
format is the image's to define.

### 2.3 Where the two trees are allowed to diverge

Everywhere else — a struct having a field the other doesn't, a union
having a variant the other doesn't, a list's declared capacity differing —
reconciliation doesn't reject the mismatch outright. It's resolved per
§3's direction-and-width rules instead, which is the entire point of doing
this walk rather than requiring the two trees to be isomorphic.

---

## 3. Relaxation rules

Four cases, crossing two axes (which side is wider; which direction data
flows). All four were reasoned through by direction; this section fixes
them as rules a reconciliation implementation must actually apply, not
just default behavior that happens to fall out.

### 3.1 Decode, local tree wider (extra local fields/variants, wider ranges, larger capacity)

The consumer's own object has storage the image's bytecode never
addresses at all — no `ENTER`/`STORE_VAL` targets it, so generated code
simply never writes to it. What it's left holding depends on *whose job
it was to allocate that storage in the first place* — which, below the
root, is not generally the application's.

Only the root handle is actually caller-supplied today (`createCodecExtension`'s
own `root: Handle` parameter, matching `roundTrip`'s `{root: {}}` pre-seed
in `builders.test.ts`) — everything the decoder navigates into below the
root, it instantiates itself, mid-walk: a nested struct field
(`ensureDecodedStructExists`, `codec-extension.ts`), a union's active
variant's payload (`computeChild`'s `set(src, {variant, value:
undefined})`), a list element. None of those pre-exist for an application
to have pre-seeded, so "keep whatever the application already put there"
isn't a coherent answer for them — there was nothing there a moment
before the decoder itself created the container.

So a local-only field inside anything the decoder itself instantiates
needs an actual initial value from *somewhere*, and the only tree that
knows this field exists at all is the local one — it needs the same kind
of **declared default** §3.3 needs from the image, just sourced from the
opposite side (§4 covers both). This is genuinely symmetric with §3.3,
not a separate, lighter-weight case: whichever tree has the field supplies
its own default when the other party's codegen needs to fill in a
placeholder.

What *is* legitimately a target-codegen choice, not something this
document mandates, is *how* that default gets applied — whether the
generated decoder assigns it explicitly wherever it instantiates a
container (the plain-object model `codec-extension.ts` uses today), or a
Buffer→mapped-type generator bakes it into the memory layout it emits so
every freshly-decoded object already reads back the right value with no
per-field assignment at all. Either way, the default has to exist and be
known at codegen time; only *which side of the codegen it's applied on*
is a target's own business.

### 3.2 Decode, image tree wider (extra image fields/variants the local tree doesn't know)

The bytecode still fully specifies how to read (and, where relevant,
navigate past) the unrecognized data — it was compiled against the wider
image tree, which does know its shape. Generated code executes that
reading faithfully (so the stream cursor stays correctly positioned for
whatever comes next); what it does with the *value* differs by kind.

For a struct field, the write is simply dropped: there is no local
storage location to bridge it to, and this is unconditionally safe — a
struct's shape doesn't depend on which fields are present, so skipping
the write of one changes nothing about how any other field is read.

For a union, the active variant *is* the payload's shape — an
unrecognized variant tag still gets its payload read correctly (the
bytecode, generated against the image tree, already knows exactly how many
bytes and what structure that variant's payload has, independent of
whether the *consumer* understands it). What happens locally now depends
on whether the local union type declares a **default variant** (§4): if
it does, decode materializes that variant instead — the same declared
default a missing struct field would reach for, just arrived at via an
unrecognized tag instead of an absent field. If it doesn't, decode
**traps**: unlike a struct field's absence (unconditionally safe, per the
paragraph above — a struct's shape never depends on which fields are
present), a union's active variant *is* its shape, so silently
materializing nothing would leave the local object holding a value from no
case its own type admits at all. Whether that's tolerable is exactly the
call §4 already assigns to whichever union declares — or deliberately
doesn't declare — a default variant: an instruction-opcode-style union
(every variant `unit`, no natural fallback) is a real "don't default,
trap" case, not an oversight the mechanism needs to work around.

A declared default variant answers *most* of what was previously an open
question here: whether the local union type should carry an explicit
"unrecognized variant" case at all — yes, opt in by declaring one (§4),
restricted to a `unit`-valued variant so it never needs a payload of its
own. What's still genuinely open: a default variant reached because §4
needed *some* value for a struct field of this union's type (§3.1/§3.3)
and a default variant reached because an *incoming tag wasn't recognized*
(this paragraph) are, on the wire, indistinguishable outcomes — both land
on the same named variant. An application that needs to tell "this
decoded fine as that variant" apart from "this arrived as something my
build doesn't recognize yet, so it fell back" has no mechanism to do so
beyond its own naming convention (e.g. reserving a variant literally named
`unrecognized`). A dedicated, unambiguous case for that distinction is
still not designed here.

### 3.3 Encode, image tree wider (image describes a field/variant local has no source value for)

The mirror image of §3.2, but encode can't simply drop the write: the wire
format the image describes still needs *some* well-formed bytes at that
position; there is no equivalent of "the bytecode already knows how to
skip it," because encoding is producing bytes, not consuming them. The
consumer substitutes the field's/variant's **declared default**, carried
in the image's own type tree (§4) — read from the image, since the image
is the only place a value for a field the consumer's own model doesn't
have at all could possibly come from.

### 3.4 Encode, local tree wider (local wants to represent something the image has no case for)

Whether this is safe to encode anyway depends on *what kind* of "extra"
it is — "local tree wider" alone doesn't decide it, so this splits into
two sub-cases rather than one blanket rule:

**Additive extras — a local-only struct field — drop silently, same as
before.** This isn't actually a new rule: a struct field being additive
is exactly what makes a narrower peer already tolerant of its absence
(§3.2's own reasoning, just run in the other direction), so encoding
simply omits it, the same way §3.2 omits the write on decode.

**All-or-nothing extras — a local-only union variant, or a local integer
value outside the image's declared range — trap instead.** Neither has a
value to fall back to: a union variant has no wire representation for
"this data's shape has no case in the target schema" that wouldn't
misrepresent it, and an out-of-range integer has no legal substitute that
wouldn't just be a different, wrong number. Unlike §3.3, there's no
default to reach for here, because it's the *consumer's own real data* —
not an absent slot — that doesn't fit.

So the dividing line that actually matters is additive-vs-all-or-nothing,
not "local tree wider" as a category: today that means struct fields drop
and union variants (or out-of-range integers) trap, and the same split
would apply to any future kind with the same one-of-several-incompatible-
shapes structure as a union.

---

## 4. Declared defaults — the `@ppl/core` prerequisite (ROADMAP item 9)

§3.1 and §3.3 are the two relaxations that need a value to come from
somewhere other than "the consumer's own data" or "just don't write it" —
a genuine schema-level addition, not something reconciliation can
synthesize on its own. The two are symmetric: whichever tree actually
declares a given field is the one that must supply its default, whether
that's the image (§3.3, encode) or the local tree (§3.1, decode) — neither
direction is more of an afterthought than the other.

**Where it attaches.** On the type value itself, not on a separate slot
between name and type. `type-graph.ts` already keys sharing by
type-*object* identity, not structure ("same JS object → same `TypeNode`
… the author controls sharing by how they construct/export types" — its
own file header) — so "the same leaf type (say `u8`) reused across many
fields needs a different sensible default in each context" isn't actually
a gap to fill with a new per-slot wrapper: a field that needs its own
default simply doesn't reuse the shared `u8` constant, it constructs its
own `integer(0, 255, d)` value, which already gets its own `TypeNode` for
free. The `SemanticField = {name, type}` shape floated here previously as
a candidate for a third `default` member is *not* the direction taken —
`struct()`/`union()` keep building a plain `Map<string, SemanticType>`,
unchanged.

**What it is**, per kind (the concrete `@ppl/core` shape is ROADMAP item
9's own work; this is the decision that work has to implement):

- **Integer** — a third constructor parameter, `default = 0`
  (`IntegerType.default: number`). Every existing constant (`u8`, `i16`,
  …) gets default `0` for free, since none of them pass a third argument.
- **Unit** — none; carries no data, nothing to default.
- **List** — none, ever. An unfilled list is empty — that's not a
  declared default, it's the only value absence can coherently have for a
  list.
- **Struct** — none authored. Always the composition of its own fields'
  declared defaults, recursively — a whole nested default object is never
  hand-authored as one literal blob.
- **Union** — opt-in, naming one of its own variants as the
  **default variant**, restricted to a `unit`-valued one (so it never
  needs a payload of its own). Deliberately not mandatory: some unions
  (all-`unit`, instruction-opcode-style, no natural fallback — §3.2) must
  trap instead of ever defaulting, and that's the type-tree author's own
  per-union call.

A composite default that bottoms out in a union with no declared default
variant fails — and since which defaults will ever be asked for is fully
knowable once the two trees are reconciled (§2), that failure belongs at
build/codegen time, not deferred to a per-message runtime trap the way
§3.4's real out-of-range-value trap has to be.

**When it's required.** Only a field actually reached by §3.1 or §3.3 in
practice needs one — but since nobody can know in advance whether a given
field will someday be "the extra one" in some future counterpart's
narrower tree (on either side — a device's older schema missing a field
the server added, or a server's own schema missing a field a newer device
added), the practical authoring discipline is: **declare a default at the
point a field or variant is added**, not retroactively for everything
that predates this mechanism, and regardless of which of the two parties'
schemas happens to be adding it. (This mirrors Avro's own schema-evolution
convention for new record fields, for the same reason — it's the one
point in a field's lifetime where "what should an old reader do if it
doesn't know I exist yet" is a question whoever's adding the field is
already best placed to answer.)

This document fixes *why* a default is needed, *where* it has to attach,
and *which kind gets what shape of default* for §3.1/§3.3 to work. The
literal `@ppl/core` syntax and `defaultValueOf`, the function that
actually walks a type computing one, are implemented — ROADMAP item 9,
`@ppl/core/metamodel.ts`.

---

## 5. What the image carries

- The semantic type tree, rooted at the entry procedure's declared object
  type (codec-extension.md §2.4) — now additionally carrying each
  integer's own declared `default` and each union's own declared
  `defaultVariant`, if any (§4), since §3.3 needs to read them *from the
  image*: the image is the only place a value for a field the local tree
  doesn't have at all could come from. §3.1's own defaults are the mirror
  image, not something the image needs to carry at all — they're declared
  in the *consumer's* own schema, compiled into its own on-demand codegen
  exactly the way the image's defaults are compiled into the origin's, and
  never cross the wire either way. Each side's defaults live with the tree
  that declares them; the image only ever needs to carry its own.
- One encoder program, one decoder program — unchanged from what
  codec-extension.md already specifies. Reconciliation is purely a
  codegen-time bridge (§2.1); nothing about it changes the bytecode's own
  shape or addressing.

What it does **not** carry, two already-settled decisions restated here
only because reconciliation was the open question blocking them from
being finished, not a reason to revisit either: per-resource peak-usage
stats (ROADMAP.md item 8 — declined; nothing consumes them, and this
domain wants maximum compactness), and any per-procedure header data
beyond the entry's own root type (ROADMAP.md item 7/codec-extension.md
§2.4 — every other handle's type is already derived, never declared).

The concrete byte-level layout of the image container itself — how the
type tree (including defaults), the two programs, and whatever framing
ties them together actually get serialized — is still open, same
"measure real cases first" reasoning as isa-core.md §5.3 and
codec-extension.md §6 before it. This document fixes the *shape* the
container needs to hold and the *algorithm* a consumer runs against it;
the wire bytes are a separate, later question.

---

## Appendix — Worked Example

A tiny struct, not the real `packages/example` schema (kept intentionally
small — the real schema's own fields all happen to be present in every
version considered so far, which is exactly why it can't illustrate
divergence).

Origin (device) builds, at version 1:

```ts
const ReadingV1 = struct({ id: u8, value: i16 })
```

Version 2 adds a field, with a declared default (§4) — exactly what lets
an older consumer's decode ignore it gracefully while a newer consumer's
encode still has something well-formed to send to an older device:

```ts
const ReadingV2 = struct({ id: u8, value: i16, quality: u8 /* default 0 */ })
```

**Consumer built against V1, device ships a V2 image (decode):**
image tree is wider (`quality` is new). Generated decode code reads `id`
and `value` into the consumer's `ReadingV1`-shaped object exactly as
before; the bytecode's own read of `quality`'s byte still executes (the
stream cursor lands correctly on whatever follows), but nothing is
written locally — §3.2. The consumer's object simply has no `quality` at
all, precisely because its own tree never declared one.

**Consumer built against V2, decoding a V1 image, where the new field
sits inside a union payload (§3.1):** suppose `quality` had instead been
added inside a `SensorKind` union's `temperature` variant, not at
`Reading`'s own top level — `temperature: struct({ celsius: i16, quality:
u8 /* default 0 */ })`. The `temperature` payload object doesn't exist
until decode actually selects that variant, so there's nothing for an
application to have pre-seeded ahead of time (§3.1's whole point). When
generated decode code selects `temperature` and instantiates its payload,
it assigns `quality` its own declared default right there — not because
the V1 image says anything about `quality` (it doesn't know the field
exists at all), but because V2's own local tree declares it, and this is
the only point decode ever touches this freshly-allocated object.

**Consumer built against V2, device ships a V1 image (encode):**
image tree is narrower (no `quality`). The consumer has a `quality` value
in hand but nowhere in the image's wire format to put it — there's no
`quality` field on the wire for this older device at all, and (§3.4's
struct case) that's fine: the field is simply never written, exactly as a
V1 device already expects.

**Consumer built against V1, device ships a V2 image (encode — less
common, but the mirror case):** image tree is wider. The consumer's
`ReadingV1` object has no `quality` value of its own; generated code
substitutes V2's declared default (`0`) — §3.3 — so the V2-shaped wire
bytes this device still expects come out well-formed regardless.

**A union's default variant (§3.2/§4):** suppose `SensorKind` is
`union({ temperature: ..., humidity: ..., unrecognized: unit },
"unrecognized")` at the server's (consumer's) own build, and an older
device ships an image whose `SensorKind` has a third variant the server
predates entirely, say `pressure`. Decoding a `pressure` reading: the
bytecode reads its payload correctly (compiled against the image, which
does know `pressure`'s shape), but the server's own tree has no
`pressure` case to write into — decode selects `unrecognized` instead of
trapping, because `SensorKind` declared a default variant for exactly
this. Had `SensorKind` not named one, this exact scenario would trap
instead — the same union, minus one constructor argument, trades
"gracefully degrade" for "fail loudly," which is the point: that trade is
the type author's call, not a distinction the mechanism makes for them.

---

## Appendix — Deferred Design Points

- **Image container byte encoding.** Still open — §5's closing paragraph.
- **`@ppl/core` default-value API.** Done (§4, ROADMAP item 9) — integer
  gets a third constructor parameter (`default`, defaulting to `0`);
  union gets an opt-in `defaultVariant` restricted to a `unit`-valued
  variant; list/struct/unit need none (always empty / always composed /
  never needed); `defaultValueOf` computes one, recursively.
- **Explicit "unrecognized variant" case.** Mostly answered by §3.2's
  default-variant refinement — a union opts in by declaring one. What's
  still genuinely open: a default variant reached via §4 (composing a
  struct field's default) and one reached via an unrecognized incoming
  tag (§3.2) are indistinguishable on the wire, so an application that
  needs to tell those two apart has no mechanism beyond its own naming
  convention. Not designed here.
- **Kind-changing evolution** (§2.2). Rejected outright, not designed
  around.
- **List element-type evolution.** A list's one element edge reconciles
  by the same struct/union-field rules already given — nothing extra
  needed there. **List capacity**, though, isn't quite the same shape as
  an integer range: `ListType.capacity` (`@ppl/core/metamodel.ts`) bounds
  the *host* container, while the image's own declared capacity only ever
  shows up baked into the wire count-prefix's byte width (`binary-rules.ts`'s
  `countPrefixWidth`, a component convention, not part of the core ISA).
  A real message's actual element count could still exceed local capacity
  regardless of what either tree declares — that's a per-message runtime
  bound check (closer to the integer-range-overflow case in §3.4 than to
  anything §2's static tree walk resolves once and for all). Not designed
  here; not exercised by the worked example above.
