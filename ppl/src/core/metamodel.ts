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
    /** Value a decoder/encoder substitutes when this field/variant has no
     *  source value of its own on one side of a reconciled pair of trees
     *  (docs/codec-image.md §3.1/§3.3). Always concrete — every integer
     *  has a default, `0` unless the constructor was given a third
     *  argument. A field needing a non-zero default doesn't reuse a
     *  shared constant like `u8`; it constructs its own `integer(min,
     *  max, d)` value, which is already a distinct `TypeNode`
     *  (type-graph.ts's sharing is keyed by object identity, not
     *  structure) — no separate per-slot default record is needed. */
    default: number
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
    /** Name of the variant `defaultValueOf` (and a decoder reconciling
     *  against a narrower image tree, docs/codec-image.md §3.2) falls
     *  back to. Opt-in and restricted to a `unit`-valued variant (so it
     *  never needs a payload of its own) — a union with no natural
     *  fallback (e.g. an instruction-opcode-style enum) simply doesn't
     *  declare one, and defaultValueOf/reconciliation trap instead. */
    defaultVariant?: string
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

export const integer = (min: number, max: number, defaultValue: number = 0): IntegerType =>
    ({kind: SemanticTypeKinds.Integer, min, max, default: defaultValue})

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

export const union = (def: {[k: string]: SemanticType}, defaultVariant?: string): UnionType =>
{
    if(defaultVariant !== undefined)
    {
        const variantType = def[defaultVariant]
        if(variantType === undefined)
            throw new Error(`union: defaultVariant "${defaultVariant}" is not a variant of this union`)
        if(!isUnit(variantType))
            throw new Error(`union: defaultVariant "${defaultVariant}" must be unit-valued`)
    }

    return {
        kind: SemanticTypeKinds.Union,
        variants: new Map(Object.entries(def)),
        defaultVariant
    }
}

/**
 * An optional value: sugar for the 2-variant `union({value: T, empty:
 * unit}, "empty")` shape target/codec rules already recognize by exact
 * name (e.g. a C++ target's `std::optional<T>` rule,
 * `target-js`'s `T | null` rule) — one blessed constructor instead of each
 * schema author hand-rolling a union and hoping they used the same two
 * variant names those rules match on. `"empty"` is the declared
 * `defaultVariant` for free, so a decoder reconciling against a narrower
 * image tree (docs/codec-image.md §3.2) falls back to "absent" without the
 * schema author declaring anything extra.
 */
export const optional = (T: SemanticType): UnionType => union({value: T, empty: unit}, "empty")

/**
 * The value a decoder/encoder substitutes when a field/variant has no
 * source value of its own on one side of a reconciled pair of trees
 * (docs/codec-image.md §3.1/§3.3): `undefined` for `unit` (no data to
 * default), the type's own `default` for an integer, `[]` for a list
 * (an unfilled list is simply empty, never a declared value), the
 * field-by-field composition of its own fields' defaults for a struct,
 * and `{variant: defaultVariant, value: undefined}` for a union that
 * declared one.
 *
 * Throws if a union with no declared `defaultVariant` is reached — a
 * type-tree author who never needs this union's default (e.g. it's never
 * the type of a field only one side of a reconciled pair declares) never
 * has to declare one; the failure only surfaces once this is actually
 * asked for, which docs/codec-image.md §4 fixes as a build/codegen-time
 * error, not a per-message runtime trap.
 */
// — First-class type names ————————————————————————————————
//
// Replaces the old symbol-bag trait mechanism (`traits.ts`, removed):
// a name is definition-time metadata on the type object itself, read back
// by the same reference — no registry, no per-build extraction pass. Used
// for codegen labeling (`target-js`'s `nameOf`) and for
// `matcher.ts`'s `pNamed()` rule-matching. Deliberately a different
// namespace from a struct/union's field/variant names: those travel on
// the wire (docs/codec-image.md §6.3); a type's own name never does.

const NAME = Symbol("name")

/** Attach a name to a type object at definition time, e.g.
 *  `named("Timestamp", struct({secs: u32, nanos: u32}))`, or
 *  `named("Tree", (): any => union({...}))` for a recursive thunk. */
export const named = <T extends object>(name: string, obj: T): T =>
{
    (obj as {[NAME]?: string})[NAME] = name
    return obj
}

/** Read back a type's declared name, if any. */
export const nameOf = (t: SemanticType): string | undefined => (t as {[NAME]?: string})[NAME]

export function defaultValueOf(t: SemanticType): unknown
{
    const c = derefType(t)
    switch(c.kind)
    {
        case SemanticTypeKinds.Unit:    return undefined
        case SemanticTypeKinds.Integer: return c.default
        case SemanticTypeKinds.List:    return []
        case SemanticTypeKinds.Struct:
            return Object.fromEntries([...c.fields.entries()].map(([name, type]) => [name, defaultValueOf(type)]))
        case SemanticTypeKinds.Union:
            if(c.defaultVariant === undefined)
                throw new Error("defaultValueOf: union has no declared defaultVariant")
            return {variant: c.defaultVariant, value: undefined}
    }
}
