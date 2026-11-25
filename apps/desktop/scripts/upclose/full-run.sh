#!/usr/bin/env bash
set -euo pipefail
run=${1:?Usage: full-run.sh <run-folder> [capture-shards] [pass-shards]}
capture_shards=${2:-4}
pass_shards=${3:-6}
if [[ $(uname -s) != Linux || ${UPLINK_GYM_XVFB:-} != 1 ]]; then
  echo 'Run the full gym on a Linux gym box with UPLINK_GYM_XVFB=1.' >&2
  exit 1
fi
status=0
bash scripts/upclose/parallel.sh "$run" "$capture_shards" || status=$?
bash scripts/upclose/passes/run-all.sh "$run" "$pass_shards" || status=$?
node --input-type=module - "$run" <<'JS'
import { writeReport } from './scripts/upclose/report.ts';
const report = await writeReport(process.argv[2]);
console.log(`${report.summary.groups.open} open groups, ${report.counts.open} instances. Report: ${process.argv[2]}/report.md`);
JS
exit "$status"
