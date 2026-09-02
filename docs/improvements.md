# Performance
## Lowerer

3 Branchless &&/|| when both operands are pure, in *value* contexts only. Re-measure first: the −22% to −51% figure predates the §8.7 revision, and on `return a > 0 && b > 0` (and the || form) it is now 16 → 13 bytes, −19%. "Frees the slot" no longer applies either — the branching form stopped using one when conditionalToAcc landed, and the branchless form needs a transient TOS slot of its own (PUSH … AND [--tos]). In *test* position it is now the wrong answer outright: `if ((a > 0) & (b > 6))` translates to 25 native instructions where `if (a > 0 && b > 6)` takes 15. bench/workloads/pulse-trigger.ts still spells that condition `&`, which was the faster of the two before the nesting lowering and is no longer. Do not do this for ternaries either: branchless wins on bytes but loses on native instructions (~11–13 Thumb vs ~8–9), because ARMv6-M has no conditional-set — branchless needs the condition as a 0/1 word (4 instructions) where branching consumes it as flags for free.

4 Drop the redundant != 0 desugar.ts injects on a short-circuit operator's right operand when it is already a comparison (§4.2 guarantees 0/1). Value contexts and loop conditions only — an `if`'s test no longer goes through the ternary. ~1 byte, and ~5 Thumb instructions because the != 0 is not branch-fusable where it sits; it also breaks that operand's own store-fold.

5 Teach lowerReturn acc liveness (the lattice validate.ts already implements) — drops 10 of 12 CONST 0s per codec. Worth more than when written: §8.7's exit rule now carries acc past a BR_TABLE merge when every case reaching it leaves it live, where the old rule was "never live after a BR_TABLE", so more bare returns follow a live acc.

## JIT

6 testAccNonzero flushes acc to r0 just to CMP it against 0, where the value's own producer could have set the flags in place. `Shape::ofFlags` is the representation for it — an arithmetic producer would leave `Flags(NE)` exactly as a comparison leaves its own condition. What is missing is the table of which producers leave usable flags, and the guarantee that nothing between such a producer and its branch disturbs them.

7 An arm whose sibling is empty still emits its exit branch — a B to the very next halfword. translateIfThen is the fast path for an empty case[0] and there is no mirror for an empty case[1]. 2 bytes, and lower.ts never produces that shape (`if (c) {}` with no else becomes the empty-case[0] form), so only hand-written bytecode reaches it.
