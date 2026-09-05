# Protocol projection language

A language for describing bidirectional mappings between semantic object
graphs and arbitrary wire representations.

## Representative problem set

These examples span different regions of the design space, each isolating
one class of mapping between a semantic object model and a wire
representation. Together they are the requirements corpus for the
expressive power the language and its runtime need.

### Fixed binary layout with cross-field dependencies (UDP)

Fields whose values derive from other fields or from the serialized output
itself. Needs calculated fields and potentially multipass serialization.

```text
UdpPacket {                        +---------+---------+
    srcPort : u16                  | SrcPort | DstPort |
    dstPort : u16                  +---------+---------+
    payload : byte[]               | Length* | Check*  |
}                                  +-------------------+
                                   | Payload ...       |
        (* calculated)             +-------------------+
```

### Bit packing

Fixed-size fields occupying arbitrary numbers of bits rather than bytes.
Needs bit-level read/write.

```text
Status {                           76543210
    mode : u3                      MMMECCCC
    enabled : bool
    channel : u4
}
```

### Boolean array as bitmap

A semantic collection of booleans as packed bits: dynamic collection size,
bit-level wire packing.

```text
Flags {                            Length
    values : bool[]                00110110
}                                  10000001
                                   ...
```

### Generic collection codecs

The same semantic collection under different serialization strategies.

```text
Array<T>        length-prefixed:   Count   terminated:   Elem
                                   Elem                  Elem
                                   Elem                  END
                                   ...
```

### Tagged unions

Runtime variant selection: the decoder picks the concrete object type from
a wire-level discriminator while exposing a typed union semantically.

```text
Value =                            Tag
    Int(i32)                       Payload...
  | Text(string)
  | Blob(byte[])
```

### Optional fields (TLV or presence bitmap)

Optional members as either TLV records (unknown fields ignored) or a
presence bitmap controlling a fixed layout. The semantic object is
unchanged across substantially different wire representations.

```text
DeviceInfo {          TLV:                    bitmap:
    serial? : string  Type Len Value          PresenceBitmap
    fw? : Version     Type Len Value          Field1
    temp? : f32       ...                     Field3
}
```

### Recursive typed trees

Recursive object graph with statically known node types. Recursion through
the type system.

```text
Node = {                           Object
    entries :                       ├─ key
        map<string,                 ├─ string
            string | Node[]>        └─ array
}                                       └─ Object
```

### Generic recursive trees (JSON-like)

Fully generic hierarchical data with runtime type selection. Exercises
recursion, tagged unions, heterogeneous collections and maps at once.

```text
Primitive =                        Object
    string | number                 ├─ "a": Number
  | boolean | null                  ├─ "b": Array
                                    │      ├─ Bool
Tree =                              │      └─ Object
    Primitive                       └─ "c": String
  | Tree[]
  | map<string, Tree>
```

### Compression (LZ4)

The semantic object passes through a transformation stage before
transmission. The extreme case: the wire representation is no longer a
direct structural mapping.

```text
Firmware {                         +------------+
    image : byte[]                 | LZ4 stream |
}                                  +------------+
```

### What the set demands

Taken together these require a system considerably more general than a
serialization format, able to express:

- structural mapping between semantic objects and binary layouts;
- representation transformations (bit packing, optional fields, collection
  encodings);
- context-sensitive encoding through computed and cross-dependent fields;
- recursive composition;
- generic codecs parameterized by semantic types;
- runtime dispatch through tagged unions;
- streaming and transformation stages such as compression;
- codecs that stay analyzable enough for efficient code generation and
  runtime interpretation.

## Architectural decomposition

The problem decomposes into largely orthogonal concerns; separating them
early simplifies both the language design and the implementation.

**Semantic type system.** Defines the object model independently of any
wire representation: purely declarative, describing the concepts exposed to
application code. Primitives, structures, interfaces, tagged unions,
collections, generic types, recursive types, reusable abstractions. This is
the IDL-analogous layer, with plenty of prior art (TypeScript, Protocol
Buffers, OpenAPI, GraphQL, CORBA IDL), making it the least exploratory part
of the design. The implemented form is in ARCHITECTURE.md and
`packages/core/src/metamodel.ts`.

**Object-to-wire mapping language.** Describes how semantic objects
transform into and reconstruct from wire representations. Operational
rather than declarative, and must express arbitrary binary layouts,
self-describing formats, recursive encodings, context-sensitive fields,
computed values, and transformations such as compression, while staying
structured enough for static analysis and efficient code generation. It
must be independent of any particular serialization format: CBOR, TLV,
JSON and custom binary protocols should be expressible as libraries or
reusable codec definitions, not as dedicated compiler support. The
implemented form is `mog-core`'s IR plus `@ppl/codecs`'s rule sets.

**Interaction between the two.** Intentionally separated, tightly coupled.
The semantic layer defines *what* information exists; the mapping layer
defines *how* it appears on the wire. A single semantic type may have
several independent encodings, and a single encoding strategy should be
reusable across semantic types through generic composition. This interface
is the principal design problem.

**Root entities.** The language's entry point is still open. Candidates:
semantic types; interfaces or operations (RPC-like); codecs; complete
protocol descriptions; modules exposing multiple interfaces. The choice
determines both the compilation model and how reusable components are
organized.

**Compilation targets,** all generated from one source description:
efficient native parser/formatter source for embedded firmware; host-side
source or bindings for multiple languages; documentation; a compact
embedded runtime representation.

**Runtime intermediate representation.** A compiled form of the interface
description rather than a serialized copy of the source language. Its
purpose is letting a host application reconstruct the semantic interface
and execute the corresponding codecs with no prior knowledge of the
specific protocol, so it must be compact, versionable and efficient to
interpret. Interpretation is the primary execution model, but the design
does not preclude AOT or JIT compilation into host-native code. The
representation binds semantic object definitions and executable codec
descriptions into one portable artifact, serving simultaneously as
interface description, codec repository and runtime reflection mechanism.
The implemented form is the codec image (docs/codec-image.md).

## Objective

Define a language capable of describing bidirectional mappings between
semantic object models and arbitrary wire representations, together with a
compilation pipeline generating both highly optimized native
implementations and a compact portable runtime representation from the same
source description.
