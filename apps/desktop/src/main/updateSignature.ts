import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";

/**
 * Update signatures (docs/releases.md, "Update signatures"). Every installer the release script
 * publishes gets a detached `<file>.sig` beside it, signed with the Ed25519 release key, and the app
 * refuses an update whose signature doesn't check out against a key below. The key is separate from
 * the Blob store's write token, so access to the store alone can't ship code. Windows installers
 * aren't Authenticode-signed yet and the AppImage has no signature of its own, so this is what
 * stands between the feed and the install there; macOS also has Squirrel.Mac's Developer ID check.
 *
 * A `.sig` file holds one signature per line, one per release key, so a release can be signed with
 * an old and a new key while the key is rotated. The app accepts the file when any line is a valid
 * signature, by a key it trusts, for this channel, version, file and sha512.
 *
 * Shared by the app (main process) and scripts/release.ts, so both sign and check the same message.
 */

/** Keys the app accepts, by id. To rotate, add the new key here first and ship that (docs/releases.md). */
export const UPDATE_KEYS: Readonly<Record<string, string>> = {
  // Created 2026-11-03. Private half: GitHub secret UPDATES_SIGNING_KEY and the release Mac's login keychain.
  "40fad3ee746fa476": "uWWs5lcYnI2RO5VqKomstq-HfvKHcQoKG-dyvE2XIuU",
};

/** The update a signature vouches for. `channel` is the feed folder it was released to (latest, test). */
export type SignedUpdate = { channel: string; version: string; file: string; sha512: string };

/** One line of a `.sig` file. */
export type UpdateSignature = SignedUpdate & {
  format: "uplink-room-update-signature";
  v: 2;
  key: string;
  signature: string;
};

/** A `.sig` file larger than this isn't read: a real one is a few hundred bytes per key. */
const MAX_SIG_BYTES = 64 * 1024;

/**
 * What's signed: the channel, the version, the file's name and its sha512 (base64, as in the feed),
 * so a signature can't be moved to another file, version or channel (a test build replayed into
 * the latest feed carries a `test` signature, which a latest app refuses).
 */
export function signedMessage(update: SignedUpdate): Buffer {
  const { channel, version, file, sha512 } = update;
  return Buffer.from(
    `uplink-room-update-signature/v2\n${channel}\n${version}\n${file}\n${sha512}\n`,
    "utf8",
  );
}

/** A key's id: the first 8 bytes of the sha256 of its raw public key, in hex. */
export function keyIdOf(publicKey: string): string {
  return createHash("sha256")
    .update(Buffer.from(publicKey, "base64url"))
    .digest("hex")
    .slice(0, 16);
}

function privateKeyOf(privateKey: string) {
  return createPrivateKey({ key: Buffer.from(privateKey, "base64"), format: "der", type: "pkcs8" });
}

/** The id of a private key's public half. `privateKey` is the pkcs8 DER key in base64. */
export function keyIdOfPrivateKey(privateKey: string): string {
  return keyIdOf(createPublicKey(privateKeyOf(privateKey)).export({ format: "jwk" }).x ?? "");
}

/** Signs one file. `privateKey` is the pkcs8 DER key in base64 (one of UPDATES_SIGNING_KEY's keys). */
export function signUpdate(privateKey: string, update: SignedUpdate): UpdateSignature {
  const key = privateKeyOf(privateKey);
  const { channel, version, file, sha512 } = update;
  return {
    format: "uplink-room-update-signature",
    v: 2,
    key: keyIdOfPrivateKey(privateKey),
    channel,
    version,
    file,
    sha512,
    signature: sign(null, signedMessage(update), key).toString("base64"),
  };
}

/** A `.sig` file's text: one signature per line. */
export function signatureFile(signatures: readonly UpdateSignature[]): string {
  return signatures.map((s) => `${JSON.stringify(s)}\n`).join("");
}

/**
 * Why one line doesn't vouch for the update, or null when it does. Ranked: a higher rank is the
 * more telling reason, and the file's reason is its best-ranked line's.
 */
function checkLine(
  line: string,
  expected: SignedUpdate,
  keys: Readonly<Record<string, string>>,
): { reason: string; rank: number } | null {
  let sig: Partial<UpdateSignature>;
  try {
    sig = JSON.parse(line) as Partial<UpdateSignature>;
  } catch {
    return { reason: "the signature file isn't one signature per line", rank: 0 };
  }
  if (sig?.format !== "uplink-room-update-signature" || sig.v !== 2)
    return { reason: "not an update signature", rank: 1 };
  if (sig.channel !== expected.channel)
    return { reason: `the signature is for the ${String(sig.channel)} channel`, rank: 3 };
  if (
    sig.version !== expected.version ||
    sig.file !== expected.file ||
    sig.sha512 !== expected.sha512
  )
    return { reason: "the signature is for another file or version", rank: 3 };
  const publicKey = typeof sig.key === "string" ? keys[sig.key] : undefined;
  if (!publicKey) return { reason: "signed with a key the app doesn't trust", rank: 2 };
  if (typeof sig.signature !== "string") return { reason: "no signature value", rank: 4 };
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
  const ok = verify(null, signedMessage(expected), key, Buffer.from(sig.signature, "base64"));
  return ok ? null : { reason: "the signature doesn't match", rank: 4 };
}

/** Why a `.sig` file doesn't vouch for this update, or null when one of its lines does. */
export function checkSignature(
  text: string | null,
  expected: SignedUpdate,
  keys: Readonly<Record<string, string>> = UPDATE_KEYS,
): string | null {
  if (text == null) return "no signature published";
  if (text.length > MAX_SIG_BYTES) return "the signature file is too large";
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "no signature published";
  let worst: { reason: string; rank: number } | null = null;
  for (const line of lines) {
    const problem = checkLine(line, expected, keys);
    if (!problem) return null;
    if (!worst || problem.rank > worst.rank) worst = problem;
  }
  return worst?.reason ?? "no signature published";
}

/** electron-builder's hash of a file: sha512, base64. */
export function sha512OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha512");
    createReadStream(path)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("base64")));
  });
}

/**
 * The kind of file each platform's updater installs. A feed can list another platform's files (a
 * Mac feed put where the Linux feed belongs), and their signatures are valid, so the platform has to
 * be checked too: on Linux electron-updater falls back to a zip when the feed has no AppImage, and
 * deletes the installed AppImage before it finds the zip won't run.
 */
const INSTALLER_SUFFIX: Readonly<Record<string, string>> = {
  darwin: ".zip",
  win32: ".exe",
  linux: ".AppImage",
};

/**
 * Checks a downloaded update file in the app: finds it in the feed by its sha512 (electron-updater
 * already checked the bytes against that, or found a cached file with that sha512), fetches
 * `<feed>/<file>.sig`, and checks it against the channel and the version the feed offers. Resolves
 * to the file's sha512 and null when the update may install, or the reason it may not. With
 * `platform`, the file must also be the kind that platform installs.
 */
export async function verifyDownloadedUpdate(options: {
  path: string;
  channel: string;
  version: string;
  files: readonly { url: string; sha512?: string }[];
  feed: string;
  fetchText: (url: string) => Promise<string | null>;
  keys?: Readonly<Record<string, string>>;
  platform?: string;
}): Promise<{ sha512: string; reason: string | null }> {
  const sha512 = await sha512OfFile(options.path);
  const entry = options.files.find((f) => f.sha512 === sha512);
  if (!entry) return { sha512, reason: "the downloaded file isn't one the feed lists" };
  const file = basename(entry.url);
  if (options.platform !== undefined) {
    const suffix = INSTALLER_SUFFIX[options.platform];
    if (!suffix || !file.endsWith(suffix))
      return { sha512, reason: `${file} isn't an installer for ${options.platform}` };
  }
  const text = await options.fetchText(`${options.feed}/${encodeURIComponent(file)}.sig`);
  const { channel, version } = options;
  return { sha512, reason: checkSignature(text, { channel, version, file, sha512 }, options.keys) };
}
