import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { bounded, formatLine, MAX_FIELDS, MAX_LINE_BYTES, pipeToRotating, RotatingFile } from "./logFile";

const dirs: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "uplink-log-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const at = new Date("2026-11-04T04:34:28.595Z");

test("a line has its time, level and scope, and keeps ids, counts and states", () => {
  expect(formatLine(at, "info", "call", "heartbeats ok", { beats: 16, join: "p57bc86w", final: false })).toBe(
    "2026-11-04T04:34:28.595Z INFO  [call] heartbeats ok beats=16 join=p57bc86w final=false",
  );
});

test("no secret or content reaches the file, whatever a caller passes", () => {
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEyMyJ9.c2lnbmF0dXJlLWhlcmUtbG9uZy1lbm91Z2g";
  const line = formatLine(at, "warn", "call", `joined with ${jwt}`, {
    token: "lk_secret_value",
    body: "meet at the pier at 6",
    url: "wss://uplink-room-8az2pkns.livekit.cloud/rtc?access_token=abc.def.ghi",
    where: "/Users/julio/Library/Application Support/Uplink Room/x.log",
    invite: "uri_0123456789abcdef0123456789abcdef",
    who: "ana@example.com",
    reason: 'Couldn\'t send "the launch codes"',
  }, "/Users/julio");
  expect(line).not.toContain("eyJ");
  expect(line).not.toContain("lk_secret_value");
  expect(line).not.toContain("pier");
  expect(line).not.toContain("access_token");
  expect(line).not.toContain("/Users/julio");
  expect(line).not.toContain("0123456789abcdef");
  expect(line).not.toContain("ana@example.com");
  expect(line).not.toContain("launch codes");
  expect(line).toContain("token=[refused]");
  expect(line).toContain("url=wss://uplink-room-8az2pkns.livekit.cloud/rtc");
  expect(line).toContain('where="~/Library/Application Support/Uplink Room/x.log"');
});

test("the file rotates at its size, keeping four old ones", () => {
  const d = dir();
  const file = new RotatingFile(d, "uplink-room.log", 200, 4);
  for (let i = 0; i < 40; i++) file.write(`line ${i} ${"x".repeat(40)}`);
  expect(readdirSync(d).sort()).toEqual(["uplink-room.log", "uplink-room.log.1", "uplink-room.log.2", "uplink-room.log.3", "uplink-room.log.4"]);
  expect(readFileSync(join(d, "uplink-room.log"), "utf8")).toContain("line 39");
  expect(file.tail(3).at(-1)).toContain("line 39");
});

test("a line keeps at most 20 fields, follows objects 2 deep and stays under 8 KB, saying what it cut", () => {
  const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`f${i}`, i]));
  const line = formatLine(at, "info", "renderer:x", "many fields", many);
  expect(line.match(/ f\d+=/g)).toHaveLength(MAX_FIELDS);
  expect(line).toContain("fieldsDropped=30");
  // Followed 2 deep (and 20 wide), whatever the window sends.
  expect(bounded({ tree: { a: { b: { c: { d: 1 } } } } })).toEqual({ tree: { a: "[…]" } });
  expect(Object.keys(bounded(many) as object)).toHaveLength(MAX_FIELDS);
  // A huge value is cut before it's serialized whole.
  const huge = formatLine(at, "info", "x", "huge", { list: Array.from({ length: 100_000 }, (_, i) => ({ i, pad: "x".repeat(50) })) });
  expect(Buffer.byteLength(huge)).toBeLessThan(MAX_LINE_BYTES);
});

test("one line longer than the file's cap is cut to fit, so no file passes its size", () => {
  const d = dir();
  const file = new RotatingFile(d, "uplink-room.log", 200, 4);
  file.write("x".repeat(5_000));
  file.write("next");
  for (const name of readdirSync(d)) expect(statSync(join(d, name)).size).toBeLessThanOrEqual(200);
  expect(readFileSync(join(d, "uplink-room.log.1"), "utf8")).toContain("…[cut]");
  expect(readFileSync(join(d, "uplink-room.log"), "utf8")).toBe("next\n");
});

test("the bridge's output rotates while the bridge runs, and no file passes its size", async () => {
  const d = dir();
  const file = new RotatingFile(d, "bridge.log", 1_000, 4);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  pipeToRotating(stdout, file);
  pipeToRotating(stderr, file);
  for (let i = 0; i < 60; i++) (i % 2 ? stdout : stderr).write(Buffer.from(`bridge line ${i} ${"y".repeat(40)}\n`));
  // A character split across two chunks arrives whole.
  const euro = Buffer.from("€\n");
  stdout.write(euro.subarray(0, 1));
  stdout.write(euro.subarray(1));
  await new Promise((r) => setImmediate(r));
  const names = readdirSync(d).sort();
  expect(names).toEqual(["bridge.log", "bridge.log.1", "bridge.log.2", "bridge.log.3"]);
  for (const name of names) expect(statSync(join(d, name)).size).toBeLessThanOrEqual(1_000);
  const newest = readFileSync(join(d, "bridge.log"), "utf8");
  expect(newest).toContain("bridge line 59");
  expect(newest.endsWith("€\n")).toBe(true);
});

