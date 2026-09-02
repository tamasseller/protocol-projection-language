# Done
* name for the whole machine/isa/vm/jit thing, the technology as a whole (the part that is not PPL specific): **MOG** — Motor-Gerät, the powered-implement half of Unimog. A bounded core chassis with a standardized take-off, and the domain implement bolts on.**

# Current

- JIT
  - JIT bytecode reader interface — plan in jit-armv6m/docs/bytecode-reader.md; carries the extension interface simplification with it
  
- @ppl/machine
  - process improvements.md with regard to recent ISA revision
  - `switch` gap filling now copies the `default:` clause per gap; if that
    shows up as size, the alternative is a per-group range test again

# The move

- Move @ppl/machine and JIT to separate root repos, publish on github
  - create repos, move source, apply branding
  - untagle references (probably npm should reference git repo directly for now)
  - clean up 
    - de-slop docs
    - code readthrough
      - check for AI smells (and regular ones)
      - remove prose comments
    - test/fuzz/bench cleanup on both sides

# PPL

## Hygiene
  - reorganize packages once the genuinely general purpose parts are moved out, consider real application usage patterns (could be developed via ).

## Codec extension 

- clarify stream iterator & object lifecycle: allocation side in docs/extension-surface.md §7-8
- TS side DSL upgrades: design sketch in docs/extension-surface.md, nothing implemented
- crypto extension on the remaining reserved opcodes (covers all sorts of well known, standardized coding schemes, crcs, hashes, encryption, aead, better not attempted in DSL and would be golden code - if not even tucked away in some secure element - under any normal circumstances anyway)
  - how to handle/reference key material? could it/does it need to support environments where those are isolated somehow, how would it interact with higher level code? (for example DH is not a codec level issue but related along key material at least)

- Quantities / units of measurement — design sketch in docs/quantities.md, nothing implemented.

## Target codegen

- try to apply a core vs codec extension split, should be pretty easy i think, if done right core codegen could move into the root machine repo
- js codegen total runtime stream and object accessor isolation -> it becomes slim core that basically always uses a runtime dep + bunch of rules that depend on the details of that runtime mainly.
- c++ codegen the same way as the js works: the core should be almost identical to js + another bunch of specific rules

## Proofing

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

## Documentation

- document the whole ppl properly
  - brief rationale in the readme with problem statement, why prior-art is no match, how this package solves it maybe in the form of a mini tutorial 
  - write a case-study like doc about the example project, explain all the mechanisms that solve the challanges.
  - create a definitive guide to all the important bits. It is supposed to give enough insight to a skilled reader to comprehend the operation of the whole system. Also fold in the root docs, some of those are early superseeded drafts, never touched since, but may contain important information and there's the specification of the extension of the (not yet named) ISA-machine-vm thing.
  