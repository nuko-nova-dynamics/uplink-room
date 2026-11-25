#!/usr/bin/env bash
set -euo pipefail
run=${1:?Usage: parallel.sh <run-folder> [shards]}
shards=${2:-4}
extra=("${@:3}")
[[ $shards =~ ^[1-9][0-9]*$ && $shards -le 16 ]] || { echo 'Use 1 to 16 shards.' >&2; exit 2; }
mkdir -p "$run"
started=$SECONDS
pids=()
for ((i=1; i<=shards; i++)); do
  xvfb-run -a -s '-screen 0 3000x2000x24' node scripts/upclose/run.ts "$run" --shard "$i/$shards" --skip-checks "${extra[@]}" > "$run/shard-$i.log" 2>&1 &
  pids+=("$!")
done
status=0
for pid in "${pids[@]}"; do wait "$pid" || status=1; done
[[ $status == 0 ]] || { echo 'A capture shard failed. See the shard logs.' >&2; exit "$status"; }
node scripts/upclose/checks/cli.ts "$run" || { code=$?; [[ $code == 2 ]] || exit "$code"; }
printf 'Parallel capture and checks finished in %ss.\n' "$((SECONDS-started))"
