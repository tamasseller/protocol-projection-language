#!/usr/bin/env bash
# Run one crash campaign in the background for N seconds, exporting every
# validator-approved program for the QEMU half to sweep later.
#
#   campaign.sh [seconds] [corpus-out]
#
# Backgrounded because the Bash tool times out at 2 minutes. Poll
# $STATE/campaign.log; any line that is not "fuzz: N executions ..." is a
# finding or a harness problem.
set -uo pipefail
REPO=${PPL_REPO:-/home/tooma/proj/protocol-projection-language}
STATE=${PPL_FUZZ_STATE:-/tmp/ppl-fuzz-state}
SECS=${1:-400}
OUT=${2:-/tmp/ppl-corpus}
mkdir -p "$STATE"

if [ -f "$STATE/campaign.pid" ]; then
    kill "$(cat "$STATE/campaign.pid")" 2>/dev/null
    sleep 1
fi
pkill -x fuzz_driver 2>/dev/null   # -x, exact name: never -f
rm -rf "$OUT"; mkdir -p "$OUT"

cd "$REPO/mog-jit/fuzz"
PPL_FUZZ_CORPUS_OUT="$OUT" nohup timeout "$SECS" src/driver/fuzz_driver seeds \
    > "$STATE/campaign.log" 2>&1 &
echo $! > "$STATE/campaign.pid"
echo "campaign started for ${SECS}s, log $STATE/campaign.log, exporting to $OUT"
