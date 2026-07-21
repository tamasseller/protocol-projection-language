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

Tree walking

### Structural Predicates

Codecs do not bind to specific, named types. Instead, they act as **declarative predicates** that filter based on topological location and structural constraints. 

Because the metamodel tracks exact integer bounds, a codec signature can express logic like: *"I can encode any integer, as long as its maximum value fits in a byte."*

### Type mapping

### Codecs

### Projections
