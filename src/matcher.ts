import {IntegerType, isInteger, isList, isReference, isStruct, isUnion, isUnit, kindOf, ListType, SemanticType, SemanticTypeKinds, StructType, UnionType, UnitType} from "./metamodel"

export interface UnitPattern 
{
    kind: SemanticTypeKinds.Unit
}

export const isUnitPattern = (P: TypePattern): P is UnitPattern => P.kind === SemanticTypeKinds.Unit

export interface UnitMatch
{
    kind: SemanticTypeKinds.Unit
}

export const matchUnit = <P extends UnitPattern>(T: UnitType, P: P): MatchOf<P> | undefined => ({kind: SemanticTypeKinds.Unit} as MatchOf<P>)

////////////////////////////////////////////////////////////////////////////////////////////////

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

export const matchInteger = <P extends IntegerPattern>(T: IntegerType, P: P): MatchOf<P> | undefined => 
{
    if(P.min <= T.min && T.max <= P.max) return {kind: SemanticTypeKinds.Integer, min: T.min, max: T.max} as MatchOf<P>
}

////////////////////////////////////////////////////////////////////////////////////////////////

export interface ListPattern<E extends TypePattern = TypePattern>
{
    kind: SemanticTypeKinds.List
    elementPattern: E
    capacityMax?: number
}

export const isListPattern = (P: TypePattern): P is ListPattern => P.kind === SemanticTypeKinds.List

export interface ListMatch<E extends TypeMatch = TypeMatch> 
{
    kind: SemanticTypeKinds.List
    elementMatch: E
    capacity?: number
}

export const matchList = <P extends ListPattern>(T: ListType, P: P): MatchOf<P> | undefined => 
{
    if(P.capacityMax === undefined || T.capacity !== undefined && T.capacity <= P.capacityMax) 
    {
        const e = matchType(T.elementType, P.elementPattern);
        if(e !== undefined)
        {
            return {
                kind: SemanticTypeKinds.List,
                elementMatch: e,
                capacity: T.capacity
            } as MatchOf<P>   
        }
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////

export interface StructPattern<F extends {[name: string]: TypePattern} = {[name: string]: TypePattern}>
{
    kind: SemanticTypeKinds.Struct
    fields: "named"
    fieldPatterns: F
}

export const isStructPattern = (P: TypePattern): P is StructPattern => P.kind === SemanticTypeKinds.Struct && (P as StructPattern).fields === "named"

export interface StructMatch<F extends {[name: string]: TypePattern} = {[name: string]: TypePattern}> 
{
    kind: SemanticTypeKinds.Struct
    fieldMatches: {[K in keyof F]: MatchOf<F[K]>}
}

export const matchStruct = <P extends StructPattern>(T: StructType, P: P): MatchOf<P> | undefined => 
{
    const requiredFields = new Map<string, TypePattern>(Object.entries(P.fieldPatterns))
    const matchedFields = new Map<string, TypeMatch>()

    for(const [name, type] of T.fields.entries())
    {
        const pattern = requiredFields.get(name)
        if(pattern === undefined) return undefined;

        const m = matchType(type, pattern)
        if(m === undefined) return undefined;

        if(matchedFields.has(name)) throw new Error("?")
        matchedFields.set(name, m)
        requiredFields.delete(name)
    }

    if(requiredFields.size === 0)
    {
        return {
            kind: SemanticTypeKinds.Struct,
            fieldMatches: Object.fromEntries(matchedFields)
        } as MatchOf<P>
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Homogeneous-fields struct pattern: matches a struct whose EVERY field's
 * type matches `elementPattern`, regardless of field names. The witness is
 * an ordered collection (one entry per field of T), NOT a fixed record —
 * this is the shape a reduction (e.g. presence-bitmap packing) consumes.
 *
 * `fields: "all"` discriminates this from `StructPattern` (`fields: "named"`).
 */
export interface StructFieldsPattern<E extends TypePattern = TypePattern>
{
    kind: SemanticTypeKinds.Struct
    fields: "all"
    elementPattern: E
}

export const isStructFieldsPattern = (P: TypePattern): P is StructFieldsPattern => P.kind === SemanticTypeKinds.Struct && (P as StructFieldsPattern).fields === "all"

export interface StructFieldsMatch<E extends TypeMatch = TypeMatch>
{
    kind: SemanticTypeKinds.Struct
    fieldMatches: Array<{name: string, match: E}>
}

export const matchStructFields = <P extends StructFieldsPattern>(T: StructType, P: P): MatchOf<P> | undefined => 
{
    const fieldMatches: Array<{name: string, match: TypeMatch}> = []

    for(const [name, type] of T.fields.entries())
    {
        const m = matchType(type, P.elementPattern)
        if(m === undefined) return undefined;
        fieldMatches.push({name, match: m})
    }

    return {kind: SemanticTypeKinds.Struct, fieldMatches} as MatchOf<P>
}

////////////////////////////////////////////////////////////////////////////////////////////////

export interface UnionPattern<V extends {[name: string]: TypePattern} = {[name: string]: TypePattern}>
{
    kind: SemanticTypeKinds.Union
    variantPatterns: V
}

export const isUnionPattern = (P: TypePattern): P is UnionPattern => P.kind === SemanticTypeKinds.Union

export interface UnionMatch<V extends {[name: string]: TypePattern} = {[name: string]: TypePattern}>
{
    kind: SemanticTypeKinds.Union
    variantMatches: {[K in keyof V]: MatchOf<V[K]>}
}

export const matchUnion = <P extends UnionPattern>(T: UnionType, P: P): MatchOf<P> | undefined => 
{
    const requiredVariants = new Map<string, TypePattern>(Object.entries(P.variantPatterns))
    const matchedVariants = new Map<string, TypeMatch>()

    for(const [name, type] of T.variants.entries())
    {
        const pattern = requiredVariants.get(name)
        if(pattern === undefined) return undefined;

        const m = matchType(type, pattern)
        if(m === undefined) return undefined;

        if(matchedVariants.has(name)) throw new Error("?")
        matchedVariants.set(name, m)
        requiredVariants.delete(name)
    }

    if(requiredVariants.size === 0)
    {
        return {
            kind: SemanticTypeKinds.Union,
            variantMatches: Object.fromEntries(matchedVariants)
        } as MatchOf<P>
    }
}

////////////////////////////////////////////////////////////////////////////////////////////////

export interface AnyOfPattern<Ps extends readonly TypePattern[] = readonly TypePattern[]>
{
    kind: "anyof"
    alternatives: () => Ps
}

export const isAnyOfPattern = (P: TypePattern): P is AnyOfPattern => (P as AnyOfPattern).kind === "anyof"

/**
 * Tagged discriminated union of branch witnesses.
 * The `branch` index carries priority information (which alternative won),
 * so consumers (e.g. a struct-fields-optional partition) can tell
 * "matched as optional" from "matched as generic" even when the
 * inner match shapes overlap.
 *
 * Default `Ps` collapses to `{ branch: number; match: TypeMatch }`,
 * the recursive but structurally-lazy form used by the bare `TypeMatch` union.
 */
export type AnyOfMatch<Ps extends readonly TypePattern[] = readonly TypePattern[]> = {
    [I in keyof Ps & number]: { branch: I; match: MatchOf<Ps[I]> }
}[keyof Ps & number]

export const matchAnyOf = <P extends AnyOfPattern>(T: SemanticType, P: P): MatchOf<P> | undefined =>
{
    const alts = P.alternatives()
    for(let i = 0; i < alts.length; i++)
    {
        const m = matchType(T, alts[i] as TypePattern)
        if(m !== undefined) return { branch: i, match: m } as MatchOf<P>
    }
    return undefined
}

////////////////////////////////////////////////////////////////////////////////////////////////

export type TypePattern = UnitPattern | IntegerPattern | ListPattern | StructPattern | StructFieldsPattern | UnionPattern | AnyOfPattern
export type TypeMatch = UnitMatch | IntegerMatch | ListMatch | StructMatch | StructFieldsMatch | UnionMatch | AnyOfMatch

export type MatchOf<P extends TypePattern> =
    P extends AnyOfPattern         ? AnyOfMatch<ReturnType<P["alternatives"]>>
  : P extends ListPattern           ? ListMatch<MatchOf<P["elementPattern"]>>
  : P extends StructFieldsPattern   ? StructFieldsMatch<MatchOf<P["elementPattern"]>>
  : P extends StructPattern         ? StructMatch<P["fieldPatterns"]>
  : P extends UnionPattern          ? UnionMatch<P["variantPatterns"]>
  : P extends IntegerPattern        ? IntegerMatch
  : P extends UnitPattern            ? UnitMatch
  : never

export function matchType<P extends TypePattern>(T: SemanticType, P: P): MatchOf<P> | undefined
{
    // AnyOf is type-agnostic: it dispatches before the type-kind switch
    // and re-enters matchType per alternative (which handles references).
    if(isAnyOfPattern(P))       return matchAnyOf(T, P)
    if(isUnit(T))               return (isUnitPattern(P)           ? matchUnit(T, P)           : undefined) as MatchOf<P> | undefined
    if(isInteger(T))            return (isIntegerPattern(P)        ? matchInteger(T, P)        : undefined) as MatchOf<P> | undefined
    if(isList(T))               return (isListPattern(P)          ? matchList(T, P)           : undefined) as MatchOf<P> | undefined
    if(isStruct(T))
    {
        if(isStructFieldsPattern(P)) return matchStructFields(T, P) as MatchOf<P> | undefined
        if(isStructPattern(P))        return matchStruct(T, P)       as MatchOf<P> | undefined
        return undefined
    }
    if(isUnion(T))              return (isUnionPattern(P)         ? matchUnion(T, P)          : undefined) as MatchOf<P> | undefined
    if(isReference(T))          return matchType(T(), P)

    throw new Error("Nope.")
}

////////////////////////////////////////////////////////////////////////////////////////////////
// Pattern constructors — mirror the metamodel's `unit`/`integer`/`list`/...
// constructors so patterns read like the types they match.
// All return their literal shape so `MatchOf<P>` narrowing still works at
// call sites (the constructor return type is the concrete pattern interface).
////////////////////////////////////////////////////////////////////////////////////////////////

export const pUnit = (): UnitPattern => ({kind: SemanticTypeKinds.Unit})

export const pInteger = (min: number, max: number): IntegerPattern => ({kind: SemanticTypeKinds.Integer, min, max})

export const pList = <E extends TypePattern>(elementPattern: E, capacityMax?: number): ListPattern<E> => ({
    kind: SemanticTypeKinds.List,
    elementPattern,
    capacityMax,
})

export const pStruct = <F extends {[name: string]: TypePattern}>(fieldPatterns: F): StructPattern<F> => ({
    kind: SemanticTypeKinds.Struct,
    fields: "named",
    fieldPatterns,
})

/**
 * Homogeneous-fields struct pattern: every field of T must match
 * `elementPattern`, regardless of name. The witness is an ordered
 * array (one entry per field of T) — the shape a reduction
 * (e.g. presence-bitmap packing) consumes.
 */
export const pStructFields = <E extends TypePattern>(elementPattern: E): StructFieldsPattern<E> => ({
    kind: SemanticTypeKinds.Struct,
    fields: "all",
    elementPattern,
})

export const pUnion = <V extends {[name: string]: TypePattern}>(variantPatterns: V): UnionPattern<V> => ({
    kind: SemanticTypeKinds.Union,
    variantPatterns,
})

/**
 * `alternatives` is lazy (a thunk returning the array) so the pattern
 * graph can be cyclic: a rule may reference the root (or `*`) from inside
 * its own branches. This is the pattern-layer analog of the metamodel's
 * `() => SemanticType` reference thunks.
 *
 * Use `as const` on a literal array at the call site to preserve the
 * tuple shape so `AnyOfMatch`'s `branch` field narrows to a literal index.
 */
export const pAnyOf = <Ps extends readonly TypePattern[]>(alternatives: () => Ps): AnyOfPattern<Ps> => ({
    kind: "anyof",
    alternatives,
})

// Compile-time and runtime tests live under /test at the project root.
// See test/matcher.types.test.ts and test/matcher.runtime.test.ts.

// export function printTypeAst(T: SemanticType): string
// {
//     if(isUnit(T)) return printUnit(T)
//     if(isInteger(T)) return printInteger(T)
//     if(isList(T)) return printList(T)
//     if(isStruct(T)) return printStruct(T)
//     if(isUnion(T)) return printUnion(T)
//     if(isReference(T)) return printReference(T)

//     throw "Nope"
// }

// const printUnit = (_: UnitType): string => "-"
// const printInteger = (S: IntegerType): string => `(${S.min}, ${S.max})`
// const printList = (S: ListType): string => printTypeAst(S.elementType) + "[" + (S.capacity ?? "") + "]"
// const printStruct = (S: StructType): string => `{${S.fields.map(({name, type}) => `${name}: ${printTypeAst(type)}`).join("; ")}}`
// const printUnion = (S: UnionType): string => `<${S.variants.map(({name, type}) => `${name}: ${printTypeAst(type)}`).join(" | ")}>`
// const printReference = (S: () => SemanticType): string => "^"