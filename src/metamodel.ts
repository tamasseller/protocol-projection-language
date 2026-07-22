/**
 * Semantic Metamodel AST Definitions
 */

export type SemanticType = IntegerType | StructType | UnionType | ListType;

export type SemanticField = { name: string; type: SemanticType }

export interface IntegerType 
{
    kind: 'Integer';
    min: number;
    max: number;
}

export interface ListType 
{
    kind: 'List';
    elementType: SemanticType;
}

export interface StructType 
{
    kind: 'Struct';
    fields: SemanticField[];
}

export interface UnionType 
{
    kind: 'Union';
    variants: SemanticField[];
}

