# Quantities

**Status: design sketch, unimplemented.** ROADMAP.md §13's "target-side
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
mismatch is checked (§2.2), a unit mismatch is invisible.

## 2. Layer split

Same split the metamodel already makes for shape — `Integer(min, max)` is
semantic, bit-width is projection:

| | semantic (travels in the image, reconciled) | projection (per target, swappable) |
|---|---|---|
| shape | `integer(min, max)` | wire width, endianness, varint |
| quantity | kind + dimension + scale-to-canonical | the target's own preferred scale/repr |

The schema-declared scale is **semantic**, not projection: `805.664 µV per
count` is part of what the stored number means, and a peer cannot
reconcile without it. What the *application* wants (`float` volts, `int32`
millivolts, a branded TS type) is the projection choice. Both are
`Transform`s; codegen composes them.

## 3. `Quantity` — the semantic side

Lives on `IntegerType` (and on `Float` when it lands) as a real field, not
a `named()`-style symbol side-channel: metamodel.ts:170-174 notes type
names deliberately never travel on the wire, but a quantity must.

```ts
/** SI base exponents: length, mass, time, current, temperature, amount,
 *  luminous intensity. All-zero = dimensionless. */
export type Dimension = readonly [number, number, number, number, number, number, number]

/** Exact rational. Normalized, den > 0. Never a float — see §4. */
export interface Rational { readonly num: number; readonly den: number }

export interface Quantity
{
    /** Nominal kind. Two quantities are compatible only if these are
     *  equal. Mandatory, and it — not `dimension` — is what carries the
     *  weight: ratio / percent / dB / ADC-count / radian are all
     *  dimensionless, torque and energy are both N·m. Pure dimensional
     *  analysis (F#, Boost.Units) cannot separate any of those pairs. */
    readonly kind: string
    readonly dimension: Dimension
    /** Stored value -> canonical value. Canonical is the SI-coherent unit
     *  for `dimension` (volt, second, kelvin); for a dimensionless kind it
     *  is whatever that kind declares itself to be. */
    readonly toCanonical: Transform
}
```

`kind` is a bare string here. A registry (J1939's SLOT catalog is the
model) is a later refinement; the checking works without it.

Type-graph sharing is by object identity (type-graph.ts:7-13), so two
differently-scaled voltages are already distinct `TypeNode`s with no extra
work — the same property the `default` field's comment relies on.

## 4. `Transform` — the algebra

Small, total, composable, invertible. That is what keeps codegen able to
fold it; it is not a general expression escape hatch.

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
always, table iff monotonic (validate at build time), formula only via its
declared inverse.

## 5. Reconciliation

Two separate insertions, matching the existing §2.2-vs-§3 split.

### 5.1 `reconcile` — compatibility (§2.2, throws)

A quantity mismatch is the same tier as a kind mismatch, not a runtime
`CodecTrap`: it is a build-time error, thrown from `reconcile`'s existing
exact-match check alongside the kind test at reconcile.ts:168.

| image | local | outcome |
|---|---|---|
| same `kind` | same `kind` | compatible; §5.2 computes the transform |
| dimension differs | | throw — hard incompatibility |
| dimension same, `kind` differs | | throw — the counts-vs-millivolts catch |
| undeclared | undeclared | compatible, no transform (today's behavior) |
| declared | undeclared | **warn**, bridge untransformed |

That last row is the migration ramp. Without it, adding quantities to an
existing schema is a cliff. It should be a diagnostic the build can
escalate to an error, not a permanent silent allowance.

Range checking falls out for free, and generalizes §2.2's existing rule:
push the image range through the composed transform into local units and
compare against the local range. That catches "v2's `i16` millivolts
overflow" and "you just threw away 4 bits of resolution" at build time.
No precedent in §9 does this across protocol versions.

### 5.2 `resolve` — the transform (§3)

`Resolution`'s `bridge` gains an optional payload; every other variant is
unchanged. Additive, in the same shape as ROADMAP item 12's
`correspondences?:` hook — `undefined` means today's exact behavior.

```ts
export type Resolution =
    | {readonly action: "bridge"; readonly transform?: readonly Transform[]}
    | {readonly action: "drop"}
    | {readonly action: "default"; readonly value: unknown}
    | {readonly action: "trap"; readonly reason: string}
    | {readonly action: "unreachable"}
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

`bridgeTransform` returns `undefined` for anything that is not a pair of
quantity-carrying integer leaves, and otherwise composes
`localToCanonical⁻¹ ∘ imageToCanonical` (swapped for `encode`), normalized
per §4. Interior struct/union/list edges keep returning a bare `bridge`.

## 6. Codec image

A `QUANTITY` decorator instruction in §6.2's fourth family, from the
reserved `0xD1`-`0xFF` range: pops the top of the value stack (which must
be an integer), pushes it back with a quantity attached. Postorder-clean,
no change to any existing tag.

Operands: `kind` via §6.3's string table, `dimension` as 7 zigzag-LEB128s
with a single-byte all-zero escape for the dimensionless case, then the
transform (its own small tag byte plus rationals as LEB128 pairs).

An old decoder hitting an unknown tag fails hard — §6.5 gives no
per-instruction skipping. That is the correct behavior here, not a
problem: a decoder that does not understand quantities must not silently
ignore them. Whether this also warrants a container version bump (§7) is
open.

## 7. What is deliberately out of scope

**Runtime calibration.** `805.664 µV` assumes a 3.3 V reference; the real
board is 3.28 V and drifts with temperature. Two different objects:

- the **nominal** transform is a schema constant, versioned with the
  protocol — that is what this document owns;
- the **actual** calibration is per-device data that must travel *on the
  wire*.

Conflating them produces a protocol that is precise and wrong. The second
needs a way for a quantity-typed field to act as another field's scale
(IEEE 1451 TEDS's model). Not designed here; the point is that the schema
constant must not be where people put it.

**Sentinels** (`0x8000` = sensor fault). The metamodel already has the
right answer — `union({value: Voltage, fault: unit})`, with the codec
merging the sentinel into the value space, which is exactly ROADMAP §13's
small-value-space merging item. A2L needed verbal tables for this. Say so
explicitly so nobody smuggles NaN-likes into a quantity.

## 8. Staging

The ontology must not block the checking. In order:

1. `kind: string` + `toCanonical` restricted to `identity | affine`, on
   `IntegerType`. §5.1's compatibility check, §5.2's affine composition.
   This alone kills the silent-corruption class.
2. Range/precision checking through the transform.
3. Wire encoding (§6), so it survives a codec image round-trip.
4. Target consumption: branded numbers in `target-js`, a strong type or a
   folded multiply in a generated C++ target.
5. `dimension`, then `log` / `table` / `formula`.

**The risk is authorship, not algebra.** Optional unchecked metadata rots
exactly like protobuf field comments. It sticks only if it is
load-bearing: declaring the quantity has to be what earns you free
conversion in generated target code, not a documentation chore.

## 9. Precedents

| | what to take |
|---|---|
| **ASAM MCD-2 MC (A2L)** | `COMPU_METHOD`: `LINEAR`, `RAT_FUNC`, `TAB_INTP`, `TAB_VERB`, `FORM`, plus `UNIT` with SI exponent vectors. Automotive ECU calibration, standardized since the 90s, and literally the hardware-dictated-arbitrary-unit problem. |
| **Ada fixed point** | `type Volt is delta 0.000805664 range 0.0 .. 3.3;` — arbitrary rational `small`, compiler picks the representation. 1983. Closest philosophical match to PPL's whole premise. |
| **Simulink / Embedded Coder** | slope-and-bias scaling (`V = S·Q + B`) and the power-of-two-elides-the-multiply optimization, in production for embedded codegen. |
| **SenML, RFC 8428 + 8798** | a registered unit list that explicitly separates `/` (0-1 ratio), `%`, `dB`, `%RH`, with defined secondary→primary conversions. Directly §3's dimensionless problem. |
| **QUDT** | `quantityKind` separate from unit, with `conversionMultiplier`/`conversionOffset`. Steal the shape, not the size. |
| **J1939 SLOT** | Scaling, Limit, Offset, Transfer function — a catalog of named reusable quantity descriptors. The model for §3's `kind` registry. |
| **UCUM** | if a parseable unit-string syntax is ever wanted, this is the one with a real grammar. |
| **OPC UA** | `EUInformation` / `AnalogItemType`: instrument range vs EU range, i.e. the same two-sided scaling split as §2. |
| **IEEE 1451 TEDS** | the sensor carries its own calibration. The model for §7's runtime-calibration half. |
| **`std::chrono::duration`, F# UoM, Rust `uom`** | the zero-cost-at-runtime end: scale in the type, conversions folded at compile time. |

Not precedents: Protobuf (naming conventions and custom options only) and
ASN.1 (nothing). Their absence here is a line for the README's
why-prior-art-is-no-match section.
