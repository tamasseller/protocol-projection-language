# Workspace TODO

Management-level state, one section per repo. Each repo's own docs carry the
design and the specifications; what lands here is what to do next.

## ppl

### Codec extension

- TS side carriers adopted where an id was hand-picked: struct rules, delta-leb128's walks, iso8601-demo
  - everywhere else a bare 0 is just o0/i0 — documentation value only, no collision to prevent
  
- Crypto primitives (CRC, hash, MAC, cipher, AEAD) — design sketch in crypto.md, nothing implemented.
  - No reserved opcodes remain; needs the extension-level escape crypto.md §2.1 proposes.
  - Key material: host-bound key slot table, never an ISA value or an object handle (§5). Key establishment (DH) stays above this layer.

- Quantities / units of measurement — design sketch in quantities.md, nothing implemented.

- small-value-space merging binary codec, e.g. a union tag merged with a limited-range number field in one variant. Needs annotation or a meta-argument to say what merges with what, since it favours some variants heavily over others compactness-wise.

### Target codegen

- target-type-mapping composability: a regular baseline plus selectively-opted special representations
- raise.ts pattern match recognizing WRITE_SEQ/READ_SEQ, emitting a raw-buffer/DMA version for a target that opted in — codec-extension.md §3.5 built the snatch point, choosing what to do with it is open
- js codegen total runtime stream and object accessor isolation -> it becomes slim core that basically always uses a runtime dep + bunch of rules that depend on the details of that runtime mainly.
- try to apply a core vs codec-extension split, should be pretty easy i think, if done right core codegen could move into the mog-core repo
- c++ codegen the same way as the js works: the core should be almost identical to js + another bunch of specific rules

### Proofing

- example project
  - develop a narrative as if it was a case study, to show how protocol evolution is handled, keep different version to check interoperability.
  - exercise the whole machinery for realistic cases
  - structure it like a proper application to validate and showcase the ergonomics

- tools
  - codec back and forth tester
    - known semantic value test vector roundtrip
    - semantic value fuzzing?
    - is there a simple way to track coverage via the vm? that could also be applied to simple roundtrip tests

- exercises
  - implement codec for legacy hunor protocol: fully custom format, extremely dense encoding, should be possible to make it fully compatible, usable and extendable at the same time.
  - try to implement systematic encoder that acheives similar compactness or better by leveraging the ability to have optional fields simply
  - could we encode 
    - frames of proper network porotocols?
      - DHCP: should be trivial
      - modbus: should be relatively easy but the thing itself doesn't make too much sense semantically
      - IPv4/IPv6 with some of the extension nonsense, could exercise direct access mapping
      - TLS: obvious crypto focus with negotiated suites (probably too much)
      - can we represent stupid HTTP framing properly (req/status line, header parsing, chunked mode, etc)
    - legacy file format containerization things
      - BMP: fixed(?) header, then a header dependent pixel representation
      - tar is a nice quirky one (octal numbers LOL) but is also relatively simple

### Documentation

- document the whole ppl properly
  - brief rationale in the readme with problem statement, why prior-art is no match, how this package solves it maybe in the form of a mini tutorial 
  - write a case-study like doc about the example project, explain all the mechanisms that solve the challanges.
  - create a definitive guide to all the important bits. It is supposed to give enough insight to a skilled reader to comprehend the operation of the whole system. Also fold in the root docs, some of those are early superseeded drafts, never touched since, but may contain important information and there's the specification of the extension of the MOG ISA.

