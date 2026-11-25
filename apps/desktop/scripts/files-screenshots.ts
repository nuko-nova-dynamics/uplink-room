import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@uplink-room/backend/api";
import { appDir, launch, serveRenderer } from "./lib.ts";

/**
 * Screenshots of project files (spec #9): a doc, a canvas, a PDF and an image,
 * each with pinned comments, in dark and light. Sign in once with
 * `node scripts/signin.ts`, build, then run `node scripts/files-screenshots.ts`.
 * It adds a "Reef Runner" project with sample files to the remembered team (or
 * reuses them; `RESEED=1` starts them over), through the Room API, including an
 * agent's comments over HTTP.
 */
const profile = join(appDir, ".shots-profile");
const outDir = join(appDir, "screenshots");
const env = await readFile(join(appDir, ".env.local"), "utf8");
const convexUrl = env.match(/^VITE_CONVEX_URL=(.+)$/m)![1]!.trim();
const siteUrl = (env.match(/^VITE_CONVEX_SITE_URL=(.+)$/m)?.[1] ?? convexUrl.replace(/:(\d+)$/, (_, p) => `:${Number(p) + 1}`)).trim();
await mkdir(outDir, { recursive: true });

type Json = Record<string, unknown>;
type ClerkGlobal = { Clerk: { session: { getToken(o?: { skipCache?: boolean }): Promise<string> } } };

const DOC = `# Level 1: The reef

The first level teaches jumping and the **save slot** flow before any enemy appears.

## Beats

1. Wake up on the beach, with no HUD until the first jump.
2. Cross three rock gaps, each wider than the last.
3. Reach the shell shrine, which saves the run.

## To do

- [x] Block out the beach
- [ ] Tune the second gap
- [ ] Write the shrine prompt

| Gap | Width | Goal |
| --- | --- | --- |
| 1 | 2 tiles | Teach the jump |
| 2 | 3 tiles | Teach holding jump |
| 3 | 4 tiles | Test both |

Art notes live in the [publisher brief](https://example.com/brief). The shrine saves with \`saveSlot.write()\`.
`;

/** A small multi-page PDF built by hand: sample data for the screenshots. */
function briefPdf(): Uint8Array {
  const pages = [
    ["Reef Runner", "Publisher brief (sample)", "", "Audience: ages 8 to 12, first platformer.", "Platforms: Switch, Steam Deck.", "Length: 6 worlds, 4 levels each.", "", "Tone: bright, calm water; no time pressure", "in the first world."],
    ["Milestones", "", "Vertical slice: level 1 playable end to end.", "Alpha: worlds 1 and 2, all save slots.", "Beta: every world, localized menus.", "", "Out of scope: online play, level editor."],
  ];
  const objects: string[] = [];
  const kids: number[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push("PAGES");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  for (const lines of pages) {
    const body = lines
      .map((line, i) => (i === 0 ? `BT /F2 26 Tf 72 700 Td (${line}) Tj ET` : `BT /F1 14 Tf 72 ${660 - i * 24} Td (${line}) Tj ET`))
      .join("\n");
    objects.push(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
    const contents = objects.length;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>`);
    kids.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let pdf = "%PDF-1.7\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

const { server, url } = await serveRenderer();
const { app, page } = await launch(url, profile);
page.on("pageerror", (error) => console.log("page error:", error.message));

try {
  const sidebar = page.locator(".sidebar");
  const gate = page.getByText("Pick a team, make one");
  await sidebar.or(gate).first().waitFor({ timeout: 40_000 });
  if (await gate.isVisible()) {
    await page.getByLabel("Create a team").fill("Nuko Nova");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await sidebar.waitFor({ timeout: 30_000 });
  }
  const teamId = await page.evaluate(() => localStorage.getItem("uplink.team"));
  if (!teamId) throw new Error("No team was remembered.");

  const client = new ConvexHttpClient(convexUrl);
  const call = async <T>(kind: "query" | "mutation", ref: unknown, args: Json = {}): Promise<T> => {
    client.setAuth(await page.evaluate(() => (window as unknown as ClerkGlobal).Clerk.session.getToken({ skipCache: true })));
    const fn = (kind === "query" ? client.query : client.mutation).bind(client) as (r: unknown, a: Json) => Promise<T>;
    return fn(ref, { teamId, ...args });
  };
  const m = <T = unknown>(ref: unknown, args: Json = {}) => call<T>("mutation", ref, args);
  const q = <T = unknown>(ref: unknown, args: Json = {}) => call<T>("query", ref, args);
  const asAgent = async <T = unknown>(key: string, fn: string, args: Json = {}): Promise<T> => {
    const res = await fetch(`${siteUrl}/api/v1/call`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ fn, args }),
    });
    const body = (await res.json()) as { ok: boolean; result?: T; error?: { message: string } };
    if (!body.ok) throw new Error(`${fn} as an agent: ${body.error?.message}`);
    return body.result as T;
  };
  const upload = async (projectId: string, name: string, type: string, bytes: Uint8Array) => {
    const { uploadUrl, uploadId } = await m<{ uploadUrl: string; uploadId: string }>(api.files.uploadUrl);
    const res = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": type }, body: new Blob([bytes as Uint8Array<ArrayBuffer>], { type }) });
    const { storageId } = (await res.json()) as { storageId: string };
    return m<string>(api.files.addUpload, { projectId, name, uploadId, storageId });
  };

  // ---- seed once ----
  const projects = await q<{ projectId: string; name: string }[]>(api.projects.list);
  let projectId = projects.find((p) => p.name === "Reef Runner")?.projectId;
  if (!projectId) projectId = await m<string>(api.projects.create, { name: "Reef Runner", repos: ["nuko-nova-dynamics/reef-runner"] });
  // `RESEED=1` deletes the project's files first, to capture freshly seeded ones.
  if (process.env["RESEED"]) {
    for (const f of await q<{ fileId: string }[]>(api.files.list, { projectId })) await m(api.files.delete, { fileId: f.fileId });
  }
  const existing = await q<{ name: string }[]>(api.files.list, { projectId });
  if (!existing.some((f) => f.name === "level-1.md")) {
    console.log("seeding files…");
    // Reuse Scribe when an earlier run added it, with a new key.
    const members = await q<{ name: string; kind: string; agentId?: string }[]>(api.teams.members);
    const agentId =
      members.find((x) => x.kind === "agent" && x.name === "Scribe")?.agentId ??
      (await m<string>(api.agents.add, {
        name: "Scribe",
        connection: "mcp",
        character: { body: "scribe", color: "lilac", accessory: "scribe" },
      }));
    const { secret } = await m<{ secret: string }>(api.agents.createKey, {
      agentId,
      name: "files",
      scopes: ["room.read", "messages.post", "work.manage"],
    });

    const docId = await m<string>(api.files.save, { projectId, name: "level-1.md", content: DOC });
    await m(api.comments.add, {
      fileId: docId,
      body: "Should the HUD fade in, or pop in on the first jump?",
      pin: { kind: "text", quote: "with no HUD until the first jump", prefix: "Wake up on the beach, " },
    });
    const scribeComment = await asAgent<string>(secret, "comments.add", {
      fileId: docId,
      body: "Playtests on the slice took **11 tries** on average here. Suggest 3.5 tiles.",
      pin: { kind: "text", quote: "4 tiles" },
    });
    await m(api.comments.reply, { commentId: scribeComment, body: "Agreed, try 3.5 and rerun the playtest." });
    const done = await m<string>(api.comments.add, { fileId: docId, body: "Beach blockout is in.", pin: { kind: "text", quote: "Block out the beach" } });
    await asAgent(secret, "comments.resolve", { commentId: done });

    const canvasId = await m<string>(api.files.save, { projectId, name: "level-1-flow.excalidraw", content: "" });
    await asAgent(secret, "canvas.draw", {
      fileId: canvasId,
      shapes: [
        { type: "rectangle", x: 0, y: 0, width: 170, height: 80, label: "Beach start" },
        { type: "arrow", x: 175, y: 40, width: 110, height: 0 },
        { type: "rectangle", x: 290, y: 0, width: 170, height: 80, label: "Rock gaps", color: "#4f6fb3" },
        { type: "arrow", x: 465, y: 40, width: 110, height: 0 },
        { type: "diamond", x: 580, y: -20, width: 180, height: 120, label: "Fell?" },
        { type: "arrow", x: 670, y: 105, width: -295, height: 110 },
        { type: "ellipse", x: 290, y: 220, width: 170, height: 80, label: "Shell shrine", color: "#1f8a55" },
        { type: "text", x: 0, y: 150, text: "Drawn by Scribe from level-1.md" },
      ],
    });
    await asAgent(secret, "comments.add", {
      fileId: canvasId,
      body: "If they fall, respawn at the last rock, not the beach.",
      pin: { kind: "point", x: 670, y: 130 },
    });

    const pdfId = await upload(projectId, "publisher-brief.pdf", "application/pdf", briefPdf());
    await m(api.comments.add, { fileId: pdfId, body: "Steam Deck wasn't in the contract. Check with the publisher.", pin: { kind: "page", page: 1, x: 0.42, y: 0.235 } });
    await asAgent(secret, "comments.add", { fileId: pdfId, body: "Localized menus need the string table by alpha, not beta.", pin: { kind: "page", page: 2, x: 0.5, y: 0.245 } });

    // A sample title screen, drawn in the app's own page so no image file ships with the repo.
    const png = await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 960;
      c.height = 540;
      const g = c.getContext("2d")!;
      const sky = g.createLinearGradient(0, 0, 0, 540);
      sky.addColorStop(0, "#7fd3e6");
      sky.addColorStop(1, "#e9f7f2");
      g.fillStyle = sky;
      g.fillRect(0, 0, 960, 540);
      g.fillStyle = "#2b8fb0";
      g.fillRect(0, 380, 960, 160);
      g.fillStyle = "#f2d49b";
      for (let x = 0; x < 960; x += 48) g.fillRect(x, 420 + ((x / 48) % 2) * 6, 46, 120);
      g.fillStyle = "#ff8a65";
      g.beginPath();
      g.arc(700, 360, 34, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "#123040";
      g.font = "bold 76px sans-serif";
      g.fillText("REEF RUNNER", 210, 190);
      g.font = "28px sans-serif";
      g.fillText("Press A to start", 360, 260);
      return c.toDataURL("image/png").split(",")[1]!;
    });
    const imageId = await upload(projectId, "title-screen.png", "image/png", Buffer.from(png, "base64"));
    await m(api.comments.add, { fileId: imageId, body: "Title needs more contrast against the sky.", pin: { kind: "spot", x: 0.45, y: 0.3 } });
    await asAgent(secret, "comments.add", { fileId: imageId, body: "The crab reads as an enemy. Is that intended on the title screen?", pin: { kind: "spot", x: 0.73, y: 0.64 } });
    await page.waitForTimeout(1500);
  }
  if (!existing.some((f) => f.name === "credits.md")) {
    await m(api.files.save, {
      projectId,
      name: "credits.md",
      content: "# Credits\n\n<details><summary>Music</summary>Tide tracks by the sample composer.</details>\n\nArt by the sample studio.\n",
    });
  }

  const settle = (ms = 900) => page.waitForTimeout(ms);
  const shot = async (name: string, theme: "dark" | "light") => {
    // Off the controls: a hovered pressed segment's label takes its background's color.
    await page.mouse.move(1, 830);
    await page.evaluate((t) => (document.documentElement.dataset["theme"] = t), theme);
    await settle(700);
    await page.screenshot({ path: join(outDir, `${name}-${theme}.png`) });
  };
  const both = async (name: string) => {
    await shot(name, "dark");
    await shot(name, "light");
    await page.evaluate(() => (document.documentElement.dataset["theme"] = "dark"));
  };
  const open = async (name: string) => {
    await page.locator(".file-item", { hasText: name }).click();
    await settle(2500);
  };

  await sidebar.getByRole("button", { name: "Reef Runner" }).first().click();
  await settle(1200);
  await page.getByRole("tab", { name: "Files" }).click();
  await settle(1500);

  await open("level-1.md");
  await page.locator(".comment-card", { hasText: "11 tries" }).click();
  await settle(1200);
  await both("23-files-doc");

  await page.locator(".comment-rail").getByRole("button", { name: "Resolved" }).click();
  await settle(900);
  await both("24-files-resolved");
  await page.locator(".comment-rail").getByRole("button", { name: /^Open/ }).click();

  await open("credits.md");
  await both("29-files-doc-source");

  await open("level-1-flow.excalidraw");
  await settle(2500);
  await both("25-files-canvas");

  await open("publisher-brief.pdf");
  await settle(3000);
  await page.locator(".comment-card", { hasText: "Steam Deck" }).click();
  await settle(1500);
  await both("26-files-pdf");

  await open("title-screen.png");
  await page.locator(".comment-rail").getByRole("button", { name: "Pin a comment" }).click();
  await page.locator(".image-stage").click({ position: { x: 150, y: 250 } });
  await settle(900);
  await both("27-files-image-new-comment");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "New", exact: true }).click();
  await settle(700);
  await page.getByRole("dialog").getByRole("button", { name: "Canvas" }).click();
  await settle(500);
  await both("28-files-new");
  await page.keyboard.press("Escape");
  console.log("done");
} catch (error) {
  const where = join(outDir, "..", "test-results", "files-screenshots-failure.png");
  await page.screenshot({ path: where }).catch(() => {});
  console.log("failed; screen saved to", where);
  throw error;
} finally {
  await app.close();
  server.close();
}
