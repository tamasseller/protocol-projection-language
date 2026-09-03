# Performance
## Lowerer

## JIT

7 An arm whose sibling is empty still emits its exit branch — a B to the very next halfword: 2 bytes, and a taken branch on every execution of the non-empty arm. translateIfThen is the fast path for an empty case[0] and there is no mirror for an empty case[1], which is what `if (c) {} else { ... }` lowers to. The skip needs a peek past arm 0's BLOCK_END, and must drop the unguarded flushPool with the branch — arm 0 would otherwise fall through into the pool, the same reason the FALLTHROUGH arm skips both.
