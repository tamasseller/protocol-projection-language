#!/usr/bin/env bash
# Start (or restart) the validator-gate oracle, recording its PID.
#
# Kills by recorded PID, never by `pkill -f`: any pattern specific enough to
# match the node process also appears in the argv of the shell that mentions
# it, so a pkill there reliably kills its own caller. Run this from anywhere;
# it keeps its state next to itself unless PPL_FUZZ_STATE says otherwise.
set -uo pipefail
REPO=${PPL_REPO:-/home/tooma/proj/protocol-projection-language}
STATE=${PPL_FUZZ_STATE:-/tmp/ppl-fuzz-state}
SOCK=${PPL_FUZZ_SOCK:-/tmp/ppl-jit-oracle.sock}
mkdir -p "$STATE"

if [ -f "$STATE/oracle.pid" ]; then
    kill "$(cat "$STATE/oracle.pid")" 2>/dev/null
    sleep 1
fi
rm -f "$SOCK" "$STATE/oracle.log"

cd "$REPO"
nohup npx ts-node --transpile-only jit-armv6m/fuzz/oracle_server.ts "$SOCK" \
    > "$STATE/oracle.log" 2>&1 &
echo $! > "$STATE/oracle.pid"

for _ in $(seq 1 40); do
    grep -q listening "$STATE/oracle.log" 2>/dev/null && break
    sleep 1
done
cat "$STATE/oracle.log"
