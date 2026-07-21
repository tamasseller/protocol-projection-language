# Protocol projection language

A language capable of describing bidirectional mappings between semantic object graphs and arbitrary wire representations.

## Representative Problem Set

The following examples are intentionally chosen to span different regions of the design space. Each isolates a particular class of mapping between a semantic object model and a wire representation. Collectively, they serve as a problem statement for evaluating the expressive power required from the language and its runtime.

---

### Fixed binary layout with cross-field dependencies (UDP)

**Problem statement**

A fixed binary layout containing fields whose values are derived from other fields or from the serialized output itself. Requires calculated fields and potentially multipass serialization.

**Object representation**

```text
UdpPacket {
    srcPort : u16
    dstPort : u16
    payload : byte[]
}
```

**Wire representation**

```text
+---------+---------+
| SrcPort | DstPort |
+---------+---------+
| Length* | Check*  |
+-------------------+
| Payload ...       |
+-------------------+

(* calculated)
```

---

### Bit packing

**Problem statement**

Fixed-size fields occupy arbitrary numbers of bits rather than bytes. Requires bit-level read/write operations.

**Object representation**

```text
Status {
    mode : u3
    enabled : bool
    channel : u4
}
```

**Wire representation**

```text
76543210
MMMECCCC
```

---

### Boolean array as bitmap

**Problem statement**

A semantic collection of booleans represented as packed bits. The collection size is dynamic while the wire representation performs bit-level packing.

**Object representation**

```text
Flags {
    values : bool[]
}
```

**Wire representation**

```text
Length

00110110
10000001
...
```

---

### Generic collection codecs

**Problem statement**

The same semantic collection may be represented using different serialization strategies such as length-prefixed, terminated, or chunked representations.

**Object representation**

```text
Array<T>
```

**Wire representation**

Length-prefixed:

```text
Count
Elem
Elem
...
```

Terminated:

```text
Elem
Elem
END
```

---

### Tagged unions

**Problem statement**

Runtime variant selection. The decoder selects the concrete object type from a wire-level discriminator while exposing a typed union at the semantic level.

**Object representation**

```text
Value =
    Int(i32)
  | Text(string)
  | Blob(byte[])
```

**Wire representation**

```text
Tag
Payload...
```

---

### Optional fields (TLV / presence bitmap)

**Problem statement**

Optional object members represented either by TLV records (unknown fields ignored) or by a presence bitmap controlling a fixed layout. The semantic object remains unchanged despite substantially different wire representations.

**Object representation**

```text
DeviceInfo {
    serial? : string
    fw? : Version
    temp? : f32
}
```

**Wire representation**

TLV:

```text
Type Len Value
Type Len Value
...
```

Presence bitmap:

```text
PresenceBitmap
Field1
Field3
```

---

### Recursive typed trees

**Problem statement**

Recursive object graph with statically known node types. Demonstrates recursion through the type system.

**Object representation**

```text
Node = {
    entries :
        map<string,
            string | Node[]>
}
```

**Wire representation**

```text
Object
 ├─ key
 ├─ string
 └─ array
     └─ Object
```

---

### Generic recursive trees (JSON-like)

**Problem statement**

Fully generic hierarchical data with runtime type selection. Exercises recursion, tagged unions, heterogeneous collections, and maps simultaneously.

**Object representation**

```text
Primitive =
    string
  | number
  | boolean
  | null

Tree =
    Primitive
  | Tree[]
  | map<string, Tree>
```

**Wire representation**

```text
Object
 ├─ "a": Number
 ├─ "b": Array
 │      ├─ Bool
 │      └─ Object
 └─ "c": String
```

---

### Compression (LZ4)

**Problem statement**

The semantic object passes through a transformation stage before transmission. Compression represents an extreme case where the wire representation is no longer a direct structural mapping.

**Object representation**

```text
Firmware {
    image : byte[]
}
```

**Wire representation**

```text
Compressed Block

+------------+
| LZ4 stream |
+------------+
```

---

### Summary

Taken together, these examples suggest that the desired system is considerably more general than a conventional serialization format. It should be capable of expressing:

* Structural mapping between semantic objects and binary layouts.
* Representation transformations such as bit packing, optional fields, and collection encodings.
* Context-sensitive encoding through computed and cross-dependent fields.
* Recursive composition.
* Generic codecs parameterized by semantic types.
* Runtime dispatch through tagged unions.
* Streaming and transformation stages such as compression.
* Arbitrary yet analyzable codecs suitable for efficient code generation and runtime interpretation.

# Architectural Decomposition

The examples above suggest that the problem naturally decomposes into several largely orthogonal concerns. Separating them early should simplify both the language design and the implementation strategy.

## Semantic type system

The semantic layer defines the object model independently of any wire representation. It is purely declarative and describes the concepts exposed to application code. Typical entities include primitive types, structures, interfaces, tagged unions, collections, generic types, recursive types, and reusable abstractions. This component is analogous to a conventional Interface Definition Language (IDL) and should contain no serialization-specific concerns.

Numerous existing systems (TypeScript, Protocol Buffers, OpenAPI, GraphQL, CORBA IDL, etc.) provide inspiration for this layer, making it the least exploratory part of the overall design.

## Object-to-wire mapping language

The second component describes how semantic objects are transformed into and reconstructed from wire representations. Unlike the semantic layer, this is operational rather than purely declarative. It must be capable of expressing arbitrary binary layouts, self-describing formats, recursive encodings, context-sensitive fields, computed values, transformations such as compression, and other serialization strategies while remaining sufficiently structured for static analysis and efficient code generation.

This language should be independent of any particular serialization format. Instead, established formats such as CBOR, TLV, JSON, or custom binary protocols should ideally be expressible as libraries or reusable codec definitions rather than requiring dedicated compiler support.

## Interaction between semantics and encoding

The semantic type system and the mapping language are intentionally separated but tightly coupled.

The semantic layer defines *what* information exists, while the mapping layer defines *how* that information appears on the wire.

A single semantic type may have multiple independent encodings, and a single encoding strategy should ideally be reusable for multiple semantic types through generic composition.

The interaction between the two layers therefore becomes one of the principal design problems.

## Root entities

The entry point of the language remains an open design question.

Possible candidates include:

* semantic types;
* interfaces or operations (RPC-like);
* codecs;
* complete protocol descriptions;
* modules exposing multiple interfaces.

The chosen root abstraction determines both the compilation model and the organization of reusable components.

## Compilation targets

The language should support multiple independent compilation targets generated from a single source description.

These include:

* efficient native parser/formatter source code suitable for embedded firmware;
* host-side source code or bindings for multiple programming languages;
* documentation;
* a compact embedded runtime representation.

## Runtime intermediate representation

The embedded representation should be viewed as a compiled form of the interface description rather than as a serialized copy of the source language.

Its primary purpose is to allow a host application to reconstruct the semantic interface and execute the corresponding codecs without prior knowledge of the specific protocol.

This representation should therefore be compact, versionable, and efficient to interpret. While interpretation is the primary execution model, the design should not preclude ahead-of-time or just-in-time compilation into host-native code where appropriate.

The runtime representation is expected to bind semantic object definitions and executable codec descriptions into a single portable artifact. It therefore serves simultaneously as an interface description, a codec repository, and a runtime reflection mechanism.

## Overall objective

The ultimate objective is not merely to define another serialization format or Interface Definition Language. Instead, the goal is to define a language capable of describing bidirectional mappings between semantic object models and arbitrary wire representations, together with a compilation pipeline that can generate both highly optimized native implementations and a compact portable runtime representation from the same source description.

# Language definition

## The type system

Since the semantic layer defines what information exists independently of any wire representation, its logical structure must be capable of expressing:
* product types (structs/records), 
* sum types (unions/variants), 
* collections, 
* parameterized generics, 
* and recursion.

Here is the representation of this type system using a set of logical nodes modeled here as TypeScript interfaces:

```typescript
type Expression = 
    | PrimitiveType
    | 

type PrimitiveType = 
    | IntegerType 
    | DecimalType 
    | BooleanType 
    | CharType 
    | UnitType;

interface IntegerType {
    kind: "Integer";
    min?: number; // e.g., 0
    max?: number; // e.g., 65535
}

// IEEE-754 semantics (NaN, Infinity) but agnostic to physical size
interface FloatType {
    kind: "Float";
    width: | "half"      // sign 1bit, exponent 5 bits, fraction: 10 bits stored
           | "single"    // sign 1bit, exponent 8 bits, fraction: 23 bits stored
           | "double"    // sign 1bit, exponent 11 bits, fraction: 52 bits stored
           | "quadruple" // sign 1bit, exponent 15 bits, fraction: 112 bits stored
           | "octuple"   // sign 1bit, exponent 19 bits, fraction: 237 bits stored
}

type CollectionType = ListType | MapType;

interface StructType {
    kind: "Struct";
    fields: Field[];
}

interface Field {
    name: string;
    type: TypeExpression;
    isOptional: boolean; // e.g., fw? : Version
}

interface UnionType {
    kind: "Union";
    variants: Variant[];
}

interface Variant {
    name: string;
    payload: TypeExpression; // Can be a Primitive, Struct, or Unit if no payload
}

interface ListType {
    kind: "List";
    elementType: TypeExpression;
    capacity?: number; // e.g., List<T, 10>
}

interface TypeReference {
    kind: "Reference";
    targetName: string;            // The name of the TypeDefinition being referenced
    typeArguments: TypeExpression[]; // E.g., if targeting Array<T>, this holds the bound type for T
}
```

## The scaffolding

```typescript

interface Project {
    semantics: Map<string, TypeDefinition>; 
    codecs: Map<string, CodecScaffolding>;
    projections: Map<string, ProjectionDefinition>;
}

interface SemanticModule {
    types: Map<string, TypeDefinition>;
}

interface TypeDefinition {
    name: string;
    typeParameters: string[]; 
    body: TypeExpression;
}

```

