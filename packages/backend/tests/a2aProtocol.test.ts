import { afterEach, expect, test } from "vitest";
import { cardUrlFor, INSECURE_PEERS_ENV, isBlockedAddress } from "../convex/lib/a2a/peerUrl";
import { createSseParser, parseCard, stream } from "../convex/lib/a2a/protocol";
import { redact, redactor } from "../convex/lib/a2a/redact";
import {
  coalesceArtifacts,
  fromStreamResult,
  mergeArtifacts,
  roomStateFor,
} from "../convex/lib/a2a/observe";

const insecure = process.env[INSECURE_PEERS_ENV];
afterEach(() => {
  process.env[INSECURE_PEERS_ENV] = insecure;
});

test("in production only public https addresses are accepted, and a bare address means its well-known card", () => {
  delete process.env[INSECURE_PEERS_ENV];
  expect(cardUrlFor("https://hermes.example.com:9900")).toBe(
    "https://hermes.example.com:9900/.well-known/agent-card.json",
  );
  expect(cardUrlFor("https://claw.example.com/a2a/v1")).toBe(
    "https://claw.example.com/.well-known/agent-card.json",
  );
  expect(cardUrlFor("https://claw.example.com/cards/claw.json")).toBe(
    "https://claw.example.com/cards/claw.json",
  );
  for (const url of [
    "http://hermes.example.com",
    "https://localhost:9900",
    "https://127.0.0.1",
    "https://10.0.0.4",
    "https://100.101.1.2",
    "https://[::1]:9900",
    "https://julio-mbp.local",
  ]) {
    expect(() => cardUrlFor(url), url).toThrow();
  }
});

test("a spec-shaped 1.0 card is read: the first JSON-RPC interface, streaming, and a bearer requirement", () => {
  const card = parseCard(
    {
      name: "Hermes",
      description: "d",
      version: "1",
      supportedInterfaces: [
        { url: "https://h.example.com/grpc", protocolBinding: "GRPC", protocolVersion: "1.0" },
        {
          url: "https://h.example.com/",
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
          tenant: "julio",
        },
      ],
      capabilities: { streaming: true },
      securitySchemes: {
        peer: { httpAuthSecurityScheme: { scheme: "Bearer" } },
        key: { apiKeySecurityScheme: { location: "header", name: "X-Key" } },
      },
      securityRequirements: [{ schemes: { peer: { list: [] } } }],
      defaultInputModes: [],
      defaultOutputModes: [],
      skills: [],
    },
    "https://h.example.com/.well-known/agent-card.json",
  );
  expect(card).toMatchObject({
    endpoint: { url: "https://h.example.com/", tenant: "julio" },
    streaming: true,
    needsCredential: true,
    security: [
      { name: "peer", kind: "bearer" },
      { name: "key", kind: "header", detail: "X-Key" },
    ],
  });
});

test("an honest A2A 0.3 card is read from its own fields, Hermes's card as 1.0, and A2A 0.2 is refused", () => {
  const at = "https://h.example.com/.well-known/agent-card.json";
  // A 0.3 card names its endpoint at the top, served over preferredTransport (JSON-RPC when absent).
  expect(
    parseCard({ name: "Old", url: "https://h.example.com/a2a", protocolVersion: "0.3.0" }, at),
  ).toMatchObject({ protocolVersion: "0.3.0", endpoint: { url: "https://h.example.com/a2a" } });
  expect(
    parseCard(
      {
        name: "Old",
        url: "https://h.example.com/grpc",
        preferredTransport: "GRPC",
        additionalInterfaces: [{ url: "https://h.example.com/rpc", transport: "JSONRPC" }],
        protocolVersion: "0.3.0",
        securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
        security: [{ bearer: [] }],
      },
      at,
    ),
  ).toMatchObject({
    endpoint: { url: "https://h.example.com/rpc" },
    needsCredential: true,
    security: [{ name: "bearer", kind: "bearer" }],
  });
  // The card Icarus serves (Hermes's build_agent_card): 1.0 interfaces, a 0.3-style url and security.
  expect(
    parseCard(
      {
        name: "Icarus",
        url: "https://h.example.com/",
        version: "1.0.0",
        supportedInterfaces: [
          { url: "https://h.example.com/", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
        ],
        capabilities: { streaming: true, pushNotifications: true },
        securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
        security: [{ bearer: [] }],
      },
      at,
    ),
  ).toMatchObject({ protocolVersion: "1.0", streaming: true, needsCredential: true });
  expect(() =>
    parseCard({ name: "Older", url: "https://h.example.com/", protocolVersion: "0.2.6" }, at),
  ).toThrow(/A2A 0\.2\.6; the room needs A2A 1\.0 or 0\.3/);
  expect(() =>
    parseCard(
      { name: "Old", url: "https://h.example.com/", preferredTransport: "GRPC", protocolVersion: "0.3.0" },
      at,
    ),
  ).toThrow(/only over GRPC/);
});

test("observations are bounded and keep only http(s) links", () => {
  const long = "x".repeat(10_000);
  const obs = fromStreamResult({
    artifactUpdate: {
      taskId: "t",
      contextId: "c",
      artifact: {
        artifactId: "a",
        parts: [
          { text: long },
          { url: "javascript:alert(1)" },
          { url: "https://example.com/r" },
          { data: { big: true } },
        ],
      },
    },
  });
  expect(obs?.artifacts?.[0]).toMatchObject({
    urls: ["https://example.com/r"],
    hasData: true,
    truncated: true,
  });
  expect(obs!.artifacts![0]!.text!.length).toBeLessThanOrEqual(4_000);
  expect(roomStateFor("TASK_STATE_UNSPECIFIED", "Hermes", undefined)).toEqual({ state: "unknown" });
});

test("blocked addresses: private, loopback, link-local, metadata, and IPv4 hidden in IPv6", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.100.100.200",
    "168.63.129.16",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "::",
    "::1",
    "::ffff:7f00:1",
    "::ffff:127.0.0.1",
    "::ffff:a9fe:a9fe",
    "64:ff9b::7f00:1",
    "2002:7f00:1::",
    "fc00::1",
    "fd00:ec2::254",
    "fe80::1",
    "fe80::1%en0",
    "ff02::1",
    "2001:db8::1",
    "::127.0.0.1",
  ]) {
    expect(isBlockedAddress(ip), ip).toBe(true);
  }
  for (const ip of [
    "93.184.216.34",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "::ffff:5db8:d822",
    "64:ff9b::5db8:d822",
  ]) {
    expect(isBlockedAddress(ip), ip).toBe(false);
  }
});

test("registration refuses literal private addresses in any IPv6 spelling, and the deployment's own hosts", () => {
  delete process.env[INSECURE_PEERS_ENV];
  for (const url of [
    "https://[::ffff:7f00:1]/",
    "https://[::ffff:127.0.0.1]",
    "https://[fe80::1]",
    "https://[fd00:ec2::254]",
    "https://[64:ff9b::a9fe:a9fe]",
    "https://169.254.169.254",
    "https://focused-fish-459.convex.cloud",
    "https://focused-fish-459.convex.site/x",
  ]) {
    expect(() => cardUrlFor(url), url).toThrow();
  }
  process.env[INSECURE_PEERS_ENV] = "1";
  // Even for development, the room never calls its own deployment.
  expect(() => cardUrlFor("https://focused-fish-459.convex.site")).toThrow();
});

test("SSE events split anywhere, including between CR and LF, parse the same", () => {
  const stream = 'data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n';
  for (let cut = 1; cut < stream.length; cut++) {
    const parser = createSseParser();
    const events = [...parser.push(stream.slice(0, cut)), ...parser.push(stream.slice(cut))];
    expect(events, `cut at ${cut}`).toEqual(['{"a":1}', '{"b":2}']);
  }
});

test("coalescing stream chunks keeps each artifact's append, so stored text is extended", () => {
  const stored = [
    { artifactId: "a", text: "a1", urls: [] },
    { artifactId: "b", text: "b1", urls: [] },
  ];
  const batch = coalesceArtifacts(
    coalesceArtifacts([], [{ artifactId: "a", text: "a2", urls: [], append: true }]),
    [
      { artifactId: "b", text: "b2", urls: [], append: true },
      { artifactId: "a", text: "a3", urls: [], append: true },
    ],
  );
  expect(mergeArtifacts(stored, batch, false).map((a) => a.text)).toEqual(["a1a2a3", "b1b2"]);
  // A replacement in the batch still replaces.
  const replaced = coalesceArtifacts(
    [{ artifactId: "a", text: "x", urls: [], append: true }],
    [{ artifactId: "a", text: "new", urls: [] }],
  );
  expect(mergeArtifacts(stored, replaced, false)[0]!.text).toBe("new");
});

test("a last event ended by CR-only line breaks is not lost at the end of the stream", async () => {
  const parser = createSseParser();
  expect(parser.push('data: {"a":1}\r\r')).toEqual([]);
  expect(parser.end()).toEqual(['{"a":1}']);

  const event = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { message: { messageId: "m", parts: [{ text: "hi" }] } },
  });
  const transport = async () =>
    new Response(`data: ${event}\r\r`, { headers: { "content-type": "text/event-stream" } });
  const results: unknown[] = [];
  for await (const r of stream(
    transport,
    { url: "https://a.example.com/" },
    null,
    "SendStreamingMessage",
    {},
    new AbortController().signal,
    1000,
  )) {
    results.push(r);
  }
  expect(results).toEqual([{ message: { messageId: "m", parts: [{ text: "hi" }] } }]);
});

test("redaction takes the token out in every spelling an agent might echo, and caps the length", () => {
  const bearer = { kind: "bearer" as const, secret: "tok/en+value=1" };
  const echoed = `bad: ${JSON.stringify({ authorization: "Bearer tok/en+value=1", accept: "x" })} raw tok/en+value=1 in a link ?t=${encodeURIComponent("tok/en+value=1")}`;
  const out = redact(echoed, bearer);
  expect(out).not.toContain("tok/en+value=1");
  expect(out).not.toContain(encodeURIComponent("tok/en+value=1"));
  expect(out).toContain('"authorization":"[redacted]","accept":"x"');
  // A named header's value, and any bearer token, even one that isn't the room's.
  const header = { kind: "header" as const, name: "X-Gateway-Key", secret: "k3y-value-9" };
  expect(redact("x-gateway-key: something-else; next", header)).toBe("x-gateway-key: [redacted]; next");
  expect(redact("Authorization: Bearer someone-elses-token", null)).toBe("Authorization: [redacted]");
  expect(redact("got Bearer eyJhbGciOiJIUzI1NiJ9.e30.c2ln back", null)).toBe("got Bearer [redacted] back");
  // Ordinary words stay.
  expect(redact("method not found: SendMessage", bearer)).toBe("method not found: SendMessage");
  expect(redact("a".repeat(2_000), null)).toHaveLength(600);
});

test("redaction reads Bearer and Basic as credentials only when a token follows, not in ordinary words", () => {
  for (const text of [
    "Start with basic arithmetic",
    "a bearer of bad news",
    "Basic internationalization is next",
    "The Bearer token is in the vault",
  ]) {
    expect(redact(text, null)).toBe(text);
  }
  expect(redact("Basic dXNlcjpwYXNzd29yZA==", null)).toBe("Basic [redacted]");
  expect(redact("bearer 0f3a9c2e7b1d4f6a8c0e", null)).toBe("bearer [redacted]");
  // A credential header redacts its value whatever follows it.
  expect(redact("Authorization: Basic arithmetic", null)).toBe("Authorization: [redacted]");
});

test("redaction takes a cookie's every pair, and a quoted header value up to its closing quote", () => {
  expect(redact("Cookie: theme=dark; session=SECRET", null)).toBe("Cookie: [redacted]");
  expect(redact("Set-Cookie: session=SECRET; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT\r\nAccept: x", null)).toBe("Set-Cookie: [redacted]\r\nAccept: x");
  expect(redact(JSON.stringify({ cookie: "theme=dark; session=SECRET", accept: "x" }), null)).toBe('{"cookie":"[redacted]","accept":"x"}');
  expect(redact("{'Authorization': 'Bearer abc, SECRET', 'Accept': 'x'}", null)).toBe("{'Authorization': '[redacted]', 'Accept': 'x'}");
  expect(redact('{"x-api-key":"k;SECRET&more"}', null)).toBe('{"x-api-key":"[redacted]"}');
  // Another header's unquoted value still ends at its separator.
  expect(redact("x-auth-token: abc; next", null)).toBe("x-auth-token: [redacted]; next");
});

test("a cut comes after the token is taken out, and a cut that ends with the start of the token loses it", () => {
  const secret = "cutsecret-0123456789abcdef";
  const r = redactor({ kind: "bearer", secret });
  // The token straddles the cut: taken out whole first, so nothing of it is left.
  const straddling = r.cut(`${"p".repeat(590)}${secret} and more`, 600);
  expect(straddling.text).not.toContain(secret.slice(0, 6));
  expect(straddling.truncated).toBe(true);
  // Only the start of the token was ever there (the rest past an earlier limit): it goes at the cut.
  const start = r.cut(`${"p".repeat(590)}${secret.slice(0, 14)} and more`, 600);
  expect(start.text).toBe(`${"p".repeat(590)}[redacted]…`);
  expect(start.text).not.toContain(secret.slice(0, 6));
});
