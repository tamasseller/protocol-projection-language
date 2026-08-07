/**
 * @ppl/codecs — Barrel re-exports.
 *
 * The codec extension (`Extension` hook for `@ppl/machine`, ROADMAP.md
 * item 7), the generic codec-generation library built on top of it, and
 * a couple of specific, opt-in codecs (delta+LEB128 lists, encoder-only
 * pretty-printed JSON) demonstrating what it can do beyond plain binary.
 */
export * from "./codec-extension"
export * from "./rules"
export * from "./builders"
export * from "./delta-leb128"
export * from "./json"
