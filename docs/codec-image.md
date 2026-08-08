# Codec Image

> **Status:** Design spec, not yet implemented — ROADMAP.md item 10.
> Depends on item 8 (multi-procedure program envelope) and item 9
> (declared default values), neither implemented yet either. Specifies the
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
whatever comes next) but drops the corresponding write: there is no local
storage location to bridge it to.

For a struct field this is unconditionally safe: a struct's shape doesn't
depend on which fields are present, so skipping the write of one changes
nothing about how any other field is read.

For a union, the active variant *is* the payload's shape — an
unrecognized variant tag still gets its payload read correctly (the
bytecode, generated against the image tree, already knows exactly how many
bytes and what structure that variant's payload has, independent of
whether the *consumer* understands it), but there is no local case to
materialize a value into, so the value is simply dropped, same as an
unrecognized struct field — nothing is written, decode moves on.

Whether the local union type should instead carry an explicit
"unrecognized variant" case, so application code can tell "this arrived
and decoded fine" apart from "something arrived that this build doesn't
understand yet," is a real, separate question this document does *not*
resolve — not a lighter "opt-in" toggle on the mechanism above, since no
concrete mechanism for it exists yet (there's no schema-level way today to
mark one variant as "the catch-all for anything unrecognized," and
matching by name (§2.1) gives reconciliation no way to route an
unrecognized tag into a specific local variant without one). Nor is it
the same problem §4's declared defaults solve: a default stands in for a
value of a *known* shape the consumer simply has no source for; an
unrecognized variant is the absence of shape knowledge itself, not a
missing value of a known one — §4 doesn't cover it, and inventing a
default for "whatever this unknown thing is" wouldn't mean anything. Left
for the Appendix as a genuinely open question, not a decided,
just-not-mandatory feature.

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

**Where it attaches.** Per struct field and per union variant — not per
leaf type. The same leaf type (say `u8`) reused across many fields needs a
different sensible default in each context, so the default belongs to the
*slot* (the field/variant edge), not the type sitting at the far end of
it. `@ppl/core/metamodel.ts` today has no such slot: `struct()`/`union()`
build a plain `Map<string, SemanticType>`, with nothing between the name
and the type to hang a default off. (The existing `SemanticField = {name:
string; type: SemanticType}` alias is unused by `struct()`/`union()`
today — `dogfood.ts` shadows the name locally for something unrelated —
but its shape, `{name, type}`, is exactly where a third `default` member
would go if this is the direction item 9 takes; not a decision made here,
just a candidate the shape already points at.)

**What it is.** A fully-formed value of the field's/variant's own type.
For a composite (struct/union) field with no default of its own, the
default should be derivable by composing its *own* fields'/variants'
declared defaults recursively — so a whole nested default object doesn't
need to be hand-authored as one literal blob wherever a composite field
might need one. `unit` needs no default at all (it carries no data —
there's nothing to default).

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

This document fixes *why* a default is needed and *where* it has to
attach for §3.1/§3.3 to work — not the `@ppl/core` API/syntax for
declaring one, nor whether it's mandatory at every field going forward.
That's ROADMAP item 9's own design work; this section is the constraint
that work has to satisfy, not a preview of its outcome.

---

## 5. What the image carries

- The semantic type tree, rooted at the entry procedure's declared object
  type (codec-extension.md §2.4) — now additionally carrying, per struct
  field and union variant, an optional declared default (§4), since §3.3
  needs to read it *from the image*: the image is the only place a value
  for a field the local tree doesn't have at all could come from. §3.1's
  own defaults are the mirror image, not something the image needs to
  carry at all — they're declared in the *consumer's* own schema, compiled
  into its own on-demand codegen exactly the way the image's defaults are
  compiled into the origin's, and never cross the wire either way. Each
  side's defaults live with the tree that declares them; the image only
  ever needs to carry its own.
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

---

## Appendix — Deferred Design Points

- **Image container byte encoding.** Still open — §5's closing paragraph.
- **`@ppl/core` default-value API.** Still open — §4's closing paragraph,
  tracked as ROADMAP item 9.
- **Explicit "unrecognized variant" case.** Genuinely open, per §3.2 — no
  schema-level mechanism exists yet for a union to mark one variant as a
  catch-all for an unrecognized tag, and §4's declared defaults don't
  cover it (a default stands in for a missing value of a *known* shape;
  this is the absence of shape knowledge itself). Not designed here.
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
