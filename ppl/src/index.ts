/**
 * ppl — Protocol Projection Language.
 *
 * One semantic schema, projected into every artifact a protocol needs: a
 * wire codec, a host-language type declaration, an accessor surface. The
 * three directories below are a layering, not a packaging boundary —
 * `core` knows nothing of codecs, `codecs` nothing of TypeScript — and
 * that layering is enforced by nothing but the import graph, which is
 * where it belongs.
 *
 * `mog-core` (a separate package) supplies the bytecode ISA, lowering and
 * VM underneath; nothing here re-exports it.
 */
export * from "./core/index"
export * from "./codecs/index"
export * from "./target-js/index"
