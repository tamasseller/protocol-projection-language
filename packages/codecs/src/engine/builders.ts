/**
 * @ppl/codecs — Generic codec builder driver
 *
 * `buildCodec(root, rules, initialCtx)` walks a semantic type and generates
 * a real `RtlProgram` for it — the metaprogramming layer codec-extension.md
 * always assumed would exist (§5: "the metaprogramming layer that walks the
 * semantic type graph and emits `ir` fragments").
 *
 * This is Layer 1 (docs/ARCHITECTURE.md's "Mappings" section): a thin,
 * opinion-free driver over `./resolver`'s generic on-demand resolution
 * primitive. It has no built-in notion of "the" codec, and no built-in
 * notion of "direction" either — `rules` is a plain required argument,
 * exactly the ordered `CodecRule<Ctx>[]` (pattern + producer, `./resolver`)
 * that will actually run, first match wins. Direction, for the binary
 * family, is which of `../components/binary-rules.ts`'s two rule lists you
 * pass in — `Ctx` there is `void`, since nothing about *which* rule runs
 * needs to vary per call once the list itself is already direction-specific
 * (see that file for why: a single rule list threading a runtime direction
 * flag through every `produce` call was pure ceremony once every resolver
 * run is already committed to one direction for its whole walk). `Ctx`
 * stays generic here because not every rule family is direction-shaped —
 * `../components/json.ts` uses it for nesting depth instead.
 */

import type { RtlProgram } from "@ppl/machine"
import { lowerProgram } from "@ppl/machine"
import type { SemanticType } from "@ppl/core"
import { codecRules } from "./codec-extension"
import type { CodecRule } from "./resolver"
import { createCodecResolver } from "./resolver"

/**
 * Build a complete `RtlProgram` for `root` from `rules` (first match wins —
 * list a caller's own rules before a library's to let them preempt it for
 * specific shapes) and `initialCtx` (the context the root itself resolves
 * with — `undefined` for a `CodecRule<void>[]` library like the binary
 * rules, `0` for a depth-keyed one like `json.ts`'s). Returns the program
 * only — not a bound `Extension`, since an `Extension` (via
 * `createCodecExtension`, codec-extension.ts) is bound to one specific
 * root *value* and byte buffer, which only exist per encode/decode call,
 * not per type; build the program once with `buildCodec`, then call
 * `createCodecExtension(direction, {container, key, type: root}, buffer)`
 * fresh for every value encoded/decoded against it.
 */
export function buildCodec<Ctx>(root: SemanticType, rules: readonly CodecRule<Ctx>[], initialCtx: Ctx): RtlProgram
{
    const resolve = createCodecResolver(rules)
    return lowerProgram(resolve(root, initialCtx), { rules: codecRules })
}
