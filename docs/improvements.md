# Performance
## Lowerer

## JIT

6 testAccNonzero flushes acc to r0 just to CMP it against 0, where the value's own producer could have set the flags in place. `Shape::ofFlags` is the representation for it — an arithmetic producer would leave `Flags(NE)` exactly as a comparison leaves its own condition. What is missing is the table of which producers leave usable flags, and the guarantee that nothing between such a producer and its branch disturbs them.

7 An arm whose sibling is empty still emits its exit branch — a B to the very next halfword. translateIfThen is the fast path for an empty case[0] and there is no mirror for an empty case[1]. 2 bytes, and lower.ts never produces that shape (`if (c) {}` with no else becomes the empty-case[0] form), so only hand-written bytecode reaches it.
