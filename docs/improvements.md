# Performance
## JIT

7 An arm whose sibling is empty still emits its exit branch — a B to the very next halfword: 2 bytes, and a taken branch on every execution of the non-empty arm. translateIfThen is the fast path for an empty case[0] and there is no mirror for an empty case[1], which is what `if (c) {} else { ... }` lowers to. The skip needs a peek past arm 0's BLOCK_END, and must drop the unguarded flushPool with the branch — arm 0 would otherwise fall through into the pool, the same reason the FALLTHROUGH arm skips both.

8 A `switch` gap case emits a branch to the default case where it could emit nothing. `translateSwitch` patches each case's jump-table slot as that case is reached (`patchRawHalfword`), so a lone `DEFAULT` costs its 2-byte slot plus a 2-byte `B`. Chaining the pending slots through the table halfwords themselves — the trick `Label.chain` already uses in the instruction stream — and resolving them when `case[N]` starts would point the slot straight at the default case: 2 bytes per gap instead of 4, and no emitted code. Matters in proportion to how aggressively `gapCost` (lower.ts) merges runs, since every gap in a merged span is one of these.
