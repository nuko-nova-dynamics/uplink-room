/**
 * The boot step of a cloud machine (#10, ADR 0013): a script the provider runs
 * detached on every boot. Only the disk survives a stop, so the bridge must be
 * started again each time.
 *
 * On the first boot it installs the bridge from `UPLINK_BRIDGE_TARBALL` (an
 * npm tarball, as `packages/bridge/README.md` builds) once its sha256 matches
 * `UPLINK_BRIDGE_TARBALL_SHA256`, lets the room's
 * settings decide the machine's limits, and pairs with the one-time code in
 * `UPLINK_PAIRING_CODE`. The bridge's token then stays in its private folder
 * on the kept disk, so later boots only start it. Secrets come in the
 * environment of this boot alone, never in the script.
 *
 * The hash comes from the room's own record (`tarballSetting`), not from the
 * Blob store, so whoever can write to the store still can't change what a
 * machine runs.
 *
 * A later boot reinstalls the bridge only when the tarball changed, and pairs
 * again only if the disk has no pairing (a fresh disk). The paired token is
 * never copied anywhere else.
 */

/** Where the provider writes the script on the machine. */
export const BOOT_SCRIPT_PATH = "/vercel/sandbox/.uplink/boot.sh";

/** The machine's own limits on a cloud machine: nobody sits at it, so the room's admin-set settings decide. */
const CLOUD_LIMITS = { mostOpenAccess: "open", slots: 16, longestProfileMs: 30 * 24 * 60 * 60 * 1000 };

/**
 * `UPLINK_BRIDGE_TARBALL_URL` holds the tarball's URL and its sha256 in one value,
 * `<url>#sha256=<hex>`, so a release changes both in one write
 * (`packages/bridge/scripts/release.ts`). Null when it's missing or carries no hash: a machine
 * then doesn't boot, rather than install a bridge nobody can vouch for.
 */
export function tarballSetting(value: string | undefined): { url: string; sha256: string } | null {
  const match = /^(https:\/\/[^#\s]+)#sha256=([0-9a-f]{64})$/.exec(value ?? "");
  return match ? { url: match[1]!, sha256: match[2]! } : null;
}

/**
 * The release a person installs from, out of `<url>#sha256=<hex>` (set by the Bridge release
 * workflow, packages/bridge/scripts/release.ts). The app puts the URL into commands people paste
 * into a shell, so only the shape the release script uploads passes: https, the public Blob store's
 * host, and `/bridge/uplink-room-bridge-<version>-<sha>.tgz`. That leaves no quote of any kind
 * (PowerShell also ends a quoted string at ‘ ’ ‚ ‛), no whitespace and nothing else a shell reads.
 */
export function bridgeReleaseFrom(value: string | undefined) {
  const release = tarballSetting(value);
  const parts = release
    ? /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\/bridge\/uplink-room-bridge-(\d+\.\d+\.\d+)-[0-9a-f]{7,40}\.tgz$/.exec(release.url)
    : null;
  if (!release || !parts) return null;
  return { url: release.url, sha256: release.sha256, version: parts[1]! };
}

export function bootScript(): string {
  return `#!/usr/bin/env bash
# Uplink Room boot step for a cloud machine. Runs on every boot.
set -euo pipefail
export UPLINK_BRIDGE_HOME="$HOME/.uplink-room"
PREFIX="$UPLINK_BRIDGE_HOME/npm"
BIN="$PREFIX/bin/uplink-bridge"
mkdir -p "$UPLINK_BRIDGE_HOME"
chmod 700 "$UPLINK_BRIDGE_HOME"
exec >>"$UPLINK_BRIDGE_HOME/boot.log" 2>&1
echo "boot $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# A retried start while the bridge already runs changes nothing.
PIDFILE="$UPLINK_BRIDGE_HOME/bridge.pid"
if [ -f "$PIDFILE" ] && grep -q uplink-bridge "/proc/$(cat "$PIDFILE")/cmdline" 2>/dev/null; then
  echo "bridge already running"
  exit 0
fi

if [ "$(cat "$PREFIX/.tarball" 2>/dev/null || true)" != "$UPLINK_BRIDGE_TARBALL#$UPLINK_BRIDGE_TARBALL_SHA256" ]; then
  # The tarball must be the one the release recorded, whatever the download serves.
  TARBALL="$(mktemp -d)/uplink-room-bridge.tgz"
  curl -fsSL --retry 3 -o "$TARBALL" "$UPLINK_BRIDGE_TARBALL"
  if [ "$(sha256sum "$TARBALL" | cut -d' ' -f1)" != "$UPLINK_BRIDGE_TARBALL_SHA256" ]; then
    echo "the bridge tarball's sha256 doesn't match the release, so it isn't installed"
    exit 1
  fi
  # node-pty has no Linux prebuild, so npm compiles it.
  if ! command -v make >/dev/null || ! command -v g++ >/dev/null || ! command -v python3 >/dev/null; then
    if command -v dnf >/dev/null; then
      sudo dnf install -y make gcc-c++ python3
    else
      sudo apt-get update && sudo apt-get install -y make g++ python3
    fi
  fi
  npm install --global --allow-scripts=node-pty --prefix "$PREFIX" "$TARBALL"
  printf '%s' "$UPLINK_BRIDGE_TARBALL#$UPLINK_BRIDGE_TARBALL_SHA256" > "$PREFIX/.tarball"
fi

if ! grep -q '"token"' "$UPLINK_BRIDGE_HOME/bridge.json" 2>/dev/null; then
  if [ -z "\${UPLINK_PAIRING_CODE:-}" ]; then
    echo "not paired, and no pairing code for this boot"
    exit 1
  fi
  "$BIN" limits --most-open-access ${CLOUD_LIMITS.mostOpenAccess} --slots ${CLOUD_LIMITS.slots} --longest-profile-ms ${CLOUD_LIMITS.longestProfileMs}
  "$BIN" pair "$UPLINK_PAIRING_CODE" --url "$UPLINK_CONVEX_URL"
fi
unset UPLINK_PAIRING_CODE

# Terminals the bridge starts get this folder at the front of their PATH, so Claude Code's hooks
# (\`uplink-bridge hook ...\`) find this private install.
export UPLINK_BRIDGE_BIN_DIR="$PREFIX/bin"
export PATH="$PREFIX/bin:$PATH"

echo $$ > "$PIDFILE"
exec "$BIN" run
`;
}
