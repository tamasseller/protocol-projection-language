/**
 * Semantic Metamodel AST Definitions
 */

export const enum SemanticTypeKinds
{
    Unit     = "unit",
    Integer  = "integer",
    List     = "list",
    Struct   = "struct",
    Union    = "union"
}

export type SemanticType = UnitType | IntegerType | StructType | UnionType | ListType | (() => SemanticType)

export type SemanticField = {name: string; type: SemanticType}

export interface UnitType {kind: SemanticTypeKinds.Unit}
export const unit: UnitType = {kind: SemanticTypeKinds.Unit}

export interface IntegerType 
{
    kind: SemanticTypeKinds.Integer
    min: number
    max: number
}

export interface ListType 
{
    kind: SemanticTypeKinds.List
    elementType: SemanticType
    capacity?: number
}

export interface StructType 
{
    kind: SemanticTypeKinds.Struct
    fields: SemanticField[]
}

export interface UnionType 
{
    kind: SemanticTypeKinds.Union
    variants: SemanticField[]
}

export const kindOf = (t: SemanticType): SemanticTypeKinds | "reference" => typeof t === "function" ? "reference" : t.kind

export const isUnit = (t: SemanticType): t is UnitType => kindOf(t) === SemanticTypeKinds.Unit
export const isInteger = (t: SemanticType): t is IntegerType => kindOf(t) === SemanticTypeKinds.Integer
export const isList = (t: SemanticType): t is ListType => kindOf(t) === SemanticTypeKinds.List
export const isStruct = (t: SemanticType): t is StructType => kindOf(t) === SemanticTypeKinds.Struct
export const isUnion = (t: SemanticType): t is UnionType => kindOf(t) === SemanticTypeKinds.Union
export const isReference = (t: SemanticType): t is UnionType => kindOf(t) === "reference"

export const integer = (min: number, max: number): IntegerType => ({kind: SemanticTypeKinds.Integer, min, max})

export const signedInteger = (bits: number): IntegerType => integer(-1 << (bits - 1), (1 << (bits - 1)) - 1)
export const unsignedInteger = (bits: number): IntegerType => integer(0, (1 << bits) - 1)

export const i8 = signedInteger(8)
export const i16 = signedInteger(16)
export const i32 = signedInteger(32)

export const u8 = unsignedInteger(8)
export const u16 = unsignedInteger(16)
export const u32 = unsignedInteger(32)

export const list = (T: SemanticType, capacity?: number): ListType => ({kind: SemanticTypeKinds.List, elementType: T, capacity})

export const struct = (def: {[k: string]: SemanticType}): StructType =>
({
    kind: SemanticTypeKinds.Struct,
    fields: Object.entries(def).map(([k, v]) => ({name: k, type: v}))
})

export const union = (def: {[k: string]: SemanticType}): UnionType =>
({
    kind: SemanticTypeKinds.Union,
    variants: Object.entries(def).map(([k, v]) => ({name: k, type: v}))
})
