Done:
* name for the whole machine/isa/vm/jit thing, the technology as a whole (the part that is not PPL specific): **MOG** — Motor-Gerät, the powered-implement half of Unimog. A bounded core chassis with a standardized take-off, and the domain implement bolts on.**

Open:
- JIT
  - move to separate root repo, publish on github (needs to move the current @ppl/machine as well)
  
- @ppl/machine
  - process improvements.md with regard to recent ISA revision
  - move @ppl/machine to separate root repo publish on github
  - DSL improvements

- ISA
  - opcode mapping change
  - BR_TABLE exhaustive, change encoding to rule out BR_TABLE 0

- the actual PPL itself
  - Quantities / units of measurement — design sketch in docs/quantities.md, nothing implemented.
  - reorganize packages once the genuinely general purpose parts are moved out, consider real application usage patterns (could be developed via ).
  - codec extension 
    - DSL level upgrades (allowed by upgraded extension mechanism)
    - crypto extension on the remaining reserved opcodes (covers all sorts of well known, standardized coding schemes, crcs, hashes, encryption, aead, better not attempted in DSL and would be golden code under any normal circumstances anyway)
  - target codegen
    - try to apply a core vs codec extension split, should be pretty easy i think, if done right core codegen could move into the root machine repo
    - js codegen total runtime stream and object accessor isolation -> it becomes slim core that basically always uses a runtime dep + bunch of rules that depend on the details of that runtime mainly.
    - c++ codegen the same way as the js works: the core should be almost identical to js + another bunch of specific rules
  - example project
    - develop a narrative as if it was a case study, to show how protocol evolution is handled, keep different version to check interoperability.
    - exercise the whole machinery for realistic cases
    - structure it like a proper application to validate and showcase the ergonomics
  - document the whole ppl properly
    - brief rationale in the readme with problem statement, why prior-art is no match, how this package solves it maybe in the form of a mini tutorial 
    - write a case-study like doc about the example project, explain all the mechanisms that solve the challanges.
    - create a definitive guide to all the important bits. It is supposed to give enough insight to a skilled reader to comprehend the operation of the whole system. Also fold in the root docs, some of those are early superseeded drafts, never touched since, but may contain important information and there's the specification of the extension of the (not yet named) ISA-machine-vm thing.
  - legacy hunor protocol exercise: fully custom codec, extremely dense encoding, probably wants to have a funny semantic representation, but should be possible to make it fully compatible, usable and extendable at the same time.