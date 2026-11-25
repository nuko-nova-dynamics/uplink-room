#!/usr/bin/env bash
set -euo pipefail
out=${1:?run folder required}
shards=${2:-6}
pids=()
options=()
if [[ -n ${3:-} ]]; then options+=(--passes "$3"); fi
if [[ -n ${4:-} ]]; then options+=(--states "$4"); fi
if [[ ${5:-} == --overlays-only ]]; then options+=(--overlays-only); fi
for ((i=1; i<=shards; i++)); do
  mkdir -p "$out/.shards/$i"
  xvfb-run -a -s '-screen 0 3000x2000x24' node scripts/upclose/passes/run.ts "$out/.shards/$i" --shard "$i/$shards" "${options[@]}" > "$out/.shards/$i.log" 2>&1 &
  pids+=("$!")
done
status=0
for pid in "${pids[@]}"; do wait "$pid" || status=1; done
node scripts/upclose/passes/merge.ts "$out"
exit "$status"
