#!/usr/bin/env bash
# Runs the up-close gym on several instabox boxes at once, each taking its own slice of the shards,
# merges their run folders here, and runs the checks and the report locally (they're plain Node).
# With --sheet it then builds the visual sheet on the first box (sheet rendering refuses macOS) and
# pulls it back. Only committed HEAD is sent; see run.sh.
#
#   fanout.sh <local-out> <boxes> [--per-box N] [--passes] [--sheet] [--sheet-only] [--sheet-box NAME] [--prefix NAME] [--snapshot NAME]
#
# --sheet-only skips capture and only builds the sheet for the run already merged in <local-out>/run.
# --sheet-box builds the sheet on that box (created from the snapshot when missing) instead of <prefix>-1,
# so a judge box can read the sheet where it was built.
#
# Boxes are named <prefix>-1 … <prefix>-N (default gym173-run), created from the pinned platform
# snapshot (default gym173-platform-2) when missing and woken when suspended. They auto-suspend after
# 30 idle minutes; delete them with `instabox rm --yes <name>` when the work is done.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
desktop=$(cd "$here/../.." && pwd)
out=${1:?Usage: fanout.sh <local-out> <boxes> [--per-box N] [--passes] [--sheet] [--prefix NAME] [--snapshot NAME]}
boxes=${2:?Usage: fanout.sh <local-out> <boxes> [options]}
shift 2
per=6 passes=0 sheet=0 sheet_only=0 sheet_box= prefix=gym173-run snapshot=gym173-platform-2
while [[ $# -gt 0 ]]; do
  case $1 in
    --per-box) per=$2; shift 2 ;;
    --passes) passes=1; shift ;;
    --sheet) sheet=1; shift ;;
    --sheet-only) sheet=1 sheet_only=1; shift ;;
    --sheet-box) sheet_box=$2; shift 2 ;;
    --prefix) prefix=$2; shift 2 ;;
    --snapshot) snapshot=$2; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[[ $boxes =~ ^[1-9][0-9]*$ && $per =~ ^[1-9][0-9]*$ ]] || { echo 'Boxes and --per-box are positive numbers.' >&2; exit 2; }
total=$((boxes * per))
mkdir -p "$out"
# Later steps run from apps/desktop, so a relative path would name another folder there.
out=$(cd "$out" && pwd)
started=$SECONDS

# Create or wake every box in parallel.
ensure() {
  local name=$1 state
  state=$(instabox get "$name" --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin).get("state",""))' 2>/dev/null || true)
  case $state in
    '') instabox create --snapshot "$snapshot" --name "$name" --vcpus 8 --mem-mib 16384 --auto-suspend 30m --no-vault --secrets none >/dev/null ;;
    suspended|paused) instabox resume "$name" >/dev/null ;;
    stopped) instabox start "$name" >/dev/null ;;
  esac
}
if ((sheet_only)); then ensure "${sheet_box:-$prefix-1}"; else
for ((i = 1; i <= boxes; i++)); do ensure "$prefix-$i" & done
[[ -n $sheet_box ]] && ensure "$sheet_box"
wait
fi
echo "Boxes ready after $((SECONDS - started))s."
status=0
if ((!sheet_only)); then

# Each box runs its shards of capture (and of the passes), each shard on its own virtual display.
pids=()
for ((i = 1; i <= boxes; i++)); do
  first=$(((i - 1) * per + 1)) last=$((i * per))
  cmd="s=0; ps=(); for j in \$(seq $first $last); do xvfb-run -a -s '-screen 0 3000x2000x24' node scripts/upclose/run.ts \"\$OUT\" --shard \$j/$total --skip-checks > \"\$OUT/shard-\$j.log\" 2>&1 & ps+=(\$!); done; for p in \"\${ps[@]}\"; do wait \$p || s=1; done"
  if ((passes)); then
    # Every pass shard writes findings/<pass>.json, so each gets its own folder under .shards/;
    # passes/merge.ts joins them here after the parts come back.
    cmd+="; ps=(); for j in \$(seq $first $last); do mkdir -p \"\$OUT/.shards/\$j\"; xvfb-run -a -s '-screen 0 3000x2000x24' node scripts/upclose/passes/run.ts \"\$OUT/.shards/\$j\" --shard \$j/$total > \"\$OUT/passes-\$j.log\" 2>&1 & ps+=(\$!); done; for p in \"\${ps[@]}\"; do wait \$p || s=1; done"
  fi
  cmd+="; exit \$s"
  "$here/run.sh" "$prefix-$i" "$out/part-$i" -- bash -c "$cmd" > "$out/part-$i.log" 2>&1 &
  pids+=($!)
done
for ((i = 0; i < ${#pids[@]}; i++)); do
  wait "${pids[$i]}" || { echo "Box $prefix-$((i + 1)) failed; see $out/part-$((i + 1)).log" >&2; status=1; }
done
echo "Boxes finished after $((SECONDS - started))s."

# Merge the parts. Capture writes per-component folders and per-shard files, so parts don't collide.
rm -rf "$out/run"
mkdir -p "$out/run"
for ((i = 1; i <= boxes; i++)); do
  [[ -d "$out/part-$i" ]] && rsync -a "$out/part-$i/" "$out/run/"
done
if ((passes)); then
  (cd "$desktop" && node scripts/upclose/passes/merge.ts "$out/run") || status=1
fi
(cd "$desktop" && node scripts/upclose/checks/cli.ts "$out/run") || { code=$?; [[ $code == 2 ]] || status=$code; }
echo "Merged and checked after $((SECONDS - started))s: $out/run/report.md"
fi

if ((sheet)); then
  box=${sheet_box:-$prefix-1}
  # Without a capture run first, bring the box's checkout to committed HEAD so the sheet code matches.
  if ((sheet_only)) || [[ -n $sheet_box ]]; then "$here/run.sh" "$box" "$out/sync" -- true > "$out/sync.log" 2>&1 || status=1; fi
  # macOS tar would add AppleDouble ._* entries (xattrs such as com.apple.provenance) that
  # Linux extracts as stray files the sheet then tries to read.
  COPYFILE_DISABLE=1 tar --no-mac-metadata -C "$out/run" -czf "$out/run.tgz" .
  instabox push "$box" "$out/run.tgz" /data/home/sheet-run.tgz >/dev/null
  # instabox ssh joins its arguments with spaces, so the script goes on stdin as in run.sh.
  instabox ssh "$box" --no-paste -- bash -s > "$out/sheet.log" 2>&1 <<'EOF' || status=1
set -euo pipefail
source /data/gym-env.sh
rm -rf /data/home/sheet-run
mkdir -p /data/home/sheet-run
tar -xzf /data/home/sheet-run.tgz -C /data/home/sheet-run
rm -f /data/home/sheet-run.tgz
cd /data/home/gym-repo/apps/desktop
CHROMIUM_PATH=/usr/bin/chromium node scripts/upclose/sheet.ts /data/home/sheet-run
EOF
  rm -rf "$out/run/sheet"
  mkdir -p "$out/run/sheet"
  instabox ssh "$box" --no-paste -- tar -C /data/home/sheet-run/sheet -czf - . | tar -xzf - -C "$out/run/sheet" || status=1
  rm -f "$out/run.tgz"
  echo "Sheet built after $((SECONDS - started))s: $out/run/sheet"
fi
exit "$status"
