import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  UPDATE_KEYS,
  checkSignature,
  keyIdOf,
  keyIdOfPrivateKey,
  sha512OfFile,
  signatureFile,
  signUpdate,
  verifyDownloadedUpdate,
} from "./updateSignature.ts";

/** A throwaway key pair for the tests, trusted here only. */
function testKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x!;
  return {
    secret: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    id: keyIdOf(x),
    x,
  };
}
const key = testKey();
const trusted = { [key.id]: key.x };
const dir = mkdtempSync(join(tmpdir(), "uplink-sig-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("each key the app trusts is listed under its own id", () => {
  for (const [id, x] of Object.entries(UPDATE_KEYS)) expect(keyIdOf(x)).toBe(id);
  expect(keyIdOfPrivateKey(key.secret)).toBe(key.id);
});

test("a signature vouches only for its own channel, file, version and bytes, from a trusted key", () => {
  const expected = {
    channel: "latest",
    version: "0.2.1",
    file: "Uplink-Room-Setup-0.2.1-x64.exe",
    sha512: "abc==",
  };
  const sig = signatureFile([signUpdate(key.secret, expected)]);
  expect(checkSignature(sig, expected, trusted)).toBeNull();
  expect(checkSignature(sig, { ...expected, sha512: "other==" }, trusted)).toMatch(
    /another file or version/,
  );
  expect(checkSignature(sig, { ...expected, version: "9.9.9" }, trusted)).toMatch(
    /another file or version/,
  );
  expect(
    checkSignature(sig, { ...expected, file: "Uplink-Room-0.2.1-linux-x86_64.AppImage" }, trusted),
  ).toMatch(/another file or version/);
  // Signed with a key the app doesn't know: the default list here, which holds only the release key.
  expect(checkSignature(sig, expected)).toMatch(/doesn't trust/);
  // Someone with the feed's write token edits the signature to match a file they made.
  const forged = { ...JSON.parse(sig), sha512: "theirs==" };
  expect(
    checkSignature(JSON.stringify(forged), { ...expected, sha512: "theirs==" }, trusted),
  ).toMatch(/doesn't match/);
  // ...or relabels a signature's channel.
  const relabelled = { ...JSON.parse(sig), channel: "test" };
  expect(
    checkSignature(JSON.stringify(relabelled), { ...expected, channel: "test" }, trusted),
  ).toMatch(/doesn't match/);
  expect(checkSignature(null, expected, trusted)).toMatch(/no signature/);
  expect(checkSignature("", expected, trusted)).toMatch(/no signature/);
  expect(checkSignature("not json", expected, trusted)).toMatch(/one signature per line/);
  expect(checkSignature("x".repeat(70_000), expected, trusted)).toMatch(/too large/);
});

test("a test build's signature doesn't pass in the latest feed, where someone replayed it", () => {
  const update = {
    channel: "test",
    version: "0.2.2-test.1",
    file: "Uplink-Room-0.2.2-test.1-mac-arm64.zip",
    sha512: "abc==",
  };
  const sig = signatureFile([signUpdate(key.secret, update)]);
  expect(checkSignature(sig, update, trusted)).toBeNull();
  // A latest app checks it against its own channel.
  expect(checkSignature(sig, { ...update, channel: "latest" }, trusted)).toMatch(
    /for the test channel/,
  );
});

test("a .sig with one line per key passes on any key the app trusts, so the key can rotate", () => {
  const next = testKey();
  const update = {
    channel: "latest",
    version: "0.3.0",
    file: "Uplink-Room-0.3.0-mac-arm64.zip",
    sha512: "abc==",
  };
  // A release made during the rotation, signed with the old key and the new one.
  const both = signatureFile([signUpdate(key.secret, update), signUpdate(next.secret, update)]);
  expect(both.trim().split("\n")).toHaveLength(2);
  // An app from before the rotation trusts only the old key; one from after trusts only the new.
  expect(checkSignature(both, update, { [key.id]: key.x })).toBeNull();
  expect(checkSignature(both, update, { [next.id]: next.x })).toBeNull();
  // A line from a key the app doesn't trust, or a bad line, doesn't spoil a good one...
  const stranger = testKey();
  const mixed = `not json\n${signatureFile([signUpdate(stranger.secret, update), signUpdate(key.secret, update)])}`;
  expect(checkSignature(mixed, update, trusted)).toBeNull();
  // ...and with no good line, the file's reason is the most telling line's.
  const forged = {
    ...signUpdate(key.secret, update),
    signature: Buffer.alloc(64).toString("base64"),
  };
  const bad = `${signatureFile([signUpdate(stranger.secret, update)])}${JSON.stringify(forged)}\n`;
  expect(checkSignature(bad, update, trusted)).toMatch(/doesn't match/);
});

test("the app checks a downloaded file by its feed entry and the .sig published beside it", async () => {
  const path = join(dir, "temp-download.exe");
  writeFileSync(path, "installer bytes");
  const sha512 = await sha512OfFile(path);
  const files = [
    { url: "Uplink-Room-Setup-0.2.1-arm64.exe", sha512: "arm==" },
    { url: "Uplink-Room-Setup-0.2.1-x64.exe", sha512 },
  ];
  const published = new Map([
    [
      "https://uplinkroom.com/updates/latest/Uplink-Room-Setup-0.2.1-x64.exe.sig",
      signatureFile([
        signUpdate(key.secret, {
          channel: "latest",
          version: "0.2.1",
          file: "Uplink-Room-Setup-0.2.1-x64.exe",
          sha512,
        }),
      ]),
    ],
  ]);
  const options = {
    path,
    channel: "latest",
    version: "0.2.1",
    files,
    feed: "https://uplinkroom.com/updates/latest",
    fetchText: async (url: string) => published.get(url) ?? null,
    keys: trusted,
  };
  expect(await verifyDownloadedUpdate(options)).toEqual({ sha512, reason: null });
  // The same file advertised under a higher version: its signature is for 0.2.1.
  expect((await verifyDownloadedUpdate({ ...options, version: "9.9.9" })).reason).toMatch(
    /another file or version/,
  );
  // The bytes changed after signing: they match no feed entry the signature covers.
  writeFileSync(path, "other bytes");
  expect((await verifyDownloadedUpdate(options)).reason).toMatch(/isn't one the feed lists/);
  // The feed lists the new bytes, but nobody with the key signed them.
  const tampered = [{ url: "Uplink-Room-Setup-0.2.1-x64.exe", sha512: await sha512OfFile(path) }];
  expect((await verifyDownloadedUpdate({ ...options, files: tampered })).reason).toMatch(
    /another file or version/,
  );
  // No .sig published at all.
  expect(
    (await verifyDownloadedUpdate({ ...options, files: tampered, fetchText: async () => null }))
      .reason,
  ).toMatch(/no signature/);
});

test("a signed installer for another platform doesn't install, so a Mac feed served to Linux can't replace the AppImage", async () => {
  const path = join(dir, "update.zip");
  writeFileSync(path, "mac zip bytes");
  const sha512 = await sha512OfFile(path);
  const file = "Uplink-Room-0.2.3-mac-x64.zip";
  const sig = signatureFile([
    signUpdate(key.secret, { channel: "latest", version: "0.2.3", file, sha512 }),
  ]);
  const options = {
    path,
    channel: "latest",
    version: "0.2.3",
    files: [{ url: file, sha512 }],
    feed: "https://uplinkroom.com/updates/latest",
    fetchText: async () => sig,
    keys: trusted,
  };
  expect((await verifyDownloadedUpdate({ ...options, platform: "darwin" })).reason).toBeNull();
  expect((await verifyDownloadedUpdate({ ...options, platform: "linux" })).reason).toMatch(
    /isn't an installer for linux/,
  );
  expect((await verifyDownloadedUpdate({ ...options, platform: "win32" })).reason).toMatch(
    /isn't an installer for win32/,
  );
});
