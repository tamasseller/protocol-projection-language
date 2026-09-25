# Crypto primitives

**Status: stages 1 (CRC), 2 (keyless hashes) and 3 (MACs) implemented; stages 4–5 unimplemented. §5's provider model supersedes stage 3's `keys` table; §7's injection point is unimplemented.** TODO.md's
"crypto extension".

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

### 1.1 Placement: beneath the codec mapping

- A CRC, MAC or AEAD tag is wire detail. No schema field or semantic type names it.
- The codec layer computes and writes it on encode, reads and checks it on decode.
- Happy path is transparent: the decoded tree is exactly what the unframed codec yields.
- The only visible behaviour is a `TRAP` on mismatch.
- Anything in the packet may be a tree field; anything the host needs from it must be one (a sequence number, an explicit IV, a session id).
- A crypto op sees exactly three things: packet ranges (§3), literal parameters (§4.1) and slots (§5).
- Crypto above packet coding (handshakes, key derivation, nonce construction, session management) is the host's (§8).
- Main target: application-layer protocols on untrusted channels, with crypto tailored to the application and devices. Transport protocols (TLS, ESP, QUIC) are a proof of generality, not a use case.
- A real legacy codec's framing is custom DSL; the frame below is a composable utility that knows nothing of message structure.
- The carrier is a framing codec rule, opted in through the rules array like `delta-leb128.ts`: `framedEncode`/`framedDecode(spec, inner, name?)` wrap `inner`'s fragment.
- Wire layout `[crc][body]`: the CRC covers the rest of the stream, so a frame is the last thing its stream carries.
- Encode is codec-extension.md §8.4's fixup: a placeholder through `i0`, the CRC written back through a parked `CLONE_WR` fork.
- Decode verifies first: a reader clone absorbs the rest of the stream, `VERIFY` reads the tag through `i0`, and only then does the body decode.
- It wraps a rule, not a procedure: `CALL_CODEC` binds only `child(src, ref)` (codec-extension.md §3.3), so a frame cannot delegate its own `o0`.
- The frame's fork iterators and crypto handles come from `CodecScope`, so they cannot collide with `inner`'s.
- `CodecScope` gains a third allocator, `CryptoId`, splicing as its number like `IterId`, per procedure as §3 scopes handles.

## 2. Opcode space

There is none left:

- Core's 128 codes are fully assigned (isa-core.md §5.2), with §5.3's
  three escapes carrying an unbounded LEB128 sub-code space — core-owned.
- The codec extension's 128 were filled exactly by `WRITE_SEQ`/`READ_SEQ`
  (codec-extension.md §6.4, wire.ts's band table).
- `0xD1`-`0xFF` is free in the *type tree* encoding (codec-image.md §3.2),
  a different stream, and reconciliation.md §3.1 already claims a tag there.

`Extension` is also singular: bytecode.ts routes every byte ≥128 to one
`Extension.codec`, so a standalone crypto extension is not expressible.

### 2.1 A crypto extension point

`SEEK`'s band shrinks from `N + 1 = 5` codes to 1, with `iter` always
LEB128'd alongside the zigzag `delta` it already carries. `SEEK` is
codec-extension.md §3.1's one op marked "(optional)", nothing in
`src/codecs/components/` emits it, and its compact form therefore saves one
byte on an op with no emitter. It stays fully functional, one byte longer.

Of the four freed codes, byte 221 becomes `CRYPTO sub-code`: the extension
point for crypto ops only, an unsigned LEB128 sub-code plus that op's own
operands. It is shaped like isa-core.md §5.3's escapes, with the same
payoff: two bytes instead of one, for a space that does not run out. A
crypto op is per-message or per-field, never per-byte, so the second byte
falls where nothing hot pays it. The other three (222-224) stay spare and
reserved.

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
below needs a context to outlive the call that made it. State that outlives
one codec invocation lives in slots (§5), never in a context.

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
- **An absorbed range ends at another iterator, not a count.** `ABSORB c,
  src, end` advances reader `src` until it reaches `end`'s position. Every
  iterator is a fork of the one stream (codec-extension.md §2.1), so the
  positions compare; `src` already past `end` traps. A frame covers a body
  that a delegate wrote or read, and the frame never learns its length.
- `ABSORB_REST c, src` advances reader `src` to the stream's end: the decode
  side of a frame, whose body lies ahead of every cursor.
- Open (§6.1): `XFORM`'s count alone arrives in `acc`, as `WRITE_SEQ`'s does
  (codec-extension.md §3.5): a decoder's ciphertext lies ahead of every
  cursor, so only framing (a length prefix) says where it ends.
- Output and tag lengths are context configuration (§3.1), never operands.

### 3.1 Instruction sketch

Six sub-codes, enough for all five stages of §6. Handle and iterator IDs
are LEB128 after the crypto sub-code — no compact index forms, by
`WRITE_SEQ`'s argument (codec-extension.md §6.4): the per-op cost amortizes
over the range the op processes. `alg` is a length-prefixed UTF-8 name
(§4), inline rather than a string-table reference, which keeps
codec-image.md §3.3's invariant that a program section carries no names
intact.

| Op | Effect |
|---|---|
| `INIT c, "alg", params` | fresh, fully configured context in slot `c` |
| `ABSORB c, src, end` | advance reader `src` to `end`'s position, absorbing every byte it passes |
| `ABSORB_REST c, src` | advance reader `src` to the stream's end, absorbing every byte it passes |
| `FINAL c, iter` | write the result, at its configured length, to `stream[iter]` |
| `XFORM c, src, dst` | transform `acc` bytes from `stream[src]` to `stream[dst]` (§6.1) |
| `VERIFY c, iter, code` | read the configured tag length from `stream[iter]` and compare; `TRAP code` on mismatch |

Output length is configuration: the natural digest length, a `tag_len`
parameter for a truncated tag, an `out_len` parameter for an XOF (§4.1).
`FINAL` and `VERIFY` read it from the context, so the two directions
cannot disagree on it. `code` is a literal, as in `TRAP` (isa-core.md §4.5).

A CRC's result is an integer, and its wire form is configuration too:
`ceil(width / 8)` bytes, unused high bits zero, in the order the
`byteorder` parameter gives (0 little-endian, 1 big-endian). Its default
follows `refout`: little-endian for a reflected CRC, big-endian otherwise,
the convention the catalog's reflected and unreflected CRCs are sent in.
No op yields a result into `acc`: nothing on the happy path reads it (§1.1).

**A context's whole configuration is one instruction.** Every part of it
is literal (isa-core.md §11.3), so nothing is gained by spreading it over
several ops, and codegen — whose lowering differs wholesale between a CRC,
an HMAC and a cipher — dispatches on one instruction with the algorithm,
key and every parameter in view, rather than reassembling a context from
an `INIT` and a trail of setters.

`params` is a TLV list: per entry a NUL-terminated UTF-8 name, then a
LEB128 length and that many value bytes; an empty name ends the list. The
value's meaning is fixed by its name, never by the encoding, so a reader
that knows no names can still skip every entry. Integer-valued parameters
are unsigned little-endian, as wide as the value's length; a slot name is
UTF-8. A repeated name is a decode error.

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
| `INIT`/`ABSORB`/`ABSORB_REST`/`FINAL`/`VERIFY` | `killsAcc` |
| `XFORM` | `readsAcc` (the byte count) |

`killsAcc` on all four for the reason codec-extension.md §6.3 gives
for `ENTER`/`CLONE_*`: every one is helper-call work on a real target,
where the accumulator's register is an argument register.

### 3.3 Validation

`validate-handles.ts`'s existing pattern, extended with a third
environment. A crypto handle must be initialized before it is absorbed into
or finished. `ABSORB`'s `src` must be a `CLONE_RD` fork;
`end` may be any iterator. Same-procedure-only, exactly as that file already checks stream
forks and object handles — and exact rather than conservative, since §3's
scoping is the real rule and not an approximation of a wider one.

No ordering rule is needed: configuration exists only inside `INIT` (§3.1),
so a context cannot be reconfigured mid-stream by construction.

Neither `alg` nor a parameter name is validated here, and nor is `key`:
no slot exists when a program is validated (§5). Whether either is
implemented is a target-codegen question, not a structural one, and failing
there is what produces a useful message (§4).

### 3.4 `ir` surface: string literals

The `ir` language has only numeric literals (`ast.ts`'s `Literal`), and
`alg` and parameter names are strings. Compile-time string literals are an
extension-agnostic `mog-core` DSL feature that the core itself never
consumes; other extensions can use them too (debug or log output). The spec
is isa-core.md §10.2. The additions:

- **Grammar** (`grammer.pegjs`): `"..."`, UTF-8, escapes `\"` and `\\` only, so a name is always valid UTF-8. Byte strings as `x"0a1b..."`, even digit count, lowercase hex.
- **AST**: `StringLiteral { value: string; raw }` and `BytesLiteral { value: readonly number[]; raw }`, leaves beside `Literal`, reused as-is by `east.ts`; `explain.ts` never blames one.
- **Types** (`types.ts`): neither has a value type. Legal only as a builtin or extension call's argument; anywhere else (operand, assignment, procedure argument, `return`) is a type error. ISA values stay 32-bit integers.
- **Matcher**: `pString()`/`pBytes()`, matching only their own literal. `pConst()` never matches one.
- **Parameter lists**: `pImmediate()` matches a constant, string or byte string. `INIT`'s rule is `pBuiltinCall("crypto_init", pConst(), pString(), pTail(pImmediate()))`, the tail read as name/value pairs.
- A malformed tail (odd length, non-string name, repeated name) fails in the rule's lowering, at compile time.
- Byte strings are needed first by stage 4's fixed IV; stage 1 needs only `StringLiteral`.

```
crypto_init(${c}, "CRC", "width", 16, "poly", 0x1021, "init", 0xffff,
            "refin", 0, "refout", 0, "xorout", 0);   // CRC-16/IBM-3740
```

DSL names are `crypto_init`, `absorb`, `absorb_rest`, `final`, `xform`,
`verify`, with operands in §3.1's order and `XFORM`'s count as a trailing
`pRtl("acc")`, as `write_seq` takes its count.

## 4. Algorithm identity

**A short canonical name, inline in the instruction. Not a number.**

A numeric registry would be the only externally-resolved namespace in the
whole format. Every other identifier an image carries resolves *inside* the
image: `ref` into the type tree it ships, `codec_idx` into the procedure
table it ships, a field name into the string table it ships. `alg = 47`
resolves against a table nobody ships, and the two parties holding it were
built independently, which is the definition of drift.

This is the choice reconciliation.md §4.1 already made for the same reason —
struct fields and union variants match by name, never by position, because
two independently-evolved builds cannot be assumed to agree on a number
neither of them allocated. Algorithm identity is that problem exactly.

The general rule, which also settles what stays numeric: **names for what a
third party names, numbers for what this repo names.** `ref` and
`codec_idx` are numeric because the compiler here assigns them and the
image is self-contained. Field names are strings because the schema author
names them and two authors must agree. An algorithm is named by a standards
body, so it is a string. A slot is named by the schema author, and a party
conforming to another's image must map it onto its own provider state, so
it is a string too, inline like `alg`. The crypto sub-codes (§2.1) stay numeric:
this repo allocates them in `opcodes.ts` and ships the code that reads
them, with no second party in the loop.

Compactness does not argue against it. These ops are parsed once at codegen
time, never interpreted per byte, and a codec suite instantiates any given
primitive zero or two times — once per direction. A name costs a
length-prefixed handful of bytes against an image carrying a whole type
tree and two programs.

It also makes the failure legible. An image may name an algorithm the
consumer's build does not implement, which is reconciliation.md §4's ordinary
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
`xorout`), so a custom CRC is `INIT c, "CRC"` carrying six parameters,
and a catalog CRC is just its catalog name with none.

- Catalog names are the whole RevEng catalogue, spelled exactly as each entry's `name=`.
- An alias RevEng lists is rejected, and the error names its canonical entry.
- The table is pinned to a dated catalogue snapshot, recorded beside it; each entry carries its `check` value.
- `byteorder` is the one CRC parameter this repo names: Rocksoft models the value, not its wire form (§3.1).
- A custom `"CRC"` is at most 32 bits wide, since `ir` integer literals are u32; wider CRCs are catalog names only.

Values are integers or byte strings, or for a slot role a slot name, and the name alone says which.
Lowering enforces the last: a slot role's value must be a string literal, and no other parameter's may be. Both
are literal, as isa-core.md §11.3 requires of every extension operand anyway,
which is also the line that says where anything else goes: **a parameter is
a compile-time constant; anything else is a stream range or a slot (§5).**

**An unrecognized parameter name is a hard error, never ignored.** This is
the rule the whole mechanism depends on, and the one a named bag invites
getting wrong. A parameter is contractual — silently dropping `tag_len` 12
yields a codec that runs and interoperates incorrectly, which is strictly
worse than one that refuses to build. Same reasoning as isa-core.md §5.3's
unassigned sub-codes and reconciliation.md §3.1's unknown decorator tag.

Slot content never becomes a parameter: a parameter is public contract
that travels in the image identically for both parties, whereas a slot is
provider state that never enters the image at all (§5). What does travel
is a slot name under a role name (`key`, `iv`, `nonce`): public, literal,
and resolved like any other parameter.

Placement, then, is four-way and worth stating once:

| what | where | why |
|---|---|---|
| algorithm identity | the `INIT` name (§4) | named by a standards body |
| contractual constants | `INIT`'s named parameters (§4.1) | literal, in the image, both sides must agree |
| associated data, payload, tag | stream ranges (§3) | in the packet |
| keys, IVs, nonces, counters | slots, selected by role parameters (§5) | outlive one invocation; the host manages them |

### 4.2 Hash names

Provided by `@noble/hashes`, pinned to 1.x: 2.x is ESM-only and ppl is CommonJS.
A keyless digest gives integrity against accident, never authenticity; that is stage 3's MAC.

| names | standard | parameters |
|---|---|---|
| `SHA-224` `SHA-256` `SHA-384` `SHA-512` `SHA-512/224` `SHA-512/256` | FIPS 180-4 | `tag_len`: truncate to a prefix |
| `SHA3-224` `SHA3-256` `SHA3-384` `SHA3-512` | FIPS 202 | `tag_len` |
| `SHAKE128` `SHAKE256` | FIPS 202 | `out_len`, required |
| `BLAKE2b` `BLAKE2s` | RFC 7693 | `out_len` (default 64 / 32), `salt` and `personal` (16 / 8 bytes) |
| `MD5` `SHA-1` | RFC 1321, RFC 3174 | `tag_len`; legacy wire formats only |

- BLAKE2's `out_len` is its own digest, not a truncation.
- BLAKE2's `key` makes it a MAC (§4.3).

### 4.3 MAC names

| names | standard | parameters |
|---|---|---|
| `HMAC-<hash>`, for every fixed-length §4.2 name, e.g. `HMAC-SHA-256` | RFC 2104, RFC 4231 | `key`, required; `tag_len` |
| `KMAC128` `KMAC256` | NIST SP 800-185 | `key` and `out_len`, required; `customization`, a byte string |
| `BLAKE2b` `BLAKE2s` with `key` | RFC 7693 | §4.2's, plus `key` |

- A key is at least 1 byte; a BLAKE2 key at most its natural digest length (64 / 32).
- AES-CMAC needs a block cipher: stage 4, with `@noble/ciphers`.
- Poly1305 needs a fresh key per message: stage 5.
- `VERIFY` compares every tag byte whatever the first mismatch; that is all §8's disclaimer leaves this repo to promise.

## 5. Slots and the crypto provider

- A slot is crypto provider state: a key, an IV, a nonce, a counter. `INIT` names slots under role parameters; an algorithm defines its roles.
- A slot name is opaque UTF-8, compared exactly (§4), chosen by the schema author.
- Reconciliation matches slots by name, as fields (reconciliation.md §4.1). Unimplemented.
- A slot's algorithm and role, read off every `INIT` naming it, must agree between the two images; a mismatch is found at codegen.
- A new slot extends the crypto side compatibly, but has no default: the consumer's host must provision it before conforming. Renaming is removing plus adding.
- A context reads its slots, and updates them as its algorithm defines. On a `VERIFY` failure that handling is the provider's.
- **Never an ISA value, never an object handle.** Slot content reaches neither `acc` nor the tree; the program only names slots.
- The host manages slot content through the provider, however the target exposes that.
- Representation, allocation (static or dynamic) and isolation (plain memory, a PSA key id, a secure element), uniform or per slot, are the target's.
- In-packet data the host needs is a tree field. The host derives what it must from it (session keys, composite nonces) and loads slots for the packets that follow.
- A decode whose crypto setup depends on the packet's clear part is two steps: one codec for the clear header, the host loads the slots, a second codec verifies and decodes the rest. The same shape as protocol layering, e.g. a gateway trunking end-to-end sessions over one transport session.
- Only crypto state known before a packet is touched validates it.
- A fresh IV on encode is loaded by the host: in practice a per-key counter, random only for CBC. An explicit part on the wire is a tree field the host also supplies.
- Stage 3 implements slots as a per-call `keys: ReadonlyMap<string, Uint8Array>` table, checked by `keySlots`/`bindKeys`; §7's provider injection replaces it.

## 6. Staging

Each stage named by the new problem it introduces, not by algorithm count:

1. **CRC.** Catalog-named, or named `"CRC"` with Rocksoft parameters for
   the long tail (§4.1); no key material, no isolation question. Encode:
   parked tag fork and placeholder, `inner`'s body, `ABSORB`, `FINAL`.
   Decode: `ABSORB_REST`, `VERIFY`, then `inner`'s body (§1.1). Builds the
   range-I/O plumbing, §3.4's string literal and §1.1's framing rules.
2. **Hashes, fixed and XOF (SHAKE).** Introduces byte-string results and
   `out_len` (§4.1). No ISA change: a hash frame is §1.1's frame with a
   §4.2 name.
3. **MAC / HMAC.** First appearance of slots (§5).
4. **Ciphers**, as modes of operation (§6.1). First *transform* op: stages
   1-3 absorb a range and yield a small value, this one is range in, range
   out.
5. **AEAD.** `ABSORB` covers the associated data, sent in the clear;
   `XFORM` the encrypted part; `FINAL`/`VERIFY` the tag. A nonce is a
   per-algorithm slot input.

Decode order is `XFORM`, `VERIFY`, then the body: no plaintext reaches a
parser before the tag checks, which keeps codec-extension.md §3.4's
sequential cursor.

### 6.1 Modes of operation

- A mode is a catalogue algorithm (`AES-128-CTR`, `AES-128-CBC`, `ChaCha20`, ...), never DSL composed from a block function: a target maps each onto its hardware when present.
- Software-only algorithms (Keccak-based, ChaCha) are catalogue entries like any other.
- The IV or nonce is a slot input (§5).
- No padding in the op. Padding is bytes the DSL writes; CBC's block-multiple requirement is a trap on a misaligned range.
- Open: `XFORM`'s extent. A count in `acc` (§3.1), or an end iterator as `ABSORB` takes, since an encoder knows its body only by iterator positions.
- Open: decode's destination. In place, which makes the decode stream writable and has generated entry points copy the caller's input.
- Open: a padding length computed at run time needs FINDINGS.md's remaining-length and `SEEK`-by-`acc` ops.

### 6.2 Stage 1 tests

- `ppl/test/codecs/crc-frame.test.ts`, under the interpreter:
  - a `framed` struct round-trips to the tree it was encoded from;
  - its wire bytes are the unframed codec's bytes followed by the CRC, in `byteorder`'s default and in both explicit orders;
  - a frame around a variable-length delegated body (a list) round-trips, which exercises `ABSORB`'s catch-up;
  - a frame followed by more of the stream traps;
  - every catalogue entry yields its `check` value over `"123456789"`, and so does its `"CRC"` parameter spelling where it is at most 32 bits wide;
  - a RevEng alias is rejected, naming its canonical entry;
  - one flipped bit in body or CRC makes `VERIFY` trap with the frame's code before the body is read, and nothing else observable differs.
- `ppl/test/target-js/crc-frame.runtime.test.ts`: the round-trip and trap cases again, through generated code.
- `wire.test.ts`: every crypto sub-code round-trips, `params` TLV included; an unassigned sub-code is rejected; `SEEK`'s single-code form.
- `validate-handles.test.ts`: rejects `ABSORB` on an uninitialized handle, `ABSORB`/`ABSORB_REST` from a writer fork, a handle used outside its procedure.
- `mog-core`: a string literal parses with both escapes; one outside a call argument is a type error.

### 6.3 Stage 2 tests

- `ppl/test/codecs/hash-frame.test.ts`:
  - each §4.2 name's standard "abc" vector, and every implemented name has one;
  - chunked absorption equals one-shot; a 1000-byte SHAKE256 output agrees with `node:crypto`;
  - `tag_len`, `out_len`, `salt`, `personal`, and every missing, unknown or out-of-range parameter;
  - hash frames round-trip, write the digest of the unframed bytes ahead of them, and trap on every single-bit flip.
- `ppl/test/target-js/hash-frame.runtime.test.ts`: the interpreter's bytes, the round trip and the flip sweep, through generated code.

### 6.4 Stage 3 tests

- `ppl/test/codecs/mac-frame.test.ts`:
  - RFC 2202 / RFC 4231 test cases 2 and 6 for `HMAC-MD5`, `HMAC-SHA-1` and SHA-2; every other `HMAC-<hash>` against `node:crypto`;
  - SP 800-185 KMAC samples 1, 2 and 4; keyed BLAKE2b/s against the BLAKE2 KAT's first entry;
  - `key` missing, and every unknown or out-of-range MAC parameter;
  - `keySlots` / `bindKeys`: a missing slot, a key of the wrong length, one slot under two algorithms;
  - MAC frames round-trip, write the tag of the unframed bytes ahead of them, trap on every single-bit flip and under a different key.
- `ppl/test/target-js/mac-frame.runtime.test.ts`: the interpreter's bytes, the round trip, the flip sweep and the wrong key, through generated code; its entry points reject a missing or wrong-length key.

## 7. Target codegen

One native call per op. `target-js`'s `codec-codegen-ext.ts` gains one case
each against a runtime helper, the shape `SEEK`/`WRITE_SEQ` already have
there. A target with a hardware unit specializes at its own `raise.ts`
pass, optional and local to one instruction — codec-extension.md §3.5's
precedent exactly, and the reason §3 insists on the range form.

Every algorithm goes through a **crypto provider** in the target's runtime:
an injection point with a default implementation.

- target-js's default is today's `@noble/hashes` code; a backend can inject `node:crypto`, a web target WebCrypto.
- An embedded target may implement only what its codecs use, in software, over an accelerator, or behind a secure world.
- The interpreter takes a provider too, with the same default.
- Where an unimplemented name fails is the target's: at startup when it resolves at run time, as an undefined reference when at compile time.
- How a provider's calling convention fits the target's codegen and runtime is the target's.

## 8. Out of scope

- **Key establishment, key derivation, nonce construction, session management** (§5): the host's, through whatever its provider offers.
- **Crypto not tied to packet framing** (§1.1): handshakes, application-level signing or encryption.
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
| **FIPS 202 / NIST SP 800-185** | XOF semantics: output length is a caller parameter, which §4.1 makes `out_len`. |
| **RFC 5116** | the AEAD interface (nonce, AAD, tag) stage 5 implements. |
| **TLS 1.2 record layer (RFC 5246)** | the cipher-plus-separate-MAC composition stages 3 and 4 give together. |
| **mbedTLS, TinyCrypt** | the reality check on what an embedded target's library actually offers, and at what granularity. |
