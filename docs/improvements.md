# Performance
## Lowerer

1 Lower &&/|| as control flow in test position. if (A && B) S currently desugars to a value-producing ternary, so the test is a second dispatch on the first one's result rather than a branch straight to the else arm. Keep the ternary lift for genuine value contexts.

2 Reuse the assignment destination as the ternary slot rather than a fresh temp when possible.

3 Branchless &&/|| when both operands are pure — measured −22% to −51% bytes, and it frees the slot. Do not do this for ternaries: branchless wins on bytes but loses on native instructions once fusion is restored (~11–13 Thumb vs ~8–9), because ARMv6-M has no conditional-set — branchless needs the condition as a 0/1 word (4 instructions) where branching consumes it as flags for free.

4 Drop the redundant != 0 desugar.ts injects on a short-circuit operator's right operand when it is already a comparison (§4.2 guarantees 0/1). ~1 byte and ~5 Thumb instructions — it currently breaks that operand's own store-fold.

5 Teach lowerReturn acc liveness (the lattice validate.ts already implements) — drops 10 of 12 CONST 0s per codec.

## JIT

6 testAccNonzero flushes acc to r0 just to CMP it against 0, where the value's own producer could have set the flags in place. `Shape::ofFlags` is the representation for it — an arithmetic producer would leave `Flags(NE)` exactly as a comparison leaves its own condition. What is missing is the table of which producers leave usable flags, and the guarantee that nothing between such a producer and its branch disturbs them.

# Correctness

7 No repo document states the intended application domains; target-profile.md documents legality ceilings (131 ABI, 128 fuzz cap) but has no note that the performance cliff is WINDOW_SIZE = 4, which realistic hand-written programs cross at the fourth local.