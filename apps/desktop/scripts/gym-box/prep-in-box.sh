#!/usr/bin/env bash
# Prepares a checkout inside a gym-capable box (snapshot gym173-platform-2) to run the
# up-close gym there: dependencies, the Electron sandbox, ffmpeg, the desktop build and the pinned
# fonts. These are the same steps run.sh takes after it uploads HEAD. Run it from the repo root:
#
#   bash apps/desktop/scripts/gym-box/prep-in-box.sh
#   cd apps/desktop && UPLINK_GYM_XVFB=1 xvfb-run -a -s '-screen 0 3000x2000x24' \
#     node scripts/upclose/run.ts "$OUT" --components <ids>
set -euo pipefail
[[ -f pnpm-workspace.yaml ]] || { echo "Run from the repo root." >&2; exit 2; }
# shellcheck disable=SC1091
source /data/gym-env.sh
pnpm install --frozen-lockfile
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
echo "Ready: cd apps/desktop, export UPLINK_GYM_XVFB=1, and run the gym under xvfb-run."
