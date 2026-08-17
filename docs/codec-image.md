# Codec Image

> **Status:** ROADMAP.md item 10 — Done. §6 (type tree wire encoding) and
> §7 (container layout) are implemented, `packages/codecs/src/engine/
> type-tree-wire.ts` and `engine/codec-image.ts` — that's this item's own
> scope, the artifact itself. §2/§3/§2.4 (reconciliation) is *also*
> implemented, but under item 11, not this one — `engine/reconcile.ts`, a
> target-independent `reconcile()`/`resolve()` pair (mirroring `raise.ts`'s
> own placement in `@ppl/machine`: it computes a mapping a target codegen
> consumes, but knows nothing about any target language itself). What's
> still genuinely item 12's job is a real target codegen actually calling
> it and emitting native accessor code from the result. Depends on item 8
> (multi-procedure program envelope — done) and item 9 (declared default
> values — done). Specifies the
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

### 2.4 Implementation shape

`packages/core/src/reconcile.ts` — target- *and* codec-independent, like
`raise.ts` is target-independent in `@ppl/machine`: it computes a mapping
a target codegen consumes, but knows nothing about any target language,
wire byte, or opcode. Two functions, deliberately kept separate:

```ts
export function reconcile(imageRoot: TypeNode, localRoot: TypeNode): Correspondence
export function resolve(parent: Correspondence, edge: CorrespondenceEdge, direction: Direction): Resolution
```

`reconcile` is the direction-agnostic lock-step walk §2 describes: one
`Correspondence` tree, `imageRoot`'s `TypeNode.id` (from a `TypeGraph`
built over the *decoded* image tree, `buildTypeGraph(decoded.typeTree)`)
paired against `localRoot`'s own `TypeNode` — the "image nodes by index,
local nodes by `TypeNode`" split falls out for free, since both are
ordinary `TypeNode`s once the image tree is decoded. Throws on a §2.2 kind
mismatch; every other divergence becomes a `"matched"` / `"image-only"` /
`"local-only"` node.

A `Correspondence` carries **no name of its own** — struct fields and
union variants are `CorrespondenceEdge {name, correspondence}` pairs
hanging off `.children`, mirroring `type-graph.ts`'s own `TypeEdge
{step, target}` split (a `TypeNode` has no name; only the edge reaching it
does). This isn't a style choice: `reconcile` is memoized on the exact
(imageNode, localNode) pair, mint-before-recurse exactly like
`buildTypeGraph`'s own `byObject` cache, so a cyclic or independently-
shared position returns the *same* `Correspondence` object a caller may
already have elsewhere in the tree — valuable, since it lets a codegen
monomorphize one generated procedure per distinct pair, the same way
`resolver.ts` already does via `TypeNode` identity. Putting a name on the
node itself (an earlier draft's mistake, caught by a test before this
ever shipped) would silently report the *first* edge's name for every
later edge that happens to reach the same shared or cyclic node — exactly
the class of bug `type-graph.ts` avoids by keeping names off nodes in the
first place.

`resolve` is the separate, direction-*aware* step that turns one
*edge* — not a bare node — into what a codegen should actually emit,
which is why it takes `parent` alongside the edge: a struct field and a
union variant need different rules under the same outcome (below), and
only the *parent's own kind* (Struct vs. Union — read directly off
`parent.imageNode`/`parent.localNode`) tells `resolve` which applies.
`parent` must itself be `"matched"` — never a limitation in practice,
since a non-`"matched"` edge's own resolution (`drop`/`default`/`trap`/
`unreachable`) already fully describes what to do with everything nested
inside it (§3.2's own reasoning: dropping a struct field write is safe
regardless of what the field's type contains), so a real caller only ever
calls `resolve` on children of an edge it already bridged into.

**The asymmetry `resolve` has to get right**: a struct field is an
always-present slot regardless of direction, so all four combinations of
(extra side × direction) are real and each needs an actual resolution. A
union variant is *not* an always-present slot — it's a §2.3-style
mutually-exclusive choice — so only two of the four combinations are ever
reachable at runtime:

| Parent kind | Extra side | Direction | §3 rule | Resolution |
|---|---|---|---|---|
| struct | image-only | decode | §3.2 | `drop` |
| struct | image-only | encode | §3.3 | `default` (from image) |
| struct | local-only | decode | §3.1 | `default` (from local) |
| struct | local-only | encode | §3.4 (additive) | `drop` |
| union | image-only | decode | §3.2 | `default` (local's declared default variant) or `trap` if none |
| union | image-only | **encode** | — | **`unreachable`** — encode switches on the local value's own active variant, which can never *be* a variant local's type doesn't define |
| union | local-only | **decode** | — | **`unreachable`** — decode switches on the incoming tag, which is always one the image itself declares |
| union | local-only | encode | §3.4 (all-or-nothing) | `trap` — no wire representation |

The two `unreachable` rows aren't a gap in §3 — they're combinations §3
never needed to give a rule for, because the union's own selection
mechanism (the local value's active variant on encode; the wire tag on
decode) already rules them out structurally. `resolve` names this
explicitly (a fifth `Resolution` case) rather than silently returning
`drop` or fabricating a `default` for a branch that can never execute.

Two things §2.2 leaves to the caller, deliberately not computed by either
function: an integer's range compatibility (`imageRange ⊆ localRange` for
decode; the actual value fitting `imageRange` for encode) and a list's
capacity — both are directly readable off `c.imageNode.type`/
`c.localNode.type` on a `"matched"` `Correspondence`, and §2.2 already
frames the value-fitting half as "checked at generation time where
possible, at runtime otherwise" — the consuming codegen's own job, not a
structural reconciliation question.

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

The concrete byte-level layout — §6 (the type tree itself) and §7 (how the
three pieces sit next to each other in one container).

---

## 6. Type tree wire encoding

### 6.1 A postorder stack machine, not a table of nodes with pointers

The bytecode itself already encodes a tree with zero pointers: `ref`
operands (`ENTER`/`CALL_CODEC`, codec-extension.md §2.4) are *local* —
positional into whichever node the current handle already stands on, not
a global index into some tree-wide table. The only place a node's global
identity matters at all is the single entry binding (handle 0 ↔ root
type). Nothing downstream of decode cares how this section internally
represents the tree, only that decode hands back the right shape — so
this section's own wire format is free to pick whatever's most compact,
independent of §2's reconciliation algorithm and independent of item 8's
program envelope.

The same trick the bytecode itself doesn't need to reach for — because a
tree, walked postorder, never needs a reference to a child at all: by the
time a parent is described, its children are already fully built and
sitting right where the last few construction steps left them. This reads
as a tiny stack machine: leaves push a value; a list/struct/union pops
however many children it has and pushes the combined result. No node ever
says "my child is over there" — the child is simply whatever the
machine just finished building.

### 6.2 Instructions

One byte-tag instruction stream, decoded by a stack machine over a value
stack of already-built (sub)types. The top 2 bits of the tag byte pick a
*family*; for the three families that recur once per tree node
(`STRUCT`'s field count, `UNION`'s variant count, `PUSH_REF`'s delta),
the low 6 bits *are* the payload — no separate count/delta operand, ever,
for the overwhelming majority of realistic values (0–63, or 1–64 for the
1-based `PUSH_REF` delta). Decode is `family = byte >> 6; payload = byte &
0x3F`, four cases, no bit-packing beyond that one shift+mask:

| range | family | payload |
|---|---|---|
| `0x00`–`0x3F` | `STRUCT` | field count = payload (0–63) |
| `0x40`–`0x7F` | `UNION` | variant count = payload (0–63) |
| `0x80`–`0xBF` | `PUSH_REF` | delta = payload + 1 (1–64 constructions back, §6.4) |
| `0xC0`–`0xFF` | everything else | sub-selected by payload |

`STRUCT`/`UNION` are followed by a name specification — the range-list
form §6.3 defines, self-terminating once it's supplied exactly that many
names — plus, for `UNION`, one more LEB128 (`0` = no default variant,
else `index + 1`, §4). A struct/union with ≥64 members, or a `PUSH_REF`
more than 64 constructions back, falls through to the fourth family's own
explicit-count escapes below — realistic schemas are never expected to
reach them; they exist so nothing silently breaks on one that does.

Fourth family (`0xC0`–`0xFF`), plain sequential tags, no further bit
tricks — there's no per-node recurrence to exploit here, so a byte per
tag is already at floor:

| byte | instruction | operands |
|---|---|---|
| `0xC0` | `PUSH_UNIT` | none |
| `0xC1`–`0xC6` | `PUSH_U8` / `I8` / `U16` / `I16` / `U32` / `I32` | none — covers every constant `metamodel.ts` exports today |
| `0xC7` | `PUSH_INT_MIN0_D0_EXT` | max (zigzag-LEB128) — `min = 0`, `default = 0` |
| `0xC8` | `PUSH_INT_MIN0_EXT` | max, default — `min = 0` |
| `0xC9` | `PUSH_INT_D0_EXT` | min, max — `default = 0` |
| `0xCA` | `PUSH_INT_EXT` | min, max, default — the fully general case |
| `0xCB` | `LIST` | none (uncapacitated) |
| `0xCC` | `LIST_EXT` | capacity: LEB128 |
| `0xCD` | `STRUCT_EXT` | fieldCount: LEB128, then a name specification (§6.3) for that many names |
| `0xCE` | `UNION_EXT` | variantCount: LEB128, name specification, defaultIndex |
| `0xCF` | `PUSH_REF_EXT` | delta: LEB128 |
| `0xD0` | `END` | none — pop the one remaining value (must be the *only* one left) → the root type; section over |
| `0xD1`–`0xFF` | *reserved* | — |

Four integer forms rather than one generic form plus min/default checks:
`default = 0` is the common case even for a non-canonical range (§4's own
declare-at-point-of-need discipline means most fields never bother
overriding it), and `min = 0` covers most non-canonical ranges anyway
(an arbitrary-width unsigned count or percentage, not just the six
canonical widths). Both fold independently, so all four combinations get
their own tag rather than paying for operands the common cases don't
need — same "fold the measured-common case into the tag, keep one
general escape" move `wire.ts` already made for the codec opcodes
themselves.

Encode is a bare postorder walk, no bookkeeping beyond what §6.4 adds:

```
encode(node):
    switch(node.type.kind)
        unit:    emit PUSH_UNIT
        integer: emit canonical PUSH_*, or whichever PUSH_INT_*EXT
                 fits (min=0? default=0? both? neither?)
        list:    encode(elementType); emit LIST or LIST_EXT(capacity)
        struct:  for each field:   encode(child)
                 emit STRUCT(N, nameSpec) or, if N ≥ 64,
                      STRUCT_EXT(N, nameSpec)
        union:   for each variant: encode(child)
                 emit UNION(N, nameSpec, defaultIndex) or,
                      if N ≥ 64, UNION_EXT(...)
encode(root); emit END
```

### 6.3 String table

Field/variant names never appear inline — they're looked up in a table
that precedes the instruction stream: `count: LEB128`, then `count`
length-prefixed UTF-8 entries, deduplicated at encode time (a
`Map<string, index>` built while walking, in first-appearance order — see
below for why this document doesn't try to do better than that).

This table belongs to the type tree section specifically, not the
container as a whole: the two programs never carry names at all — they
address everything positionally via `ref` (§6.1), and reconciliation's own
name matching (§2.1) is a codegen-time concern that only ever touches the
*decoded* tree, never the bytecode.

**Name specification.** `STRUCT`/`UNION` don't reference the string table
as a flat list of indices — they reference it as a list of *ranges*,
read until it has supplied exactly as many names as the instruction's own
count already said to expect (no separate range-count needed). Unlike
`§6.2`'s outer instruction stream, this sub-encoding isn't itself
opcode-tagged — it's a private format contextually known to be exactly
this shape (a run of small integers, mostly length 1, occasionally
longer), so it's free to use whatever's most compact without needing to
fit the tag-byte scheme at all:

Each range is `(base, length)`, meaning "names at string-table indices
`base, base+1, …, base+length-1`," encoded as either one or two LEB128
values depending on `length`:

- **`length = 1`** (the common case — most individual name references
  aren't part of a longer run): one LEB128, `(base << 1) | 1`.
- **`length ≥ 2`**: two LEB128 values, `(length - 2) << 1` then `base`
  plain.

Decode reads one LEB128 `v`: if odd, `base = v >> 1`, `length = 1`; if
even, `length = (v >> 1) + 2` and a second LEB128 supplies `base`. Fill
that many slots from `base` upward, advance, and read another range if
slots remain.

Given a fixed string-table order, an encoder never needs to search for
the best partition into ranges: merging any two numerically-adjacent
pieces into one longer range never costs more (one range of length *L*
always costs ≤ the cost of splitting it, under this scheme) and often
costs less, so greedily extending each run as far as consecutiveness
holds is already optimal. (A `length = 2` range costs the same 2 LEB128
values as two separate `length = 1` entries, so it's a wash, not a loss —
worth knowing, not worth special-casing further.)

**Why the string table's order stays plain first-appearance, not
actively optimized for this.** A struct that's the first place all of its
own names ever appear already gets them as a contiguous run for free, no
extra effort — first-appearance order already hands the range mechanism
something to work with. Doing better than that — reordering the whole
table so that names shared *across* multiple structs/unions also end up
contiguous for each of them — is a real, named problem, not just an
implementation detail: it's the **Consecutive Ones Property** (does a
0/1 matrix of referrer-vs-name membership admit a column order making
every row's membership contiguous), decidable in linear time via a
**PQ-tree** (Booth & Lueker, 1976) when a single order can satisfy every
referrer at once. When it can't — three referrers pairwise sharing one
name each out of three names is enough to make that impossible, by simple
pigeonhole on how many adjacent pairs a line of 3 elements even has —
*maximizing* how many referrers still end up satisfied is NP-hard in
general, the same complexity class as the physical-mapping problems this
structure shows up in. Implementing or lifting a PQ-tree (or a heuristic
approximating one) is real algorithmic machinery to carry for a payoff
bounded by shaving a handful of index bytes off name-lists in images that
are already small; declined for that reason, same bar applied to
`PUSH_REF` (§6.4) and the nibble-packing question before it.

### 6.4 `PUSH_REF` — optional, decode-mandatory dedup

Every *construction* (everything except `PUSH_REF`/`PUSH_REF_EXT`
themselves) gets an implicit sequential index just by counting how many
have executed so far. Decode already has to retain a table of
constructions to support `PUSH_REF` resolving against it at all
(append-as-built, unconditionally — cheap whether or not an encoder ever
emits one); `PUSH_REF`/`PUSH_REF_EXT` look up `table[nextIndex - delta]`
and push a copy, without adding a new table entry.

The discovery side falls out of §6.2's postorder walk for free: since
each subtree's bytes are fully known the instant it finishes emitting,
keep a `Map<bytes, constructionIndex>` alongside the walk — the literal
emitted bytes as the key, not a hash, since these are small and a direct
key sidesteps collision-handling entirely. Before appending a subtree's
bytes, check whether that exact sequence was already emitted; if so, emit
`PUSH_REF` instead; if not, emit normally and record it.

This is strictly more general than `type-graph.ts`'s own object-identity
sharing: it also catches two independently-written `struct({a: u8, b:
unit})` calls — distinct objects that just happen to be structurally
identical, not only genuine fan-in through one shared thunk. It's also
fully opt-in: an encoder that never populates the map simply never emits
`PUSH_REF` and still produces a correct, fully self-contained tree (real
schemas seen so far — `packages/example`'s `Timestamp` is defined once
and used in exactly one field — have no fan-in at all, so duplicating
whatever sharing *does* show up elsewhere is not assumed to be a real
cost; §6.2's postorder form is the one actually doing the compactness
work, `PUSH_REF` is a strictly-optional refinement on top of it, not load
bearing).

### 6.5 Self-framing

`END` pops the single value the whole stream must have reduced to and
asserts nothing else is left on the stack — a decode-time sanity check
that also means this section needs no outer length prefix: decode simply
runs until it hits `END`.

---

## 7. Container layout

Three sections, concatenated in this fixed order, with no framing between
them at all — none is needed, because each already knows its own length
as it's produced:

1. **Type tree** (§6) — self-framing via `END` (§6.5).
2. **Encoder program** — item 8's `encodeProgram` format: a procedure
   count then a header row per procedure (`argCount`, `bodyLength`) up
   front, so decode already knows exactly how many bytes the whole
   program occupies before reading a single body byte.
3. **Decoder program** — same format as (2).

Decode reads the three in order, each consuming exactly its own bytes and
handing back the next offset; nothing about the container adds anything
beyond what its parts already carry.

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

- **Image container byte encoding.** Done — §6 (a postorder stack
  machine over the type tree, with an opt-in `PUSH_REF` for structural
  dedup) and §7 (the three sections just concatenate; each already
  self-frames, so the container adds nothing on top), implemented in
  `engine/type-tree-wire.ts`/`engine/codec-image.ts` and verified against
  a real `buildCodec`-built encoder/decoder pair, run through the VM after
  a full round trip.
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
