/**
 * ts-check.ts — actually typecheck generated TS output via the real
 * TypeScript compiler, instead of only eyeballing substrings. Verifies the
 * *whole* emitted string is one syntactically and semantically valid
 * standalone module — real lib.d.ts globals (`Uint8Array`, etc.) and real
 * cross-declaration name resolution (an interface field referencing
 * another emitted type actually has to resolve to something real).
 * Substring assertions still pin the exact expected shape (interface vs.
 * type alias, discriminant field name, ...) — this is complementary, not
 * a replacement.
 */
import * as ts from "typescript"

const FILE_NAME = "generated.ts"

const OPTIONS: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2020,
    noEmit: true,
    // Without this, TS auto-includes every ambient package under
    // node_modules/@types (real, default behavior) — pulling in
    // @types/node, whose newer versions reference `undici-types`, which
    // this host's minimal module resolution can't find. Generated
    // declarations never need Node's ambient globals anyway.
    types: [],
}

// One host, reused across every call, with lib.d.ts's SourceFiles cached
// by object identity across calls (never the generated file itself, which
// changes every call — `currentSource` below). This is the actual cost
// `tsDiagnostics` used to pay on every single call: re-parsing AND
// re-binding the whole standard library from scratch. TS's binder skips
// re-binding a SourceFile object it recognizes as already bound — the
// same mechanism `ts.createLanguageService`'s document registry relies on
// for incremental builds — so handing back the *same* lib SourceFile
// object on every call turns each later call into "bind/check one small
// file" instead of "bind/check the whole standard library".
let currentSource: ts.SourceFile | undefined
const libCache = new Map<string, ts.SourceFile>()
const host = ts.createCompilerHost(OPTIONS)

const baseGetSourceFile = host.getSourceFile.bind(host)
host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) =>
{
    if(fileName === FILE_NAME) return currentSource
    const cached = libCache.get(fileName)
    if(cached) return cached
    const sourceFile = baseGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile)
    if(sourceFile) libCache.set(fileName, sourceFile)
    return sourceFile
}

const baseFileExists = host.fileExists.bind(host)
host.fileExists = fileName => fileName === FILE_NAME || baseFileExists(fileName)

/** Compile `source` as a standalone module; return every diagnostic
 *  message (empty when it typechecks clean). */
export function tsDiagnostics(source: string): string[]
{
    currentSource = ts.createSourceFile(FILE_NAME, source, ts.ScriptTarget.ES2020, true)
    const program = ts.createProgram([FILE_NAME], OPTIONS, host)
    return ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
}

/** Assert `source` typechecks with zero diagnostics — the thrown message
 *  includes every diagnostic plus the offending source, so a break is
 *  diagnosable from the test output alone. */
export function assertCompiles(source: string): void
{
    const diagnostics = tsDiagnostics(source)
    if(diagnostics.length > 0)
        throw new Error(`generated TypeScript failed to typecheck:\n${source}\n\n${diagnostics.join("\n")}`)
}
