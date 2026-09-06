# Crypto primitives

**Status: design sketch, unimplemented.** TODO.md's "crypto
extension". Nothing in `src/` references any of this yet.

## 1. The gap

A CRC or a hash compression function written as a per-byte PPL loop is
both slow and pointless: every real target has a hardware unit or a tuned
library, and none of it is reachable from a loop the VM interprets a byte
at a time. codec-extension.md §8.4's checksum fork is the honest version of
that today — correct, interpretable, and exactly what one opcode should
replace.

isa-core.md §11.3's literal-only-operands rule exists for this: an
ahead-of-time translator can map an opcode whose every operand is known at
translation time onto a native call. That is the whole mechanism these
primitives need.

They are not core ops. isa-core.md §5.3 reserves `MISC_BINARY` for
general-purpose arithmetic the core should own; a CRC is domain work, and
belongs where the stream iterators it reads from already live.

## 2. Opcode space

There is none left:

- Core's 128 codes are fully assigned (isa-core.md §5.2), with §5.3's
  three escapes carrying an unbounded LEB128 sub-code space — core-owned.
- The codec extension's 128 were filled exactly by `WRITE_SEQ`/`READ_SEQ`
  (codec-extension.md §6.4, wire.ts's band table).
- `0xD1`-`0xFF` is free in the *type tree* encoding (codec-image.md §6.2),
  a different stream, and quantities.md §6 already claims a tag there.

`Extension` is also singular: bytecode.ts routes every byte ≥128 to one
`Extension.codec`, so a standalone crypto extension is not expressible.

### 2.1 An extension-level escape

`SEEK`'s band shrinks from `N + 1 = 5` codes to 1, with `iter` always
LEB128'd alongside the zigzag `delta` it already carries. `SEEK` is
codec-extension.md §3.1's one op marked "(optional)", nothing in
`src/codecs/components/` emits it, and its compact form therefore saves one
byte on an op with no emitter. It stays fully functional, one byte longer.

Of the four freed codes, one becomes `ESCAPE sub-code`, an unsigned LEB128
sub-code plus whatever that sub-code's own operands are. This mirrors
isa-core.md §5.3 one level down, for the same reason and with the same
payoff: two bytes instead of one, for a space that does not run out. A
crypto op is per-message or per-field, never per-byte, so the second byte
falls where nothing hot pays it. Three codes stay spare.

isa-core.md §5.3's unassigned-sub-code rule inherits verbatim. A sub-code
has no length until it is assigned, so a decoder cannot skip an unknown one
and must reject the program.

Making `Extension` composable in `mog-core` would relabel who owns which
bytes ≥128 without creating any, and would break the codec extension's
exact-128 fit. Separately motivated, not needed here (§8).

## 3. Crypto handles

A third resource space beside codec-extension.md's stream iterators
(§2.1) and object handles (§2.2), addressed the same way: small literal IDs
`c0..cN`, each a live context. The lifecycle is OpenSSL's EVP shape —
init, absorb, finish — because that is what every target library already
exposes and what a hardware peripheral's register interface looks like.

Scoped like both of those: per frame, ids restarting at `c0` in every
callee. A context is created and finished inside one procedure, which is
also the shape a framing codec wants — the MAC covers what the delegated
body wrote, and the delegate never sees the context computing it. Nothing
below needs a context to outlive the call that made it.

**All bulk data moves through stream iterators, never `acc`.** This is the
load-bearing decision:

- It generalizes codec-extension.md §8.4's `CLONE_RD` fork unchanged.
  "Hash the range I just wrote" is the same mechanism as "sum the bytes I
  just wrote", one op instead of a loop, and needs no new way to say where
  the range is.
- The op boundary is a **snatch point** in codec-extension.md §3.5's exact
  sense: the raw byte run's start and end are visible to a target's
  `raise.ts` pass with nothing op-internal left to account for, so a
  hardware CRC unit or a DMA descriptor can take the whole range.
- Byte counts arrive in `acc`, the way `WRITE_SEQ`/`READ_SEQ` take their
  element count (codec-extension.md §3.5), keeping every op agnostic to how
  the surrounding codec encoded the length.

### 3.1 Instruction sketch

Nine sub-codes, enough for all five stages of §6. Handle and iterator IDs
are LEB128 after the escape's sub-code — no compact index forms, by
`WRITE_SEQ`'s argument (codec-extension.md §6.4): the per-op cost amortizes
over the range the op processes. `alg` is a length-prefixed UTF-8 name
(§4), inline rather than a string-table reference, which keeps
codec-image.md §6.3's invariant that a program section carries no names
intact.

| Op | Effect |
|---|---|
| `INIT c, "alg"` | fresh context in slot `c` |
| `INIT_KEY c, "alg", key` | ditto, bound to key slot `key` (§5) |
| `SET_PARAM c, "name", value` | a literal integer parameter (§4.1) |
| `SET_PARAM_BYTES c, "name", bytes` | a literal byte-string parameter (§4.1) |
| `ABSORB c, iter` | consume `acc` bytes from `stream[iter]` into `c` |
| `FINAL c, iter` | write `acc` bytes of result to `stream[iter]` |
| `FINAL_VAL c` | `acc` = the result as an integer (CRC, ≤32 bits) |
| `XFORM c, src, dst` | transform `acc` bytes from `stream[src]` to `stream[dst]` (§6.1) |
| `VERIFY c, iter` | compare against the tag at `stream[iter]`; `TRAP` on mismatch |

`FINAL`'s `acc` is the output length, which is what an XOF needs; for a
fixed-length algorithm it must equal the natural digest length or trap,
rather than a second opcode existing to say the same thing.

A string operand costs nothing in `mog-core`: `ExtOpPayload`'s numeric
`operands` is only the default payload shape, `CodecExtInstr` already
carries named fields per opcode, and the one generic reader (`rtl.ts`'s
`format`) is typed to the default and documents that a named-field
extension owns its own rendering. The numeric assumption to widen is
`wire.ts`'s own — `Band`'s flat operand array and the `operandsOf`/
`fromOperands` pair — local to that file.

### 3.2 Effect declarations

isa-core.md §11.2, as `ExtOpEffect` (`mog-core/src/extension.ts`). All
`tosDelta: 0`, `maxTransient: 0`, none call-shaped.

| Op | Acc |
|---|---|
| `INIT`/`INIT_KEY`/`VERIFY` | `killsAcc` |
| `ABSORB`/`FINAL`/`XFORM` | `readsAcc` (the byte count) |
| `FINAL_VAL` | `writesAcc` |

`killsAcc` on the first three for the reason codec-extension.md §6.3 gives
for `ENTER`/`CLONE_*`: every one is helper-call work on a real target,
where the accumulator's register is an argument register.

### 3.3 Validation

`validate-handles.ts`'s existing pattern, extended with a third
environment. A crypto handle must be initialized before it is absorbed into
or finished, and `INIT_KEY`'s key slot must be in range for the bound table
(§5). Same-procedure-only, exactly as that file already checks stream forks
and object handles — and exact rather than conservative, since §3's scoping
is the real rule and not an approximation of a wider one.

One ordering rule: every `SET_PARAM` on a handle must precede the first
`ABSORB`/`XFORM`/`FINAL` on it, so a context has one configuration phase
and is never reconfigured mid-stream. The same flow-sensitive walk that
tracks initialization tracks that.

Neither `alg` nor a parameter name is validated here. Whether either is
implemented is a target-codegen question, not a structural one, and failing
there is what produces a useful message (§4).

## 4. Algorithm identity

**A short canonical name, inline in the instruction. Not a number.**

A numeric registry would be the only externally-resolved namespace in the
whole format. Every other identifier an image carries resolves *inside* the
image: `ref` into the type tree it ships, `codec_idx` into the procedure
table it ships, a field name into the string table it ships. `alg = 47`
resolves against a table nobody ships, and the two parties holding it were
built independently, which is the definition of drift.

This is the choice codec-image.md §2.1 already made for the same reason —
struct fields and union variants match by name, never by position, because
two independently-evolved builds cannot be assumed to agree on a number
neither of them allocated. Algorithm identity is that problem exactly.

The general rule, which also settles what stays numeric: **names for what a
third party names, numbers for what this repo names.** `ref` and
`codec_idx` are numeric because the compiler here assigns them and the
image is self-contained. Field names are strings because the schema author
names them and two authors must agree. An algorithm is named by a standards
body, so it is a string. The escape's own sub-codes (§2.1) stay numeric:
this repo allocates them in `opcodes.ts` and ships the code that reads
them, with no second party in the loop.

Compactness does not argue against it. These ops are parsed once at codegen
time, never interpreted per byte, and a codec suite instantiates any given
primitive zero or two times — once per direction. A name costs a
length-prefixed handful of bytes against an image carrying a whole type
tree and two programs.

It also makes the failure legible. An image may name an algorithm the
consumer's build does not implement, which is codec-image.md §3's ordinary
situation rather than a corruption. "unknown algorithm `SHAKE256`" is
actionable at codegen; "unknown alg 47" is forensics.

**Names are opaque. Compare the bytes.** No case folding, no whitespace
rule, no normalization of any kind — every such rule is itself something
two implementations can disagree about, which reintroduces drift through
the back door. Exact UTF-8, canonical spelling documented, mismatch is an
error.

**Parameters are not part of the name.** A name is an identifier, never
parsed; the moment it carries `poly=0x1021,refin,…`, codegen has to parse
it and two images spelling the same CRC differently compare unequal.
Parameters get their own mechanism instead (§4.1).

### 4.1 Parameters

A CRC's polynomial is not the only contractual constant that is not part of
an algorithm's identity. A truncated GCM tag length, CCM's tag *and* nonce
lengths, a fixed CBC IV in a legacy protocol, a BLAKE2 digest length or
personalization string: each is schema-level, must be identical on both
sides, and none of them names the algorithm.

A fixed positional operand list per algorithm would be a registry, and
fails for exactly the reason §4's numeric `alg` fails one level up: this
repo would have to know in advance that GCM takes a tag length and CCM
takes two, and an algorithm whose parameter set nobody anticipated would
need a wire-format change to express. So parameters are **named**, by the
same rule and for the same reason — a parameter is named by the standards
body that named the algorithm, not by this repo. For CRCs the names are
Rocksoft's own field names (`width`, `poly`, `init`, `refin`, `refout`,
`xorout`), so a custom CRC is `INIT c, "CRC"` followed by six
`SET_PARAM`s, and a catalog CRC is just its catalog name with none.

Two value shapes, because that is what the set actually contains: an
integer (`SET_PARAM`) and a byte string (`SET_PARAM_BYTES`). Both are
literal, as isa-core.md §11.3 requires of every extension operand anyway,
which is also the line that says where anything else goes: **a parameter is
a compile-time constant; anything that varies per message is a stream range
or arrives in `acc`.**

**An unrecognized parameter name is a hard error, never ignored.** This is
the rule the whole mechanism depends on, and the one a named bag invites
getting wrong. A parameter is contractual — silently dropping `tag_len` 12
yields a codec that runs and interoperates incorrectly, which is strictly
worse than one that refuses to build. Same reasoning as isa-core.md §5.3's
unassigned sub-codes and quantities.md §6's unknown decorator tag.

The generalization stops short of key material. A key could be spelled as
one more named parameter, and should not be: a parameter is public contract
that travels in the image identically for both parties, whereas a key is
host-bound capability that never enters the image at all (§5). Sharing one
mechanism would blur the single boundary this document works hardest to
draw, and `INIT_KEY`'s slot operand is also what `validate-handles.ts`
bounds-checks.

Placement, then, is four-way and worth stating once:

| what | where | why |
|---|---|---|
| algorithm identity | the `INIT` name (§4) | named by a standards body |
| contractual constants | named parameters (§4.1) | literal, in the image, both sides must agree |
| per-message data (IV, nonce, AAD, payload, tag) | stream ranges (§3) | varies per message |
| key material | a host-bound slot (§5) | never in the image at all |

## 5. Key material

Two constraints settle it:

- **A key is never an ISA value.** The value stack is 32-bit integers and
  `acc` is a register.
- **A key is never an object handle.** The object tree is the application's
  data model, and codec-image.md §3's whole reconciliation story assumes
  everything in it is describable, defaultable and wire-shippable. A key is
  none of those.

So: a **host-bound key slot table**. `INIT_KEY`'s `key` operand is a
literal index into a table the host binds at codec instantiation, exactly
parallel to `createCodecExtension`'s existing `root: Handle` parameter. In
a test the slot holds bytes; in firmware it holds a PSA `psa_key_id_t`, a
TPM object handle, a secure-element slot number. Isolation needs no extra
mechanism, because the bytecode never held the key.

Two consequences:

**Key establishment is above this layer.** DH, session negotiation,
ratcheting: out of scope, as a hard boundary rather than an omission. A
codec transforms bytes under a bound key; how that key came to be bound is
the application's.

**The image carries a per-slot requirement, never a key or a key
identity.** "Slot 0 must be an AES-128 key" is what a consumer's codegen
needs to check it has something to bind before generating code it cannot
run. This is a new kind of image content: codec-image.md §5's list is a
type tree plus two programs, and a crypto-using program is the first thing
needing a third entry. Whether that warrants a container version bump is
open, as it is in quantities.md §6.

## 6. Staging

Each stage named by the new problem it introduces, not by algorithm count:

1. **CRC.** Catalog-named, or named `"CRC"` with Rocksoft parameters for
   the long tail (§4.1); no key material, no isolation question.
   codec-extension.md §8.4's loop collapses to
   `INIT`/`ABSORB`/`FINAL_VAL`, and it builds the whole range-I/O
   plumbing.
2. **Hashes, fixed and XOF (SHAKE).** Introduces variable output length,
   which is what forces `FINAL`'s destination to be a stream iterator
   rather than `acc`.
3. **MAC / HMAC.** First appearance of the key slot table (§5).
4. **Bare cipher** (CTR, CBC). First *transform* op: stages 1-3 absorb a
   range and yield a small value, this one is range in, range out (§6.1).
5. **AEAD.** Fuses 3 and 4 into one context, and adds a failure path:
   decrypt can fail, so `VERIFY` traps with a codec-defined code
   (codec-extension.md §8.7).

Stage 5's hard problem, stated rather than solved: **a streaming decoder
has already handed the application unverified plaintext by the time the tag
check fails**, which conflicts with the sequential-cursor model
codec-extension.md §3.4 commits to. The proposed rule is a mandatory
two-pass — verify the tag over the whole range via a `CLONE_RD` fork first,
then decode — which the existing fork mechanism supports with no new
opcode. Confirm when stage 5 is built.

### 6.1 Bare encryption

Included, not declined. Authentication composes at the layer above: that is
what a TLS record layer does, and what every legacy protocol pairing a raw
CBC or CTR cipher with a separate MAC does. Stage 3 plus stage 4 gives
encrypt-then-MAC or MAC-then-encrypt with no further mechanism, and stage 5
is the fused convenience rather than the only sanctioned path.

What being a transform op introduces:

- **Source and destination iterators.** In-place (`src == dst`) is the
  ordinary encoder case: encrypt the range just written, through a
  `CLONE_RD`/`CLONE_WR` fork pair. codec-extension.md §2.1's "a `CLONE_WR`
  fork overwrites only, never appends" invariant is exactly the constraint
  that makes it well-defined.
- **IV and nonce are ranges.** One read from or written to the wire needs
  no mechanism: the codec body positions it with ordinary `READ`/`WRITE`,
  and it reaches the context through `ABSORB` like anything else. A legacy
  protocol's *fixed* IV is the other case, a schema constant rather than
  per-message data, so it is a `SET_PARAM_BYTES` (§4.1) — with the usual
  caveat that a fixed IV is fatal for CTR and GCM and merely bad for CBC.
- **No padding in the op.** Padding is bytes, and the DSL already writes
  bytes. Keeping it out leaves `XFORM` a pure range transform; CBC's
  block-multiple requirement becomes a trap condition on a misaligned
  range, not an implicit PKCS#7 nobody asked for.

Composing a bare cipher correctly is the schema author's job. The standard
failure is an unauthenticated CBC padding oracle, and stage 5 is the
default when nothing forces the split.

## 7. Target codegen

One native call per op. `target-js`'s `codec-codegen-ext.ts` gains one case
each against a runtime helper, the shape `SEEK`/`WRITE_SEQ` already have
there. A target with a hardware unit specializes at its own `raise.ts`
pass, optional and local to one instruction — codec-extension.md §3.5's
precedent exactly, and the reason §3 insists on the range form.

## 8. Out of scope

- **Key establishment** (§5).
- **Composable `Extension`s in `mog-core`** (§2.1).
- **Signatures and asymmetric operations.** A different lifecycle, with no
  streaming update in this shape, and no call-out case yet.
- **Constant-time guarantees.** The ISA cannot promise them; the target's
  native implementation owns that, and saying so is better than implying
  otherwise by silence.

## 9. Precedents

| | what to take |
|---|---|
| **PSA Crypto API** | opaque integer key ids with the key material behind an isolation boundary — §5's model, and the reason it needs no extra mechanism. |
| **OpenSSL EVP** | the init/update/final context lifecycle over an opaque handle, the reference point this sketch starts from. |
| **CRC RevEng catalog** | the canonical CRC naming registry (`CRC-32/ISO-HDLC` and ~100 more), so §4's names are looked up rather than invented. |
| **Rocksoft CRC model** | the (width, poly, init, refin, refout, xorout) parametrization, whose field names are §4.1's parameter names for an unnamed CRC. |
| **NIST SP 800-38C / 38D** | tag length, and CCM's nonce length, as explicit *mode* parameters rather than part of the algorithm's name — §4.1's motivating case beyond CRC. |
| **FIPS 202 / NIST SP 800-185** | XOF semantics: output length is a caller parameter, which is what §3.1's `FINAL` is shaped around. |
| **RFC 5116** | the AEAD interface (nonce, AAD, tag) stage 5 implements. |
| **TLS 1.2 record layer (RFC 5246)** | the cipher-plus-separate-MAC composition §6.1 exists to support. |
| **mbedTLS, TinyCrypt** | the reality check on what an embedded target's library actually offers, and at what granularity. |
