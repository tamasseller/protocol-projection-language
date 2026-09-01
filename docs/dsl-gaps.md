# DSL surface gaps

What `grammer.pegjs` accepts that `lower.ts` does not handle, or handles
wrongly. Every entry was reproduced by running the case through parse →
lower → validate → run; the repro line is the observed result, not a
prediction.

The audit that produced this list ran at b4e8f87 and found five silent
miscompiles, one crash and six missing operators. What is left is below;
everything else is under **Closed**, with the test that holds it.

## Open

### `/` and `%` do not lower

Repro: `u32 a = 7; return a / 2;` → `Failed to lower return expression`.
No opcode exists (isa-core.md §4.1), so this is not a rules.ts entry: it needs an extension op, or a helper procedure the lowerer calls.
Compound `/=` and `%=` desugar correctly and then hit the same wall.

### A `for` init's registers outlive its names

`for(u32 i = 0; …)` scopes `i` to the loop, but nothing pops the slot at the back-edge, so the enclosing scope numbers past it (`RegAlloc.consume`).
The name is correctly gone; only the register is spent. Reclaiming it would need a block boundary the construct does not have.

### A `switch` cannot spell a no-op case

An empty case body is rejected (it would be C fallthrough), and omitting a label sends that value to the default. With a default present there is no way to say "this label does nothing".
Workaround: give the label a body that does nothing observable.
