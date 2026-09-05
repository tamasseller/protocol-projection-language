# Workspace

Four repos live side by side here, each with its own git:

- `ppl/` — the projection language: metamodel, codec extension, JS codegen
- `mog-core/` — the MOG ISA: DSL, lowering, VM, wire format
- `mog-jit/` — the ARMv6-M JIT for MOG bytecode
- `ppl-example/` — a worked protocol built on `ppl`

`ppl-example` and `ppl` depend on their siblings by git URL, not by path, so
each clones and builds on its own. This repo carries only what spans all
four: `CLAUDE.md` and `.claude/`.
