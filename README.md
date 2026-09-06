# Workspace

Four repos live side by side here, each with its own git:

- `ppl/` — the projection language: metamodel, codec extension, JS codegen
- `mog-core/` — the MOG ISA: DSL, lowering, VM, wire format
- `mog-jit/` — the ARMv6-M JIT for MOG bytecode
- `ppl-example/` — a worked protocol built on `ppl`

`ppl-example` and `ppl` depend on their siblings by git URL, not by path, so
each clones and builds on its own. This repo carries only what spans all
four: `CLAUDE.md`, `.claude/`, and `docs/`:

- `docs/TODO.md` — what to do next, one section per repo
- `docs/handover.md` — plans that cross a repo boundary
- `docs/decisions.md` — reasoning that must outlive the change that made it
- `docs/crypto.md`, `docs/quantities.md` — design sketches, nothing implemented

Each repo's own `docs/` keeps its specifications and architecture; what
lands here is management-level or spans more than one repo.
