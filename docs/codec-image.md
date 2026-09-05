# Codec Image

> **Status:** implemented. §6 (type tree wire encoding) and §7 (container
> layout) are `packages/codecs/src/engine/type-tree-wire.ts` and
> `engine/codec-image.ts` (ROADMAP.md item 10). §2/§3's reconciliation is
> `packages/core/src/reconcile.ts` (item 11), and `target-js`'s
> `engine/bridging-codec-module.ts` is its first consuming codegen (item
> 12). Builds on docs/codec-extension.md throughout:
> `TypeNode`/`edges`/`Step` (§2.2/§2.4), `CALL_CODEC`'s `ref` addressing
> (§2.4), and the entry procedure's declared object type, the only type a
> wire image names explicitly.

---

## 1. Overview

A **codec image** is the artifact one build produces so a second,
independently-built party can generate its own native ser/des code against
the same wire format, without ever seeing the first party's source schema
and without both parties being redeployed in lockstep when the protocol
changes. It bundles:

- the semantic type tree rooted at the entry procedure's own object type
  (codec-extension.md §2.4; everything else is derived structurally by
  walking it),
- an encoder program and a decoder program, never one call graph between
  them (codec-extension.md §2.3's directionality rule),
- and a declared default value at each of its own struct fields and union
  variants that might need one (§4). The consumer's tree carries its own
  defaults separately, never shipped in the image (§5).

The motivating shape: an embedded device builds once, generates native code
directly from its own schema at build time, and ships a codec image as a
portable description of the wire format it speaks, either embedded in
firmware or published to an artifact store. The other party (a cloud
service, a desktop or mobile client, anything able to defer codegen to
runtime) has its *own* schema, baked into *its* own build from the same
nominal protocol definition, and generates its own ser/des code on demand,
per device, from that device's published image.

This needs its own document because everything in codec-extension.md
describes one coherent program built from one schema. A codec image is
consumed by a *second* build with its own independently-versioned schema,
and the two schemas are not guaranteed to be the same tree: the protocol
can legitimately evolve between when the image's origin was built and when
the consumer generates code against it. Reconciling two structurally
similar but not necessarily identical trees, gracefully, is a distinct
concern from anything the codec bytecode ISA needs to know about.

Throughout, **origin** is the party whose build produced the image. It owns
the *image tree*, the schema the bytecode was compiled against, which is
authoritative for the wire format in both directions. **Consumer** is the
party generating native code from a received image, reconciling it against
its own independently-built **local tree**.

---

## 2. Reconciliation

Reconciliation is a lock-step walk of the image tree and the local tree
from each root, matching corresponding nodes and computing, per node, how
the consumer's generated code should bridge "what the bytecode navigates in
the image tree" to "where the corresponding value lives in the consumer's
own object model."

### 2.1 Matching key: name, not position

`TypeGraph`'s `edges` (`@ppl/core/type-graph.ts`) are ordered: a struct's
`Map<string, SemanticType>` iterates in declaration order, and
`ENTER`/`CALL_CODEC`'s `ref` operand addresses that order positionally
(codec-extension.md §2.4). That positional order is fixed forever for the
*image* tree, since the shipped bytecode already navigates by it, and
reconciliation never changes it.

Two independently-evolved trees are not guaranteed to agree on position: a
field added after the image was built lands wherever its own author's
`struct({...})` call put it. Reconciliation therefore matches struct fields
and union variants by **name** (`Step`'s
`{field: string}`/`{variant: string}`), never by `ref` index. A list has
exactly one element edge (codec-extension.md §3.4), so it needs no name at
all.

The output per shared node is exactly the mapping a native codegen needs:
"image edge `#K`, named `foo`, corresponds to local storage location `L`."
That mapping is baked into the *generated* accessor code (`myStruct.foo`, a
computed field offset). The bytecode's `ref` operands are never rewritten;
they stay positional into the image tree as shipped. Reconciliation is a
codegen-time bridge, not a transformation of the image.

### 2.2 What must match exactly

A node's *kind* (struct/union/list/integer/unit, `SemanticTypeKinds`) must
agree wherever both trees have the node. Kind-changing evolution, a field
that was an integer becoming a struct, is out of scope: reconciliation
rejects it rather than defining what it would mean.

An integer's *range* may differ, in one direction per side (§3):
consumer-decode needs `imageRange ⊆ localRange`, since whatever width the
wire carries must fit local storage; consumer-encode needs the actual value
being sent to fit `imageRange`, checked at generation time where possible
and at runtime otherwise, since a genuinely out-of-range value is a real
error rather than a reconciliation question. The wire *width* `WRITE`/`READ`
use is always the image's own (`intWireSize` of the image's declared range);
the local range bounds only what the consumer does with the value on its
own side, because the wire format is the image's to define.

### 2.3 Where the two trees may diverge

Everywhere else: a struct having a field the other doesn't, a union having
a variant the other doesn't, a list's declared capacity differing.
Reconciliation resolves these per §3's direction-and-width rules instead of
rejecting them, which is the entire point of doing this walk rather than
requiring the two trees to be isomorphic.

### 2.4 Implementation shape

`packages/core/src/reconcile.ts`, target- and codec-independent the way
`raise.ts` is target-independent in `mog-core`: it computes a mapping a
target codegen consumes and knows nothing about any target language, wire
byte or opcode. Two functions, deliberately separate:

```ts
export function reconcile(imageRoot: TypeNode, localRoot: TypeNode): Correspondence
export function resolve(parent: Correspondence, edge: CorrespondenceEdge, direction: Direction): Resolution
```

`reconcile` is the direction-agnostic lock-step walk of §2: one
`Correspondence` tree pairing `imageRoot`'s `TypeNode` (from a `TypeGraph`
built over the decoded image tree, `buildTypeGraph(decoded.typeTree)`)
against `localRoot`'s own. Both sides are ordinary `TypeNode`s once the
image tree is decoded. It throws on a §2.2 kind mismatch; every other
divergence becomes a `"matched"`, `"image-only"` or `"local-only"` node.

A `Correspondence` carries **no name of its own**: struct fields and union
variants are `CorrespondenceEdge {name, correspondence}` pairs off
`.children`, mirroring `type-graph.ts`'s `TypeEdge {step, target}` split,
where a `TypeNode` has no name and only the edge reaching it does.
`reconcile` is memoized on the exact `(imageNode, localNode)` pair,
mint-before-recurse like `buildTypeGraph`'s `byObject` cache, so a cyclic
or independently-shared position returns the *same* `Correspondence` object
a caller may already hold elsewhere. That is what lets a codegen
monomorphize one generated procedure per distinct pair, the same way
`resolver.ts` does via `TypeNode` identity. Putting a name on the node
would report the *first* edge's name for every later edge reaching the same
shared or cyclic node.

`resolve` is the direction-*aware* step turning one *edge* into what a
codegen should emit, which is why it takes `parent` alongside the edge: a
struct field and a union variant need different rules under the same
outcome, and only the parent's own kind (read off
`parent.imageNode`/`parent.localNode`) says which applies. `parent` must
itself be `"matched"`, never a limitation in practice: a non-`"matched"`
edge's own resolution already fully describes what to do with everything
nested inside it (§3.2's reasoning, that dropping a struct field write is
safe regardless of what the field's type contains), so a real caller only
calls `resolve` on children of an edge it already bridged into.

**The asymmetry `resolve` has to get right.** A struct field is an
always-present slot regardless of direction, so all four combinations of
(extra side × direction) are real and each needs a resolution. A union
variant is a mutually-exclusive choice, so only two of its four
combinations are ever reachable at runtime:

| Parent kind | Extra side | Direction | §3 rule | Resolution |
|---|---|---|---|---|
| struct | image-only | decode | §3.2 | `drop` |
| struct | image-only | encode | §3.3 | `default` (from image) |
| struct | local-only | decode | §3.1 | `default` (from local) |
| struct | local-only | encode | §3.4 (additive) | `drop` |
| union | image-only | decode | §3.2 | `default` (local's declared default variant), or `trap` if none |
| union | image-only | **encode** | none | **`unreachable`**: encode switches on the local value's active variant, which can never be a variant local's type doesn't define |
| union | local-only | **decode** | none | **`unreachable`**: decode switches on the incoming tag, which is always one the image declares |
| union | local-only | encode | §3.4 (all-or-nothing) | `trap`, no wire representation |

The two `unreachable` rows are combinations §3 never needed a rule for,
because the union's own selection mechanism (the local value's active
variant on encode, the wire tag on decode) rules them out structurally.
`resolve` names this explicitly, as a fifth `Resolution` case, rather than
returning `drop` or fabricating a `default` for a branch that can never
execute. A codegen still has to emit *something* there, since the bytecode
instruction genuinely exists, so `"unreachable"` and `"trap"` both compile
to a runtime throw, never a codegen-time failure.

Two things §2.2 leaves to the caller: an integer's range compatibility
(`imageRange ⊆ localRange` for decode, the actual value fitting
`imageRange` for encode) and a list's capacity. Both read directly off
`c.imageNode.type`/`c.localNode.type` on a `"matched"` `Correspondence`,
and §2.2 already frames the value-fitting half as the consuming codegen's
job rather than a structural reconciliation question.

---

## 3. Relaxation rules

Four cases crossing two axes: which side is wider, and which direction data
flows. These are rules a reconciliation implementation must apply, not
default behavior that happens to fall out.

### 3.1 Decode, local tree wider

Extra local fields or variants, wider ranges, larger capacity. The
consumer's object has storage the image's bytecode never addresses, so no
`ENTER`/`STORE_VAL` targets it and generated code never writes to it. What
it holds instead depends on whose job it was to allocate that storage,
which below the root is not generally the application's.

Only the root handle is caller-supplied (`createCodecExtension`'s `root:
Handle` parameter, matching `roundTrip`'s `{root: {}}` pre-seed in
`builders.test.ts`). Everything the decoder navigates into below the root
it instantiates itself, mid-walk: a nested struct field
(`ensureDecodedStructExists`, `codec-extension.ts`), a union's active
variant payload (`computeChild`'s `set(src, {variant, value: undefined})`),
a list element. None of those pre-exist for an application to have
pre-seeded, so "keep whatever the application already put there" is not a
coherent answer: there was nothing there a moment before the decoder
created the container.

So a local-only field inside anything the decoder instantiates needs an
initial value, and the only tree that knows the field exists is the local
one. It needs the same kind of **declared default** §3.3 needs from the
image, sourced from the opposite side (§4 covers both). This is fully
symmetric with §3.3: whichever tree has the field supplies its own default
when the other party's codegen needs a placeholder.

*How* that default gets applied is a target-codegen choice, not something
this document mandates: the generated decoder can assign it explicitly
wherever it instantiates a container (the plain-object model
`codec-extension.ts` uses today), or a Buffer-to-mapped-type generator can
bake it into the memory layout so every freshly-decoded object already
reads back the right value with no per-field assignment. Either way the
default must exist and be known at codegen time.

### 3.2 Decode, image tree wider

Extra image fields or variants the local tree doesn't know. The bytecode
still fully specifies how to read (and navigate past) the unrecognized
data, having been compiled against the wider image tree. Generated code
executes that reading faithfully, so the stream cursor stays correctly
positioned for whatever follows; what happens to the *value* differs by
kind.

For a struct field the write is dropped. There is no local storage location
to bridge it to, and this is unconditionally safe: a struct's shape doesn't
depend on which fields are present, so skipping one write changes nothing
about how any other field is read.

For a union, the active variant *is* the payload's shape. An unrecognized
variant tag still gets its payload read correctly, since the bytecode was
generated against the image tree and knows exactly how many bytes and what
structure that payload has, regardless of whether the consumer understands
it. What happens locally depends on whether the local union type declares a
**default variant** (§4). If it does, decode materializes that variant, the
same declared default a missing struct field reaches for, arrived at via an
unrecognized tag instead of an absent field. If it doesn't, decode
**traps**: a union's active variant is its shape, so silently materializing
nothing would leave the local object holding a value from no case its own
type admits. Whether that is tolerable is exactly the call §4 assigns to
whichever union declares, or deliberately doesn't declare, a default
variant. An instruction-opcode-style union (every variant `unit`, no
natural fallback) is a real "don't default, trap" case.

Still open: a default variant reached because §4 needed *some* value for a
struct field of this union's type (§3.1/§3.3) and one reached because an
*incoming tag wasn't recognized* are indistinguishable outcomes on the
wire, both landing on the same named variant. An application needing to
tell "this decoded fine as that variant" from "this arrived as something my
build doesn't recognize yet" has no mechanism beyond its own naming
convention, such as reserving a variant literally named `unrecognized`.

### 3.3 Encode, image tree wider

The image describes a field or variant local has no source value for. The
mirror of §3.2, except encode cannot drop the write: the wire format the
image describes needs well-formed bytes at that position, and there is no
equivalent of "the bytecode already knows how to skip it", because encoding
produces bytes rather than consuming them. The consumer substitutes the
field's or variant's **declared default**, carried in the image's own type
tree (§4), read from the image because the image is the only place a value
for a field the consumer's model lacks entirely could come from.

### 3.4 Encode, local tree wider

Local wants to represent something the image has no case for. Whether that
is safe depends on *what kind* of extra it is, so this splits in two rather
than being one blanket rule.

**Additive extras (a local-only struct field) drop silently.** A struct
field being additive is what makes a narrower peer tolerant of its absence
(§3.2's reasoning run the other way), so encoding omits it exactly as §3.2
omits the write on decode.

**All-or-nothing extras (a local-only union variant, or a local integer
value outside the image's declared range) trap.** Neither has a value to
fall back to: a union variant has no wire representation for "this data's
shape has no case in the target schema" that wouldn't misrepresent it, and
an out-of-range integer has no legal substitute that wouldn't be a
different, wrong number. Unlike §3.3, there is no default to reach for,
because it is the *consumer's own real data* rather than an absent slot
that doesn't fit.

The dividing line that matters is additive versus all-or-nothing, not
"local tree wider" as a category. Today that means struct fields drop and
union variants (or out-of-range integers) trap, and the same split applies
to any future kind with a union's one-of-several-incompatible-shapes
structure.

---

## 4. Declared defaults

§3.1 and §3.3 are the two relaxations needing a value from somewhere other
than the consumer's own data or "just don't write it": a schema-level
addition reconciliation cannot synthesize. The two are symmetric: whichever
tree declares a given field supplies its default, whether that is the image
(§3.3, encode) or the local tree (§3.1, decode).

**Where it attaches.** On the type value itself, not on a separate slot
between name and type. `type-graph.ts` keys sharing by type-*object*
identity rather than structure ("same JS object → same `TypeNode`; the
author controls sharing by how they construct and export types"), so "the
same leaf type such as `u8`, reused across many fields, needs a different
sensible default in each context" is not a gap needing a per-slot wrapper:
a field needing its own default doesn't reuse the shared `u8` constant, it
constructs its own `integer(0, 255, d)` value, which already gets its own
`TypeNode`. `struct()`/`union()` keep building a plain
`Map<string, SemanticType>`.

**What it is, per kind** (implemented in `@ppl/core/metamodel.ts`,
ROADMAP.md item 9):

- **Integer**: a third constructor parameter, `default = 0`
  (`IntegerType.default: number`). Every existing constant (`u8`, `i16`,
  …) gets default `0` for free, since none passes a third argument.
- **Unit**: none; carries no data.
- **List**: none, ever. An unfilled list is empty, the only value absence
  can coherently have for a list.
- **Struct**: none authored. Always the recursive composition of its own
  fields' declared defaults, so a whole nested default object is never
  hand-authored as one literal blob.
- **Union**: opt-in, naming one of its own variants as the **default
  variant**, restricted to a `unit`-valued one so it never needs a payload.
  Deliberately not mandatory: an all-`unit`, instruction-opcode-style union
  with no natural fallback (§3.2) must trap instead, and that is the type
  author's per-union call.

A composite default bottoming out in a union with no declared default
variant fails. Since which defaults get asked for is fully knowable once
the two trees are reconciled (§2), that failure belongs at build/codegen
time, not deferred to a per-message runtime trap the way §3.4's real
out-of-range-value trap has to be.

**When it's required.** Only a field actually reached by §3.1 or §3.3 needs
one, but nobody can know in advance whether a given field will be "the
extra one" in some future counterpart's narrower tree, on either side (a
device's older schema missing a field the server added, or a server's
schema missing a field a newer device added). So the authoring discipline
is: **declare a default at the point a field or variant is added**, not
retroactively for everything predating this mechanism, and regardless of
which party's schema is adding it. This mirrors Avro's schema-evolution
convention for new record fields, for the same reason: it is the one point
in a field's lifetime where "what should an old reader do if it doesn't
know I exist yet" is a question whoever adds the field is best placed to
answer.

---

## 5. What the image carries

- The semantic type tree, rooted at the entry procedure's declared object
  type (codec-extension.md §2.4), additionally carrying each integer's
  declared `default` and each union's declared `defaultVariant` if any
  (§4), since §3.3 reads them *from the image*. §3.1's defaults are the
  mirror: declared in the *consumer's* own schema, compiled into its
  on-demand codegen exactly as the image's are compiled into the origin's,
  and never crossing the wire either way. Each side's defaults live with the
  tree that declares them.
- One encoder program, one decoder program, unchanged from what
  codec-extension.md specifies. Reconciliation is purely a codegen-time
  bridge (§2.1) and changes nothing about the bytecode's shape or
  addressing.

It carries no per-resource peak-usage stats (ROADMAP.md item 8: nothing
consumes them, and this domain wants maximum compactness) and no
per-procedure header data beyond the entry's root type (codec-extension.md
§2.4: every other handle's type is derived, never declared).

---

## 6. Type tree wire encoding

### 6.1 A postorder stack machine, not a table of nodes with pointers

The bytecode already encodes a tree with zero pointers: `ref` operands
(`ENTER`/`CALL_CODEC`, codec-extension.md §2.4) are *local*, positional
into whichever node the current handle stands on rather than global indices
into a tree-wide table. The only place a node's global identity matters is
the single entry binding, handle 0 ↔ root type. Nothing downstream of
decode cares how this section represents the tree internally, only that
decode hands back the right shape, so this wire format is free to pick
whatever is most compact, independently of §2's algorithm and item 8's
program envelope.

A tree walked postorder never needs a reference to a child: by the time a
parent is described, its children are fully built and sitting where the
last few construction steps left them. That reads as a tiny stack machine:
leaves push a value; a list/struct/union pops however many children it has
and pushes the combined result. No node says "my child is over there"; the
child is whatever the machine just finished building.

### 6.2 Instructions

One byte-tag instruction stream, decoded by a stack machine over a value
stack of already-built (sub)types. The top 2 bits of the tag pick a
*family*. For the three families recurring once per tree node (`STRUCT`'s
field count, `UNION`'s variant count, `PUSH_REF`'s delta) the low 6 bits
*are* the payload, so there is no separate count or delta operand for any
realistic value (0-63, or 1-64 for the 1-based `PUSH_REF` delta). Decode is
`family = byte >> 6; payload = byte & 0x3F`:

| range | family | payload |
|---|---|---|
| `0x00`-`0x3F` | `STRUCT` | field count = payload (0-63) |
| `0x40`-`0x7F` | `UNION` | variant count = payload (0-63) |
| `0x80`-`0xBF` | `PUSH_REF` | delta = payload + 1 (1-64 constructions back, §6.4) |
| `0xC0`-`0xFF` | everything else | sub-selected by payload |

`STRUCT`/`UNION` are followed by a name specification, the range-list form
§6.3 defines, self-terminating once it has supplied exactly that many
names; `UNION` adds one more LEB128 (`0` = no default variant, else
`index + 1`, §4). A struct or union with ≥64 members, or a `PUSH_REF` more
than 64 constructions back, falls through to the fourth family's
explicit-count escapes. Realistic schemas never reach them; they exist so
nothing silently breaks on one that does.

Fourth family (`0xC0`-`0xFF`), plain sequential tags: there is no
per-node recurrence to exploit here, so a byte per tag is already at floor.

| byte | instruction | operands |
|---|---|---|
| `0xC0` | `PUSH_UNIT` | none |
| `0xC1`-`0xC6` | `PUSH_U8` / `I8` / `U16` / `I16` / `U32` / `I32` | none; covers every constant `metamodel.ts` exports |
| `0xC7` | `PUSH_INT_MIN0_D0_EXT` | max (zigzag-LEB128); `min = 0`, `default = 0` |
| `0xC8` | `PUSH_INT_MIN0_EXT` | max, default; `min = 0` |
| `0xC9` | `PUSH_INT_D0_EXT` | min, max; `default = 0` |
| `0xCA` | `PUSH_INT_EXT` | min, max, default: the fully general case |
| `0xCB` | `LIST` | none (uncapacitated) |
| `0xCC` | `LIST_EXT` | capacity: LEB128 |
| `0xCD` | `STRUCT_EXT` | fieldCount: LEB128, then a name specification (§6.3) |
| `0xCE` | `UNION_EXT` | variantCount: LEB128, name specification, defaultIndex |
| `0xCF` | `PUSH_REF_EXT` | delta: LEB128 |
| `0xD0` | `END` | none; pop the one remaining value (which must be the only one left) as the root type, section over |
| `0xD1`-`0xFF` | reserved | |

Four integer forms rather than one general form: `default = 0` is the
common case even for a non-canonical range (§4's declare-at-point-of-need
discipline means most fields never override it), and `min = 0` covers most
non-canonical ranges anyway (an arbitrary-width unsigned count or
percentage, not just the six canonical widths). Both fold independently, so
all four combinations get their own tag rather than paying for operands the
common cases don't need, the same move `wire.ts` makes for the codec
opcodes.

Encode is a bare postorder walk, no bookkeeping beyond §6.4's:

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

Field and variant names never appear inline. They live in a table preceding
the instruction stream: `count: LEB128`, then `count` length-prefixed UTF-8
entries, deduplicated at encode time via a `Map<string, index>` built while
walking, in first-appearance order.

The table belongs to the type tree section, not the container: the two
programs carry no names at all, addressing everything positionally via
`ref` (§6.1), and reconciliation's name matching (§2.1) only ever touches
the *decoded* tree.

**Name specification.** `STRUCT`/`UNION` reference the string table as a
list of *ranges*, read until it has supplied exactly as many names as the
instruction's own count said to expect, so no separate range count is
needed. Unlike §6.2's outer instruction stream this sub-encoding is not
opcode-tagged: it is a private format contextually known to be exactly this
shape (a run of small integers, mostly length 1, occasionally longer), free
to use whatever is most compact.

Each range is `(base, length)`, meaning names at string-table indices
`base, base+1, …, base+length-1`, encoded as one or two LEB128 values:

- **`length = 1`** (the common case): one LEB128, `(base << 1) | 1`.
- **`length ≥ 2`**: two LEB128 values, `(length - 2) << 1` then `base`
  plain.

Decode reads one LEB128 `v`: odd means `base = v >> 1, length = 1`; even
means `length = (v >> 1) + 2` with a second LEB128 supplying `base`. Fill
that many slots from `base` upward, advance, read another range if slots
remain.

Given a fixed string-table order an encoder never needs to search for the
best partition into ranges: merging two numerically-adjacent pieces into
one longer range never costs more (one range of length *L* always costs ≤
splitting it) and often costs less, so greedily extending each run as far as
consecutiveness holds is optimal. A `length = 2` range costs the same two
LEB128 values as two separate `length = 1` entries, a wash rather than a
loss.

**Why the string table's order stays first-appearance.** A struct that is
the first place all of its own names appear already gets them as a
contiguous run for free. Doing better, reordering the whole table so names
shared *across* multiple structs and unions also end up contiguous for each
of them, is the **Consecutive Ones Property**: does a 0/1 matrix of
referrer-versus-name membership admit a column order making every row's
membership contiguous. It is decidable in linear time via a **PQ-tree**
(Booth & Lueker, 1976) when a single order satisfies every referrer at
once; when none does (three referrers pairwise sharing one name each out of
three names suffices, by pigeonhole on how many adjacent pairs a line of 3
elements has), *maximizing* how many referrers stay satisfied is NP-hard,
the same complexity class as the physical-mapping problems this structure
appears in. Implementing or lifting a PQ-tree, or a heuristic approximating
one, is real algorithmic machinery for a payoff bounded by shaving a handful
of index bytes off name lists in images that are already small. Declined
for that reason, the same bar applied to `PUSH_REF` (§6.4).

### 6.4 `PUSH_REF`: optional dedup, decode-mandatory

Every *construction* (everything except `PUSH_REF`/`PUSH_REF_EXT`) gets an
implicit sequential index by counting how many have executed. Decode
retains a table of constructions unconditionally to support `PUSH_REF` at
all, appending as it builds, which is cheap whether or not an encoder emits
one; `PUSH_REF`/`PUSH_REF_EXT` look up `table[nextIndex - delta]` and push a
copy without adding a new entry.

Discovery keys on a structural *signature*, a pure function of shape (kind,
range, field/variant names, recursively) computed before deciding whether to
recurse into children. Keying on the emitted bytes instead never matches a
repeated composite's second occurrence: its children resolve to short
backrefs the first occurrence's construction bytes lack, so two occurrences
of the same shape never look byte-identical.

This is strictly more general than `type-graph.ts`'s object-identity
sharing, catching two independently-written `struct({a: u8, b: unit})` calls
as well as genuine fan-in through one shared thunk. It is also fully
opt-in: an encoder that never populates the map emits no `PUSH_REF` and
still produces a correct, self-contained tree. Real schemas so far
(`packages/example`'s `Timestamp` is defined once and used in one field)
have no fan-in at all, so §6.2's postorder form does the compactness work
and `PUSH_REF` is a strictly optional refinement on top.

### 6.5 Self-framing

`END` pops the single value the whole stream must have reduced to and
asserts nothing else is left on the stack: a decode-time sanity check that
also means this section needs no outer length prefix, since decode simply
runs until `END`.

---

## 7. Container layout

Three sections concatenated in fixed order with no framing between them,
because each already knows its own length as it is produced:

1. **Type tree** (§6), self-framing via `END` (§6.5).
2. **Encoder program**, isa-core.md §5.5's format: a procedure count, then
   each procedure's own `argCount` immediately followed by its own body —
   no stored body length; decode finds where one ends by walking it (a
   body is self-delimiting, §8.4).
3. **Decoder program**, same format.

Decode reads the three in order, each consuming exactly its own bytes and
handing back the next offset. This is why `decodeProgram` returns
`{program, next}`: a single program is not self-delimiting from the
outside.

---

## Appendix - Worked Example

A tiny struct rather than the real `packages/example` schema, whose own
fields all happen to be present in every version considered so far and so
cannot illustrate divergence.

Origin (device) builds, at version 1:

```ts
const ReadingV1 = struct({ id: u8, value: i16 })
```

Version 2 adds a field with a declared default (§4), which is what lets an
older consumer's decode ignore it gracefully while a newer consumer's
encode still has something well-formed to send to an older device:

```ts
const ReadingV2 = struct({ id: u8, value: i16, quality: u8 /* default 0 */ })
```

**Consumer built against V1, device ships a V2 image (decode).** The image
tree is wider (`quality` is new). Generated decode reads `id` and `value`
into the consumer's `ReadingV1`-shaped object as before; the bytecode's read
of `quality`'s byte still executes so the stream cursor lands correctly on
whatever follows, but nothing is written locally (§3.2). The consumer's
object has no `quality` at all, because its own tree never declared one.

**Consumer built against V2, decoding a V1 image, new field inside a union
payload (§3.1).** Suppose `quality` had been added inside a `SensorKind`
union's `temperature` variant instead of at `Reading`'s top level:
`temperature: struct({ celsius: i16, quality: u8 /* default 0 */ })`. The
`temperature` payload object doesn't exist until decode selects that
variant, so there is nothing for an application to have pre-seeded. When
generated decode selects `temperature` and instantiates its payload, it
assigns `quality` its declared default right there: not because the V1 image
says anything about `quality`, which it doesn't know exists, but because
V2's own local tree declares it and this is the only point decode touches
this freshly-allocated object.

**Consumer built against V2, device ships a V1 image (encode).** The image
tree is narrower. The consumer has a `quality` value in hand and nowhere in
the image's wire format to put it, and per §3.4's struct case that is fine:
the field is never written, exactly as a V1 device expects.

**Consumer built against V1, device ships a V2 image (encode).** The image
tree is wider. The consumer's `ReadingV1` object has no `quality` value, so
generated code substitutes V2's declared default `0` (§3.3), and the
V2-shaped wire bytes this device expects come out well-formed.

**A union's default variant (§3.2/§4).** Suppose `SensorKind` is
`union({ temperature: ..., humidity: ..., unrecognized: unit },
"unrecognized")` at the server's (consumer's) build, and an older device
ships an image whose `SensorKind` has a third variant the server predates,
say `pressure`. Decoding a `pressure` reading: the bytecode reads its
payload correctly, having been compiled against the image, which does know
`pressure`'s shape, but the server's tree has no `pressure` case to write
into, so decode selects `unrecognized` instead of trapping, because
`SensorKind` declared a default variant for exactly this. Had it not named
one, this scenario would trap: the same union, minus one constructor
argument, trades graceful degradation for failing loudly, and that trade is
the type author's call.

---

## Appendix - Deferred Design Points

- **Explicit "unrecognized variant" case.** Mostly answered by §3.2's
  default-variant refinement, where a union opts in by declaring one. Still
  open: a default variant reached via §4 (composing a struct field's
  default) and one reached via an unrecognized incoming tag (§3.2) are
  indistinguishable on the wire, so an application needing to tell them
  apart has no mechanism beyond its own naming convention.
- **Kind-changing evolution** (§2.2). Rejected outright.
- **List element-type evolution.** A list's one element edge reconciles by
  the same struct/union-field rules already given. **List capacity** is a
  different shape from an integer range: `ListType.capacity`
  (`@ppl/core/metamodel.ts`) bounds the *host* container, while the image's
  declared capacity only shows up baked into the wire count-prefix's byte
  width (`binary-rules.ts`'s `countPrefixWidth`, a component convention,
  not part of the core ISA). A real message's element count could exceed
  local capacity regardless of what either tree declares, which is a
  per-message runtime bound check, closer to §3.4's integer-range overflow
  than to anything §2's static tree walk resolves once and for all. Not
  designed here.
