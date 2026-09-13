# Value semantics

**Status: design sketch, unimplemented.** TODO.md's "target-side
transformation (unit of measurement)". Nothing in `src/` references
any of this yet.

## 1. The gap

The metamodel pins the *shape* of a value and reconciliation checks it.
Neither says anything about what a number *means*, so this reconciles
clean and produces silent garbage:

```ts
const V1 = struct({ battery: integer(0, 4095) })   // raw ADC counts
const V2 = struct({ battery: integer(0, 4095) })   // millivolts
```

`reconcile` sees two matched integer leaves and `resolve` returns
`{action: "bridge"}`. This is worse than the failures reconciliation
already catches: a kind mismatch throws (reconcile.ts:168), a range
mismatch is checked (§2.2), a meaning mismatch is invisible.

The class is wider than units. Each of these is also two matched integer
leaves and a silent bridge:

- Unix seconds vs Unix milliseconds vs NTP vs .NET ticks;
- a UTC instant vs a zoneless civil one stored the same way;
- degrees × 1e7 vs binary angle measure;
- an Ethernet MAC vs the byte-reversed form BLE advertises;
- an IPv4 host address vs a netmask.

Both declarations say `integer(0, 4095)` because that is the only thing the
metamodel lets them say, and neither one is stating a protocol fact. The
protocol's fact is *battery voltage, 2.5 to 4.2 volts, to a millivolt*.
`0..4095` is one party's answer to how it holds that.

## 2. Layer split

The bug in §1 is a conflation, so the fix is a split.

| | semantic — the protocol asserts it | projection — one peer decides it |
|---|---|---|
| shape | which fields, of which kinds | wire width, endianness, varint |
| value | kind, canonical range, resolution | integer or float, scale and offset, repertoire, text encoding, storage form |

**Both columns travel.** codec-image.md §5 has the image carry the semantic
type tree *and* an encoder and a decoder program, and those programs are
nothing but projection — every width, endianness and varint decision is
compiled into them. So "a consumer cannot decode without it" establishes
that something has to travel. It establishes nothing about whether that
thing is semantic.

That inference is what §1 turns on. `805.664 µV per count` is a fact about a
board: twelve bits against a 3.3 V reference. It is not a fact about
batteries. A host that wants a `float` in volts and a sensor that wants raw
counts do not disagree about the protocol, and neither should have to write
the other's preference into the schema.

**The transform therefore belongs to the projection.** Each peer declares
how it holds a value, and the bridge composes two such declarations through
the canonical that the kind names (§5.3). The origin's declaration travels
beside its programs, as layout.

**Representations are projection the whole way down.** The metamodel has
five kinds — `unit`, `integer`, `list`, `struct`, `union`
(metamodel.ts:5-12) — and no string among them. Dot-decimal, colon-hex,
IPv6 `::` elision, UTF-8 and UTF-16 are renderings, never wire forms of
their own. §7 puts text's whole stack in this column bar one residue.

**What the split buys.** §1's two declarations collapse into one semantic
type with two projections, and the bridge between them is computed. The bug
stops being detectable and becomes unwritable, which beats a check.

## 3. `Quantity` — the semantic side

A value whose meaning is a point on a continuum is not an integer, so it
needs a leaf of its own. `integer(min, max)` stays for values whose semantic
space really is the integers — a CAN identifier, an index, a codepoint — and
those take a `kind` without a range or a resolution.

```ts
/** Exact rational. Normalized, den > 0. Never a float — see §4. */
export interface Rational { readonly num: number; readonly den: number }

export interface Quantity
{
    /** Namespaced nominal kind. Compatibility is equality, and that is the
     *  whole check. The kind names its own canonical: `si:voltage` is the
     *  volt, `time:utc-instant` POSIX seconds. */
    readonly kind: string
    /** Inclusive bounds, in that canonical unit. */
    readonly min: Rational
    readonly max: Rational
    /** The largest step a representation may quantize to. Ada's `delta`. */
    readonly resolution: Rational
}

export const scalar = (q: Quantity): ScalarType => ({kind: SemanticTypeKinds.Scalar, quantity: q})
```

**`resolution` is mandatory, and it is what makes the range mean anything.**
Without it, `2.5 .. 4.2 V` is satisfied by four bits, and §5.2 has no
baseline against which "you threw away four bits" could be measured. With
it, a representation either meets the contract or does not.

Range and resolution together are Ada's `type Volt is delta 0.000805664
range 0.0 .. 3.3` — the type states the interval and the step, the compiler
picks a machine representation. §10 already calls Ada the closest
philosophical match to PPL's premise; this is the part being matched.

**Compatibility is nominal.** `kind` has to be specific enough to separate
torque from energy, both N·m, and ratio / percent / dB / ADC-count / radian,
all dimensionless — pairs no dimensional analysis (F#, Boost.Units) can
split. A `kind` that specific already determines its dimension, so carrying
an SI vector alongside adds no information a check can use; it can only
disagree with the kind that implies it.

`kind` is a bare namespaced string. A registry (J1939's SLOT catalog is the
model) is a later refinement; the checking works without it, and the
namespace prefix keeps two authors' `pressure` apart in the meantime.

Two kinds sharing a canonical they never convert between is a coincidence:
`time:utc-instant` and `time:civil-instant` are both POSIX seconds,
`ipv4:host-address` and `ipv4:netmask` both 32-bit integers, and in each
pair the second is the bug the first has to be checked against.

## 4. `Representation` — the projection side

One per leaf per build. Never part of the semantic tree, and never
reconciled against a peer's — §5.3 composes the two instead.

```ts
export interface Representation
{
    /** The value space this build actually stores. */
    readonly stored: IntegerType | FloatType
    /** Stored value -> the canonical value the leaf's `kind` names. */
    readonly toCanonical: Transform
}
```

### 4.1 `Transform` — the algebra

Total on a declared domain, deterministic, composable, invertible. That
contract is what lets codegen fold a transform, and §4.2 spends it a second
time as this document's scope boundary. Only `table` has a domain narrower
than its input type; §7.2 is why.

```ts
export type Transform =
    | {readonly op: "identity"}
    /** canonical = scale * x + offset */
    | {readonly op: "affine"; readonly scale: Rational; readonly offset: Rational}
    /** canonical = reference * base ** (x / factor).
     *  dB power: base 10, factor 10. dB amplitude: factor 20.
     *  `reference` is mandatory — it is where dB bugs actually live
     *  (dBm vs dBV vs dBFS). */
    | {readonly op: "log"; readonly base: Rational; readonly factor: Rational; readonly reference: Rational}
    /** NTC / thermocouple curves. A2L's TAB_INTP / TAB_NOINTP. */
    | {readonly op: "table"; readonly points: readonly (readonly [number, number])[]; readonly interp: "none" | "linear"}
    /** Escape hatch, as mog-core IR rather than an unexecutable
     *  string (contrast A2L's FORM). Inverse must be declared. */
    | {readonly op: "formula"; readonly forward: ProcedureRef; readonly inverse: ProcedureRef}
```

**Scale is an exact rational, never a float.** Store `3.3/4096`, not
`0.000805664`. Consequences:

- chains compose exactly; a further divider stage stays exact;
- "is this ratio a power of two, emit a shift not a multiply" becomes
  decidable at codegen time — the `std::chrono::duration<Rep, Period>` /
  Simulink-slope-bias trick;
- identity is recognizable, so the common case folds to nothing.

**Composition** is only closed for affine (`affine ∘ affine = affine`), so
`compose` returns `readonly Transform[]`, normalized by folding adjacent
affines and dropping identities. A one-element `[{op:"identity"}]` result
means codegen emits nothing.

**Inversion** — encode is decode inverted: affine iff `scale ≠ 0`, log
always, formula only via its declared inverse. A table inverts iff injective
for `interp: "none"` and iff strictly monotonic for `interp: "linear"`,
which is what interpolating an inverse actually needs; both validate at
build time.

**The op set spans the non-physical kinds too.** With `time:utc-instant`'s
canonical fixed at POSIX seconds, nothing below is new machinery:

| stored | `toCanonical` |
|---|---|
| Unix milliseconds | `affine{1/1000, 0}` |
| NTP seconds | `affine{1, -2208988800}` |
| .NET ticks, 100 ns since 0001 | `affine{1/10^7, -62135596800}` |
| Windows FILETIME, since 1601 | `affine{1/10^7, -11644473600}` |
| degrees × 1e7 | `affine{1/10^7, 0}` |
| binary angle measure, 2^31 per 180° | `affine{45/2^29, 0}` |
| GPS or TAI seconds | `table`, `interp: "none"` |

Binary angle measure is the power-of-two case above, so BAM to degrees × 1e7
is a shift and known to be one at codegen time. The last row carries the
difficulty: GPS and TAI run without leap seconds, so they are affine only
within a single leap era, and the op that covers them is the one introduced
for thermistor curves. It is monotonic and so invertible, though not
*strictly* at a positive leap, which leaves the inverse ambiguous for
exactly one second. The ambiguity is in the timescales themselves.

### 4.2 What the contract excludes

The contract decides where the line falls without an argument about taste.
One question settles every candidate: **is there a shared canonical, and is
the map to it total on a declared domain, deterministic and invertible?**

| | |
|---|---|
| yes | a `Transform` — epoch offsets, geodetic and register scaling |
| shared *role*, no shared canonical | a `union` — §8 |
| map exists, contract fails | out of scope, and stays there |

Source code to a binary program is the third row: compilation has no
inverse. DNS resolution fails four ways — not total, not deterministic, not
a function, not invertible — which puts domain-name-vs-IP in the second row,
as §8's union.

### 4.3 Point and displacement rest on the kind string

Durations add, instants do not, and the difference of two instants is a
duration. Separating them is the kind string's job: `si:duration` and
`time:utc-instant` are different kinds, so §5.1 throws, the same way it
throws on torque against energy.

What remains is the authorship risk §9 names. An author who writes
`si:temperature` for both an absolute reading and a difference gets a silent
bridge that adds 273.15 to a delta, and nothing can see it, because the kind
string was where that distinction had to be made. Absolute vs differential
pressure is the same shape. Open.

## 5. Three checks

Splitting §2's columns splits the checking with them. Two of these are new
and one already existed.

### 5.1 Semantic compatibility — `reconcile`, throws

Per-pair, build-time, in `reconcile`'s existing exact-match check alongside
the type-kind test at reconcile.ts:168.

| image | local | outcome |
|---|---|---|
| same `kind` | same `kind` | compatible; §5.3 computes the bridge |
| `kind` differs | | throw — §1's whole class |
| ranges disjoint | | throw |
| image range wider | | narrowing — §5.3's policy decides |
| undeclared | undeclared | compatible, no transform (today's behavior) |
| declared | undeclared | **warn**, bridge untransformed |

One failure tier: the kind comparison already rejects everything a dimension
comparison would — see §3.

Scale can no longer cause a mismatch here, which is the point of §2. Two
peers holding the same quantity in counts and in millivolts now agree
semantically and differ only in §5.3's composed transform.

The last row is the migration ramp. Without it, adding quantities to an
existing schema is a cliff. It should be a diagnostic the build can escalate
to an error, not a permanent silent allowance.

### 5.2 Projection fit — one build against itself

New, and it needs no peer at all. A build checks its own `Representation`
against its own `Quantity`: push `stored`'s bounds through `toCanonical` and
require that the result covers `[min, max]`, and that the step it quantizes
to is no coarser than `resolution`.

One semantic declaration, three candidate boards:

| representation of `si:voltage, 2.5..4.2 V, 1 mV` | verdict |
|---|---|
| 12-bit, 3.3 V reference, no divider | **fails coverage** — reaches 3.3 V |
| 12-bit, 3.3 V reference, 1:2 divider | covers `0..6.6 V`, **fails resolution** at 1.611 mV |
| 12-bit spanning `2.5..4.2 V`, `affine{1/2048, 5/2}` | covers, and steps at 488 µV |

Both failures are hardware design errors, caught at build time by a party
that has not yet spoken to anybody. No precedent in §10 does this.

### 5.3 The bridge — `resolve`

`Resolution`'s `bridge` gains an optional payload; every other variant is
unchanged. Additive, in the same shape as the target codegens'
`correspondences?:` hook — `undefined` means today's exact behavior.

```ts
export type Resolution =
    | {readonly action: "bridge"
       readonly transform?: readonly Transform[]
       readonly onNarrowing?: Narrowing}
    | {readonly action: "drop"}
    | {readonly action: "default"; readonly value: unknown}
    | {readonly action: "trap"; readonly reason: string}
    | {readonly action: "unreachable"}

/** What a bridge does with a value the local projection cannot hold.
 *  Absent = reject, and §5.1 threw before this was ever built. */
export type Narrowing =
    | {readonly kind: "trap"}
    | {readonly kind: "replace"; readonly value: number}
```

One branch, at reconcile.ts:239 where `matched` already returns early —
before the parent-matched precondition, which the leaf case does not need:

```ts
if(c.outcome === "matched")
{
    const t = bridgeTransform(c.imageNode!, c.localNode!, direction)
    return t ? {action: "bridge", transform: t} : {action: "bridge"}
}
```

`bridgeTransform` composes `localToCanonical⁻¹ ∘ imageToCanonical` (swapped
for `encode`), normalized per §4.1, and returns `undefined` where either
side has no representation to compose. Interior struct/union/list edges keep
returning a bare `bridge`.

`onNarrowing` is a conditional check on a *matched* edge, which neither
`trap` nor `default` can express: both of those are whole-edge decisions for
edges that did not match. It asks a projection-fit question: the peers agree
about the quantity, and one of them cannot hold the other's whole range. Absent means either that nothing narrows or
that §5.1 already rejected the pair, so the default stays reject-at-build,
which is what catches 2038 and the `i16` overflow.

Where the policy is declared is open, but it belongs to the local side: the
receiver is the only party that can act on it, and the sender never needs to
know. That makes it projection, and nothing about it travels.

## 6. Codec image

A `QUANTITY` decorator instruction in §6.2's fourth family, from the
reserved `0xD1`-`0xFF` range: pops the top of the value stack, pushes it
back with a quantity attached. Postorder-clean, no change to any existing
tag. Its operands are `kind` via §6.3's string table, then `min`, `max` and
`resolution` as rationals — the semantic half of §2, and all of it.

**The representation travels separately, as layout.** codec-image.md §5
lists what an image carries; §2's argument adds a fourth bullet to it,
per-leaf, beside the programs and outside the type tree. The consumer reads
it to compose §5.3's bridge and never reconciles against it.

A transform is a tag byte and its operands. A rational is a zigzag-LEB128
numerator and a LEB128 denominator, so a zero offset and a unit denominator
cost a byte each and no op needs a compact variant of its own:

| op | operands |
|---|---|
| `identity` | none |
| `affine` | scale, offset |
| `log` | base, factor, reference |
| `table` | one index — see below |
| `formula` | unencodable — see below |

**Tables are interned.** A `table` is the only operand whose size is
unbounded: leap eras are tens of points, a text repertoire is 256 (§7.1).
Inlining repeats the whole map in every field that uses it, and repertoires
are shared by construction. So tables get a table of their own, indexed the
way §6.3 indexes strings.

**`formula` has no encoding, and §9 stages around it.** A `ProcedureRef`
names mog-core IR, so an image would have to embed that IR or assume the
peer already holds the procedure, and neither is settled here. The
consequence, stated: a formula-carrying representation works in process at
§9's step 4 and does not survive an image round-trip at step 5.

An old decoder hitting an unknown tag fails hard — §6.5 gives no
per-instruction skipping. That is the correct behavior here, not a
problem: a decoder that does not understand quantities must not silently
ignore them. §7's trap tier does not soften it either — a decoder that
cannot see a repertoire must not guess at one. Whether this also warrants a
container version bump (codec-image.md §7) is open.

## 7. Text

A string is `list(integer)` — the metamodel has no string kind (§2) — and
the element's `kind` is `text:codepoint`, canonical the Unicode codepoint.
That, plus the list's length bound, is the whole semantic declaration.

Everything else about text is projection, in one column:

| | |
|---|---|
| **repertoire** | which integers the peer can hold — ASCII, Latin-1, CP1252 |
| **encoding** | how the sequence becomes bytes — UTF-8, UTF-16, one byte each |
| **storage** | a fixed narrow buffer, a start/end pair into the packet, `std::string` |

The residue that stays semantic is small and real: a country code is two
ASCII letters because the protocol says so. That earns a `kind` of its own;
a device limit does not.

### 7.1 A repertoire is a per-element transform

| representation | `toCanonical` | `stored` |
|---|---|---|
| ASCII | `identity` | `0..127` — Unicode's first 128 codepoints *are* ASCII |
| ISO-8859-1 | `identity` | `0..255` — and its first 256 are Latin-1 |
| Windows-1252 | `table`, `interp: "none"` | `0..255`, differing from Latin-1 in `0x80..0x9F` |
| KOI8-R | `table`, `interp: "none"` | `0..255`, arbitrary high half |
| Unicode | `identity` | `0..1114111` |

An ASCII peer and a Unicode peer agree semantically and differ by an
`identity` that folds to nothing, so ASCII into Unicode needs nothing at
all. Unicode into ASCII is §5.3's narrowing, decided per value — the
capability mismatch it was built for, and not a disagreement about meaning.

Multi-byte code pages do not fit, and should not: Shift-JIS decides a byte's
meaning from its predecessor, which a per-element transform cannot see. It
decomposes: JIS X 0208 to Unicode is the table, Shift-JIS is the encoding,
and the encoding half is projection.

### 7.2 What text forces

**Inversion turns on injectivity.** Code maps are injective and nowhere near
monotonic: Windows-1252 sends `0x82` to U+201A and `0x83` to U+0192. §4.1
splits the rule by `interp` for that reason — monotonicity is what
interpolating an inverse needs, and only `interp: "linear"` interpolates.
Nothing here is text-specific; the rule is the same for a numeric table.

**A repertoire is partial.** Windows-1252 assigns nothing to `0x81`, `0x8D`,
`0x8F`, `0x90` or `0x9D`, and without a domain narrower than the input type
an author has to invent a mapping or lie about one. Hence §4.1's contract:
totality on a *declared* domain. It needs no new field, because a `table` is
already total on its own point set, so off-domain is a trap and
`Resolution`'s `{action: "trap"}` already spells it.

The trap costs what §5.1 was built to avoid. A value-dependent failure can
only be a runtime `CodecTrap`, so this is a tier the design did not have
before. The alternative is silent mojibake.

Two things open the tier: a `table` off its own domain, and §5.3's
`onNarrowing` on any bridge the local projection cannot hold. The second
applies to any kind, and text is the case that motivates it.

**An interval is the wrong shape for a repertoire.** Surrogates
`D800..DFFF` are not scalar values, and noncharacters and unassigned
codepoints are scattered throughout, but a stored space is `{min, max}`.
`0..1114111` overapproximates and no interval does better. The exact set
needs a refinement mechanism this metamodel does not have — the same gap as
"this integer is one of an enum's members". Out of scope; overapproximating
and trapping at runtime is the interim.

## 8. What is deliberately out of scope

**Runtime calibration.** `805.664 µV` assumes a 3.3 V reference; the real
board is 3.28 V and drifts with temperature. Two different objects:

- the **nominal** transform is a build-time constant — §4's
  `Representation`, and what this document owns;
- the **actual** calibration is per-device data that must travel *on the
  wire*.

Conflating them produces a protocol that is precise and wrong. The second
needs a way for a quantity-typed field to act as another field's scale
(IEEE 1451 TEDS's model). Not designed here; the point is that the schema
constant must not be where people put it.

§2's split is the same distinction one level up, and generalizing it is what
this document did: nominal-versus-actual was never specific to calibration.
Runtime calibration is also the first thing here that multiplies two
quantities, so it is where a dimension vector would start to pay for itself.
§3's kind string decides equality on its own; deriving the dimension of a
product is the job no string does.

**Sentinels** (`0x8000` = sensor fault). The metamodel already has the
right answer — `union({value: Voltage, fault: unit})`, with the codec
merging the sentinel into the value space, which is exactly TODO.md's
small-value-space merging item. A2L needed verbal tables for this. Say so
explicitly so nobody smuggles NaN-likes into a quantity.

**Alternatives with a shared role and no shared canonical.** A domain name
and an IPv4 address fill one slot, and §4.2 puts resolution between them
outside the contract four times over. `union({addr: IPv4, name: DomainName})`
is the right answer, the same move as sentinels above. The pull towards a
`resolve` op is strong, which is why this is written down.

## 9. Staging

The ontology must not block the checking. In order:

1. `Quantity` on a `scalar` leaf, and `kind` on `integer`. §5.1's
   compatibility check. This alone kills §1's class, because the two
   declarations can no longer both be written.
2. `Representation` with `toCanonical` restricted to `identity | affine`,
   and §5.2's projection fit. Covers every epoch and geodetic scale in §4.1.
3. §5.3's bridge composition, and its narrowing policy.
4. `table` and `formula`. Leap seconds and byte-reversed addresses are the
   second case in their own kind, so the escape hatch is load-bearing here
   in a way it never is for voltages.
5. Text (§7), and wire encoding (§6) so representations survive an image
   round-trip. Text needs step 4's `table` and the one new tier in the
   design — a value-dependent runtime failure, opened both by a `table` off
   its own domain and by §5.3's `onNarrowing`. Nothing before this can fail
   on a value.
6. Target consumption: branded numbers in `target-js`, a strong type or a
   folded multiply in a generated C++ target.
7. `log`, then the kind registry — which is where a dimension vector goes if
   §8's calibration ever calls for one.

**The risk is authorship, not algebra.** Optional unchecked metadata rots
exactly like protobuf field comments. It sticks only if it is
load-bearing: declaring the quantity has to be what earns you free
conversion in generated target code, not a documentation chore.

## 10. Precedents

| | what to take |
|---|---|
| **Ada fixed point** | `type Volt is delta 0.000805664 range 0.0 .. 3.3;` — the type states an interval and a step, the compiler picks the representation. 1983, and the model for §3 outright. |
| **ASAM MCD-2 MC (A2L)** | `COMPU_METHOD`: `LINEAR`, `RAT_FUNC`, `TAB_INTP`, `TAB_VERB`, `FORM`. Its SI exponent vectors sit on a named `UNIT` that `COMPU_METHOD` references, once per unit. Automotive ECU calibration, standardized since the 90s, and literally the hardware-dictated-arbitrary-unit problem. |
| **Simulink / Embedded Coder** | slope-and-bias scaling (`V = S·Q + B`) and the power-of-two-elides-the-multiply optimization, in production for embedded codegen. |
| **CBOR tags, RFC 8949 §3.4** | a registered decorator wrapping an existing shape to say what it means — date-time, bignum, and RFC 9164's IP address — which is §6's `QUANTITY` instruction and §3's `kind` registry, already standardized. |
| **IEEE 1588 (PTP)** | a TAI timescale with a stated epoch and `currentUtcOffset` carried on the wire as live data. §4.1's last table row and §8's calibration split, in one protocol. |
| **SenML, RFC 8428 + 8798** | a registered unit list that explicitly separates `/` (0-1 ratio), `%`, `dB`, `%RH`, with defined secondary→primary conversions. Directly §3's dimensionless problem. |
| **QUDT** | `quantityKind` separate from unit, with `conversionMultiplier`/`conversionOffset`, and its dimension vector on the kind itself. Steal the shape, not the size. |
| **J1939 SLOT** | Scaling, Limit, Offset, Transfer function — a catalog of named reusable quantity descriptors. The model for §3's `kind` registry. |
| **UCUM** | if a parseable unit-string syntax is ever wanted, this is the one with a real grammar. |
| **WHATWG Encoding Standard** | every legacy single-byte code page as an explicit byte→codepoint index, with its holes marked as holes. §7.1's table and §7.2's trap, already tabulated. |
| **OPC UA** | `EUInformation` / `AnalogItemType`: instrument range vs EU range, which is §5.2's projection fit against §5.1's semantic range. |
| **IEEE 1451 TEDS** | the sensor carries its own calibration. The model for §8's runtime-calibration half. |
| **`std::chrono::duration`, F# UoM, Rust `uom`** | the zero-cost-at-runtime end: scale in the type, conversions folded at compile time. |

Not precedents for the numeric half: Protobuf (naming conventions and custom
options only) and ASN.1 (nothing). Their absence there is a line for the
README's why-prior-art-is-no-match section.

ASN.1 is a precedent for §7, though: `IA5String`, `PrintableString`,
`NumericString`, `BMPString` and `UTF8String` put the repertoire in the type,
which is §7.1's claim. It conflates repertoire with encoding in the same
name, which is §7's split and the reason to take the shape and not the list.

## 11. Examples

```ts
const r = (num: number, den = 1): Rational => ({num, den})
const ZERO = r(0)
const aff = (scale: Rational, offset: Rational = ZERO): Transform =>
    ({op: "affine", scale, offset})
const ident: Transform = {op: "identity"}
const rep = (stored: IntegerType | FloatType, toCanonical: Transform): Representation =>
    ({stored, toCanonical})
```

### 11.1 The semantic side

What the protocol asserts, and all any peer has to agree to.

```ts
const Battery   = scalar({kind: "si:voltage",      min: r(5, 2), max: r(21, 5), resolution: r(1, 1000)})
const Ambient   = scalar({kind: "si:temperature",  min: r(4663, 20), max: r(7963, 20), resolution: r(1, 10)})
const Timestamp = scalar({kind: "time:utc-instant", min: ZERO, max: r(4102444800), resolution: r(1)})
const Longitude = scalar({kind: "geo:longitude",   min: r(-180), max: r(180), resolution: r(1, 10 ** 7)})
```

Values whose semantic space really is the integers keep `integer`, and take
a `kind` without a range or a resolution:

```ts
const HostAddr  = integer(0, 4294967295,     {kind: "ipv4:host-address"})
const NetMask   = integer(0, 4294967295,     {kind: "ipv4:netmask"})
const MacAddr   = integer(0, 281474976710655, {kind: "mac48:address"})
const HoldReg   = integer(0, 9998,           {kind: "modbus:holding-register"})
const CanExtId  = integer(0, 536870911,      {kind: "can:extended-id"})
const Codepoint = integer(0, 1114111,        {kind: "text:codepoint"})
const Label     = list(Codepoint, 64)
```

### 11.2 The projection side

One per build. Nothing here is shared, agreed, or reconciled.

```ts
// Battery — three boards and two hosts
const battOverrun = rep(integer(0, 4095),    aff(r(33, 40960)))          // 3.3 V ref, direct
const battDivided = rep(integer(0, 4095),    aff(r(33, 20480)))          // 3.3 V ref, 1:2 divider
const battSpanned = rep(integer(0, 4095),    aff(r(1, 2048), r(5, 2)))   // input spans 2.5..4.2 V
const battMillis  = rep(integer(2500, 4200), aff(r(1, 1000)))
const battFloat   = rep(float64,             ident)

// Ambient
const tempDeciC   = rep(integer(-400, 1250),        aff(r(1, 10), r(5463, 20)))
const tempMilliK  = rep(integer(233150, 398150),    aff(r(1, 1000)))

// Timestamp
const tsSec32     = rep(integer(-2147483648, 2147483647), ident)
const tsMillis    = rep(integer(0, 4102444800000),        aff(r(1, 1000)))
const tsNtp       = rep(integer(0, 4294967295),           aff(r(1), r(-2208988800)))

// Longitude
const lonDeg1e7   = rep(integer(-1800000000, 1800000000),  aff(r(1, 10 ** 7)))
const lonBam      = rep(integer(-2147483648, 2147483647),  aff(r(45, 2 ** 29)))

// Integer kinds
const macEthernet = rep(integer(0, 281474976710655), ident)
const macBle      = rep(integer(0, 281474976710655),
                        {op: "formula", forward: reverseOctets48, inverse: reverseOctets48})
const regDocument = rep(integer(40001, 49999), aff(r(1), r(-40001)))
const regWire     = rep(integer(0, 9998),      ident)

// Codepoint
const charAscii   = rep(integer(0, 127),     ident)
const charLatin1  = rep(integer(0, 255),     ident)
const charCp1252  = rep(integer(0, 255),     {op: "table", interp: "none", points: WINDOWS_1252})
const charUnicode = rep(integer(0, 1114111), ident)
```

### 11.3 §5.2 — each build against itself, no peer involved

| representation | of | verdict |
|---|---|---|
| `battOverrun` | `Battery` | **fails coverage** — reaches 3.3 V, needs 4.2 |
| `battDivided` | `Battery` | covers `0..6.6 V`, **fails resolution** at 1.611 mV |
| `battSpanned` | `Battery` | covers `2.5..4.4995 V`, steps at 488 µV |
| `battMillis`, `battFloat` | `Battery` | cover, and step at 1 mV or finer |
| `tempDeciC` | `Ambient` | covers `233.15..398.15 K` exactly, steps at 0.1 K |
| `tsSec32` | `Timestamp` | **fails coverage** — reaches 2038-01-19, needs 2100 |
| `tsMillis`, `tsNtp` | `Timestamp` | cover, and step at 1 ms or 1 s |
| `lonBam` | `Longitude` | steps at 83.8 n° — **fails coverage** at `+180` by one step |
| `charAscii` | `Codepoint` | an `integer` kind has no range to fit; §5.3 decides |

Four of these are hardware or storage design errors, and every one of them
is caught before the build has seen a peer. 2038 in particular stops being
a cross-version discovery: `tsSec32` cannot hold `Timestamp` and says so on
its own.

### 11.4 §5.3 — the bridge between two projections

| image -> local | outcome |
|---|---|
| `battSpanned` -> `battMillis` | `affine{125/256, 2500}`, emitted as `(x*125 >> 8) + 2500` |
| `battSpanned` -> `battFloat` | `affine{1/2048, 5/2}` |
| `tempDeciC` -> `tempMilliK` | `affine{100, 273150}`, both coefficients integral |
| `tsNtp` -> `tsMillis` | `affine{1000, -2208988800000}` |
| `lonBam` -> `lonDeg1e7` | `affine{3515625/4194304}`, emitted as `(x*3515625) >> 22` |
| `macBle` -> `macEthernet` | `formula`, self-inverse |
| `regDocument` -> `regWire` | `affine{1, -40001}` |
| `charAscii` -> `charUnicode` | `identity`, folds to nothing |
| `charCp1252` -> `charUnicode` | table; `0x81` `0x8D` `0x8F` `0x90` `0x9D` trap off-domain |
| `charUnicode` -> `charAscii` | narrowing; `onNarrowing` decides per value |

And what §5.1 still throws on, before any of the above runs:

| | |
|---|---|
| `si:voltage` vs `si:power` | different kinds |
| `time:utc-instant` vs `time:civil-instant` | different kinds, one canonical |
| `ipv4:host-address` vs `ipv4:netmask` | different kinds, one canonical |
| `geo:latitude` vs `geo:longitude` | different kinds, one canonical |
| `can:standard-id` vs `can:extended-id` | different kinds |
| `si:duration` vs `time:utc-instant` | §4.3 |

Note what is absent from that list. Counts against millivolts, BAM against
degrees, deci-Celsius against milliKelvin — every §1 pairing lands in the
bridge table above, because the disagreement was never semantic.

### 11.5 What writing these exposed

**A circular quantity is not an interval.** `Longitude` says `-180..180`,
and `lonBam` cannot represent `+180` because BAM wraps: `+180` and `-180`
are the same code. The interval is the wrong shape for an angle in the same
way §7.2's interval is the wrong shape for a repertoire, and for the same
reason — the value space is not an ordered range with two ends. Two
instances is enough to suspect the metamodel wants a value-space kind
richer than `{min, max}`.

**Two kinds of "does it fit" wanted separating and now are.** §5.2 asks
whether one build's storage can hold what its own protocol asserts. §5.3
asks whether two builds' storages overlap. The first is a design review the
compiler can run; the second is a deployment question. Merging them was
what made the old range check feel like it was answering two questions
badly.

**A kind can be too specific as easily as too vague.** An uptime counter and
a timeout are both `si:duration`; giving uptime a kind of its own would make
two peers that should interoperate fail to, and the role they play is what
field names are for. §4.3 warns about under-splitting a kind. Over-splitting
costs the same and nothing in the design pushes back on it.

**The two value-dependent failures do not share a shape.** §5.3's narrowing
offers `trap` or `replace`; §7.2's off-domain table offers only a trap. But
CP1252's five holes want U+FFFD, which is `replace`, and that is what every
decoder in the field does. `Narrowing` should cover both.
