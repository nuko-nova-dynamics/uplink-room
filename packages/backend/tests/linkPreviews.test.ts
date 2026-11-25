/**
 * Link previews (spec #63): fetched by the backend under strict rules, with a fake network here.
 * The real network's own check of the address each socket connects to is in a2aGuardedFetch.test.ts.
 */
import { afterEach, expect, test } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { setPreviewNetForTests, USER_AGENT, type PreviewNet } from "../convex/lib/linkPreview";
import { addTeammate, newRoom, newTeam, type Room, present } from "./setup";

afterEach(() => setPreviewNetForTests(undefined));

type Page = { status?: number; type?: string; body?: string | Uint8Array; location?: string; delayMs?: number };

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

/** A fake internet: pages by URL, and DNS answers by host (anything else is a public address). */
function fakeNet(pages: Record<string, Page>, dns: Record<string, string[]> = {}) {
  const asked: { url: string; agent: string | undefined }[] = [];
  const net: PreviewNet = {
    resolve: async (host) => dns[host] ?? ["93.184.216.34"],
    get: async (url, init) => {
      asked.push({ url, agent: init.headers["user-agent"] });
      const page = pages[url];
      if (!page) return { status: 404, headers: new Headers(), body: null };
      if (page.delayMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, page.delayMs);
          init.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          });
        });
      }
      const headers = new Headers({ "content-type": page.type ?? "text/html; charset=utf-8" });
      if (page.location) headers.set("location", page.location);
      const bytes = typeof page.body === "string" ? new TextEncoder().encode(page.body) : (page.body ?? new Uint8Array());
      return { status: page.status ?? 200, headers, body: new Blob([bytes as Uint8Array<ArrayBuffer>]).stream() };
    },
  };
  return { net, asked: () => asked.map((a) => a.url), agents: () => asked.map((a) => a.agent) };
}

const og = (title: string, image?: string) =>
  `<html><head><title>Fallback</title><meta property="og:title" content="${title}"><meta property="og:description" content="A &quot;quoted&quot; <b>description</b>"><meta property="og:site_name" content="Example">${image ? `<meta property="og:image" content="${image}">` : ""}<script>window.ran = true</script></head><body>hi</body></html>`;

async function team() {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const [general] = await julio.as.query(api.channels.list, { teamId });
  return { t, teamId, julio, ana, general: general!.channelId };
}

/** Runs the scheduled fetches until no preview is pending. */
async function settle(t: Room) {
  for (let i = 0; i < 200; i++) {
    await t.finishInProgressScheduledFunctions();
    const pending = await t.run(async (ctx) =>
      (await ctx.db.query("linkPreviews").collect()).filter((r) => r.status === "pending"),
    );
    if (pending.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("previews still pending");
}

async function rows(t: Room) {
  return await t.run(async (ctx) => ctx.db.query("linkPreviews").collect());
}

test("a page's Open Graph tags become a preview, with its image copied into storage, reused for the next message", async () => {
  const fake = fakeNet({
    "https://example.com/post": { body: og("Launch day", "/cover.png") },
    "https://example.com/cover.png": { type: "image/png", body: PNG },
  });
  setPreviewNetForTests(fake.net);
  const { t, teamId, julio, ana, general } = await team();
  const messageId = await julio.as.mutation(api.messages.post, { teamId, channelId: general, body: "read https://example.com/post." });
  await settle(t);

  const view = present(await ana.as.query(api.messages.get, { teamId, messageId }));
  expect(view.previews).toEqual([
    {
      url: "https://example.com/post",
      title: "Launch day",
      description: 'A "quoted" description',
      siteName: "Example",
      imageUrl: expect.stringMatching(/^https:\/\//),
    },
  ]);
  const [row] = await rows(t);
  const image = await t.run(async (ctx) => ctx.db.system.get(row!.imageStorageId!));
  expect(image).toMatchObject({ contentType: "image/png", size: PNG.length });
  expect(fake.agents().every((agent) => agent === USER_AGENT)).toBe(true);

  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: "same https://example.com/post#top" });
  await settle(t);
  expect(fake.asked()).toEqual(["https://example.com/post", "https://example.com/cover.png"]);
});

test("links to private, loopback, link-local or metadata addresses, or redirecting to one, get no preview", async () => {
  const fake = fakeNet(
    {
      "https://hop.example.com/": { status: 302, location: "http://127.0.0.1/admin" },
      "https://hop2.example.com/": { status: 301, location: "https://inside.example.com/" },
      "https://many.example.com/1": { status: 302, location: "/2" },
      "https://many.example.com/2": { status: 302, location: "/3" },
      "https://many.example.com/3": { status: 302, location: "/4" },
      "https://many.example.com/4": { status: 302, location: "/5" },
      "https://many.example.com/5": { body: og("Too far") },
    },
    { "inside.example.com": ["10.1.2.3"], "sneaky.example.com": ["93.184.216.34", "::ffff:127.0.0.1"] },
  );
  setPreviewNetForTests(fake.net);
  const { t, teamId, julio, general } = await team();
  const links = [
    "http://127.0.0.1/admin",
    "http://10.0.0.5/",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost/",
    "https://inside.example.com/",
    "https://sneaky.example.com/",
    "https://hop.example.com/",
    "https://hop2.example.com/",
    "https://example.com:8080/",
    "https://user:pw@example.com/",
    "https://many.example.com/1",
  ];
  for (const link of links) await julio.as.mutation(api.messages.post, { teamId, channelId: general, body: `see ${link}` });
  await settle(t);

  const all = await rows(t);
  expect(all).toHaveLength(links.length);
  expect(all.every((r) => r.status === "failed" && r.title === undefined)).toBe(true);
  // Only the public hops were ever asked for: nothing private, and nothing after a fourth redirect.
  expect(fake.asked().sort()).toEqual(
    ["https://hop.example.com/", "https://hop2.example.com/", "https://many.example.com/1", "https://many.example.com/2", "https://many.example.com/3", "https://many.example.com/4"].sort(),
  );
  expect(all.find((r) => r.url === "https://many.example.com/1")!.error).toMatch(/more than 3 redirects/);
});

test("a page over 1 MB or slower than the time limit gives no preview, and an SVG image is never kept", async () => {
  const fake = fakeNet({
    "https://big.example.com/": { body: `<title>Big</title>${"x".repeat(1024 * 1024)}` },
    "https://slow.example.com/": { body: og("Slow"), delayMs: 2000 },
    "https://svg.example.com/": { body: og("Has an SVG", "https://svg.example.com/logo.png") },
    "https://svg.example.com/logo.png": { type: "image/svg+xml", body: "<svg onload=alert(1)/>" },
    "https://fake.example.com/": { body: og("Image that lies", "https://fake.example.com/i.png") },
    "https://fake.example.com/i.png": { type: "image/png", body: "<svg/>" },
  });
  setPreviewNetForTests(fake.net, { timeoutMs: 150 });
  const { t, teamId, julio, ana, general } = await team();
  const id = async (url: string) => julio.as.mutation(api.messages.post, { teamId, channelId: general, body: url });
  const big = await id("https://big.example.com/");
  const slow = await id("https://slow.example.com/");
  const svg = await id("https://svg.example.com/");
  const lying = await id("https://fake.example.com/");
  await settle(t);

  const previews = async (messageId: Id<"messages">) => present(await ana.as.query(api.messages.get, { teamId, messageId })).previews;
  expect(await previews(big)).toEqual([]);
  expect(await previews(slow)).toEqual([]);
  expect(await previews(svg)).toMatchObject([{ title: "Has an SVG", imageUrl: null }]);
  expect(await previews(lying)).toMatchObject([{ title: "Image that lies", imageUrl: null }]);
  expect((await rows(t)).find((r) => r.url === "https://big.example.com/")!.error).toMatch(/larger than/);
  expect(await t.run(async (ctx) => ctx.db.system.query("_storage").collect())).toEqual([]);
});

test("with link previews off nothing is fetched; the author can hide a preview and nobody else can", async () => {
  const fake = fakeNet({ "https://example.com/": { body: og("Example") } });
  setPreviewNetForTests(fake.net);
  const { t, teamId, julio, ana, general } = await team();
  await expect(ana.as.mutation(api.teams.setLinkPreviews, { teamId, linkPreviews: "off" })).rejects.toThrow(/Only admins/);
  await julio.as.mutation(api.teams.setLinkPreviews, { teamId, linkPreviews: "off" });
  expect(await ana.as.query(api.teams.settings, { teamId })).toMatchObject({ linkPreviews: "off" });
  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: "https://example.com/" });
  await settle(t);
  expect(fake.asked()).toEqual([]);
  expect(await rows(t)).toEqual([]);

  await julio.as.mutation(api.teams.setLinkPreviews, { teamId, linkPreviews: "on" });
  const messageId = await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: "again https://example.com/" });
  await settle(t);
  expect(present(await julio.as.query(api.messages.get, { teamId, messageId })).previews).toMatchObject([{ title: "Example" }]);
  await expect(julio.as.mutation(api.messages.hidePreview, { teamId, messageId })).rejects.toThrow(/Only its author/);
  await ana.as.mutation(api.messages.hidePreview, { teamId, messageId });
  expect(await julio.as.query(api.messages.get, { teamId, messageId })).toMatchObject({ previews: [], previewsHidden: true });
});

test("a fetch queued or running when the team turns previews off makes no more requests", async () => {
  const { t, teamId, julio, ana, general } = await team();
  // Off before the queued fetch runs: nothing goes out, not even a DNS lookup.
  const lookups: string[] = [];
  const quiet = fakeNet({ "https://example.com/a": { body: og("A", "/a.png") } });
  setPreviewNetForTests({ ...quiet.net, resolve: async (host) => (lookups.push(host), ["93.184.216.34"]) });
  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: "https://example.com/a" });
  await julio.as.mutation(api.teams.setLinkPreviews, { teamId, linkPreviews: "off" });
  await settle(t);
  expect(quiet.asked()).toEqual([]);
  expect(lookups).toEqual([]);
  // Dropped, not recorded as having no preview.
  expect(await rows(t)).toEqual([]);

  // Off between the page and its image: the image is never asked for.
  await julio.as.mutation(api.teams.setLinkPreviews, { teamId, linkPreviews: "on" });
  const page = fakeNet({
    "https://example.com/b": { body: og("B", "https://example.com/b.png") },
    "https://example.com/b.png": { type: "image/png", body: PNG },
  });
  setPreviewNetForTests({
    ...page.net,
    get: async (url, init) => {
      const response = await page.net.get(url, init);
      if (url === "https://example.com/b") await julio.as.mutation(api.teams.setLinkPreviews, { teamId, linkPreviews: "off" });
      return response;
    },
  });
  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: "https://example.com/b" });
  await settle(t);
  expect(page.asked()).toEqual(["https://example.com/b"]);
  expect(await rows(t)).toEqual([]);
  expect(await t.run(async (ctx) => ctx.db.system.query("_storage").collect())).toEqual([]);
});

/** Julio's team, and Rosa's with its own #general. */
async function twoTeams() {
  const ours = await team();
  const rosa = await newTeam(ours.t, "Rosa");
  const [theirGeneral] = await rosa.admin.as.query(api.channels.list, { teamId: rosa.teamId });
  return { ...ours, rosa: rosa.admin, theirs: rosa.teamId, theirGeneral: theirGeneral!.channelId };
}

test("a link another team's fetch is getting still gets its preview when that team turns previews off (#70)", async () => {
  const fake = fakeNet({ "https://example.com/shared": { body: og("Shared") } });
  setPreviewNetForTests(fake.net);
  const { t, teamId, julio, ana, general, rosa, theirs, theirGeneral } = await twoTeams();
  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: "https://example.com/shared" });
  // Rosa's team posts the same link while Julio's team's fetch is queued, so it waits on that fetch.
  const theirMessage = await rosa.as.mutation(api.messages.post, { teamId: theirs, channelId: theirGeneral, body: "same https://example.com/shared" });
  await julio.as.mutation(api.teams.setLinkPreviews, { teamId, linkPreviews: "off" });
  await settle(t);

  expect(present(await rosa.as.query(api.messages.get, { teamId: theirs, messageId: theirMessage })).previews).toMatchObject([{ title: "Shared" }]);
  expect(fake.asked()).toEqual(["https://example.com/shared"]);
  const [row] = await rows(t);
  expect([row!.status, row!.waitingTeams]).toEqual(["ready", undefined]);
});

test("a fetch every team turned off hands over to a team waiting on it that has previews on again, instead of being dropped (#70)", async () => {
  const fake = fakeNet({ "https://example.com/shared": { body: og("Shared") } });
  setPreviewNetForTests(fake.net);
  const { t, teamId, julio, ana, general, rosa, theirs, theirGeneral } = await twoTeams();
  await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: "https://example.com/shared" });
  const theirMessage = await rosa.as.mutation(api.messages.post, { teamId: theirs, channelId: theirGeneral, body: "https://example.com/shared" });
  await julio.as.mutation(api.teams.setLinkPreviews, { teamId, linkPreviews: "off" });
  // As if the fetch found both teams off, and Rosa's team turned previews back on before it gave up.
  await t.mutation(internal.linkPreviews.abandon, { url: "https://example.com/shared" });
  expect(await rows(t)).toMatchObject([{ status: "pending" }]);
  const handedTo = await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect())
      .filter((f) => f.name.includes("fetchPreview") && f.state.kind === "pending")
      .map((f) => (f.args[0] as { teamId: string }).teamId),
  );
  expect(handedTo).toContain(theirs);
  await settle(t);
  expect(present(await rosa.as.query(api.messages.get, { teamId: theirs, messageId: theirMessage })).previews).toMatchObject([{ title: "Shared" }]);
});
