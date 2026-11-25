# Gym on a Linux box

Only committed HEAD is sent. Commit changes before running. The box receives a
Git archive and never needs GitHub credentials. Run one command per box at a time.

Create and provision a box from this checkout:

```sh
instabox create --name gym173-platform --template agent-browser --vcpus 8 --mem-mib 16384 --auto-suspend 30m --no-vault --secrets none --setup-file apps/desktop/scripts/gym-box/provision.sh
```

Run the scale and determinism probe, or capture two gym states:

```sh
apps/desktop/scripts/gym-box/run.sh gym173-platform /tmp/gym-smoke -- node scripts/gym-box/smoke.ts
apps/desktop/scripts/gym-box/run.sh gym173-platform /tmp/gym-captures -- bash -c 'node scripts/gym.ts "$OUT" inbox channel'
```

The command runs from `apps/desktop`, with `OUT=/data/home/gym-out`, inside Xvfb
at 3000 by 2000 pixels. Output is replaced on the box before each run and copied
into the local output directory. Use a new local directory to avoid old files.
The runner still pulls available output when the command fails. Commands run
over SSH without the exec API's 600 second limit. Clipboard paste is disabled.
The box command survives an SSH disconnect. The runner waits for its recorded
exit status before copying output; its log is saved as `command.log` in the run.

Dependencies, the pnpm store and Electron downloads stay on `/data`. The runner
skips installation when the lockfile, workspace configuration, package manifests,
patches and Node version match the previous successful install. It installs Playwright's ffmpeg binary for video recording and rebuilds the
app for each run. It sets Electron's `chrome-sandbox` owner to root and mode to
4755 after fetching the binary. It does not disable the sandbox.

Provisioning installs Node 24.22.2 through fnm, pnpm 12.16.1, Xvfb, ffmpeg and both
Atkinson font families. Font files come from Google Fonts revision
`24ddc1f324cac5d9f5aedca126d298f56e3f1640`. Their SHA-256 hashes are in
`/data/gym-fonts.sha256` and copied into every run's output.

The smoke launches two fresh Electron processes at scale 2, captures visible
`.btn` elements in the dark Inbox, checks 28 CSS pixels become 56 device pixels,
and compares the PNG hashes. `smoke.json` records font faces, font resources,
computed font families, sizes and hashes. Electron is closed in `finally`.

Save the warmed platform and test a copy:

```sh
instabox snapshot save gym173-platform --name gym173-platform
instabox create --name gym173-snaptest --snapshot gym173-platform --vcpus 8 --mem-mib 16384 --auto-suspend 30m --no-vault --secrets none
apps/desktop/scripts/gym-box/run.sh gym173-snaptest /tmp/gym-snapshot-smoke -- node scripts/gym-box/smoke.ts
instabox rm --yes gym173-snaptest
instabox suspend gym173-platform
```

Compare pixel measurements only on this snapshot. Run Electron only on boxes.
Do not run `gym-crawl.ts` unless `git merge-base --is-ancestor 6414332 HEAD`
succeeds. The gym uses sample data and needs no backend deployment.

The runner removes Google Fonts links from the built gym HTML after each build.
This makes captures use the snapshot's installed fonts. It does not change the
source HTML or the normal app. Without this step the gym downloads fonts from
Google at runtime. `UPLINK_GYM_XVFB=1` lets the Linux gym window render inside the
virtual display. Hidden Linux windows can stall Playwright's frame-based checks.
The setting has no effect on macOS.

Element screenshots can round fractional CSS edges outward. The smoke uses a
page screenshot clipped to the button rectangle, aligned to device pixels, so
a 28 CSS pixel height produces exactly 56 pixels at scale 2.

## Pinned capture platform

The `gym173-platform` snapshot uses Debian 13, 8 vCPU, 16384 MiB, Electron
45.2.1 and Node 24.22.2. Its source template is
`agent-browser@2026-11-01.3-android.1-cli.1`, digest
`sha256:808062679e901d9cd95cf734e7fd5def01e00e18bbd6d9e78d00e56413ffb710`.

Font SHA-256 values, from the revision above:

| File                                        | SHA-256                                                            |
| ------------------------------------------- | ------------------------------------------------------------------ |
| `AtkinsonHyperlegibleNext[wght].ttf`        | `5a455d1cfa099b601ab70751bb9673e8fe1854dc4500c80e1a220d0d75e31745` |
| `AtkinsonHyperlegibleNext-Italic[wght].ttf` | `ce9cffed32742ad2d9238c561a93220385e5934cdc02b8eb4097a50efa957dc6` |
| `AtkinsonHyperlegibleMono[wght].ttf`        | `5ce8b1698d1ded7dff2178c1a3ad159470085a58ea239e8b2cb88f4fb4a6f646` |
| `AtkinsonHyperlegibleMono-Italic[wght].ttf` | `e18f523877530e4abe229df6a36d394326254da488a7f5abb9b7b5ea8f780cd4` |

The probe reports no web font faces or downloaded font resources on this platform.
Chromium identifies the New task button's font as Atkinson Hyperlegible Next,
with `isCustomFont: false`, confirming the installed system font. The normal gym
HTML loads Google-hosted TTF files at runtime, not bundled WOFF2 files.

## Verification on 2026-11-06

Fresh setup took 41 seconds after a 1.9 second box boot. Repeating provisioning
took 5 seconds. A warm smoke run took 25 seconds including upload, build, two
launches and download. The Inbox and Channel gym run took 51 seconds and produced
eight PNGs, four clean detector reports and two H.264 videos, with no page errors.
The videos are 1320 by 840 at 25 fps, lasting 7.32 and 9.08 seconds.

A new box from `gym173-platform` became ready in 35.7 seconds. Its smoke run took
25 seconds. Both button crops matched between launches and matched the original
platform box byte for byte. Each crop was 56 pixels tall from a 28 CSS pixel
button. The test box was deleted and the platform box was suspended.

The initial hidden-window probe timed out waiting for stable frames. Showing the
Linux window inside Xvfb fixed it. The first video attempt stayed blank until
Playwright's own ffmpeg binary was installed; system ffmpeg alone was insufficient.
The final runner installs both. No sandbox-disabling switch is needed.

The captures also show repeated dropdown arrows in the light Inbox project
filter. That visual issue is left for the UI workers. `gym-crawl.ts` and the macOS
app were not run. Local lint and typecheck passed; lint reported existing warnings.
