import {IntegerType, isInteger, isList, isReference, isStruct, isUnion, isUnit, kindOf, ListType, SemanticType, SemanticTypeKinds, StructType, UnionType, UnitType} from "./metamodel"

export interface UnitPattern 
{
    kind: SemanticTypeKinds.Unit
}

export const isUnitPattern = (P: TypePattern): P is TypePattern => P.kind === SemanticTypeKinds.Unit

export interface UnitMatch
{
    kind: SemanticTypeKinds.Unit
}

export const matchUnit = (T: UnitType, P: UnitPattern): UnitMatch | undefined => ({kind: SemanticTypeKinds.Unit})

export interface IntegerPattern
{
    kind: SemanticTypeKinds.Integer
    min: number,
    max: number
}

export const isIntegerPattern = (P: TypePattern): P is IntegerPattern => P.kind === SemanticTypeKinds.Integer

export interface IntegerMatch 
{
    kind: SemanticTypeKinds.Integer
    min: number
    max: number
}

export const matchInteger = (T: IntegerType, P: IntegerPattern): IntegerMatch | undefined => 
{
    if(P.min <= T.min && T.max <= P.max) return {kind: SemanticTypeKinds.Integer, min: T.min, max: T.max}
}

export interface ListPattern 
{
    kind: SemanticTypeKinds.List
    elementPattern: TypePattern
    capacityMax?: number
}

export const isListPattern = (P: TypePattern): P is ListPattern => P.kind === SemanticTypeKinds.List

export interface ListMatch 
{
    kind: SemanticTypeKinds.List
    elementMatch: TypeMatch
    capacityMax?: number
}

export const matchList = (T: ListType, P: ListPattern): ListMatch | undefined => 
{
    if(P.capacityMax === undefined || T.capacity !== undefined && T.capacity <= P.capacityMax) 
    {
        return matchType(T.elementType, P.elementPattern);
    }
}

export interface StructPattern 
{
    kind: SemanticTypeKinds.Struct
    fieldPatterns: {[name: string]: TypePattern}
    restPattern: TypePattern
}

export const isStructPattern = (P: TypePattern): P is StructPattern => P.kind === SemanticTypeKinds.Struct

export interface UnionPattern
{
    kind: SemanticTypeKinds.Union
    variantPatterns: {[name: string]: TypePattern}
    restPattern: TypePattern
}

export const isUnionPattern = (P: TypePattern): P is UnionPattern => P.kind === SemanticTypeKinds.Union

export type TypePattern = UnitPattern | IntegerPattern | ListPattern | StructPattern | UnionPattern
export type TypeMatch = UnitMatch | IntegerMatch | ListMatch | StructMatch | UnionMatch

export function matchType(T: SemanticType, P: TypePattern)
{
    if(isUnit(T))      return isUnitPattern(P)     ? matchUnit(T, P)     : undefined
    if(isInteger(T))   return isIntegerPattern(P)  ? matchInteger(T, P)  : undefined
    if(isList(T))      return isListPattern(P)     ? matchList(T, P)     : undefined
    if(isStruct(T))    return isStructPattern(P)   ? matchStruct(T, P)   : undefined
    if(isUnion(T))     return isUnionPattern(P)    ? matchUnion(T, P)    : undefined
    if(isReference(T)) return matchType(T(), P)

    throw new Error("Nope.")
}

export function printTypeAst(T: SemanticType): string
{
    if(isUnit(T)) return printUnit(T)
    if(isInteger(T)) return printInteger(T)
    if(isList(T)) return printList(T)
    if(isStruct(T)) return printStruct(T)
    if(isUnion(T)) return printUnion(T)
    if(isReference(T)) return printReference(T)

    throw "Nope"
}

const printUnit = (_: UnitType): string => "-"
const printInteger = (S: IntegerType): string => `(${S.min}, ${S.max})`
const printList = (S: ListType): string => printTypeAst(S.elementType) + "[" + (S.capacity ?? "") + "]"
const printStruct = (S: StructType): string => `{${S.fields.map(({name, type}) => `${name}: ${printTypeAst(type)}`).join("; ")}}`
const printUnion = (S: UnionType): string => `<${S.variants.map(({name, type}) => `${name}: ${printTypeAst(type)}`).join(" | ")}>`
const printReference = (S: () => SemanticType): string => "^"
