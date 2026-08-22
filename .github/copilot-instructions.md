# Agent Instructions

## Role

You are working on compiler infrastructure for a **declarative
serialization compiler** targeting resource-constrained embedded systems,
not standard web or backend serialization code. Start from
`docs/ARCHITECTURE.md`.

## Project context

A two-phase, zero-allocation serialization compiler.

1. **Host language.** TypeScript as an embedded DSL.
2. **Compile-time phase.** Standard TypeScript (`if`, `for`, `map`) unrolls
   structural types and evaluates schema constraints, running in Node.
3. **Run-time phase.** A tagged template literal (`` ir`...` ``) builds an
   AST of IR instructions, later compiled into bare-metal C++, into
   TypeScript source, or into a dense binary blob for an embedded VM
   (`packages/machine/docs/isa-core.md`).

## Hard constraints

1. **No traditional serialization.** Never use or suggest
   `JSON.stringify`, Protobuf wrappers, Serde, or buffer-manipulation
   libraries. This project builds a compiler that *generates*
   byte-manipulation instructions.
2. **Total inversion of control.** Codecs never allocate. They return no
   arrays, buffers or strings; they emit IR instructions (`YIELD_VAL`,
   `ASSIGN_SPAN`, ...) telling the target environment where to put data.
3. **Respect the two phases.** Plain TypeScript syntax runs at
   compile time. Anything inside an `` ir`...` `` block runs at run time on
   the target.
4. **Never flatten the IR to strings.** A real consumer (lowering, a code
   generator) must always receive genuine in-memory AST. Parsing may be
   *deferred*: `` ir`...` `` builds source text and a callee-reference map
   immediately but parses lazily on first access, so a fragment only valid
   once spliced into a larger one (a bare `case N:` clause, say) can be
   assembled before anything parses it. It must still happen, exactly once,
   before the fragment is treated as real IR.
5. **Assume zero-allocation targets.** Generated C++ runs against a static
   memory buffer; `malloc`/`new` are forbidden in it.

## Working protocol

1. State how your solution fits the compile-time versus run-time split.
2. If a feature needs new IR instructions, say explicitly that the `ir`
   parser and the metamodel AST need updating.
3. Change only what the task needs. Provide the updated classes,
   interfaces or rules, not whole rewritten files.
4. Check `docs/ROADMAP.md` for which subsystem is currently in flight.
