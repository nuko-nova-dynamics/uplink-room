#!/usr/bin/env bash
set -euo pipefail
[[ $(uname -s) == Linux ]] || { echo 'Run provisioning inside a Linux box.' >&2; exit 1; }
started=$SECONDS
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl unzip xvfb xauth ffmpeg fontconfig python3 make g++ fonts-noto-color-emoji
export FNM_DIR=/data/fnm
if [[ ! -x /data/fnm/fnm ]]; then
  curl -fsSL https://fnm.vercel.app/install | bash -s -- --install-dir /data/fnm --skip-shell
fi
export PATH="/data/fnm:$PATH"
eval "$(fnm env --shell bash)"
fnm install 24.22.2
fnm use 24.22.2
if [[ $(pnpm --version 2>/dev/null || true) != 12.16.1 ]]; then
  npm install -g pnpm@12.16.1
fi
mkdir -p /data/pnpm-store /data/electron-cache
cat > /data/gym-env.sh <<'ENV'
export FNM_DIR=/data/fnm
export PATH="/data/fnm:$PATH"
eval "$(fnm env --shell bash)"
fnm use 24.22.2 >/dev/null
export pnpm_config_store_dir=/data/pnpm-store
export ELECTRON_CACHE=/data/electron-cache
export UPLINK_NO_TELEMETRY=1
ENV
# A fixed Google Fonts revision keeps fresh boxes on the same font files.
python3 - <<'PY'
import json, pathlib, subprocess, urllib.request
revision = '24ddc1f324cac5d9f5aedca126d298f56e3f1640'
for family in ['atkinsonhyperlegiblenext', 'atkinsonhyperlegiblemono']:
    url = f'https://api.github.com/repos/google/fonts/contents/ofl/{family}?ref={revision}'
    for entry in json.load(urllib.request.urlopen(url)):
        if entry['name'].endswith(('.ttf', '.txt')):
            target = pathlib.Path('/usr/local/share/fonts') / family / entry['name']
            subprocess.run(['sudo', 'mkdir', '-p', str(target.parent)], check=True)
            with urllib.request.urlopen(entry['download_url']) as source:
                subprocess.run(['sudo', 'tee', str(target)], input=source.read(), stdout=subprocess.DEVNULL, check=True)
PY
sudo fc-cache -f
# Emoji in messages and reactions need a color emoji font, as macOS and Windows have; without one they render as empty boxes.
{ find /usr/local/share/fonts/atkinson* -name '*.ttf' -exec sha256sum {} +; sha256sum /usr/share/fonts/truetype/noto/NotoColorEmoji.ttf; } | sort | tee /data/gym-fonts.sha256
# The binary is fetched after dependency installation. Repeat provisioning can fix it now.
if [[ -d /data/home/gym-repo/node_modules ]]; then
  find /data/home/gym-repo/node_modules/.pnpm -path '*/electron/dist/chrome-sandbox' -exec sudo chown root:root {} + -exec sudo chmod 4755 {} +
fi
printf 'Provisioned in %ss\n' "$((SECONDS-started))"
node --version
pnpm --version
