import { ir } from './ir-builder';
import { UnionType, StructType } from './metamodel';

/**
 * Skeleton for the Tagged Union Codec demonstrating the TS eDSL pattern.
 */
export const TaggedUnionCodec = {
    canHandle(T: any): T is UnionType {
        return T.kind === 'Union';
    },

    decode(T: UnionType, stream: any, target: any, scope: any) {
        const tag = stream.allocVar("tag");

        return ir`
            ${tag} = READ_U8
            
            SWITCH ${tag} {
                ${T.variants.map((variant, index) => ir`
                    CASE ${index}:
                        ${scope.decode(variant.type, target.activate(variant.name))}
                `)}
                
                DEFAULT:
                    TRAP "Unknown Union Tag"
            }
        `;
    }
};
