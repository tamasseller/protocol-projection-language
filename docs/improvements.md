# Performance
## Lowerer

3 Branchless &&/|| when both operands are pure, in *value* contexts only. Re-measure first: the −22% to −51% figure predates the §8.7 revision, and on `return a > 0 && b > 0` (and the || form) it is now 16 → 13 bytes, −19%. "Frees the slot" no longer applies either — the branching form stopped using one when conditionalToAcc landed, and the branchless form needs a transient TOS slot of its own (PUSH … AND [--tos]). In *test* position it is now the wrong answer outright: `if ((a > 0) & (b > 6))` translates to 25 native instructions where `if (a > 0 && b > 6)` takes 15. bench/workloads/pulse-trigger.ts still spells that condition `&`, which was the faster of the two before the nesting lowering and is no longer. Do not do this for ternaries either: branchless wins on bytes but loses on native instructions (~11–13 Thumb vs ~8–9), because ARMv6-M has no conditional-set — branchless needs the condition as a 0/1 word (4 instructions) where branching consumes it as flags for free.

4 Drop the redundant != 0 desugar.ts injects on a short-circuit operator's right operand when it is already a comparison (§4.2 guarantees 0/1). Value contexts and loop conditions only — an `if`'s test no longer goes through the ternary. ~1 byte, and ~5 Thumb instructions because the != 0 is not branch-fusable where it sits; it also breaks that operand's own store-fold.

5 Teach lowerReturn acc liveness (the lattice validate.ts already implements) — drops 10 of 12 CONST 0s per codec. Worth more than when written: §8.7's exit rule now carries acc past a BR_TABLE merge when every case reaching it leaves it live, where the old rule was "never live after a BR_TABLE", so more bare returns follow a live acc.

## JIT

6 testAccNonzero flushes acc to r0 just to CMP it against 0, where the value's own producer could have set the flags in place. `Shape::ofFlags` is the representation for it — an arithmetic producer would leave `Flags(NE)` exactly as a comparison leaves its own condition. What is missing is the table of which producers leave usable flags, and the guarantee that nothing between such a producer and its branch disturbs them.

7 An arm whose sibling is empty still emits its exit branch — a B to the very next halfword. translateIfThen is the fast path for an empty case[0] and there is no mirror for an empty case[1]. 2 bytes, and lower.ts never produces that shape (`if (c) {}` with no else becomes the empty-case[0] form), so only hand-written bytecode reaches it.

# Correctness

8 §8.4 rejects any instruction unreachable on every control-flow path, but closeProcBody now appends exactly one: a body whose last statement fully terminates gets a trailing TRAP #0, since every walker counts blocks structurally and a construct always continues into its merge. validate.ts accepts it — it rejects only *structurally* unreachable code — while walkProcedure's own comment still says trailing dead code is "the only shape a correct lowerer can produce" and is "always caught". Either §8.4 narrows to structural unreachability and states that a structurally-continuing body still needs a terminator, or the TRAP needs a different justification; the comment is wrong under both.

9 No repo document states the intended application domains; target-profile.md documents legality ceilings (131 ABI, 128 fuzz cap) and names WINDOW_SIZE = 4 for argCount, but has no note that the same 4 is the performance cliff for *locals*, which realistic hand-written programs cross at the fourth one.

10 `trap` has no type saying it yields nothing, so each nonsense use of it in a value position is caught late and by a different mechanism: `u32 x = trap(1)` by the lowerer ("no tiling leaves its value in tos"), `x = trap(1)` and `1 + trap(2)` by §8.4's dead-code rule, `x = c ? trap(1) : trap(2)` by §8.7 acc liveness. None of the four names trap. A bottom type — `never`, not `void` — is one front-end rule for all of them, and keeps `c ? trap(1) : 2` legal where void would not (C requires both arms of `?:` to be arithmetic or both void; it has no bottom type, `_Noreturn` being a function specifier). It also replaces lift.ts's `isTrapCall`, a syntactic callee-name check that decides whether an arm closes its own case, with a property of the arm's type — and extends that to a procedure that always traps, once signatures carry types at all.
