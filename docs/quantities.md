# Value semantics

**Status: design sketch, unimplemented.** TODO.md's "target-side
transformation (unit of measurement)". Nothing in `src/` references
any of this yet.

## 1. The gap

The metamodel pins the *shape* of a value and reconciliation checks it.
Neither says anything about what a number *means*, so this reconciles clean
and produces silent garbage:

```ts
const V1 = struct({ battery: integer(0, 4095) })   // raw ADC counts
const V2 = struct({ battery: integer(0, 4095) })   // millivolts
```

`reconcile` sees two matched integer leaves and `resolve` returns
`{action: "bridge"}`. A kind mismatch throws (reconcile.ts:168) and a range
mismatch is checked (§2.2); a meaning mismatch is invisible.

The class is wider than units. Unix seconds against milliseconds, a UTC
instant against a zoneless civil one, degrees × 1e7 against binary angle
measure, an Ethernet MAC against the byte-reversed form BLE advertises, an
IPv4 host address against a netmask — every one is the same silent bridge.

## 2. The split

One fact is shared, and everything else belongs to whoever declared it.

**Semantic — what the value represents.** Voltage, pressure, text, a count
of events, a MAC address. One string, matched between parties, and the only
thing reconciled. It may imply a canonical unit; the machinery never needs
to know which, because the canonical is only a pivot to compose through and
never a thing to name.

**Projection — how this party represents it.** The range, and the map from
those numbers to that canonical: the interface specification of the codec
procedures that put bits on the wire. It belongs to one image and is never
required to agree with a peer's.

Both live on the same leaf, so nothing needs a section of its own and
nothing outside the type tree has to be addressed. Together they are enough
to generate the conversion and catch the drift that is mechanically
catchable, and not enough to know what an application means by a field.

## 3. The leaf

Today's `IntegerType` with two fields added. Not a `named()`-style symbol
side-channel: metamodel.ts:170-174 notes type names deliberately never
travel on the wire, but both of these must.

```ts
/** Exact rational. Normalized, den > 0. Never a float — see §4. */
export interface Rational { readonly num: number; readonly den: number }

export interface IntegerType
{
    kind: SemanticTypeKinds.Integer
    min: number
    max: number
    default: number
    /** Semantic. Namespaced: `si:voltage`, `time:utc-instant`,
     *  `ipv4:host-address`, `text:codepoint`. Compatibility is equality. */
    meaning?: string
    /** Projection. `min`..`max` -> the canonical `meaning` implies. */
    toCanonical?: Transform
}
```

`meaning` rather than `kind` because the metamodel already spends `kind` on
the type discriminator.

**It has to be specific enough to carry the weight.** Torque and energy are
both N·m; ratio, percent, dB, ADC-count and radian are all dimensionless; an
instant and a duration are both seconds. No dimensional analysis (F#,
Boost.Units) splits those pairs, and a `meaning` specific enough to split
them already determines its dimension — so an SI exponent vector alongside
adds nothing a check can use. It can be too specific too: an uptime counter
and a timeout are both `si:duration`, and giving uptime a name of its own
makes two peers that should interoperate fail to. Roles are what field names
are for.

A registry (J1939's SLOT catalog is the model) is a later refinement; the
checking works without it, and the namespace prefix keeps two authors'
`pressure` apart meanwhile.

## 4. `Transform`

Total on a declared domain, deterministic, composable, invertible. That
contract is what lets codegen fold a transform, and §4.1 spends it again as
this document's scope boundary. Only `table` has a domain narrower than its
input type; §7 is why.

```ts
export type Transform =
    | {readonly op: "identity"}
    /** canonical = scale * x + offset */
    | {readonly op: "affine"; readonly scale: Rational; readonly offset: Rational}
    /** canonical = reference * base ** (x / factor). dB power: base 10,
     *  factor 10; amplitude: factor 20. `reference` is mandatory — it is
     *  where dB bugs live (dBm vs dBV vs dBFS). */
    | {readonly op: "log"; readonly base: Rational; readonly factor: Rational; readonly reference: Rational}
    /** NTC curves, leap-second eras, legacy code pages. A2L's TAB_INTP. */
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

**Composition** is only closed for affine, so `compose` returns `readonly
Transform[]`, normalized by folding adjacent affines and dropping
identities. A one-element `[{op:"identity"}]` means codegen emits nothing.

**Inversion** — encode is decode inverted: affine iff `scale ≠ 0`, log
always, formula only via its declared inverse. A table inverts iff injective
for `interp: "none"` and iff strictly monotonic for `interp: "linear"`,
which is what interpolating an inverse needs; both validate at build time.

**The op set spans the non-physical meanings with no new machinery** — §11
is the evidence. The one case it strains is GPS and TAI, which run without
leap seconds and so are affine only within a single era: they need `table`,
the op introduced for thermistor curves, which is monotonic and therefore
invertible but not strictly so at a positive leap, leaving the inverse
ambiguous for exactly one second. That ambiguity is in the timescales.

### 4.1 What the contract excludes

One question settles every candidate: **is there a shared canonical, and is
the map to it total on a declared domain, deterministic and invertible?**
Compilation fails invertibility. DNS resolution fails all four, so a domain
name and an IPv4 address share a role without sharing a canonical — a
`union` (§8), not a missing op.

## 5. Reconciliation

### 5.1 `reconcile` — compatibility, throws

A `meaning` mismatch is the same tier as a type-kind mismatch, not a runtime
`CodecTrap`: a build-time error, thrown from `reconcile`'s existing
exact-match check alongside the kind test at reconcile.ts:168.

| image | local | outcome |
|---|---|---|
| same `meaning` | same `meaning` | compatible; §5.2 computes the bridge |
| `meaning` differs | | throw — §1's whole class |
| absent | absent | compatible, no transform (today's behavior) |

Range and precision drift fall out of §5.2's bridge rather than needing
checks of their own: pushing the image range through it catches "v2's `i16`
millivolts overflow", and a composed affine scaling below 1 means the local
side is coarser, catching "you just threw away 4 bits". Both at build time,
and no precedent in §10 does either across protocol versions.

Representation can no longer cause a mismatch. Two peers holding one meaning
in counts and in millivolts agree, and differ only in the bridge.

### 5.2 `resolve` — the bridge

`Resolution`'s `bridge` gains an optional payload; every other variant is
unchanged. Additive, in the same shape as the target codegens'
`correspondences?:` hook — `undefined` means today's exact behavior.

```ts
export type Resolution =
    | {readonly action: "bridge"
       readonly transform?: readonly Transform[]
       readonly onNarrowing?: {readonly kind: "trap"} | {readonly kind: "replace"; readonly value: number}}
    | {readonly action: "drop"}
    | {readonly action: "default"; readonly value: unknown}
    | {readonly action: "trap"; readonly reason: string}
    | {readonly action: "unreachable"}
```

One branch, at reconcile.ts:239 where `matched` already returns early,
before the parent-matched precondition the leaf case does not need. It
composes `localToCanonical⁻¹ ∘ imageToCanonical` (swapped for `encode`),
normalizes per §4, and yields a bare `bridge` where either side declares no
transform or the edge is interior.

`onNarrowing` is a conditional check on a *matched* edge, which neither
`trap` nor `default` can express — both are whole-edge decisions for edges
that did not match. Absent, a narrowing is rejected at build time, which is
what catches 2038 and the `i16` overflow. It belongs to the receiver, the
only party that can act on it, so nothing about it travels.

The *target* projection composes onto this too: a host that wants a `float`
in volts states that as a second transform and codegen folds the two.

## 6. Codec image

No new section and no new addressing. `meaning` and `toCanonical` are
operands of the integer push instructions §6.2 already defines, folded into
the tag the way `min = 0` and `default = 0` already fold. `meaning` indexes
§6.3's string table.

A transform is a tag byte and its operands — none for `identity`, a scale
and offset for `affine`, a base, factor and reference for `log`, one index
for `table`. A rational is a zigzag-LEB128 numerator and a LEB128
denominator, so a zero offset and a unit denominator cost a byte each.

**Tables are interned.** A `table` is the only operand whose size is
unbounded: leap eras are tens of points, a code page is 256 (§7). Inlining
repeats the whole map per field, and code pages are shared by construction,
so tables get a table of their own, indexed the way §6.3 indexes strings.

**`formula` has no encoding.** A `ProcedureRef` names mog-core IR, so an
image would have to embed that IR or assume the peer holds the procedure,
and neither is settled. Stated consequence: a formula-carrying leaf works
in process at §9's step 3 and does not survive an image round-trip.

## 7. Text

A string is `list(integer)` — the metamodel has no string kind — so the
element's `meaning` is `text:codepoint` and its canonical is the Unicode
codepoint. That plus the list's capacity is the whole semantic declaration.

Everything else is projection on the same leaf: ASCII is `identity` over
`0..127`, Latin-1 `identity` over `0..255`, Windows-1252 and KOI8-R a
`table` over `0..255`, Unicode `identity` over `0..1114111`. So ASCII into a
Unicode field folds to nothing and Unicode into ASCII is §5.2's narrowing,
decided per value. The encoding (UTF-8, UTF-16) and the storage form (a
fixed buffer, pointers into the packet, `std::string`) never reach the leaf.

Multi-byte code pages do not fit, and should not: Shift-JIS decides a byte's
meaning from its predecessor, which a per-element transform cannot see. It
decomposes — JIS X 0208 to Unicode is the table, Shift-JIS is the encoding.

Two things text settles. **Inversion turns on injectivity**: code maps are
injective and nowhere near monotonic — Windows-1252 sends `0x82` to U+201A
and `0x83` to U+0192 — which is why §4 splits the rule by `interp`.
**A code page is partial**: Windows-1252 assigns nothing to `0x81`, `0x8D`,
`0x8F`, `0x90` or `0x9D`, so a `table` is total on its own point set and
off-domain is a trap. That is the design's only value-dependent failure
besides `onNarrowing`, and it can only be a runtime `CodecTrap`. The
alternative is silent mojibake.

An interval is also the wrong shape for a code page — surrogates
`D800..DFFF` are not scalar values — so `0..1114111` overapproximates and
traps at runtime. Same gap as "this integer is one of an enum's members".

## 8. What is deliberately out of scope

**Runtime calibration.** `805.664 µV` assumes a 3.3 V reference; the real
board is 3.28 V and drifts. The **nominal** transform is a build-time
constant and is what this document owns; the **actual** calibration is
per-device data that must travel *on the wire*. Conflating them produces a
protocol that is precise and wrong. The second needs one field to act as
another field's scale (IEEE 1451 TEDS's model), and is the first thing here
that multiplies two quantities — where an SI exponent vector would start to
pay for itself. The point is that the schema constant must not be where
people put it.

**Sentinels** (`0x8000` = sensor fault). `union({value: Voltage, fault:
unit})`, with the codec merging the sentinel into the value space, which is
TODO.md's small-value-space merging item. A2L needed verbal tables for this.
Say so explicitly so nobody smuggles NaN-likes into a leaf.

**A shared role without a shared canonical**, per §4.1 — `union({addr,
name})`. The pull towards a `resolve` op is strong, which is why this is
written down.

## 9. Staging

1. `meaning` on `IntegerType`, and §5.1's compatibility check. This alone
   kills §1's class.
2. `toCanonical` restricted to `identity | affine`, §5.2's composition, and
   the range and precision drift that falls out of it. Covers every epoch
   and geodetic scale in §4.
3. `table` and `formula`. Leap seconds and byte-reversed addresses are the
   second case in their own meaning, so the escape hatch is load-bearing
   here in a way it never is for voltages.
4. Text (§7), and the one value-dependent runtime tier it needs.
5. Wire encoding (§6), so both fields survive an image round-trip.
6. Target consumption: branded numbers in `target-js`, a strong type or a
   folded multiply in a generated C++ target.
7. `log`, then the meaning registry.

**The risk is authorship, not algebra.** Optional unchecked metadata rots
exactly like protobuf field comments. It sticks only if it is load-bearing:
declaring the meaning has to be what earns you free conversion in generated
target code, not a documentation chore.

## 10. Precedents

| | what to take |
|---|---|
| **Ada fixed point** | `type Volt is delta 0.000805664 range 0.0 .. 3.3;` — arbitrary rational `small`, compiler picks the representation. 1983, and the closest philosophical match to PPL's premise. |
| **ASAM MCD-2 MC (A2L)** | `COMPU_METHOD`: `LINEAR`, `RAT_FUNC`, `TAB_INTP`, `TAB_VERB`, `FORM`, with SI exponents on a named `UNIT` it references. Standardized since the 90s, and literally the hardware-dictated-arbitrary-unit problem. |
| **Simulink / Embedded Coder** | slope-and-bias scaling (`V = S·Q + B`) and the power-of-two-elides-the-multiply optimization, in production for embedded codegen. |
| **CBOR tags, RFC 8949 §3.4** | a registered decorator saying what an existing shape means — date-time, bignum, RFC 9164's IP address. §3's `meaning` and its registry, standardized. |
| **IEEE 1588 (PTP)** | a TAI timescale with a stated epoch and `currentUtcOffset` carried on the wire as live data. §4's leap-second case and §8's calibration split, in one protocol. |
| **SenML, RFC 8428 + 8798** | a registered unit list separating `/` (0-1 ratio), `%`, `dB`, `%RH`, with defined secondary→primary conversions. Directly §3's dimensionless problem. |
| **QUDT** | `quantityKind` separate from unit, with `conversionMultiplier`/`conversionOffset`, and its dimension vector on the kind itself. Steal the shape, not the size. |
| **J1939 SLOT** | Scaling, Limit, Offset, Transfer function — a catalog of named reusable descriptors. The model for §3's registry, and UCUM if a real unit-string grammar is ever wanted. |
| **WHATWG Encoding Standard** | every legacy single-byte code page as an explicit byte→codepoint index, holes marked as holes. §7's table and its trap, already tabulated. |
| **IEEE 1451 TEDS** | the sensor carries its own calibration. The model for §8's runtime-calibration half. |
| **`std::chrono::duration`, F# UoM, Rust `uom`** | the zero-cost-at-runtime end: scale in the type, conversions folded at compile time. |

Not precedents for the numeric half: Protobuf (naming conventions and custom
options only) and ASN.1 (nothing). Their absence is a line for the README's
why-prior-art-is-no-match section. ASN.1 *is* one for §7 — `IA5String`,
`BMPString`, `UTF8String` put the repertoire in the type while conflating it
with the encoding in the same name.

## 11. Examples

One field per row: what it means, what this party's procedures deal in, and
what those numbers mean.

| `meaning` | `min`..`max` | `toCanonical` |
|---|---|---|
| `si:voltage` | `0..4095` | `affine{1/2048, 5/2}` — 12-bit ADC spanning 2.5..4.5 V |
| `si:voltage` | `2500..4200` | `affine{1/1000, 0}` — millivolts |
| `si:temperature` | `-400..1250` | `affine{1/10, 5463/20}` — deci-Celsius, canonical kelvin |
| `si:temperature` | `233150..398150` | `affine{1/1000, 0}` — millikelvin |
| `time:utc-instant` | `0..4102444800000` | `affine{1/1000, 0}` — Unix milliseconds |
| `time:utc-instant` | `0..4294967295` | `affine{1, -2208988800}` — NTP seconds |
| `geo:longitude` | `-2^31..2^31-1` | `affine{45/2^29, 0}` — binary angle measure |
| `geo:longitude` | `-1800000000..1800000000` | `affine{1/10^7, 0}` — degrees × 1e7 |
| `mac48:address` | `0..2^48-1` | `identity` — Ethernet order |
| `mac48:address` | `0..2^48-1` | `formula` reverseOctets48 — BLE order |
| `text:codepoint` | `0..127` | `identity` — ASCII |
| `text:codepoint` | `0..255` | `table` — Windows-1252 |

Each adjacent pair bridges. §5.2 composes `localToCanonical⁻¹ ∘
imageToCanonical` and normalizes:

| image -> local | bridge |
|---|---|
| ADC counts -> millivolts | `affine{125/256, 2500}`, emitted as `(x*125 >> 8) + 2500` |
| deci-Celsius -> millikelvin | `affine{100, 273150}`, both coefficients integral |
| BAM -> degrees × 1e7 | `affine{3515625/4194304}`, emitted as `(x*3515625) >> 22` |
| NTP -> Unix milliseconds | `affine{1000, -2208988800000}` |
| BLE MAC -> Ethernet MAC | `formula`, self-inverse |
| ASCII -> Unicode | `identity`, folds to nothing |
| Windows-1252 -> Unicode | table; `0x81` `0x8D` `0x8F` `0x90` `0x9D` trap off-domain |

And what §5.1 throws on before any of that: `si:voltage` against
`si:power`, `time:utc-instant` against `time:civil-instant`,
`ipv4:host-address` against `ipv4:netmask`, `geo:latitude` against
`geo:longitude`, `si:duration` against `time:utc-instant`.

Note what is absent from that list. Counts against millivolts, BAM against
degrees, deci-Celsius against millikelvin — every §1 pairing lands in the
bridge table, because the disagreement was never semantic.
