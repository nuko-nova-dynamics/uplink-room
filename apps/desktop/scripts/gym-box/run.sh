#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 4 || $3 != -- ]]; then
  echo 'Usage: run.sh <box> <local-out-dir> -- <command ...>' >&2
  exit 2
fi
box=$1
out=$2
shift 3
root=$(git rev-parse --show-toplevel)
cd "$root"
head=$(git rev-parse HEAD)
# Never send unstaged, staged or untracked files from the checkout.
printf 'Sending only committed HEAD %s to %s. Local edits are excluded.\n' "$head" "$box"
started=$SECONDS
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
# Keep the archive name unique so parallel callers cannot overwrite each other.
upload="/data/home/gym-${head}-$(basename "$scratch").tar.gz"
git archive --format=tar.gz HEAD > "$scratch/head.tar.gz"
instabox push "$box" "$scratch/head.tar.gz" "$upload"
command=''
printf -v command '%q ' "$@"
{
  printf 'archive=%q\nhead=%q\ncommand=%q\nrun_token=%q\n' "$upload" "$head" "$command" "$(basename "$scratch")"
  cat <<'REMOTE'
set -euo pipefail
source /data/gym-env.sh
# A box has one workspace and output folder. Serialize whole runs, including captures.
exec 9>/data/gym-run.lock
flock -n 9 || { echo 'This box already has a gym run.' >&2; exit 1; }
trap 'rm -f "$archive"' EXIT
mkdir -p /data/home/gym-repo
cd /data/home/gym-repo
# Remove the old committed source, retaining dependency folders and build caches.
if [[ -f /data/gym-source-files ]]; then
  while IFS= read -r file; do
    [[ $file == */ ]] || rm -f -- "$file"
  done < /data/gym-source-files
fi
tar -xzf "$archive"
tar -tzf "$archive" > /data/gym-source-files
inputs=$( { sha256sum pnpm-lock.yaml pnpm-workspace.yaml; find . -name node_modules -prune -o -name package.json -print | sort | xargs sha256sum; find patches -type f -print | sort | xargs sha256sum; node --version; } | sha256sum | cut -d' ' -f1)
if [[ ! -d node_modules || ! -f /data/gym-installed || $(cat /data/gym-installed) != "$inputs" ]]; then
  pnpm install --frozen-lockfile
  printf '%s' "$inputs" > /data/gym-installed
else
  echo 'Dependency inputs unchanged; skipping install.'
fi
electron_dir=$(dirname "$(find node_modules/.pnpm -path '*/electron/install.js' -print -quit)")
[[ -f "$electron_dir/install.js" ]]
(cd "$electron_dir" && node install.js)
sudo chown root:root "$electron_dir/dist/chrome-sandbox"
sudo chmod 4755 "$electron_dir/dist/chrome-sandbox"
pnpm --filter @uplink-room/desktop exec playwright install ffmpeg
pnpm --filter @uplink-room/desktop build
# Use the snapshot's pinned system fonts, not a changing Google Fonts response.
python3 - <<'FONTS'
import pathlib, re
page = pathlib.Path('apps/desktop/out/renderer/gym.html')
html = page.read_text()
html = re.sub(r'<link\b[^>]*href="https://fonts\.(?:googleapis|gstatic)\.com[^"]*"[^>]*>', '', html)
page.write_text(html)
FONTS
export UPLINK_GYM_XVFB=1
export OUT=/data/home/gym-out
rm -rf "$OUT"
mkdir -p "$OUT"
printf '%s\n' "$head" > "$OUT/head.txt"
cp /data/gym-fonts.sha256 "$OUT/fonts.sha256"
cd apps/desktop
echo "Starting gym command at $(date -u +%FT%TZ)"
printf '%s\n' "$run_token" > "$OUT/command.token"
# Keep the command and lock alive if the SSH transport expires during a long run.
nohup bash -c '
  status=0
  xvfb-run -a -s "-screen 0 3000x2000x24" bash -c "$1" 9>&- || status=$?
  printf "%s\n" "$status" > "$2/command.exit"
  exit "$status"
' -- "$command" "$OUT" > "$OUT/command.log" 2>&1 < /dev/null &
wait "$!"
REMOTE
} > "$scratch/run.sh"
status=0
instabox ssh "$box" --no-paste -- bash -s < "$scratch/run.sh" || status=$?
if [[ $status == 255 ]]; then
  token=$(instabox ssh "$box" --no-paste -- cat /data/home/gym-out/command.token 2>/dev/null || true)
  if [[ $token == "$(basename "$scratch")" ]]; then
    echo 'SSH disconnected. Waiting for the box command to finish.'
    while true; do
      completed=$(instabox ssh "$box" --no-paste -- cat /data/home/gym-out/command.exit 2>/dev/null || true)
      if [[ $completed =~ ^[0-9]+$ ]]; then status=$completed; break; fi
      sleep 5
    done
  fi
fi
mkdir -p "$out"
if ! instabox pull "$box" /data/home/gym-out/ "$out"; then
  # Full inventories exceed the pull API's 32 MiB compressed limit.
  echo 'Streaming the run folder over SSH.'
  if instabox ssh "$box" --no-paste -- tar -C /data/home/gym-out -czf - . > "$scratch/output.tar.gz"; then
    tar -xzf "$scratch/output.tar.gz" -C "$out" || { [[ $status != 0 ]] || status=$?; }
  else
    [[ $status != 0 ]] || status=$?
  fi
fi
printf 'Box run and pull finished in %ss (exit %s).\n' "$((SECONDS-started))" "$status"
exit "$status"
