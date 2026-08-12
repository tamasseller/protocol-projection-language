/**
 * @ppl/codecs — Barrel re-exports.
 *
 * Grouped by docs/ARCHITECTURE.md's "Mappings" layering, not alphabetically:
 * `engine/` is codec-domain infrastructure (stable, load-bearing — the
 * `Extension` hook that makes a codec expressible at all, and the generic
 * on-demand resolver that drives any `CodecRule` set over a semantic type
 * graph); `components/` is a set of independent, swappable codec libraries
 * built on that engine and privileged by none of it. An application chooses
 * which component libraries to run, and in what order, via `buildCodec`'s
 * `rules` argument — see `packages/example/compose.ts`.
 */
export * from "./engine/codec-extension"
export * from "./engine/resolver"
export * from "./engine/validate-handles"
export * from "./engine/opcodes"
export * from "./engine/type-tree-wire"
export * from "./engine/codec-image"
export * from "./engine/reconcile"
export * from "./engine/procedure-types"
export * from "./engine/codec-ext-instr"

export * from "./components/binary-rules"
export * from "./components/delta-leb128"
export * from "./components/json"
