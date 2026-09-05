/**
 * target-js — A thin, hierarchical, auto-indenting line builder.
 *
 * Owns indentation once, so callers push trimmed line text and open/close
 * nested blocks structurally rather than threading an accumulator and an
 * indent string through every function and doing string math at each push.
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
