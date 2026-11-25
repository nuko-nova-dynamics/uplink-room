import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BlobNotFoundError, BlobPreconditionFailedError, del, head, list, put } from "@vercel/blob";
import { parse, stringify } from "yaml";
import {
  UPDATE_KEYS,
  checkSignature,
  keyIdOfPrivateKey,
  sha512OfFile,
  signatureFile,
  signUpdate,
} from "../src/main/updateSignature.ts";
import { CHANNELS, channelOf, type UpdateChannel } from "../src/main/updateSpec.ts";

/**
 * Publishes a packaged build to its update channel (docs/releases.md). It reads the feed files
 * electron-builder wrote into dist/ (`latest-mac.yml`, `latest.yml`, `latest-linux.yml`, or the
 * `test*` ones for a 0.2.1-test.1 version), signs every installer they list with the update
 * signing key (`<file>.sig`, src/main/updateSignature.ts), uploads the installers, their signatures
 * and the blockmaps updates use to the public Vercel Blob store `uplink-room-updates` at
 * `updates/<channel>/`, then the feed files last, so an app never reads a feed whose files aren't
 * there yet. It finishes by reading the feeds back through https://uplinkroom.com/updates/<channel>/,
 * the address installed apps use, and checking their hashes against what was uploaded.
 *
 * A published file with a version in its name never changes: if it's already in the store with the
 * same bytes it's skipped, and with different bytes the release stops and asks for a new version.
 * Only the feed files are replaced. So running it again for the same build is safe, and a feed and
 * the bytes it describes can't disagree.
 *
 *   node apps/desktop/scripts/release.ts                 uploads apps/desktop/dist
 *   node apps/desktop/scripts/release.ts --dist <dir>    uploads another folder (CI artifacts)
 *   node apps/desktop/scripts/release.ts --dry-run       checks and lists, uploads nothing
 *   node apps/desktop/scripts/release.ts --rollback      lets a feed go back to an older version
 *   node apps/desktop/scripts/release.ts --empty test    deletes everything on the test channel
 *
 * The version in apps/desktop/package.json picks the channel, and every feed must be for that
 * version. Each platform's feed is its own file, so the Mac (built here) and the Windows and Linux
 * builds (built in CI) publish separately without touching each other's.
 *
 * Needs the store's read-write token: BLOB_READ_WRITE_TOKEN or UPDATES_BLOB_READ_WRITE_TOKEN in the
 * environment, or BLOB_READ_WRITE_TOKEN in the repo root's .env.local, which
 * `vercel env pull --environment development` writes in a folder linked to the Vercel project
 * uplink-room-website. And the update signing keys: UPDATES_SIGNING_KEY in the environment (the
 * GitHub Actions secret), or on a Mac the login keychain item "Uplink Room update signing key"
 * (account uplink-room-updates). It holds one key, or two separated by a space while the key is
 * rotated; each installer is signed with every key, one line each in its `.sig`. Neither secret is
 * ever printed. A release isn't published unsigned.
 */

const desktop = join(import.meta.dirname, "..");
const repo = join(desktop, "../..");
const SITE = "https://uplinkroom.com";
/** The store's public host; a token for another store is refused. */
const STORE_HOST = "4slsl7bmrg2qn9i3.public.blob.vercel-storage.com";
const MULTIPART_FROM = 32 * 1024 * 1024;

class ReleaseError extends Error {}
const fail = (message: string): never => {
  throw new ReleaseError(message);
};

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

function storeToken(): string {
  const fromEnv =
    process.env["BLOB_READ_WRITE_TOKEN"] || process.env["UPDATES_BLOB_READ_WRITE_TOKEN"];
  if (fromEnv) return fromEnv;
  const file = join(repo, ".env.local");
  if (existsSync(file)) {
    const line = readFileSync(file, "utf8")
      .split("\n")
      .find((l) => l.startsWith("BLOB_READ_WRITE_TOKEN="));
    const value = line?.slice("BLOB_READ_WRITE_TOKEN=".length).trim().replace(/^"|"$/g, "");
    if (value) {
      console.log("Using BLOB_READ_WRITE_TOKEN from the repo's .env.local.");
      return value;
    }
  }
  return fail(
    "set BLOB_READ_WRITE_TOKEN (the uplink-room-updates store's read-write token), or run `vercel env pull --environment development` in a folder linked to uplink-room-website.",
  );
}

const KEYCHAIN = { service: "Uplink Room update signing key", account: "uplink-room-updates" };

/**
 * The Ed25519 update signing keys (pkcs8 DER, base64): one, or two while the key is rotated
 * (docs/releases.md, "Rotating the key"), separated by spaces. Base64 has no spaces, and the
 * keychain prints a password with a newline in it as hex, so a space is the separator.
 */
function signingKeys(): string[] {
  const split = (text: string) => text.split(/[\s,]+/).filter(Boolean);
  const fromEnv = process.env["UPDATES_SIGNING_KEY"];
  if (fromEnv?.trim()) return split(fromEnv);
  if (process.platform === "darwin") {
    const read = spawnSync(
      "security",
      ["find-generic-password", "-a", KEYCHAIN.account, "-s", KEYCHAIN.service, "-w"],
      { encoding: "utf8" },
    );
    if (read.error)
      return fail(`couldn't run security to read the signing key: ${read.error.message}`);
    if (read.status === 0 && read.stdout.trim()) {
      console.log(`Signing with the keys in the login keychain ("${KEYCHAIN.service}").`);
      return split(read.stdout);
    }
  }
  return fail(
    `set UPDATES_SIGNING_KEY, or on a Mac keep the key in the login keychain as "${KEYCHAIN.service}" (docs/releases.md). Releases aren't published unsigned.`,
  );
}

/** electron-builder's file hash: sha512, base64. */
const sha512 = sha512OfFile;

/** The sha512 of what the store holds at `url`, or null when nothing is there. */
/**
 * The sha512 of the file stored at `url`, read back in full, or null when it isn't there. A long
 * download can be cut off ("TypeError: terminated", an undici body timeout: v0.2.4's Windows
 * publish died that way six minutes into reading its installer back), so a network error starts
 * the download again, up to four tries.
 */
async function storedSha512(url: string): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${url}?release-check=${Date.now()}`, { cache: "no-store" });
      if (response.status === 404) return null;
      if (!response.ok || !response.body) fail(`downloading ${url} answered ${response.status}.`);
      const hash = createHash("sha512");
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) hash.update(chunk);
      return hash.digest("base64");
    } catch (error) {
      if (error instanceof ReleaseError || attempt >= 4) throw error;
      console.log(`Reading ${url} back failed (${String(error)}); trying again (${attempt + 1} of 4).`);
      await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));
    }
  }
}

type FeedFile = { url: string; sha512: string; size?: number; [key: string]: unknown };
type Feed = {
  version: string;
  files: FeedFile[];
  path?: string;
  sha512?: string;
  [key: string]: unknown;
};

const contentType = (name: string) =>
  name.endsWith(".yml")
    ? "text/yaml; charset=utf-8"
    : name.endsWith(".dmg")
      ? "application/x-apple-diskimage"
      : name.endsWith(".zip")
        ? "application/zip"
        : name.endsWith(".exe")
          ? "application/vnd.microsoft.portable-executable"
          : name.endsWith(".deb")
            ? "application/vnd.debian.binary-package"
            : "application/octet-stream";

async function upload(
  token: string,
  channel: UpdateChannel,
  name: string,
  body: Buffer,
  options: { maxAge?: number; overwrite: boolean; ifMatch?: string },
) {
  const { maxAge, overwrite, ifMatch } = options;
  const blob = await put(`updates/${channel}/${name}`, body, {
    access: "public",
    token,
    addRandomSuffix: false,
    allowOverwrite: overwrite,
    contentType: contentType(name),
    multipart: body.length >= MULTIPART_FROM,
    ...(maxAge ? { cacheControlMaxAge: maxAge } : {}),
    ...(ifMatch ? { ifMatch } : {}),
  });
  if (new URL(blob.url).host !== STORE_HOST)
    fail(
      `the token belongs to another store (${new URL(blob.url).host}), not uplink-room-updates.`,
    );
  return blob.url;
}

/**
 * Publishes a file whose name carries the version, once: skipped when the store already has these
 * bytes, refused when it has other bytes, and read back after a new upload.
 */
/** Orders release versions (`0.2.3`, `0.2.3-test.4`, `0.2.3+build.1`): negative when `a` is older than `b`. */
function compareVersions(a: string, b: string): number {
  const parts = (v: string) => {
    // Build metadata (`+build.1`) doesn't order versions (SemVer 2.0.0, item 10).
    const [main = "", pre] = v.split("+", 1)[0]!.split("-", 2);
    return {
      main: main.split(".").map(Number),
      pre: pre ? Number(/(\d+)$/.exec(pre)?.[1] ?? 0) : null,
    };
  };
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++)
    if ((x.main[i] ?? 0) !== (y.main[i] ?? 0)) return (x.main[i] ?? 0) - (y.main[i] ?? 0);
  if (x.pre === null || y.pre === null) return (x.pre === null ? 1 : 0) - (y.pre === null ? 1 : 0);
  return x.pre - y.pre;
}

/**
 * The feed now stored for `name`, with its ETag for a conditional write, or null if there's none.
 * Fails when it already serves a newer version than `version`, unless `--rollback` is given.
 */
async function storedFeed(token: string, channel: UpdateChannel, name: string, version: string) {
  let blob;
  try {
    blob = await head(`updates/${channel}/${name}`, { token });
  } catch (error) {
    if (error instanceof BlobNotFoundError) return null;
    throw error;
  }
  const response = await fetch(`${blob.url}?release-check=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) fail(`reading the stored ${name} answered ${response.status}.`);
  const served = (parse(await response.text()) as Feed | null)?.version;
  if (served && compareVersions(served, version) > 0 && !process.argv.includes("--rollback"))
    fail(
      `${name} already serves ${served}, newer than ${version}. Run with --rollback to go back on purpose.`,
    );
  return { etag: blob.etag };
}

async function publishOnce(token: string, channel: UpdateChannel, dist: string, name: string) {
  const local = await sha512(join(dist, name));
  let existing: string | null = null;
  try {
    existing = (await head(`updates/${channel}/${name}`, { token })).url;
  } catch (error) {
    if (!(error instanceof BlobNotFoundError)) throw error;
  }
  if (existing) {
    const stored = await storedSha512(existing);
    if (stored === local) {
      console.log(`Already published with the same bytes: ${name}.`);
      return;
    }
    fail(
      `${name} is already published with different bytes. Published files never change: bump the version in apps/desktop/package.json and package again.`,
    );
  }
  const body = await readFile(join(dist, name));
  // A long upload can be cut off (v0.2.2's Linux publish died with "TypeError: terminated" after
  // two files). Try again, and if a cut-off try in fact stored the file, take it when its bytes match.
  let url = "";
  for (let attempt = 1; ; attempt++) {
    try {
      url = await upload(token, channel, name, body, { overwrite: false });
      break;
    } catch (error) {
      if (error instanceof ReleaseError) throw error;
      const stored = await head(`updates/${channel}/${name}`, { token }).catch(() => null);
      if (stored) {
        url = stored.url;
        break;
      }
      if (attempt >= 4) throw error;
      console.log(
        `Uploading ${name} failed (${String(error)}); trying again (${attempt + 1} of 4).`,
      );
      await new Promise((resolve) => setTimeout(resolve, 5_000 * attempt));
    }
  }
  // A path that was deleted shortly before can still answer 404 from the cache for a minute or so
  // (v0.2.2's Linux rerun read its AppImage back as missing), so wait for the new file to appear.
  let stored = await storedSha512(url);
  for (let wait = 1; stored === null && wait <= 8; wait++) {
    console.log(`${name} doesn't read back yet; checking again in 15 seconds (${wait} of 8).`);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    stored = await storedSha512(url);
  }
  if (stored !== local) fail(`${name} reads back with sha512 ${stored}, not ${local}.`);
  console.log(
    `Uploaded ${name} (${Math.round(body.length / 1024 / 1024)} MB), read back and checked.`,
  );
}

async function emptyChannel(token: string, channel: string) {
  if (channel !== "test")
    fail(`only the test channel can be emptied here; ${channel} would break installed apps.`);
  let cursor: string | undefined;
  let removed = 0;
  do {
    const page = await list({
      prefix: `updates/${channel}/`,
      token,
      ...(cursor ? { cursor } : {}),
    });
    if (page.blobs.length > 0) {
      await del(
        page.blobs.map((b) => b.url),
        { token },
      );
      removed += page.blobs.length;
      for (const b of page.blobs) console.log(`Deleted ${b.pathname}`);
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  console.log(
    `The ${channel} channel is empty (${removed} file${removed === 1 ? "" : "s"} deleted).`,
  );
}

async function main() {
  const empty = argument("--empty");
  if (empty) return emptyChannel(storeToken(), empty);

  const dryRun = process.argv.includes("--dry-run");
  const dist = argument("--dist") ?? join(desktop, "dist");
  const { version } = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")) as {
    version: string;
  };
  const channel =
    channelOf(version) ??
    fail(
      `version ${version} belongs to no channel; use x.y.z for latest or x.y.z-test.n for test (${CHANNELS.join(", ")}).`,
    );
  if (!existsSync(dist)) fail(`${dist} doesn't exist. Package the app first.`);

  const feedNames = readdirSync(dist).filter((f) =>
    new RegExp(`^${channel}(-[a-z0-9]+)*\\.yml$`).test(f),
  );
  if (feedNames.length === 0)
    fail(
      `no ${channel}*.yml in ${dist}. Was the app packaged with the publish setting in electron-builder.yml?`,
    );

  // Read and check every feed: its version, and that each file it lists is there with that hash.
  const feeds: { name: string; feed: Feed; changed: boolean }[] = [];
  const files = new Set<string>();
  for (const name of feedNames) {
    const feed = parse(await readFile(join(dist, name), "utf8")) as Feed;
    if (feed.version !== version)
      fail(`${name} is for ${feed.version}, but package.json says ${version}. Package again.`);
    let changed = false;
    for (const file of feed.files) {
      const path = join(dist, file.url);
      if (!existsSync(path)) fail(`${name} lists ${file.url}, which isn't in ${dist}.`);
      const hash = await sha512(path);
      if (hash !== file.sha512) {
        // scripts/notarize-dmg.cjs signs and staples each dmg after electron-builder hashed it.
        // Updates download the zip, but the feed should still describe the dmg that's published.
        if (!file.url.endsWith(".dmg")) fail(`${file.url} doesn't match its hash in ${name}.`);
        file.sha512 = hash;
        file.size = statSync(path).size;
        changed = true;
        console.log(
          `Updated ${file.url}'s hash in ${name} (the dmg was signed and stapled after packaging).`,
        );
      }
      files.add(file.url);
      // Differential downloads use a file's blockmap. A dmg's is stale once it's stapled, and
      // updates never download a dmg, so it stays behind.
      if (!file.url.endsWith(".dmg") && existsSync(`${path}.blockmap`))
        files.add(`${file.url}.blockmap`);
    }
    if (feed.path && feed.files[0] && feed.path === feed.files[0].url)
      feed.sha512 = feed.files[0].sha512;
    feeds.push({ name, feed, changed });
  }

  const installers = feeds.flatMap(({ feed }) => feed.files);
  console.log(
    `Version ${version}, channel ${channel}: ${installers.length} installers, their signatures, ${files.size - installers.length} blockmaps and ${feeds.length} feed${feeds.length === 1 ? "" : "s"} (${feedNames.join(", ")}).`,
  );
  if (dryRun) {
    for (const f of files) console.log(`  would upload ${f}`);
    for (const f of installers) console.log(`  would sign and upload ${f.url}.sig`);
    for (const f of feedNames) console.log(`  would upload ${f} last`);
    return;
  }

  // Sign every installer with every key, and check each signature the way the app will, against
  // the keys this version trusts, so a key the app doesn't trust is caught before anything uploads.
  const keys = signingKeys();
  for (const file of installers) {
    const update = { channel, version, file: file.url, sha512: file.sha512 };
    const signatures = keys.map((key) => signUpdate(key, update));
    for (const signature of signatures) {
      const problem = checkSignature(signatureFile([signature]), update);
      if (problem)
        fail(
          `the signature for ${file.url} by key ${signature.key} wouldn't pass in the app (${problem}). Is the right key in use?`,
        );
    }
    await writeFile(join(dist, `${file.url}.sig`), signatureFile(signatures));
    files.add(`${file.url}.sig`);
  }
  const ids = keys.map(keyIdOfPrivateKey);
  const untrusting = Object.keys(UPDATE_KEYS).filter((id) => !ids.includes(id));
  console.log(
    `Signed ${installers.length} installers with ${ids.length === 1 ? "key" : "keys"} ${ids.join(", ")}.${untrusting.length ? ` (Not signed with ${untrusting.join(", ")}, which the app also trusts.)` : ""}`,
  );

  const token = storeToken();
  // A rerun of an older tag, or two tags released at once, mustn't put an older version back in a
  // feed: apps on it would stop seeing the newer release. Checked before anything uploads, and again
  // as each feed is written, which succeeds only if the feed is still the one read.
  for (const { name } of feeds) await storedFeed(token, channel, name, version);
  for (const name of files) await publishOnce(token, channel, dist, name);
  // Feeds last, cached for a minute (the shortest Blob allows), since each release replaces them.
  for (const { name, feed, changed } of feeds) {
    // YAML 1.1, as electron-updater's js-yaml reads it: there an unquoted `releaseDate` would be a Date.
    if (changed) await writeFile(join(dist, name), stringify(feed, { version: "1.1" }));
    const stored = await storedFeed(token, channel, name, version);
    try {
      await upload(token, channel, name, await readFile(join(dist, name)), {
        maxAge: 60,
        overwrite: true,
        ...(stored ? { ifMatch: stored.etag } : {}),
      });
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError)
        fail(`${name} changed while this release ran (another release?). Run it again.`);
      throw error;
    }
    console.log(`Uploaded ${name}.`);
  }

  // Read the feeds back the way installed apps do, and check every hash in them against the bytes
  // uploaded. The CDN can hold an older feed for up to a minute, so this waits for it.
  for (const { name, feed } of feeds) {
    const url = `${SITE}/updates/${channel}/${name}`;
    let problem = "";
    for (let attempt = 0; attempt < 10; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 10_000));
      const response = await fetch(`${url}?release-check=${Date.now()}`, { cache: "no-store" });
      const served = response.ok ? (parse(await response.text()) as Feed | null) : null;
      if (!served) {
        problem = `answered ${response.status}`;
        continue;
      }
      const wrong = feed.files.filter(
        (f) => served.files?.find((s) => s.url === f.url)?.sha512 !== f.sha512,
      );
      problem =
        served.version !== version
          ? `serves version ${served.version}`
          : wrong.length > 0
            ? `has other hashes for ${wrong.map((f) => f.url).join(", ")}`
            : "";
      if (!problem) break;
    }
    if (problem) fail(`${url} ${problem}, after waiting 90 seconds for the CDN.`);
    console.log(`${url} serves ${version}, with the hashes of the uploaded files.`);
  }

  // Differential updates ask for byte ranges, and full downloads for whole files, at the same URL.
  // A CDN in front of the store that cached a 206 under the plain URL would serve a few KB to every
  // later full download (apps/site/vercel.json turns that caching off), so check both answers.
  for (const { feed } of feeds) {
    const file = feed.files[0];
    if (!file?.size) continue;
    const url = `${SITE}/updates/${channel}/${encodeURIComponent(file.url)}`;
    // A file uploaded seconds ago can still be on its way through the CDN: the first plain request
    // came back streamed, without a length (v0.2.0's Linux publish). So this asks again for up to
    // 90 seconds, as the feed check does, and takes the size from the range answer's total when the
    // plain answer carries no length.
    let problem = "";
    for (let attempt = 0; attempt < 7; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 15_000));
      const ranged = await fetch(url, { headers: { Range: "bytes=0-1023" }, cache: "no-store" });
      await ranged.body?.cancel();
      const whole = await fetch(url, { cache: "no-store" });
      await whole.body?.cancel();
      const total = Number(/\/(\d+)$/.exec(ranged.headers.get("content-range") ?? "")?.[1]);
      const length = Number(whole.headers.get("content-length") ?? total);
      problem =
        ranged.status !== 206 || whole.status !== 200 || length !== file.size || total !== file.size
          ? `answers a range with ${ranged.status} (of ${total} bytes) and a plain request with ${whole.status} (${length} bytes), expected ${file.size} bytes`
          : "";
      if (!problem) break;
    }
    if (problem)
      fail(
        `${url} ${problem}, after waiting 90 seconds for the CDN. A cache in front of the store is serving the wrong response.`,
      );
  }
  console.log("Ranged and whole downloads both answer correctly through uplinkroom.com.");
}

try {
  await main();
} catch (error) {
  if (!(error instanceof ReleaseError)) throw error;
  console.error(`release: ${error.message}`);
  process.exitCode = 1;
}
