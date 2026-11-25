# Releases and updates

The desktop app updates itself from **https://uplinkroom.com/updates/&lt;channel&gt;/**. The site (`apps/site`, Vercel project `uplink-room-website`, team Miami Web AI) rewrites that path to the public Vercel Blob store `uplink-room-updates` in the same team, so the files can move to another store without breaking installed apps: only `UPDATES_ORIGIN` in `apps/site/lib/feed.ts` changes.

## Channels

| Channel | Versions | Who gets it |
| --- | --- | --- |
| `latest` | `0.2.0`, `0.2.1` | Everyone. The download page lists it. |
| `test` | `0.2.1-test.1`, `0.2.1-test.2` | Test builds only, to check a release before it ships. `uplinkroom.com/download?channel=test` lists it. |

A version's prerelease tag names its channel (`channelOf` in `apps/desktop/src/main/updateSpec.ts`), and electron-builder bakes the channel's folder into the app (`publish` in `apps/desktop/electron-builder.yml`, written to the app as `app-update.yml`). So a test build only ever sees newer test builds, and a release build only newer releases. Any other prerelease tag (`-beta.1`) belongs to no channel: the release script refuses it and the app doesn't update. Test-channel builds keep their data in `Uplink Room (test)` under the OS's app-data folder, apart from the released app's, and report errors to Sentry under the `test` environment.

Each channel's folder holds what electron-builder makes for each platform:

| Platform | Feed file | Installers | Updates download |
| --- | --- | --- | --- |
| macOS | `latest-mac.yml` | `Uplink-Room-<v>-mac-arm64.dmg` (Apple silicon only since 0.2.22; an Intel install's update check then finds no zip and fails) | the `.zip` (Squirrel.Mac needs it) |
| Windows | `latest.yml` | `Uplink-Room-Setup-<v>-x64.exe`, `-arm64.exe` | the same `.exe`, run silently |
| Linux | `latest-linux.yml` | `Uplink-Room-<v>-linux-x86_64.AppImage`, `-linux-amd64.deb` | the AppImage; a `.deb` install doesn't update itself |

The test channel's feeds are `test-mac.yml`, `test.yml` and `test-linux.yml`. Feed files are cached for 60 seconds (the shortest Blob allows); installers, whose names carry the version, for the default month. Blob's CDN does that caching. The site's own CDN doesn't cache `/updates/` (`x-vercel-enable-rewrite-caching: 0` in `apps/site/vercel.json`): with it on, it stored a differential download's 206 range response under the plain URL and served those few KB to every later full download. `release.ts` checks after each release that a range and a whole download both answer correctly.

## What the app does

`apps/desktop/src/main/updates.ts` runs electron-updater on the rules in `updateSpec.ts` (tested in `updateSpec.test.ts` and, against a stand-in for electron-updater, `updates.test.ts`):

- Installed builds check at launch and every 4 hours; development builds, `UPLINK_NO_UPDATES=1`, and Linux installs other than the AppImage never check.
- Only a version on the app's own channel is taken. A test build in the `latest` feed (or a release in the `test` feed) is refused when the check finds it, before anything downloads, and Settings says the last update was for another release channel.
- An update downloads in the background, and its signature is checked (below) before it can install. On macOS, Squirrel.Mac then stages it. Only then does the sidebar (and the sign-in screen) show "Version x is ready" with **Restart to update**. During a call it neither shows the prompt nor restarts; it asks again right before it quits. A checked update also installs the next time the app quits.
- If nobody restarts or quits, the app restarts for a ready update on its own, and opens again: once the computer has had no keyboard or mouse input for 30 minutes (Electron's `powerMonitor.getSystemIdleState`) or its screen is locked, nobody here is in a call, and the app's bridge reports no terminal that quitting would end (the bridge's local `busy` request). It asks every minute while an update is ready, and when the screen locks. A desktop that reports its idle state as unknown (some Wayland sessions) never restarts on its own; the update installs at the next quit (`src/main/updateSpec.ts`, `autoRestartDue`).
- Settings, Updates shows the version, the channel for test builds, **Check for updates** and where a download stands.
- A failed check, download, signature check, staging or install is shown in Settings and reported to Sentry with the stage and the error code as tags (once per code per launch; offline errors aren't reported). It never stops the app. Any of them ends the offer, so the prompt goes and the next check (or **Check for updates**) starts over. A download that throws before it starts (a feed file without a checksum) takes the same path.
- Each check starts an attempt and each failure ends it. A step still running for an attempt that ended (a signature check that finishes after its download failed and a retry began) changes nothing: it can't mark the newer download ready or let it install on quit.

## Update signatures

The feed's own hashes only prove a download matches the feed, and anyone holding the Blob store's write token can change the feed. So every installer also gets a detached Ed25519 signature, `<file>.sig` beside it, made with a key that is kept apart from the store. The app (`src/main/updateSignature.ts`) trusts only the public keys in `UPDATE_KEYS`, and installs nothing that isn't signed by one of them. The signature covers the channel, the version, the file's name and its sha512, so it can't be moved to another file, version or channel: a signed test build copied into the `latest` folder still carries a `test` signature.

A `.sig` file holds one signature per line (JSON, one per release key). The app accepts it when any line is a valid signature by a key it trusts, so a release can be signed with an old and a new key while the key is rotated.

electron-updater emits "update-downloaded" both for a fresh download and for an installer it already has in its cache. It accepts a cached file by its sha512 alone: in 6.8.10, `AppUpdater.executeDownload` returns a cached file through `done(false)` without the NSIS updater's `verifySignature`. So the app checks the signature on "update-downloaded", on every platform, against the version and channel the feed offers. A cached 0.2.1 that someone advertises as 9.9.9 fails, since its signature is for 0.2.1. Until the check passes, `autoInstallOnAppQuit` stays off, so electron-updater adds no install-on-quit handler and MacUpdater doesn't hand the zip to Squirrel.Mac. A refused file is deleted.

| Platform | After the check passes | What else checks the update |
| --- | --- | --- |
| Windows | The app turns `autoInstallOnAppQuit` on and adds electron-updater's install-on-quit handler (`installOnQuit` in `updates.ts`). | Nothing yet: the installers aren't Authenticode-signed, and electron-updater 6.8.10 calls `verifyUpdateCodeSignature` only when `app-update.yml` has a `publisherName`. When Windows signing (Azure Artifact Signing) lands, add `win.signtoolOptions.publisherName` to `electron-builder.yml`; electron-updater then also checks Authenticode on each fresh download. |
| macOS | The app asks Squirrel.Mac to stage the zip, and offers the restart once it has. | Squirrel.Mac's own check that the new app is signed by the same Developer ID (team 8NTMP8848J). |
| Linux (AppImage) | As on Windows. | Nothing else. |

`scripts/release.ts` signs each installer the feeds list with every key it's given, checks each signature against `UPDATE_KEYS` before it uploads anything (so a key the app doesn't trust is caught there), and refuses to publish without a key. A refused update shows "The last update wasn't signed by Nuko Nova" in Settings and reports `ERR_UPLINK_UPDATE_SIGNATURE`; one for another channel reports `ERR_UPLINK_UPDATE_CHANNEL`. The app also takes only the kind of installer its platform installs (a zip on macOS, an exe on Windows, an AppImage on Linux): another platform's files are validly signed too, and on Linux electron-updater deletes the installed AppImage before it finds a zip won't run.

The private key (pkcs8, base64) lives in two places only:

- the GitHub Actions secret `UPDATES_SIGNING_KEY`, which the Package workflow's publish step reads;
- the release Mac's login keychain, as the generic password "Uplink Room update signing key" (account `uplink-room-updates`), which `pnpm release:mac` reads with `security find-generic-password`.

No file holds it. The current key's id is `40fad3ee746fa476`. During a rotation both places hold two keys, separated by a space; the release script signs with each.

### Rotating the key

An app installed before a release that adds a key trusts only the old one, and can be offline for months. So the old key keeps signing for a long overlap, and is retired only once few installs can still be that old.

1. **Add the new key.** Make a new pair with Node's `crypto.generateKeyPairSync("ed25519")`. Add its public key to `UPDATE_KEYS` next to the old one, under its id (`keyIdOf`). Replace `UPDATES_SIGNING_KEY` with both private keys, old first, separated by a space, with `gh secret set` reading them from stdin. Do the same for the keychain item with `security -i` reading `add-generic-password -U -a uplink-room-updates -s "Uplink Room update signing key" -w "<old> <new>"` from stdin, so no key appears in a command line or a file. The next release (the bridge release) is signed with both keys, and every app that installs it trusts both.
2. **Sign with both for a long overlap**, at least six months. Every release in it is signed with both keys, so an app from before the bridge release still checks the old key's line, and a newer one either. The release script prints which keys signed, and which trusted keys didn't.
3. **Retire the old key** once the overlap is over and installs older than the bridge release are rare. In one release, remove the old public key from `UPDATE_KEYS` and the old private key from `UPDATES_SIGNING_KEY` and the keychain item. An app still older than the bridge release can't update itself after that; reinstalling from uplinkroom.com/download fixes it.

If a private key leaks, there's no time for an overlap. Installed apps trust only the leaked key, so the way out goes through it: do step 1 and release at once (signed with both keys), then do step 3 in the very next release, signed with the new key only. Apps pick up the second within 4 hours of the first. An app that doesn't update past the first still trusts the leaked key, and whoever holds it and the store's write token can send that app an update, so replace the store token as well.

## Cut a release

1. Bump `version` in `apps/desktop/package.json` (`0.2.0` for latest, `0.2.1-test.1` for test) and merge it to `main`.
2. On a Mac with the Nuko Nova Developer ID Application certificate in the keychain, from the repo root on `main`:

   ```sh
   vercel link --project uplink-room-website --scope miamiwebai   # once: links the repo root
   vercel env pull --environment development --scope miamiwebai   # once: writes BLOB_READ_WRITE_TOKEN to .env.local
   unset ELECTRON_RUN_AS_NODE
   pnpm install --frozen-lockfile
   pnpm release:mac
   ```

   It takes 30 minutes to over an hour, most of it Apple's notarization, so run it in a terminal or detached (`nohup pnpm release:mac > /tmp/release-mac.log 2>&1 &`), never under a time limit that would kill it partway (AGENTS.md). It first checks, in seconds, that `pnpm`, `node`, `stapler` and `notarytool` start from Node, and prints how long each step took.

   It builds for release, signs, notarizes the apps and the dmgs (with `APPLE_API_KEY`, `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`, or the `asc` CLI's default key in `~/.asc/config.json`), checks each app with `codesign`, `spctl` and `stapler`, and uploads to the channel. It uploads the build's source maps to Sentry with `SENTRY_AUTH_TOKEN`, or else the token `sentry-cli` is logged in with (`~/.sentryclirc`), and warns when it has neither. `pnpm release:mac --no-upload` stops before the upload.
3. Tag the same commit `v<version>` and push the tag. The Package workflow builds Windows and Linux on GitHub-hosted runners and, after checking that the tag matches the version, uploads them to the channel with the `UPDATES_BLOB_READ_WRITE_TOKEN` repository secret.
4. Check https://uplinkroom.com/download (or `?channel=test`): each platform should show the new version. Installed apps pick it up within 4 hours, or at once from Settings, Updates, **Check for updates**.

`node apps/desktop/scripts/release.ts` (also `pnpm release:upload`) uploads whatever is in `apps/desktop/dist`, or another folder with `--dist` (for example a Package workflow artifact), and `--dry-run` lists what it would upload. It checks that every feed is for the version in `package.json` and that each file matches its hash, signs the installers, uploads the installers, signatures and blockmaps before the feeds, and reads the feeds back through uplinkroom.com, checking their hashes against the bytes it uploaded. Files with the version in their name never change once published: a file already in the store with the same bytes is skipped, so running it again for the same build is safe, and a file with different bytes stops the release until the version is bumped. Only the feed files are replaced. A feed is never replaced by an older version: the script reads the stored feed before it uploads anything and again as it writes each feed, writes only if that feed hasn't changed in between (its ETag), and stops if it already serves a newer version, so a rerun of an old tag or two releases at once can't take apps back. `--rollback` replaces a newer feed on purpose.

To take the test builds down: `pnpm release:empty-test`. It refuses to empty `latest`, since installed apps read it.

## Secrets and where they live

| What | Where |
| --- | --- |
| Blob store read-write token | Vercel project `uplink-room-website`, Development environment only (`BLOB_READ_WRITE_TOKEN`), so the deployed site has none. GitHub Actions secret `UPDATES_BLOB_READ_WRITE_TOKEN`. |
| Update signing key | GitHub Actions secret `UPDATES_SIGNING_KEY`; the release Mac's login keychain ("Uplink Room update signing key"). Two keys, separated by a space, during a rotation. See Update signatures. |
| App Store Connect API key | `~/.appstoreconnect/private_keys/AuthKey_<id>.p8` on the release Mac; its key ID and issuer in `~/.asc/config.json`. |
| Developer ID Application certificate | The release Mac's keychain. |

## The site

`apps/site` is a Next.js app: the home page, `/download` (reads the feeds at request time, cached five minutes), and the draft `/privacy` and `/terms`. Its project's root directory is `apps/site`, and it installs with `pnpm install --frozen-lockfile --filter @uplink-room/site...` under Corepack (`ENABLE_EXPERIMENTAL_COREPACK=1`, so it uses the repo's pnpm). Deploy it from the repo root: `vercel deploy --prod --scope miamiwebai`. `.vercelignore` leaves research and design films out of the upload.

DNS for uplinkroom.com is on Cloudflare. The site needs the apex `A` records `216.150.1.1` and `216.150.16.1` and `www` as a `CNAME` to `783716788226adbb.vercel-dns-016.com`, all DNS only (not proxied); `www` redirects to the apex. The `clerk`, `accounts`, `clkmail` and `clk*._domainkey` records belong to Clerk.
