/**
 * @ppl/target-js — A thin, hierarchical, auto-indenting line builder.
 *
 * `codec-codegen.ts`'s statement translation used to thread an `out:
 * string[]` accumulator and an `indent: string` alongside it through every
 * function, with every push spelling out `${indent}...` by hand and every
 * nested block computing its own `indent + "    "`. That's pure formatting
 * noise with no connection to what's actually being translated — this
 * class owns indentation once, so callers push only the trimmed line text
 * and open/close nested blocks structurally instead of by string math.
 */
export class LineBuilder
{
    private readonly lines: string[] = []
    private depth = 0

    /** Push one already-trimmed line at the current indent depth. */
    line(text: string): void
    {
        this.lines.push(text === "" ? "" : "    ".repeat(this.depth) + text)
    }

    /** Run `body` one indent level deeper. */
    indented(body: () => void): void
    {
        this.depth++
        body()
        this.depth--
    }

    /** `open`, then `body` indented, then `close` — the common
     *  "header { ... }" shape (a function, a `switch`, a `case`, a
     *  `for(;;)`) collapsed into one call. */
    block(open: string, body: () => void, close = "}"): void
    {
        this.line(open)
        this.indented(body)
        this.line(close)
    }

    toString(): string { return this.lines.join("\n") }
}
