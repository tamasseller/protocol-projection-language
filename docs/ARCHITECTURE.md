# Declarative Serialization Architecture Specification

Data serialization and supporting rich communications on embedded microcontrollers (MCUs) poses several serious challenges:

1. **Strict hardware constraints:** bare-metal firmware operates under unforgiving SRAM limits (often <32 KB), real-time scheduling guarantees and many other forms of architectural pressure from hardware details like bus-architecture performance factors and DMA implementation details. Complex dynamic memory allocation (`malloc`/`new`) is also impractical due to catastrophic heap fragmentation risks and the general lack of memory space.

2. **The Failure of Existing Serialization Standards:**
   * **Text/Self-describing formats (JSON, YAML, CBOR):** Force heavy string parsing, demand intermediate dynamic memory buffers, and are redundant by nature and waste precious network bandwidth.
   * **Schema-driven binary generators (Protobuf, FlatBuffers):** Generate bloated code footprints that rapidly exhaust MCU flash, often require dynamic memory allocation for nested/variable-length structures, and force host applications to interact with awkward, non-idiomatic getters instead of native constructs. They still require serious schema handling discipline in order to deliver on the extensability claims.
   * **Raw C struct dumps:** Fast and zero-allocation, but non-portable (alignment, padding, endianness bugs), structurally fragile, and impossible to decode without manually keeping the low level packet parser/formatter code of all involved parties in sync.

3. **The Schema Coupling Paradox:** Modern edge architectures require cloud gateways, mobile apps, and local bridges to parse telemetry dynamically without re-deploying bridge code for every firmware update or addition of a new device type. However, existing "self-describing" formats are too heavy for MCUs, while lightweight binary formats lock both ends of the wire into rigid, identical compile-time dependencies.

## Key Architectural Decisions

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

### The tripartite separation (information vs data vs signal)

The most foundational principle of this architecture is the strict, structural decoupling of three distinct domains:
*   **The Semantic Model** (information): The mathematical, abstract intent of the data (e.g., `Integer(0, 255)`, `Struct`, `Union`, `List`). It contains no hardware specifics like bit-width or endianness and acts as the pure structural routing layer linking host memory to network bytes.
*   **The Target Model** (data): How the host application natively stores and interacts with the data (e.g., an idiomatic C++ `struct`, a zero-copy DMA ring buffer, or a proper JS object, Buffer or a DataView). 
*   **The Wire Format** (signal): The physical representation of bytes transmitted over the communication medium (e.g., bit-packed headers, LEB128 varints, or UTF-8 JSON text, TLV).

This decoupling allows for these distinct aspects of a protocol to change and evolve separately. 

### Dual generation via composable projections

Because memory layout and wire representation are completely decoupled from the semantic intent, they are bridged using a **Projection**. 

A Projection applies composable mapping rules to the Semantic tree. From this single source of truth, the compiler generates *both* sides of the serialization boundary:
1.  _Target_ data model generation: it emits the idiomatic, native memory structures for the host application based on the **semantic type model** only and driven by target mapping rules (e.g., generating highly optimized C++ `.h` files with specific alignment requirements).
2.  _Parser/Formatter_ generation: it emits the execution logic (the generated Codec IR) responsible for seamlessly translating between the wire format and those generated host structures. It can be used in multiple ways:
    - _Build-time_: it can be used for generating platform native code during a build process for maximal performance and minimal code size by incorporating (and thus locking in) **all current knowledge** about all aspects of the protocol
    - _Runtime_: it can be fetched during the execution of the application (e.g. from the other party) and evaluated directly or transformed into some platform specific code (like a scripting language for ) that yields better performance, while not requiring any knowledge of the wire format. This method only incorporates **limited knowledge** about the protocol at build time. 

### Wire format indepentence

This allows arbitrary wire formats to be employed without affecting the application logic. A dense binary RF protocol can be swapped for a human-readable JSON logging format by simply changing to the composable codec components in the projection, without touching the semantic model or rewriting the host application's data structures. This enables massive code reuse and eliminates boilerplate. 

The abstract IR based runtime codec generation even allows for dynamically negotiating or discovering the wire protocol even if one of the parties is working with very limited resources, because a native, build-time codegen based endpoint (embedded profile) can still serve up its IR as an opaque blob. This scheme can even be stretched further, if the compact codec IR is still too heavy for an endpoint to carry, it can still provide an adequate hash of the _contents_ of the ir, which then can be fetched from a well known location. This achieves far greater guarantees then using a semantic version for this purpose, for example. There is no human factor in this process, the wire mapping code is exact, no judgement needs to be made on the backwards compatibility of the encoding.

### Platform type mapping indepentence

The target data model being independently generated for each platform from the same semantic type tree, guided by per-platform mappings also means that each language/application/use-case is able to tailor its way of accessing the encoded information to its needs independently of the other instances.

#### Inversion of Control (Zero-Allocation Parsers)
To guarantee total flexibility over data representation and memory management, the generated parser/formatter layer **never allocates or owns memory**. Codecs operate purely as procedural bridges. They read from a stream and emit procedural instructions to a proxy. The proxy handles routing that data into the generated target data model, keeping the wire logic agnostic to the host's memory constraints.

## Imlementation

Building a custom lexer, parser, type checker, and IDE extension for a custom DSL adds massive complexity and maintenance overhead. By using **TypeScript as the eDSL**, Node.js acts as the compile-time engine. Standard TS syntax handles compile-time type unrolling and constraint validation for free. By using tagged template literals, we maintain C-like procedural readability for runtime logic. 

## The Semantic Type System (The Metamodel)

The semantic type system acts as the absolute source of truth for the **logical intent** of the data. It is mathematically pure and strictly decoupled from physical constraints—meaning concepts like "bit-width," "endianness," "memory alignment," or "null-termination" do not exist here. 

The metamodel is composed of a minimal set of irreducible structural roots. High-level constructs are aggressively normalized into the core structural types. Dictionaries / Maps are structurally modeled as a list of key value pairs. Raw binary blob are represented semantically as a list of non-negative integers that are less than 256. Strings are represented as list of characters.

### The Primitives

This is the lowest practical level, going even more primitive than this would introduce implementation problems that outweigh architectureal benefits. There are the three primitive types:

* `Integer`: A bounded mathematical range. You do not define a `uint16_t`; you define an `Integer(0, 65535)`. The projection layer later decides if this is packed into 14 bits, sent as a LEB128 varint, or expanded to 32 bits for memory alignment.
* `Float`: Abstract IEEE-754 semantics supporting real numbers, $\pm\infty$, and $\text{NaN}$.
* `Char`: A single Unicode Scalar Value. This provides the semantic context needed for host adapters to generate native string types.

### List

Lists are homogenous sequential items of unknown length. Lists have:

* An element type and
* An optional capacity bound

known about them at compile time. All items in the list share the same exact type. The capacity bound captures abstract behavioral knowledge about the type, but it also serves as guide for selecting the right representation for the data on both the wire format and the host type representation side.

### Struct

Heterogeneous static dictionaries ($\Pi$-types) mapping fixed, compile-time keys to specific types. Each field has a name, a type. Field names must be unique. All fields are always present.

### Union

Unions are tagged/discriminated sum types ($\Sigma$-types) representing mutually exclusive semantic variants. Each variant has a tag and a type. Variant tags must be unique. Exactly one variant is present at all times.

## Mappings

A **Mapping** is a rule-driven walk over the semantic type tree: an ordered list of `(structural predicate, producer)` pairs, tried in order, first match wins. Every generated artifact this project produces — a target language's native type, a wire-format codec, a JSON pretty-printer — is one instance of this same mechanism aimed at a different producer. This uniformity is what lets three unrelated artifacts (a C header, a TS declaration file, an encode/decode program) regenerate consistently from one schema change, and what lets any one of them be swapped for an alternative without touching the other two.

### Structural Predicates

Codecs do not bind to specific, named types. Instead, they act as **declarative predicates** that filter based on topological location and structural constraints. 

Because the metamodel tracks exact integer bounds, a codec signature can express logic like: *"I can encode any integer, as long as its maximum value fits in a byte."*

### Three layers, three lifecycles

Because a Mapping is just "dispatch + producer," the same three-way split applies to every kind of Mapping this project has, and it's worth naming explicitly since the layers evolve at very different rates and shouldn't be mixed in one module:

1. **Core / platform.** The facilities that let semantic types and Mappings be *defined* at all — nothing here knows about any specific type shape or wire format. This is `@ppl/core` (the metamodel; `TypePattern`/`matchType`, the structural predicate vocabulary; `runRuleset`, the rule-based dispatch engine) and `@ppl/machine` (the generic, protocol-agnostic IR/lowering/VM, and the `Extension` hook that lets a domain — codecs, eventually others — add its own opcodes without `@ppl/machine` ever having to know what a codec is). Changes here are rare and load-bearing: everything downstream depends on this layer's shape staying stable.
2. **Components.** The actual, reusable Mappings built on top of layer 1: a target's type-mapping rules (`@ppl/target-cpp`, `@ppl/target-js`), a wire format's codec rules (`@ppl/codecs`'s default binary rules, plus opt-in alternatives like delta-LEB128 lists or a JSON pretty-printer). These are libraries, plural — an application picks one, several, or writes its own alongside them. None of them is "the" codec or "the" type mapping; they're swappable by construction, and nothing in layer 1 privileges one over another.
3. **Application.** A semantic schema (the project's one real asset) plus the specific choice of which layer-2 components to run over it, producing the actual generated artifacts. This layer should own no generic machinery of its own — see `packages/example/compose.ts`, which composes layer-1 engines and layer-2 libraries over one schema and nothing else.

A useful test for "which layer does this belong in": if it can be swapped out for an alternative without the application even noticing, it's a component (layer 2). If swapping it out would mean rewriting the mechanism everything else rides on, it's core (layer 1). Machinery invented to solve one component's problem should still be judged as layer 1 or layer 2 on its own merits — a generic dispatch engine doesn't become a "component detail" just because a components package happened to be where the need first showed up.

### Type mapping

A target's type mapping is a `Rule<C>[]` (`@ppl/core/projection.ts`) run via `runRuleset` against the semantic `TypeGraph` — one rule set per target, living in that target's own package (`@ppl/target-cpp`, `@ppl/target-js`), never in `@ppl/core` itself. `@ppl/core` provides the dispatch engine and the predicate vocabulary (layer 1); each target package is a component library (layer 2) built on it.

### Codecs

A wire-format codec is the same shape aimed at a different producer: instead of a target type declaration, each matched semantic type produces an `ir` fragment — a `Procedure` body for `@ppl/machine`'s VM. `@ppl/codecs` supplies two things codecs need beyond what a type mapping gets for free from `@ppl/core` alone, both layer 1 despite living in this package:

- **The codec `Extension`** (`engine/codec-extension.ts`) — the opcode vocabulary (`ENTER`, `CALL_CODEC`, `READ`/`WRITE`, ...) that lets a codec body be authored as real `ir` text at all. This is domain infrastructure, not a component: it doesn't encode anything by itself, it's what makes encoding *expressible*. It lives in `@ppl/codecs` rather than `@ppl/machine` only because `@ppl/machine` must stay protocol-agnostic (`docs/ROADMAP.md` item 7) — conceptually it's still core.
- **The on-demand resolver** (`engine/resolver.ts`) — `runRuleset` fills its result map in one eager top-down pass, with no way to hand a not-yet-finished child a reserved slot before a sibling embeds it into its own instruction stream. Codec generation needs pull-based, memoized, cycle-safe resolution instead (a struct can reference itself through a union arm), so `@ppl/codecs` carries its own small driver for that one differing requirement rather than stretching `runRuleset` to cover an execution model it wasn't built for. A rule's `produce` sees only its own match witness and a `resolve` callback keyed on a child's `SemanticType` identity directly — no `TypeNode`, no graph — though the driver still rides internally on `@ppl/core`'s `TypeGraph` (via `TypeGraph.nodeOf`) for the actual cycle-breaking and thunk-unwrapping, rather than re-deriving that already-proven logic a second time. It's still a dispatch engine, not a codec, even though today it lives next to its only consumer — if a second consumer needs the same on-demand/cycle-safe resolution (e.g. a target generating declarations for a recursive type), that's the point to promote it into `@ppl/core` alongside `runRuleset` as one shared layer-1 primitive, not before.

The actual codec rule sets are layer 2, plain and simple: `components/binary-rules.ts`'s default length-prefixed/tag-hoisted binary encoding, and the opt-in alternatives (`components/delta-leb128.ts`, `components/json.ts`) that compose alongside or instead of it. None of them is privileged by `buildCodec` (`engine/builders.ts`) itself — it takes the rule set to run as a plain required argument, exactly the way `runRuleset` takes one for a type mapping, so an application is never stuck with an implicit default it can't fully replace. Direction, for the binary rules, is which of two flat rule lists (`binaryEncodeRules`/`binaryDecodeRules`) you pass in, not a value threaded through every rule — a resolver run already commits to one direction for its whole walk, so nothing inside a single `produce` call ever needs to branch on it.

### Projections

A **Projection** is the application-layer act of running chosen layer-2 components — a type mapping, a codec, or both — over one shared semantic schema to produce the artifacts a real system needs (see the tripartite diagram above). `packages/example/compose.ts` is the reference shape: it builds the `TypeGraph` once, then applies each package's Mapping to it, and owns nothing generic itself.
