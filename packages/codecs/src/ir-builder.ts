/**
 * @ppl/codecs — IR builder re-export.
 *
 * The `ir` tagged template and `IrFragment` type are defined in `@ppl/machine`
 * (where the PEG parser lives). This module re-exports them so codec authors
 * can import from `@ppl/codecs` directly.
 */

export { ir, IrFragment, SyntaxError } from "@ppl/machine"
