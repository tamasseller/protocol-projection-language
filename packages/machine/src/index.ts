/**
 * @ppl/machine — Barrel re-exports.
 *
 * The generic, protocol-agnostic bytecode compiler and VM (docs/isa-core.md):
 * IR authoring (`ir`/`proc`/`concat`), the AST/EAST layers, the pattern-
 * rewrite lowering ruleset and orchestrator, the RTL instruction set, the
 * lowerer, the whole-program validator, the VM, the wire codec, and the
 * generic extension hook.
 */
export * from "./ast"
export * from "./east"
export * from "./matcher"
export * from "./builders"
export * from "./orchestrator"
export * from "./rtl"
export * from "./rules"
export * from "./lower"
export * from "./validate"
export * from "./vm"
export * from "./bytecode"
export * from "./extension"
export * from "./encoding"
export * from "./ir"
