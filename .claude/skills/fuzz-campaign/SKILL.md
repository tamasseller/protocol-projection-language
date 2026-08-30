---
name: fuzz-campaign
description: Run back-to-back differential fuzzing campaigns against jit-armv6m and fix what they find. Use when asked to fuzz the JIT, hunt for miscompilations or translator crashes, run campaigns until something substantial comes up, or extend the fuzz harness/seeds. Covers both halves (host crash-finding under ASan, emulated-ARM result-checking under QEMU), the triage protocol for deciding which side of a disagreement is wrong, and the operational traps that otherwise cost hours.
---

# Fuzzing campaigns against jit-armv6m

## The loop

Run campaigns one after another until something substantial comes up. Fix
non-structural bugs between runs so the next run gets further. If a run
comes up empty, add seeds or tweak the harness rather than re-running the
same thing. Keep going until called off or a genuinely structural issue
appears — one needing new runtime asm, an ABI contract change, or an ISA
spec decision. Report that one and stop; don't fold it into the pass.

Both halves must run. They are structurally blind to each other:

| | runs | catches |
|---|---|---|
| `fuzz/harness.cpp` + `fuzz/oracle_server.ts` | the translator on the host, ASan/UBSan, asserts live | crashes, asserts, UB, bad encodings |
| `fuzz/qemu_exec/` | the *emitted Thumb* on `qemu-system-arm` against the real `runtime/` | miscompilation — wrong answer, no crash |

The host half never executes what it emits. The QEMU half is `-DNDEBUG`, so
it never sees an assert. Five of nine findings in the first campaign were
invisible to the host half alone.

## Commands

`scripts/` next to this file does the three long-running steps properly —
backgrounded, PID-tracked, killed safely (see traps below). Use them rather
than open-coding the invocations:

```sh
S=.claude/skills/fuzz-campaign/scripts
$S/oracle.sh                              # start/restart the validator gate
$S/campaign.sh 400 /tmp/ppl-corpus        # crash campaign, N seconds, exporting approved programs
$S/sweep.sh /tmp/ppl-corpus run1 3000     # QEMU execution sweep, random 3000-program sample
$S/sweep.sh jit-armv6m/fuzz/seeds seeds   # standing regression check
```

State lands in `/tmp/ppl-fuzz-state` (`PPL_FUZZ_STATE` to move it): one
`.log` and `.pid` per step. Poll the logs; any line in `campaign.log` that
is not `fuzz: N executions …` is a finding or a harness problem.

Underneath, all from the repo root — `TS_NODE_PROJECT` is mandatory, since
relative cwd drift breaks ts-node resolution.

```sh
# oracle — restart it after ANY change to validate.ts / vm.ts / extension.ts
npx ts-node --transpile-only jit-armv6m/fuzz/oracle_server.ts /tmp/ppl-jit-oracle.sock

cd jit-armv6m/fuzz && ./build.sh                    # fuzz_driver
PPL_FUZZ_CORPUS_OUT=/tmp/corpus ./fuzz_driver seeds # campaign + export

cd jit-armv6m/fuzz/qemu_exec && ./build.sh          # exec_runner.elf
TS_NODE_PROJECT=jit-armv6m/fuzz/tsconfig.json \
  npx ts-node --transpile-only jit-armv6m/fuzz/qemu_exec/qemu_exec.ts jit-armv6m/fuzz/seeds

# triage
TS_NODE_PROJECT=jit-armv6m/fuzz/tsconfig.json npx ts-node --transpile-only \
  jit-armv6m/fuzz/qemu_exec/minimize_exec.ts [--hang] <file>   # ddmin over instructions, re-encoded
jit-armv6m/fuzz/dump_code.sh <program-file>         # translate + objdump: what was actually emitted
```

`dump_code.sh` builds its own binary and disassembles every procedure —
the one thing neither half tells you on its own. `probe_arena.cpp` (build
it by hand, same pattern as `dump_code.sh`) reports compiles/resident/
evicted/bailed per arena size, for when RESOURCE_ERROR counts look wrong.

Regenerate seeds after touching `make_seeds.ts` (it owns `seeds/` and
validates every seed) or `test/corpus_programs.h` (`./dump_seeds.sh` first):

```sh
TS_NODE_PROJECT=jit-armv6m/fuzz/tsconfig.json npx ts-node --transpile-only jit-armv6m/fuzz/make_seeds.ts
```

## Operational traps

- **`pkill -f <pattern>` kills your own shell** (exit 144). The Bash tool's
  `bash -c` argv contains the pattern. Write a launcher script to a
  scratchpad file and kill by recorded PID, or use `pkill -x <exact-name>`.
  This cost four restarts before it was diagnosed.
- **A stale oracle silently validates with the old rules.** Change the
  validator, forget to restart the long-running node process, and the next
  campaign "finds" bugs you already fixed. Restart it every time.
- **Bash tool times out at 2 minutes.** Background campaigns and sweeps
  (`nohup … &` plus `timeout N`), then poll the log.
- **`PPL_FUZZ_CORPUS_OUT` writes every approved program**, not the 4096-entry
  in-memory corpus — expect 100k+ files. Sample before sweeping.
- **`make clean` before trusting `test/host`'s test count.** Stale gcov
  objects inflate it and emit checksum warnings.
- **A `return` inside a top-level `for` in a CommonJS `.ts` exits the whole
  module.** That silently ended an 808-batch sweep at its first hang and
  lost three already-found mismatches. Use `continue`, and print findings as
  they are found, not only in the summary.

## Deciding which side is wrong

The hard part, and where the first campaign got one finding backwards.
Before changing the translator to satisfy a validator-approved program:

1. Read `packages/machine/docs/isa-core.md` **and
   `isa-rationale.md`** — the rationale often names the exact pattern and
   says whether it is meant to be legal. Skipping it is what made §2 of
   `jit-armv6m/docs/fuzzing-campaign.md` get fixed on the wrong side first.
2. Check whether the pre-existing validator and its test fixtures agree with
   each other. An internally inconsistent commit (validator lax on one
   construct, strict on its sibling) is the tell for which one was
   forgotten.
3. Check whether real `packages/codecs` output depends on the behavior —
   and whether the tests that build it are already failing for other
   reasons, which makes "no test broke" meaningless. Taint-probe instead of
   trusting a pass count.
4. Be suspicious of a justification of the form "tightening the validator
   broke N tests" unless you measured N against a clean baseline. The
   pre-existing failure count is easy to misattribute.

A rule that needs an *analysis* to decide is a bad interface rule: the spec
then means "whatever this validator happens to implement". Prefer a local,
syntactic property of the opcode.

## Regression protocol

Every fixed finding gets both:
- a seed in `make_seeds.ts` (so `qemu_exec.ts seeds` is a standing check), and
- a unit test — `test/host/` for emission, the matching `test/qemu/test_*.cpp` for a
  real executed result, `packages/machine/test/validate.test.ts` for a
  rejection.

A seed asserting "which arm ran" must observe it through state a case
*writes* (`STORE` to a slot, `LOAD` after), not through `acc` — acc is dead
after any `BR_TABLE` (isa-core §8.7).

Then run everything: `cd jit-armv6m && make clean && make test`,
`make -C test/qemu stack-usage-check`, and `npm test` in every
`packages/*`.

## Calibration already measured — don't rediscover

- Compilable TOS depth ceiling is **131** (`WINDOW_SIZE + 127`), for *total*
  depth, not just `argCount` — `discardWindow`'s single `ADD sp,#imm`.
- `spillImm`'s `Uoff<2,8>` guard is unreachable; `discardWindow` bails first.
- QEMU: `-M lm3s811evb`, `-m 64k` (the `-device loader` cap is `ram_size`),
  `-serial none` not `-nographic`, semihosting output on **stderr**,
  `SYS_OPEN` returns -1 for every path including `:tt` — use
  `-device loader,…,force-raw=true` into guest flash instead of file I/O.
- Flash on this model ends at **0xA000**, measured; writes past it are
  silently dropped.
- `ProgramResult.trapped` carries a `LANDING_*` tag; nothing is encoded in
  `value`. Traps at any call depth are comparable.

`jit-armv6m/fuzz/README.md` documents the harness itself;
`jit-armv6m/docs/fuzzing-campaign.md` is the worked record of a full
campaign — read its findings before starting, so a re-run recognizes an old
shape instead of re-minimizing it.
