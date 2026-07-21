/**
 * Semantic Metamodel AST Definitions
 */
export type SemanticType = IntegerType | StructType | UnionType | ListType;

export interface IntegerType {
    kind: 'Integer';
    min: number;
    max: number;
}

export interface StructType {
    kind: 'Struct';
    fields: { name: string; type: SemanticType }[];
}

export interface UnionType {
    kind: 'Union';
    variants: { name: string; type: SemanticType }[];
}

export interface ListType {
    kind: 'List';
    elementType: SemanticType;
}
