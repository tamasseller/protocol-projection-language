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

/** A SemanticType with reference thunks deref'd — the form stored in a TypeNode. */
export type ConcreteSemanticType = UnitType | IntegerType | StructType | UnionType | ListType

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
    fields: Map<string, SemanticType>
}

export interface UnionType 
{
    kind: SemanticTypeKinds.Union
    variants: Map<string, SemanticType>
}

export const kindOf = (t: SemanticType): SemanticTypeKinds | "reference" => typeof t === "function" ? "reference" : t.kind

/** Follow reference thunks through to the concrete type they name — the
 *  same dereferencing `matchType`/`buildTypeGraph` each do internally,
 *  exposed here so any caller holding a possibly-thunk `SemanticType`
 *  (e.g. a child pulled off a match witness) can get its real kind/shape
 *  without re-deriving thunk-unwrapping itself. Recurses in case a thunk
 *  returns another thunk. */
export const derefType = (t: SemanticType): ConcreteSemanticType =>
    typeof t === "function" ? derefType(t()) : t

/** `kindOf`, but following reference thunks first — never returns
 *  `"reference"`. */
export const concreteKindOf = (t: SemanticType): SemanticTypeKinds => derefType(t).kind

export const isUnit = (t: SemanticType): t is UnitType => kindOf(t) === SemanticTypeKinds.Unit
export const isInteger = (t: SemanticType): t is IntegerType => kindOf(t) === SemanticTypeKinds.Integer
export const isList = (t: SemanticType): t is ListType => kindOf(t) === SemanticTypeKinds.List
export const isStruct = (t: SemanticType): t is StructType => kindOf(t) === SemanticTypeKinds.Struct
export const isUnion = (t: SemanticType): t is UnionType => kindOf(t) === SemanticTypeKinds.Union
export const isReference = (t: SemanticType): t is UnionType => kindOf(t) === "reference"

export const integer = (min: number, max: number): IntegerType => ({kind: SemanticTypeKinds.Integer, min, max})

// `2 ** n`, not `1 << n`: JS's `<<` operates on signed 32-bit ints (shift
// amount mod 32, result sign-interpreted), which silently breaks exactly
// at bits=32 — `1 << 32 === 1` (shift-by-32 wraps to shift-by-0), and
// `1 << 31` is already negative — giving `i32`/`u32` nonsense ranges
// (`u32` collapsed to `integer(0, 0)`). `2 ** n` is ordinary double
// arithmetic, correct for every width this is ever called with.
export const signedInteger = (bits: number): IntegerType => integer(-(2 ** (bits - 1)), 2 ** (bits - 1) - 1)
export const unsignedInteger = (bits: number): IntegerType => integer(0, 2 ** bits - 1)

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
    fields: new Map(Object.entries(def))
})

export const union = (def: {[k: string]: SemanticType}): UnionType =>
({
    kind: SemanticTypeKinds.Union,
    variants: new Map(Object.entries(def))
})
