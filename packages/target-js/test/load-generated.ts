/**
 * @ppl/target-js/test — Write generated source to disk, require() it for
 * real
 *
 * `generateCodecModule`'s output imports real packages (`@ppl/target-js`'s
 * own runtime, `@ppl/machine`'s `evalBinary`/`evalUnary`) — `ts-check.ts`'s
 * standalone compiler host can't resolve those (it only ever recognizes
 * one synthetic in-memory file plus lib.d.ts), so it isn't the right tool
 * here. This is: the source has to live at a real path under this package
 * so Node's module resolution finds the workspace-linked packages, and
 * `require()`-ing it through ts-node's own registered compile hook is
 * both the type check (ts-node's default mode type-checks on require,
 * throwing a TSError on any diagnostic) and the only way to actually run
 * the generated `encode`/`decode` functions.
 */
import * as fs from "node:fs"
import * as path from "node:path"

const SCRATCH_DIR = path.join(__dirname, ".codegen-scratch")
let counter = 0

/** Write `source` to a fresh file under the (gitignored) scratch
 *  directory and `require()` it. Each call gets its own file — never
 *  reused — so there's no require-cache staleness to guard against. */
export function loadGenerated(source: string): any
{
    fs.mkdirSync(SCRATCH_DIR, { recursive: true })
    const file = path.join(SCRATCH_DIR, `gen-${counter++}.ts`)
    fs.writeFileSync(file, source)
    return require(file)
}
