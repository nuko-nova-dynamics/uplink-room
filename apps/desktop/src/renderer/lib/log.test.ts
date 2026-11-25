// @vitest-environment happy-dom
import { expect, test, vi } from "vitest";

const sent = vi.hoisted(() => [] as unknown[][]);
vi.mock("./desktop", () => ({ desktop: { log: (...args: unknown[]) => sent.push(args) } }));
vi.mock("@sentry/electron/renderer", () => ({ addBreadcrumb: () => {} }));
const { errorFields, log, nameBlob, nameBlobFrames, recentLines, watchBlobScripts } = await import("./log");

test("a line goes to the main process scrubbed, and stays in memory for Copy diagnostics", () => {
  log.warn("call", "heartbeat failed", { failures: 2, token: "lk_abcdefghijklmnopqrstuvwxyz", where: "wss://x.livekit.cloud/rtc?access_token=abc" });
  const [level, scope, message, fields] = sent.at(-1)!;
  expect([level, scope, message]).toEqual(["warn", "call", "heartbeat failed"]);
  expect(fields).toEqual({ failures: 2, token: "[refused]", where: "wss://x.livekit.cloud/rtc" });
  expect(recentLines().at(-1)).toMatchObject({ level: "warn", scope: "call", message: "heartbeat failed" });
});

test("an error in a log line keeps its class, and a message only when it has nothing to template: the window doesn't know the environment", () => {
  // UPLINK-ROOM-DESKTOP-3, as the window's error event gives it: a safe message, but with quoted
  // parts, so only the class goes in the log (the error report gets the template, from main).
  const wasm = Object.assign(new Error("WebAssembly.Module(): Compiling or instantiating WebAssembly module violates the following Content Security policy directive because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: \"script-src 'self'\"."), { name: "CompileError" });
  expect(errorFields(wasm)).toEqual({ type: "CompileError", reason: "(message not sent)" });
  // A template made here would keep `pass-<n>-otter-blue`, which main's redaction no longer matches.
  expect(errorFields(new Error("Krisp: failed to load model pass-2024-otter-blue")).reason).toBe("(message not sent)");
  expect(errorFields(new Error("Unable to load a worklet's module."))).toEqual({ type: "Error", reason: "Unable to load a worklet's module." });
  const content = errorFields(new Error("Couldn't post 'see you at the pier'"));
  expect(content.type).toBe("Error");
  expect(content.reason).toBe("(message not sent)");
  expect(errorFields(new TypeError("Cannot read properties of undefined (reading 'x')")).reason).toContain("Cannot read properties of undefined");
});

test("a blob script is named by the bundle that made it, in log lines and report frames", () => {
  watchBlobScripts();
  const make = new Function("URL", "Blob", "return URL.createObjectURL(new Blob(['1'], { type: 'application/javascript' }))") as (u: typeof URL, b: typeof Blob) => string;
  const url = make(URL, Blob);
  expect(url.startsWith("blob:")).toBe(true);
  // happy-dom's stack has no bundle URL, so the bundle is unknown here; in the app it's `assets/dist-<hash>.js`.
  expect(nameBlob(url)).toMatch(/^app:\/\/\/blob\//);
  const event = { exception: { values: [{ stacktrace: { frames: [{ filename: url, in_app: true }, { filename: "uplink-room://app/assets/index.js", in_app: true }] } }] } };
  const named = nameBlobFrames(event).exception.values[0]!.stacktrace.frames;
  expect(named[0]).toEqual({ filename: nameBlob(url), in_app: false });
  expect(named[1]).toEqual({ filename: "uplink-room://app/assets/index.js", in_app: true });
});
