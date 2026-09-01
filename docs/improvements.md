# Performance
## Lowerer

1 Lower &&/|| as control flow in test position. if (A && B) S currently desugars to a value-producing ternary (slot, fusion break, then a second dispatch on the result) where nested dispatches cost ~4 instructions. Keep the ternary lift for genuine value contexts.

2 Reserve the slot before the test for ternaries: CONST #0 ; PUSH ; <test> ; BR_TABLE 2. +1 byte, ~8 Thumb instructions saved per construct. invert: true guarantees a ternary test fragment ends in a comparison, so this restores fusion unconditionally. This cannot be fixed JIT-side — if the comparison fuses, its 0/1 is never materialized, so a following PUSH would have nothing to push.

3 Reuse the assignment destination as the ternary slot rather than a fresh temp when possible.

4 Branchless &&/|| when both operands are pure — measured −22% to −51% bytes, and it frees the slot. Do not do this for ternaries: branchless wins on bytes but loses on native instructions once fusion is restored (~11–13 Thumb vs ~8–9), because ARMv6-M has no conditional-set — branchless needs the condition as a 0/1 word (4 instructions) where branching consumes it as flags for free.

5 Drop the redundant != 0 desugar.ts injects on a short-circuit operator's right operand when it is already a comparison (§4.2 guarantees 0/1). ~1 byte and ~5 Thumb instructions — it currently breaks that operand's own store-fold.

6 Teach lowerReturn acc liveness (the lattice validate.ts already implements) — drops 10 of 12 CONST 0s per codec.

## JIT

7 Compare in place in translateIfThenElse instead of flushing to r0 just to CMP r0,#1.

8 Drop the dead flushLive at BR_TABLE arm ends (~5 LOC in localJumpCleanup's callers). Provably dead — every BR_TABLE merge poisons two lines later (translate_control_flow.cpp:110, :192, :275) — and visible in committed expected-code tables (test_translate_proc.cpp:416-448). 9 of 147 emitted instructions in median5: ~6% of code size, ~3% of cycles. The LOOP back edge is the one caller that must keep it.

# Correctness

9 An extension opcode cannot declare that it destroys acc. isa-core.md §11.2's effect table has four fields and never mentions acc; ExtOpEffect grew readsAcc and writesAcc but no kill, so validate.ts:230-241 passes acc liveness through an op declaring neither and vm.ts:485-487 agrees — EXT MEMMOVE; RETURN validates with acc live. jit-armv6m gives every extension ExtSite::accInvalidate(), and one reaching a helper has no alternative since r0 is an argument register from the first pop (ext_rawmem.cpp:156). Assert on the host (accstate.cpp:11, kind != Kind::Poisoned), wrong answer under NDEBUG (0x18 for 0). Mirror of the first campaign's §9b, whose fix was writesAcc for the opposite direction. Not confined to the test extension: CODEC_EFFECTS' ENTER, ENTER_NEXT, OPEN_LIST, CLONE_RD, CLONE_WR and SEEK declare neither and leave state.acc alone, and all six are helper-call work, so the first jit-armv6m codec emitter inherits this. Needs a third direction in §11.2 and a decision on whether "declares neither" keeps meaning preserves or becomes undefined; either changes which programs are legal. Blocks EXT fuzzing — a campaign aborts on it ~30s in (jit-armv6m/docs/fuzzing-campaign.md, third campaign §1).

10 BR_TABLE 0 is a live validator/wire-decoder divergence. Encodable ([102, 0], pinned at bytecode.test.ts:147), accepted by validate.ts, runnable by vm.ts — but decodeProcBody pushes {kind:"case",remaining:0} whose frame never closes, and proc_scan.cpp's frame->remaining-- underflows a uint32_t. A program validateProgram approves cannot be round-tripped.
   
11 No repo document states the intended application domains; target-profile.md documents legality ceilings (131 ABI, 128 fuzz cap) but has no note that the performance cliff is WINDOW_SIZE = 4, which realistic hand-written programs cross at the fourth local.