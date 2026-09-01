perf
    - Lower &&/|| as control flow in test position. if (A && B) S currently desugars to a value-producing ternary (slot, fusion break, then a second dispatch on the result) where nested dispatches cost ~4 instructions. This is the single largest item, costs no extra byte, and does not perturb the window. Keep the ternary lift for genuine value contexts.

    - Drop the dead flushLive at BR_TABLE arm ends (~5 LOC in localJumpCleanup's callers). Provably dead — every BR_TABLE merge poisons two lines later (translate_control_flow.cpp:110, :192, :275) — and visible in committed expected-code tables (test_translate_proc.cpp:416-448). 9 of 147 emitted instructions in median5: ~6% of code size, ~3% of cycles. The LOOP back edge is the one caller that must keep it.

    - Reserve the slot before the test: CONST #0 ; PUSH ; <test> ; BR_TABLE 2. +1 byte, ~8 Thumb instructions saved per construct. invert: true guarantees a ternary test fragment ends in a comparison, so this restores fusion unconditionally. Validated by hand-building the body: same depth, same validation result. This cannot be fixed JIT-side — if the comparison fuses, its 0/1 is never materialized, so a following PUSH would have nothing to push.
    Reuse the assignment destination as the ternary slot rather than a fresh temp. Removes the window pressure that lifting §8.7 was going to buy.

    - Branchless &&/|| when both operands are pure — measured −22% to −51% bytes, and it frees the slot. Coverage is high because the usual C reasons for mandatory short-circuit are absent: no / or % opcode at all, no pointers, no arrays, non-trapping shifts. Do not do this for ternaries: branchless wins on bytes but loses on native instructions once fusion is restored (~11–13 Thumb vs ~8–9), because ARMv6-M has no conditional-set — branchless needs the condition as a 0/1 word (4 instructions) where branching consumes it as flags for free.

    - Drop the redundant != 0 desugar.ts injects on a short-circuit operator's right operand when it is already a comparison (§4.2 guarantees 0/1). ~1 byte and ~5 Thumb instructions — it currently breaks that operand's own store-fold.
    Compare in place in translateIfThenElse instead of flushing to r0 just to CMP r0,#1.
    Teach lowerReturn acc liveness (the lattice validate.ts already implements) — drops 10 of 12 CONST 0s per codec.

correctness
    - BR_TABLE 0 is a live validator/wire-decoder divergence. Encodable ([102, 0], pinned at bytecode.test.ts:147), accepted by validate.ts, runnable by vm.ts — but decodeProcBody pushes {kind:"case",remaining:0} whose frame never closes, and proc_scan.cpp's frame->remaining-- underflows a uint32_t. A program validateProgram approves cannot be round-tripped.
   
    - No repo document states the intended application domains; target-profile.md documents legality ceilings (131 ABI, 128 fuzz cap) but has no note that the performance cliff is WINDOW_SIZE = 4, which realistic hand-written programs cross at the fourth local.