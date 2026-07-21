/**
 * The Intermediary Representation (IR) Builder.
 * This tagged template function catches runtime logic and builds the AST.
 */
export type IRNode = string | IRNode[];

export function ir(strings: TemplateStringsArray, ...values: any[]): IRNode {
    // TODO: Implement micro-parser to stitch strings and TS values into an IR AST
    return { strings: Array.from(strings), values };
}
