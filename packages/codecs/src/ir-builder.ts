/**
 * The Intermediary Representation (IR) Builder.
 *
 * STATUS: STUB. The `ir` tagged template function will eventually parse
 * string chunks and injected values into an in-memory IR Node tree (AST)
 * for the C++ code generator to traverse. For now it returns an opaque
 * placeholder so dependents can type-check without implementing the
 * micro-parser.
 *
 * TODO: Implement micro-parser to stitch strings and TS values into an IR AST.
 */

/**
 * Placeholder for an unimplemented IR AST node.
 * The real node union will replace this once the IR instruction set
 * (YIELD_VAL, ASSIGN_SPAN, READ_U8, SWITCH, TRAP, ...) is designed.
 */
export type IRNode = {
    readonly kind: "IR_PLACEHOLDER";
    readonly strings: ReadonlyArray<string>;
    readonly values: ReadonlyArray<unknown>;
};

export function ir(strings: TemplateStringsArray, ...values: unknown[]): IRNode {
    return {
        kind: "IR_PLACEHOLDER",
        strings: Array.from(strings),
        values,
    };
}
