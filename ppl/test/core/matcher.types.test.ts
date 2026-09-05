/**
 * Compile-time (type-level) tests for the matcher.
 *
 * These emit no runtime code; they exist solely to fail type-checking
 * if the `MatchOf<P>` narrowing machinery regresses. Run via:
 *
 *   npm run test:types
 *
 * The asserts use the `declare const + const : T = x` idiom: if `T`
 * resolves to `false` (or errors), the `const` initializer fails to
 * type-check against the declared `true`.
 */
import {SemanticType, SemanticTypeKinds} from "../../src/core/metamodel"
import {IntegerMatch, ListMatch, matchType, pAnyOf, pInteger, pList, pStructFields, pUnit, StructFieldsMatch, UnitMatch} from "../../src/core/matcher"

////////////////////////////////////////////////////////////////////////////////////////////////

// A list-of-integers pattern must narrow `elementMatch` to IntegerMatch.
const listIntTest = (T: SemanticType) => matchType(T, pList(pInteger(0, 1)))

type _ListIntTest = ReturnType<typeof listIntTest>
type _ListIntAssert = _ListIntTest extends ListMatch<IntegerMatch> | undefined ? true : false
declare const _listIntAsserted: _ListIntAssert
const _listIntOk: _ListIntAssert = _listIntAsserted

////////////////////////////////////////////////////////////////////////////////////////////////

// AnyOf must carry the winning branch index and the narrowed inner match.
// `as const` on the alternatives array preserves the tuple shape so `branch`
// is a literal index.
const anyofTest = (T: SemanticType) => matchType(T, pAnyOf(() => [
    pInteger(0, 1),
    pUnit(),
] as const))

type _AnyOfTest = NonNullable<ReturnType<typeof anyofTest>>
type _Branch0 = Extract<_AnyOfTest, { branch: 0 }> extends { match: IntegerMatch } ? true : false
type _Branch1 = Extract<_AnyOfTest, { branch: 1 }> extends { match: UnitMatch } ? true : false
declare const _ao0: _Branch0
declare const _ao1: _Branch1
const _ao0Ok: _Branch0 = _ao0
const _ao1Ok: _Branch1 = _ao1

////////////////////////////////////////////////////////////////////////////////////////////////

// StructFieldsPattern: a struct whose every field is integer must yield
// a collection witness whose element match is IntegerMatch (not the
// broad TypeMatch union).
const structFieldsIntTest = (T: SemanticType) => matchType(T, pStructFields(pInteger(0, 1)))

type _StructFieldsTest = NonNullable<ReturnType<typeof structFieldsIntTest>>
type _StructFieldsAssert =
    _StructFieldsTest extends StructFieldsMatch<IntegerMatch> ? true : false
declare const _structFieldsAsserted: _StructFieldsAssert
const _structFieldsOk: _StructFieldsAssert = _structFieldsAsserted
