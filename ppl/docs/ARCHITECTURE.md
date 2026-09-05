# Declarative Serialization Architecture

## The problem

Serialization and rich communication on embedded microcontrollers face
three pressures at once.

**Hardware constraints.** Bare-metal firmware runs under SRAM limits often
below 32 KB, real-time scheduling guarantees, and architectural pressure
from bus performance and DMA layout. Dynamic allocation
(`malloc`/`new`) is impractical: heap fragmentation is catastrophic and
there is rarely address space to spare.

**Existing formats each fail differently.**

- Text and self-describing formats (JSON, YAML, CBOR) force string
  parsing, demand intermediate dynamic buffers, and spend bandwidth
  re-transmitting field names on every message.
- Schema-driven binary generators (Protobuf, FlatBuffers) emit code
  footprints that exhaust MCU flash, often allocate for nested or
  variable-length structures, and hand the host application awkward getters
  instead of native constructs. Their extensibility claims still rest on
  schema discipline nothing enforces.
- Raw C struct dumps are fast and zero-allocation, but carry alignment,
  padding and endianness bugs, break structurally on any change, and are
  undecodable unless every party's low-level packet code is kept in sync by
  hand.

**The schema coupling paradox.** Cloud gateways, mobile apps and local
bridges need to parse telemetry dynamically, without redeploying bridge
code for every firmware update or new device type. Self-describing formats
are too heavy for the MCU; lightweight binary formats lock both ends of the
wire into identical compile-time dependencies.

```text

      +--------------+      +------------------+      +-----------------+
    ..|   Embedded   |......|     Contract     |......| Proper Platform |...............
   '  |              |      |                  |      |                 |               '
   '  |              |      |                  |      |                 |               '
   '  |    C/C++  <-----------  Semantic  --------------->  JS/TS       |     Types     '
   '  |              |      |                  |      |                 |               '
   '  |      ^       |      |   |              |      |       ^         |               '
   '..|      |       |......|   |              |......|       |         |...............'
      |      |       |      |   |  projection  |      |       |         |
    ..|      |       |......|   |              |......|       |         |...............
   '  |      V       |      |   V              |      |       V         |               '
   '  |              |      |                  |      |                 |               '
   '  |     S11N  <-----------  CODECS  ---------------->  IR EVAL      |  Wire format  '
   '  |     CODE     |      |                  |      |    JIT/AOT      |               '
   '..|              |......|                  |......|                 |...............'
      +--------------+      +------------------+      +-----------------+

```

## Key architectural decisions

### Tripartite separation: information, data, signal

The foundational principle is a strict structural decoupling of three
domains:

- **The Semantic Model** (information): the abstract intent of the data
  (`Integer(0, 255)`, `Struct`, `Union`, `List`). No hardware specifics,
  no bit-width, no endianness. It is the routing layer linking host memory
  to network bytes.
- **The Target Model** (data): how the host application natively stores and
  works with the data (an idiomatic C++ `struct`, a zero-copy DMA ring
  buffer, a JS object, a `Buffer`, a `DataView`).
- **The Wire Format** (signal): the physical bytes on the medium
  (bit-packed headers, LEB128 varints, UTF-8 JSON text, TLV).

Each of the three evolves on its own schedule.

### Dual generation via composable projections

Memory layout and wire representation are both decoupled from semantic
intent, so a **Projection** bridges them by applying composable mapping
rules to the semantic tree. From that single source of truth the compiler
generates both sides of the serialization boundary:

1. **Target data model.** Idiomatic native memory structures for the host
   application, derived from the semantic type model alone and driven by
   target mapping rules (a C++ header with specific alignment
   requirements, say).
2. **Parser/formatter.** The execution logic (generated codec IR) that
   translates between the wire format and those generated host structures.
   Two ways to consume it:
   - *Build time*: generate platform-native code during the build, for
     maximum speed and minimum code size, locking in all current knowledge
     of every aspect of the protocol.
   - *Runtime*: fetch it during execution (from the other party, for
     instance) and either evaluate it directly or transform it into
     something faster for the platform. This locks in only limited
     knowledge of the protocol at build time.

### Wire format independence

Arbitrary wire formats work without touching application logic. Swapping a
dense binary RF protocol for a human-readable JSON logging format means
changing the composable codec components in the projection, leaving the
semantic model and the host application's data structures alone.

Runtime codec generation from abstract IR also allows negotiating or
discovering the wire protocol when one party has very limited resources: a
native, build-time-codegen endpoint (the embedded profile) can still serve
its IR as an opaque blob. If even the compact codec IR is too heavy for an
endpoint to carry, it can publish a hash of the IR *contents* instead, and
the peer fetches the IR from a well-known location. Hashing content gives
far stronger guarantees than a semantic version string: the wire mapping
code is exact, and no human judgement about backwards compatibility enters
the process.

### Platform type mapping independence

The target data model is generated independently per platform from the same
semantic type tree, guided by per-platform mappings, so each
language/application/use-case tailors its own access to the encoded
information without regard for the others.

#### Inversion of control (zero-allocation parsers)

The generated parser/formatter layer never allocates or owns memory.
Codecs are procedural bridges: they read from a stream and emit procedural
instructions to a proxy, which routes data into the generated target data
model. The wire logic stays agnostic to the host's memory constraints.

### TypeScript as the eDSL

A custom DSL would need its own lexer, parser, type checker and IDE
extension. Using TypeScript as an embedded DSL makes Node.js the
compile-time engine and gets compile-time type unrolling and constraint
validation from standard TS syntax. Tagged template literals keep C-like
procedural readability for runtime logic (`mog-core`, whose
`ir` template is specified in `mog-core/docs/isa-core.md` §10).

## The semantic type system (the metamodel)

`src/core/metamodel.ts`. The source of truth for the *logical
intent* of the data, strictly decoupled from physical constraints:
bit-width, endianness, memory alignment and null-termination do not exist
here.

The metamodel is a minimal set of irreducible structural roots, and
high-level constructs normalize aggressively into them. A dictionary or map
is a list of key-value pairs. A raw binary blob is a list of non-negative
integers below 256. A string is a list of characters.

**Primitives.** `Integer(min, max)` is a bounded mathematical range: you
do not define a `uint16_t`, you define `Integer(0, 65535)`, and the
projection layer later decides whether it packs into 14 bits, ships as a
LEB128 varint, or widens to 32 bits for alignment. `Unit` carries no data.
Abstract IEEE-754 `Float` (real numbers, ±∞, NaN) and `Char` (a single
Unicode scalar value, giving host adapters the context to generate native
string types) are part of the intended design and not yet in the
metamodel; `Integer` and `Unit` are what exists today. Going more
primitive than this level would create implementation problems outweighing
the architectural benefit.

**List.** Homogeneous sequential items of unknown length, with an element
type and an optional capacity bound known at compile time. All items share
the exact same type. The capacity bound captures abstract behavioral
knowledge and guides representation choice on both the wire and the host
side.

**Struct.** Heterogeneous static dictionaries (Π-types) mapping fixed,
compile-time keys to types. Each field has a unique name and a type. All
fields are always present.

**Union.** Tagged sum types (Σ-types) of mutually exclusive semantic
variants. Each variant has a unique tag and a type. Exactly one variant is
present at all times.

## Mappings

A **Mapping** is a rule-driven walk over the semantic type tree: an ordered
list of `(structural predicate, producer)` pairs, tried in order, first
match wins. Every generated artifact in this project is one instance of
that mechanism aimed at a different producer: a target language's native
type, a wire-format codec, a JSON pretty-printer. That uniformity is what
lets a C header, a TS declaration file and an encode/decode program
regenerate consistently from one schema change, and lets any one of them be
swapped without touching the other two.

### Structural predicates

Codecs bind to topological location and structural constraints, not to
named types. Because the metamodel tracks exact integer bounds, a codec
signature can express "I encode any integer whose maximum fits in a byte."

### Three layers, three lifecycles

A Mapping is dispatch plus producer, so the same three-way split applies to
every kind of Mapping here. The layers evolve at very different rates and
belong in separate modules — `src/core`, `src/codecs`, `src/target-js`,
one package. The boundary is the import graph, not npm: nothing published
separately, nothing versioned separately, and no consumer that wants one
layer without the others.

1. **Core / platform.** The facilities that let semantic types and Mappings
   be *defined* at all, with no knowledge of any specific type shape or
   wire format. `core` holds the metamodel, `TypePattern`/`matchType`
   and the structural predicate vocabulary, `createResolver`'s on-demand
   cycle-safe rule dispatch, and `reconcile`.
   `mog-core` holds the protocol-agnostic IR, lowering and VM, plus the
   `Extension` hook that lets a domain add opcodes without `mog-core`
   knowing what a codec is. Changes here are rare and load-bearing.
2. **Components.** The reusable Mappings built on layer 1: a target's
   type-mapping rules (`target-js`), a wire format's codec rules
   (`codecs`'s default binary rules, plus opt-in
   alternatives such as delta-LEB128 lists or a JSON pretty-printer). These
   are libraries, plural. An application picks one, several, or writes its
   own alongside them, and nothing in layer 1 privileges any of them.
3. **Application.** A semantic schema (the project's one real asset) plus
   the choice of which layer-2 components to run over it. This layer owns
   no generic machinery: see [ppl-example](https://github.com/tamasseller/ppl-example)'s `src/compose.ts`.

The test for which layer something belongs in: if it can be swapped for an
alternative without the application noticing, it is a component; if
swapping it would mean rewriting the mechanism everything else rides on, it
is core. Machinery invented to solve one component's problem is still
judged on its own merits, regardless of which package the need first
surfaced in.

### Type mapping

A target's type mapping is a rule list resolved against the semantic
`TypeGraph` by `src/core/projection.ts`'s `createResolver`: one rule set
per target, living in that target's own directory, never in `core`.
`core` supplies the dispatch engine and the predicate vocabulary; each
target is a component library built on it.

A rule gets a `resolve` callback for its children, and that is load-bearing
rather than convenient: a struct's own declaration text has to embed its
fields' refs *while being built*. A dispatch engine without it forces every
target to answer "what does a child look like" some other way — and the one
target that tried answered it with a hand-written per-kind switch that
reimplemented the rule list and no rule could override, which is exactly
the composability this layering claims to provide, silently absent.

### Codecs

A wire-format codec is the same shape aimed at a different producer: each
matched semantic type produces an `ir` fragment, a `Procedure` body for
`mog-core`'s VM. `codecs` supplies two things beyond what a type
mapping gets from `core`, both core-layer despite living alongside the
codec components:

- **The codec `Extension`** (`engine/codec-extension.ts`): the opcode
  vocabulary (`ENTER`, `CALL_CODEC`, `READ`/`WRITE`, and the rest) that
  makes a codec body authorable as real `ir` text. It encodes nothing by
  itself; it makes encoding expressible. It lives here rather than in
  `mog-core` only because `mog-core` must stay protocol-agnostic.
- **The on-demand resolver.** A struct can reference itself through a union
  arm, so a dispatch pass has to be able to hand a not-yet-finished child a
  reserved slot before a sibling embeds it into its own instruction stream.
  The mint-then-recurse, memoized, cycle-safe
  execution is `src/core/projection.ts`'s `createResolver`, shared with
  `target-js/engine/resolver.ts`'s `createTsResolver` (resolving
  `SemanticType -> TSTypeDecl` instead of `SemanticType -> Procedure`).
  `src/codecs/engine/resolver.ts`'s `createCodecResolver` is the codec
  adapter over it, and stays in `codecs` because it depends on
  `mog-core`'s `Procedure`/`declareProc`/`lowerProgram`. A rule's
  `produce` sees only its own match witness and a `resolve` callback keyed
  on a child's `SemanticType` identity: no `TypeNode`, no graph.

The actual codec rule sets are components: `components/binary-rules.ts`'s
default length-prefixed, tag-hoisted binary encoding, plus the opt-in
alternatives (`components/delta-leb128.ts`, `components/json.ts`) that
compose alongside or instead of it. `buildCodec` (`engine/resolver.ts`)
privileges none of them: it takes the rule set as a plain required
argument, exactly as a type mapping's own resolver does, so an
application is never stuck with an implicit default it cannot replace. For
the binary rules, direction is which of two flat rule lists
(`binaryEncodeRules`/`binaryDecodeRules`) gets passed in, not a value
threaded through every rule: a resolver run commits to one direction for
its whole walk, so no `produce` call ever branches on it.

### Projections

A **Projection** is the application-layer act of running chosen components,
a type mapping or a codec or both, over one shared semantic schema to
produce the artifacts a real system needs. ppl-example's `src/compose.ts` is
the reference shape: build the `TypeGraph` once, apply each package's
Mapping to it, own nothing generic.
