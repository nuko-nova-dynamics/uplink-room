import { hostname } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import * as Sentry from "@sentry/node";
import {
  MESSAGE_REMOVED,
  safeMessage,
  templateOf,
  scrubEvent,
  scrubOptions,
  telemetryDisabled,
} from "../src/telemetry/scrub.ts";
import { telemetryOptions } from "../src/telemetry/sentry.ts";

// What must never reach Sentry, one of each kind.
const TERMINAL = "drwxr-x--- secret-project terminal-output-7f3a";
const FILE = "file-contents-of-notes-md";
const TRANSCRIPT = "we agreed to ship on friday transcript-line";
const MESSAGE = "message-body-hey-team-the-db-password";
const AGENT_KEY = `urk_${"ab12".repeat(12)}`;
const BRIDGE_TOKEN = `ubt_${"cd34".repeat(16)}`;
// A thread run's key (ADR 0037): base64url, so it can hold `-` and `_` anywhere.
const RUN_KEY = `urt_${"x-_9".repeat(8)}`;
const CLERK_JWT =
  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyXzJhYmMiLCJzaWQiOiJzZXNzXzEyMyJ9.c2lnbmF0dXJlLXBhcnQ";
const ENV_VALUE = "env-value-only-in-this-process-91c2";
const EMAIL = "julio@example.com";
const MEMBER_ID = "k57abc0123456789member";

const FORBIDDEN = [
  TERMINAL,
  FILE,
  TRANSCRIPT,
  MESSAGE,
  AGENT_KEY,
  BRIDGE_TOKEN,
  RUN_KEY,
  CLERK_JWT,
  ENV_VALUE,
  EMAIL,
];

function expectClean(sent: string) {
  for (const value of FORBIDDEN) expect(sent).not.toContain(value);
  // Pieces of the JWT and keys must not survive either.
  expect(sent).not.toContain("eyJhbGciOi");
  expect(sent).not.toContain("ab12ab12ab12");
}

describe("scrubEvent", () => {
  it("keeps the error's type, place and member id, and none of the content", () => {
    const event = {
      event_id: "0123456789abcdef0123456789abcdef",
      level: "error",
      release: "uplink-room-bridge@0.1.0",
      sdk: { name: "sentry.javascript.node", version: "11.10.0" },
      message: `Couldn't send ${MESSAGE}`,
      server_name: "julios-macbook",
      user: { id: MEMBER_ID, email: EMAIL, ip_address: "203.0.113.7", username: "julio" },
      extra: { transcript: TRANSCRIPT, file: FILE },
      tags: { "event.process": "renderer", leaked: `Bearer ${CLERK_JWT}` },
      contexts: {
        os: { name: "macOS", version: "26.1" },
        device: { arch: "arm64", name: "Julio's MacBook" },
        trace: {
          trace_id: "1b8808d0721b4e82a27cb67834ed90ac",
          span_id: "bce7c64ccd13bb84",
          data: { body: MESSAGE },
        },
        react: { componentStack: MESSAGE },
        message: { body: MESSAGE },
      },
      request: {
        url: `uplink-room://app/index.html?__clerk_db_jwt=${CLERK_JWT}#terminal`,
        headers: { Authorization: `Bearer ${CLERK_JWT}` },
        cookies: { __session: CLERK_JWT },
        data: MESSAGE,
      },
      exception: {
        values: [
          {
            type: "SyntaxError",
            value: `Unexpected token 'x', "${FILE}" is not valid JSON (key ${AGENT_KEY}, run key ${RUN_KEY}, token ${BRIDGE_TOKEN}, env ${ENV_VALUE}, ${EMAIL}, code K7QX-2MPD)`,
            mechanism: { type: "onunhandledrejection", handled: false, data: { input: TERMINAL } },
            stacktrace: {
              frames: [
                {
                  filename: "app:///out/main/index.js",
                  function: "parseNote",
                  lineno: 12,
                  colno: 34,
                  in_app: true,
                  pre_context: [FILE],
                  context_line: `JSON.parse("${FILE}")`,
                  post_context: [TERMINAL],
                  vars: { note: FILE, line: TERMINAL },
                },
                {
                  filename: "/Users/julio/.uplink/dist/uplink-bridge.mjs",
                  function: "run",
                  lineno: 3,
                  colno: 9,
                  in_app: true,
                },
              ],
            },
          },
        ],
      },
      debug_meta: {
        images: [
          {
            type: "sourcemap",
            code_file: "/Users/julio/.uplink/dist/uplink-bridge.mjs",
            debug_id: "6a5ec205-7776-4a64-8191-36697f3ad7b8",
          },
        ],
      },
      breadcrumbs: [
        { category: "console", level: "log", message: TERMINAL },
        { category: "ui.input", message: `textarea[value="${MESSAGE}"]` },
        { category: "ui.click", message: `button[title="${FILE}"]` },
        { category: "electron", message: "browser-window.focus", data: { ipc: TRANSCRIPT } },
        {
          category: "fetch",
          type: "http",
          data: {
            method: "POST",
            url: `https://x.convex.cloud/api/mutation?token=${BRIDGE_TOKEN}`,
            body: MESSAGE,
            status_code: 500,
          },
        },
        {
          category: "navigation",
          data: { from: `uplink-room://app/#/files?q=${FILE}`, to: "uplink-room://app/#/inbox" },
        },
      ],
    };

    event.exception.values.push({
      type: "Error",
      value: `Couldn't save ${FILE} for ${TERMINAL}`,
      mechanism: { type: "generic", handled: true, data: { input: TERMINAL } },
      stacktrace: { frames: [] },
    });
    const scrubbed = scrubEvent(event, scrubOptions({ SECRET: ENV_VALUE, HOME: "/Users/julio" }));
    const sent = JSON.stringify(scrubbed);

    expectClean(sent);
    expect(sent).not.toContain("julios-macbook");
    expect(sent).not.toContain("Julio's MacBook");
    expect(sent).not.toContain("203.0.113.7");
    expect(sent).not.toContain("K7QX-2MPD");
    expect(scrubbed.user).toEqual({ id: MEMBER_ID });
    // The home folder (a user name) goes, the same way in frames and debug images, so Sentry still
    // matches each frame to its source map.
    expect(sent).not.toContain("/Users/julio");
    expect(scrubbed.sdk).toEqual({
      name: "sentry.javascript.node",
      version: "11.10.0",
      settings: { infer_ip: "never" },
    });
    expect(scrubbed.debug_meta.images[0]?.code_file).toBe(
      "app:///~/.uplink/dist/uplink-bridge.mjs",
    );
    expect(scrubbed.message).toBe(MESSAGE_REMOVED);
    // An engine error keeps its message, redacted; any other error keeps only its type.
    expect(scrubbed.exception.values[0]?.value).toMatch(
      /^Unexpected token '\[redacted\]', "\[redacted\]" is not valid JSON/,
    );
    expect(scrubbed.exception.values[1]).toMatchObject({ type: "Error" });
    expect(scrubbed.exception.values[1]?.value).toBe(MESSAGE_REMOVED);
    expect(scrubbed).not.toHaveProperty("extra");
    expect(scrubbed).not.toHaveProperty("server_name");
    expect(scrubbed.request).toEqual({ url: "uplink-room://app/index.html" });
    expect(scrubbed.contexts).toEqual({
      os: { name: "macOS", version: "26.1" },
      device: { arch: "arm64" },
      trace: { trace_id: "1b8808d0721b4e82a27cb67834ed90ac", span_id: "bce7c64ccd13bb84" },
    });
    expect(scrubbed.exception.values[0]).toMatchObject({
      type: "SyntaxError",
      stacktrace: {
        frames: [
          {
            filename: "app:///out/main/index.js",
            function: "parseNote",
            lineno: 12,
            colno: 34,
            in_app: true,
          },
          {
            filename: "app:///~/.uplink/dist/uplink-bridge.mjs",
            function: "run",
            lineno: 3,
            colno: 9,
            in_app: true,
          },
        ],
      },
    });
    expect(scrubbed.breadcrumbs.map((b) => b.category)).toEqual([
      "electron",
      "fetch",
      "navigation",
    ]);
    expect(scrubbed.breadcrumbs[1]?.data).toEqual({
      method: "POST",
      url: "https://x.convex.cloud/api/mutation",
      status_code: 500,
    });
  });
});

describe("parse errors", () => {
  // Node's own messages: V8 quotes the input without escaping it, and cuts a long one short.
  const parseError = (input: string) => {
    try {
      JSON.parse(input);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error("parsed");
  };

  it.each([
    ["embedded double quotes", 'my "secret" message'],
    ["embedded single quotes", `it's 'secret' text`],
    ["a cut-off excerpt", `{"note": "secret ${TERMINAL} and a long tail that V8 cuts short"`],
    ["a lone quote", `"secret`],
  ])("keep none of the input with %s", (_name, input) => {
    const message = parseError(input);
    const scrubbed = scrubEvent({
      exception: { values: [{ type: "SyntaxError", value: message }] },
    });
    const value = scrubbed.exception.values[0]?.value ?? "";
    expect(value).not.toContain("secret");
    expect(value).not.toContain(TERMINAL.slice(0, 12));
    expect(value).toMatch(/JSON/);
  });
});

describe("the bridge's Sentry options", () => {
  afterEach(async () => {
    await Sentry.close();
  });

  it("send an error report that holds none of the content", async () => {
    const sent: unknown[] = [];
    const env = { ...process.env, UPLINK_TEST_SECRET: ENV_VALUE };
    Sentry.init(
      telemetryOptions(
        "https://public@o0.ingest.sentry.io/0",
        "uplink-room-bridge@0.0.0-test",
        env,
        {
          transport: () => ({
            send: async (envelope) => {
              sent.push(envelope);
              return {};
            },
            flush: async () => true,
          }),
          // The process-wide crash handlers stay out of the test runner.
          integrations: [Sentry.linkedErrorsIntegration(), Sentry.nodeContextIntegration()],
        },
      ),
    );
    Sentry.setUser({ id: MEMBER_ID, email: EMAIL, ip_address: "203.0.113.7" });
    Sentry.setExtra("transcript", TRANSCRIPT);
    Sentry.setContext("message", { body: MESSAGE });
    Sentry.addBreadcrumb({ category: "console", message: TERMINAL });
    Sentry.addBreadcrumb({ category: "ui.input", message: MESSAGE });

    let error: unknown;
    try {
      JSON.parse(`${FILE} ${AGENT_KEY}`);
    } catch (caught) {
      error = caught;
    }
    Sentry.captureException(error);
    Sentry.captureException(
      new Error(`Bad terminal ${TERMINAL} with ${BRIDGE_TOKEN}, ${CLERK_JWT}, ${ENV_VALUE}`),
    );
    Sentry.captureMessage(`Sent ${MESSAGE} to ${EMAIL}`);
    await Sentry.flush(2000);

    const body = JSON.stringify(sent);
    expect(sent.length).toBe(3);
    expectClean(body);
    expect(body).not.toContain(hostname());
    expect(body).not.toContain("203.0.113.7");
    expect(body).toContain('"infer_ip":"never"');
    expect(body).toContain(MEMBER_ID);
    expect(body).toContain("SyntaxError");
    expect(body).toContain('"type":"Error"');
    // The stack still points at this file.
    expect(body).toContain("scrub.test.ts");
  });
});

describe("telemetryDisabled", () => {
  it("is on unless UPLINK_NO_TELEMETRY or DO_NOT_TRACK says otherwise", () => {
    expect(telemetryDisabled({})).toBe(false);
    expect(telemetryDisabled({ UPLINK_NO_TELEMETRY: "0" })).toBe(false);
    expect(telemetryDisabled({ UPLINK_NO_TELEMETRY: "1" })).toBe(true);
    expect(telemetryDisabled({ DO_NOT_TRACK: "1" })).toBe(true);
  });
});

describe("error messages", () => {
  const krisp =
    "Uncaught CompileError: WebAssembly.Module(): Compiling or instantiating WebAssembly module violates the following Content Security policy directive because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: \"script-src 'self' 'unsafe-inline' blob: https://clerk.uplinkroom.com\".";

  it("keeps a library message on the safe list as its template, and the class Sentry lost", () => {
    // UPLINK-ROOM-DESKTOP-3: Krisp's WebAssembly refused by the app's policy, from a page error event without an error object.
    // From the window, through the main process (which knows the environment: here, no values).
    const event = { exception: { values: [{ type: "Error", value: krisp, mechanism: { type: "onerror", synthetic: true } }] } };
    const sent = scrubEvent(scrubEvent(event, { messagesLater: true }), { envValues: [] }).exception!.values![0]!;
    expect(sent.type).toBe("CompileError");
    expect(sent.value).toBe(
      "WebAssembly.Module(): Compiling or instantiating WebAssembly module violates the following Content Security policy directive because <q> is not an allowed source of script in the following Content Security Policy directive: <q>.",
    );
  });

  it("sends nothing derived from any other message: no text, no hash a guess could be checked against", () => {
    for (const message of ["Couldn't send \"meet at 6 by the pier\" to 3 people", "yes", "Couldn't save the file"]) {
      expect(safeMessage("Error", message)).toBe(MESSAGE_REMOVED);
    }
  });

  it("takes environment values out before it makes a template, so a safe message can't keep one", () => {
    // Templating turns the 2024 into <n>, so a value redacted only afterwards would no longer match
    // and its other words would go out.
    const value = "pass-2024-otter-blue";
    const sent = safeMessage("Error", `Krisp: failed to load model ${value}`, [value]);
    expect(sent.startsWith("Krisp: failed to load model")).toBe(true);
    expect(sent).not.toContain("otter");
    expect(safeMessage("TypeError", `Cannot read ${value}`, [value])).not.toContain(value);
  });

  it("templates a window's message once, in the main process, after its environment values are out", () => {
    // The window doesn't know the environment: had it made the template, `pass-<n>-otter-blue`
    // would reach the main process, where no redaction matches it any more.
    const value = "pass-2024-otter-blue";
    const event = { exception: { values: [{ type: "Error", value: `Krisp: failed to load model ${value}` }] } };
    const fromWindow = scrubEvent(event, { messagesLater: true });
    const sent = scrubEvent(fromWindow, { envValues: [value] }).exception!.values![0]!.value!;
    expect(sent.startsWith("Krisp: failed to load model")).toBe(true);
    expect(sent).not.toContain("otter");
    // Where the environment isn't known and nothing scrubs after it, a message with variable parts isn't sent.
    expect(scrubEvent(event).exception!.values![0]!.value).toBe(MESSAGE_REMOVED);
    expect(safeMessage("Error", `Krisp: failed to load model ${value}`)).toBe(MESSAGE_REMOVED);
    // A safe message with nothing to template is kept there.
    expect(safeMessage("TypeError", "Failed to fetch")).not.toBe(MESSAGE_REMOVED);
    expect(safeMessage("Error", "Unable to load a worklet's module.")).toBe("Unable to load a worklet's module.");
  });

  it("makes templates without quoted text, numbers, ids, URLs or emails", () => {
    expect(templateOf("Join p57bc86wbbgk1h94n7r3c8m56n8hj6j0 failed after 3 tries at https://x.convex.cloud/a?t=1 for ana@example.com")).toBe(
      "Join <id> failed after <n> tries at <url> for <email>",
    );
  });
});

