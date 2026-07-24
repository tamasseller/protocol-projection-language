import {SemanticType, struct, u32, union, unit, i32, list, u8} from "./metamodel"

const Optional = (T: SemanticType) => union({value: T, empty: unit})

const SemanticField = (): SemanticType => struct
({
    name: list(u8),
    field: TypeExpr
})

const TypeExpr = (): SemanticType => union
({
    Unit: unit,

    Integer: struct
    ({
        min: i32, // Heh
        max: u32
    }),

    Struct: struct
    ({
        fields: list(SemanticField)
    }),

    Union: struct
    ({
        variants: list(SemanticField)
    }),

    List: struct
    ({
        elementType: TypeExpr,
        capacity: Optional(u32)
    }),
})

