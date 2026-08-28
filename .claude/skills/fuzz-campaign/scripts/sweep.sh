#!/usr/bin/env bash
# Run the QEMU execution sweep over a corpus directory, in the background.
#
#   sweep.sh <corpus-dir> [log-name] [sample-size]
#
# A campaign export holds 100k+ programs; pass a sample size to sweep a
# random subset instead of all of them.
set -uo pipefail
REPO=${PPL_REPO:-/home/tooma/proj/protocol-projection-language}
STATE=${PPL_FUZZ_STATE:-/tmp/ppl-fuzz-state}
CORPUS=${1:?usage: sweep.sh <corpus-dir> [log-name] [sample-size]}
LOG=${2:-sweep}
SAMPLE=${3:-0}
mkdir -p "$STATE"

if [ -f "$STATE/sweep.pid" ]; then
    kill "$(cat "$STATE/sweep.pid")" 2>/dev/null
    sleep 2
fi
pkill -x qemu-system-arm 2>/dev/null
sleep 1

if [ "$SAMPLE" -gt 0 ]; then
    SUB="$STATE/sample"
    rm -rf "$SUB"; mkdir -p "$SUB"
    ls "$CORPUS" | shuf -n "$SAMPLE" | while read -r f; do cp "$CORPUS/$f" "$SUB/"; done
    CORPUS="$SUB"
fi

cd "$REPO"
TS_NODE_PROJECT=jit-armv6m/fuzz/tsconfig.json \
    nohup npx ts-node --transpile-only jit-armv6m/fuzz/qemu_exec/qemu_exec.ts "$CORPUS" \
    > "$STATE/$LOG.log" 2>&1 &
echo $! > "$STATE/sweep.pid"
echo "sweep started, log $STATE/$LOG.log, corpus $(ls "$CORPUS" | wc -l) programs"
