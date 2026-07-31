/**
 * @ppl/core/machine — Combo metadata
 *
 * One constant object per combo, bundling its three properties. Single source
 * of truth consulted from operator-rule builders. Naming and semantics match
 * isa-core.md §6.3.
 */

import type { ComboName, OutputLocation, Resource } from "./east"

export interface ComboMeta
{
    /** Resources the op disturbs beyond its declared output. */
    readonly clobbers: readonly Resource[]
    /** Net TOS depth change contributed by the op itself (excluding children). */
    readonly tosDelta: number
    /** Result location. */
    readonly output: OutputLocation
}

export const COMBO: Record<ComboName, ComboMeta> = {
    REG_ACC:   { clobbers: ["acc"],        tosDelta:  0, output: "acc" },
    REG_REG:   { clobbers: ["acc"],        tosDelta:  0, output: "reg" },
    PEEK_ACC:  { clobbers: ["acc"],        tosDelta:  0, output: "acc" },
    PEEK_PEEK: { clobbers: ["acc", "tos"], tosDelta:  0, output: "tos" },
    POP_ACC:   { clobbers: ["acc"],        tosDelta: -1, output: "acc" },
    PEEK_PUSH: { clobbers: ["acc", "tos"], tosDelta:  1, output: "tos" },
    IMM_ACC:   { clobbers: ["acc"],        tosDelta:  0, output: "acc" },
}
