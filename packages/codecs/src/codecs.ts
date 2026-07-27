import {UnionType} from '@ppl/core';

/**
 * STATUS: STUB. Skeleton for the Tagged Union Codec demonstrating the TS eDSL
 * pattern. The `decode` method is intentionally a no-op placeholder — the
 * IR instruction set (READ_U8, SWITCH, CASE, TRAP, ...) and the `ir`
 * micro-parser are not yet implemented.
 *
 * TODO: Implement once `ir-builder.ts` produces a real IR AST.
 */
export const TaggedUnionCodec = {
    canHandle(T: unknown): T is UnionType {
        return typeof T === 'object' && T !== null && (T as {kind?: string}).kind === 'Union';
    },

    decode(_T: UnionType, _stream: unknown, _target: unknown, _scope: unknown): void {
        // TODO: emit IR for reading the tag byte, switching on variant tag,
        // and dispatching into per-variant decoders. Placeholder for now.
    },
};
