import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@uplink-room/backend/api";
import type { Page } from "@playwright/test";
import { appDir, launch, serveRenderer } from "./lib.ts";

/**
 * The call smoke check and the call screenshots (spec #5, Testing Decisions,
 * seam 3). Against the local Convex backend (.env.local) and a local
 * `livekit-server --dev` (docs/calls.md):
 *
 *  1. A fresh team: Julio (first test person) makes the Reef Runner project and
 *     adds the Notetaker; Ana (second test person) joins by invite.
 *  2. Ana starts a call in #reef-runner: `calls.join` with her session, then a
 *     scripted LiveKit participant plays a spoken recording as her microphone.
 *  3. Julio's app, with synthetic media (UPLINK_FAKE_MEDIA=1: no device opened,
 *     no sound played), sees the call from outside, joins, turns the camera on,
 *     mutes, and asks the Notetaker to join. The real Notetaker
 *     (packages/notetaker) runs as its own process with its agent key.
 *  4. Checks: Ana's tile and the speaking ring show in Julio's app; Julio
 *     shares a (synthetic) screen through the picker.
 *  5. Everyone leaves; the Notetaker posts call notes and proposed tasks;
 *     Julio accepts one.
 * Dark and light screenshots of each call screen go to screenshots/.
 *
 * Needs: `node scripts/signin.ts` and `node scripts/signin.ts .shots-profile-2 second`
 * once, WHISPER_MODEL, and `claude` logged in (the Notetaker's summarizer).
 *   pnpm --filter @uplink-room/desktop build && node scripts/call-smoke.ts
 *
 * Against a cloud deployment (VITE_CONVEX_URL on *.convex.cloud) with LiveKit Cloud, the same run
 * goes through LiveKit Cloud and the deployment's LiveKit webhook. `--livekit-secret-stdin` reads
 * the LiveKit API secret from stdin (never from the environment, so no child process sees it) and
 * lists the call's room from LiveKit's API: who is in it, their tracks, and their audio features.
 *   npx convex env get LIVEKIT_API_SECRET | LIVEKIT_API_KEY=<key> node scripts/call-smoke.ts --livekit-secret-stdin
 * The webhook check (a client killed without leaving) runs on a cloud deployment; on a local
 * backend it needs a LiveKit webhook set up and `--webhook`.
 */
const outDir = join(appDir, "screenshots");
const repo = join(appDir, "..", "..");
const convexUrl = (await readFile(join(appDir, ".env.local"), "utf8")).match(/^VITE_CONVEX_URL=(.+)$/m)![1]!.trim();
const cloud = new URL(convexUrl).hostname.endsWith(".convex.cloud");
// HTTP actions: `<name>.convex.site` for a cloud deployment, the next port for a local backend.
const siteUrl = cloud
  ? convexUrl.replace(".convex.cloud", ".convex.site")
  : convexUrl.replace(/:(\d+)$/, (_, port: string) => `:${Number(port) + 1}`);
const anaEmail = (JSON.parse(await readFile(join(appDir, ".shots-profile-2", "credentials.json"), "utf8")) as { email: string }).email;
const liveKitSecret = process.argv.includes("--livekit-secret-stdin")
  ? await new Promise<string>((resolve) => {
      let text = "";
      process.stdin.on("data", (d) => (text += String(d))).on("end", () => resolve(text.trim().split("\n").at(-1)!.trim()));
    })
  : undefined;
const liveKitKey = process.env["LIVEKIT_API_KEY"];

/** The call's LiveKit room as LiveKit's API reports it (ListParticipants, with a room-admin token). */
async function liveKitRoom(url: string, room: string) {
  if (!liveKitSecret || !liveKitKey) return null;
  const now = Math.floor(Date.now() / 1000);
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${part({ alg: "HS256", typ: "JWT" })}.${part({ iss: liveKitKey, sub: "call-smoke", nbf: now - 10, exp: now + 120, video: { roomAdmin: true, room } })}`;
  const token = `${unsigned}.${createHmac("sha256", liveKitSecret).update(unsigned).digest("base64url")}`;
  const response = await fetch(`${url.replace(/^ws/, "http")}/twirp/livekit.RoomService/ListParticipants`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ room }),
  });
  if (!response.ok) throw new Error(`ListParticipants: ${response.status} ${await response.text()}`);
  type Track = { source?: string; type?: string; muted?: boolean; audioFeatures?: string[]; mimeType?: string };
  const { participants = [] } = (await response.json()) as { participants?: { identity: string; kind?: string; tracks?: Track[] }[] };
  return participants.map((p) => ({
    identity: p.identity,
    kind: p.kind ?? "STANDARD",
    tracks: (p.tracks ?? []).map((t) => ({ source: t.source, muted: Boolean(t.muted), mimeType: t.mimeType, audioFeatures: t.audioFeatures ?? [] })),
  }));
}
const whisperModel = process.env["WHISPER_MODEL"];
if (!whisperModel) throw new Error("Set WHISPER_MODEL to a whisper.cpp model (docs/calls.md).");
await mkdir(outDir, { recursive: true });

type ClerkGlobal = { Clerk: { session: { getToken(o?: { skipCache?: boolean }): Promise<string> } } };
const tokenOf = (page: Page) =>
  page.evaluate(() => (window as unknown as ClerkGlobal).Clerk.session.getToken({ skipCache: true }));

function client(page: Page) {
  const convex = new ConvexHttpClient(convexUrl);
  return {
    async mutation<T>(ref: unknown, args: Record<string, unknown>): Promise<T> {
      convex.setAuth(await tokenOf(page));
      return (convex.mutation as (r: unknown, a: unknown) => Promise<T>)(ref, args);
    },
    async query<T>(ref: unknown, args: Record<string, unknown>): Promise<T> {
      convex.setAuth(await tokenOf(page));
      return (convex.query as (r: unknown, a: unknown) => Promise<T>)(ref, args);
    },
  };
}

function check(ok: unknown, what: string) {
  if (!ok) throw new Error(`Check failed: ${what}`);
  console.log(`ok: ${what}`);
}

const children: ChildProcess[] = [];
let revokeKey: (() => Promise<unknown>) | undefined;
// UPLINK_RENDERER_URL points at a Vite dev server instead of the built renderer: React's development
// build, where StrictMode mounts, unmounts and mounts again (docs/calls.md).
const devUrl = process.env["UPLINK_RENDERER_URL"];
const { server, url } = devUrl ? { server: { close() {} }, url: devUrl } : await serveRenderer();
process.env["UPLINK_FAKE_MEDIA"] = "1";
const julio = await launch(url, join(appDir, ".shots-profile"));
const ana = await launch(url, join(appDir, ".shots-profile-2"));
julio.page.on("pageerror", (error) => console.log("page error:", error.message));
julio.page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") console.log(`app ${m.type()}:`, m.text().slice(0, 300));
});
const page = julio.page;
const settle = (ms = 900) => page.waitForTimeout(ms);
// The app's Krisp messages (lib/call.tsx logs why noise cancellation is off).
page.on("console", (message) => {
  if (/krisp|noise/i.test(message.text())) console.log(`app console (${message.type()}): ${message.text()}`);
});
const shot = async (name: string, theme: "dark" | "light") => {
  await page.evaluate((t) => (document.documentElement.dataset["theme"] = t), theme);
  await settle(500);
  await page.screenshot({ path: join(outDir, `${name}-${theme}.png`) });
};
const both = async (name: string) => {
  await shot(name, "dark");
  await shot(name, "light");
  await page.evaluate(() => (document.documentElement.dataset["theme"] = "dark"));
};

try {
  // ---- 1. A fresh team ----
  for (const p of [julio.page, ana.page]) {
    await p.locator(".sidebar").or(p.getByText("Pick a team, make one")).first().waitFor({ timeout: 40_000 });
  }
  const asJulio = client(julio.page);
  const asAna = client(ana.page);
  await asJulio.mutation(api.people.ensure, {});
  const teamId = await asJulio.mutation<string>(api.teams.create, { name: cloud ? "Call check (test data)" : "Nuko Nova" });
  const projectId = await asJulio.mutation<string>(api.projects.create, { teamId, name: "Reef Runner", repos: [] });
  const channels = await asJulio.query<{ channelId: string; projectId?: string }[]>(api.channels.list, { teamId });
  const reef = channels.find((c) => c.projectId === projectId)!.channelId;
  const agentId = await asJulio.mutation<string>(api.agents.add, {
    teamId,
    name: "Notetaker",
    connection: "mcp",
    character: { body: "notetaker", color: "sage", accessory: "notetaker" },
  });
  const { secret: notetakerKey, keyId } = await asJulio.mutation<{ secret: string; keyId: string }>(api.agents.createKey, {
    teamId,
    agentId,
    name: "smoke",
    scopes: ["room.read", "messages.post", "calls.join", "calls.notes"],
  });
  revokeKey = () => asJulio.mutation(api.agents.revokeKey, { teamId, keyId });
  const { token: invite } = await asJulio.mutation<{ token: string }>(api.invites.create, {
    teamId,
    email: anaEmail,
    // A test account: the script carries the token, and no email goes out.
    sendEmail: false,
  });
  await asAna.mutation(api.people.ensure, {});
  await asAna.mutation(api.invites.accept, { token: invite });
  await asAna.mutation(api.messages.post, { teamId, channelId: reef, body: "Standup in five. Bring the save slot numbers." });
  for (const p of [julio.page, ana.page]) {
    await p.evaluate((id) => {
      localStorage.setItem("uplink.team", id);
      // Onboarding is covered by screenshots.ts; this run starts past it.
      localStorage.setItem("uplink.onboarded", "yes");
    }, teamId);
    await p.reload();
    await p.locator(".sidebar").waitFor({ timeout: 30_000 });
  }
  check(true, "a fresh team with Reef Runner, the Notetaker and Ana");

  // ---- 2. Ana starts a call and speaks ----
  const dir = await mkdtemp(join(tmpdir(), "call-smoke-"));
  const wav = join(dir, "ana.wav");
  await promisify(execFile)("say", [
    "-o",
    wav,
    "--data-format=LEI16@16000",
    "I can take the save slot bug before Friday. The tile map build is still failing on C I, so someone should look at that today.",
  ]);
  type JoinResult = { callId: string; participationId: string; url: string; token: string };
  /** A scripted LiveKit client playing the recording as Ana's microphone for one join; resolves once it publishes. */
  const voice = async (joined: JoinResult) => {
    const child = spawn("node", [join(repo, "packages/notetaker/scripts/participant.ts"), "--url", joined.url, "--token", joined.token, "--wav", wav], {
      cwd: join(repo, "packages/notetaker"),
      stdio: ["ignore", "pipe", "inherit"],
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Ana's scripted client never published to LiveKit")), 30_000);
      child.stdout!.on("data", (data) => {
        process.stdout.write(data);
        if (/connected and speaking/.test(String(data))) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    return child;
  };
  const anaJoin = await asAna.mutation<JoinResult>(api.calls.join, { teamId, channelId: reef });
  console.log(`LiveKit server for this call: ${anaJoin.url}`);
  const anaVoice = await voice(anaJoin);
  // Ana's current join: her client leaving LiveKit ends it (the webhook), so coming back is a new join.
  let anaIn = anaJoin.participationId;
  const anaBeat = setInterval(() => void asAna.mutation(api.calls.heartbeat, { teamId, participationId: anaIn }).catch(() => {}), 15_000);

  // ---- 3. Julio sees the call from outside, then joins ----
  await page.locator(".sidebar").getByRole("button", { name: /reef-runner/ }).click();
  await page.locator(".call-members").getByText(/./).first().waitFor({ timeout: 15_000 });
  await page.getByRole("button", { name: "Join call" }).waitFor({ timeout: 15_000 });
  check(await page.locator(".call-bar .call-faces").isVisible(), "Julio sees who's in the call before joining, in its call bar");
  await settle(1200);
  await both("23-call-outside");

  await page.getByRole("button", { name: "Join call" }).click();
  await page.getByRole("group", { name: "Call" }).getByRole("button", { name: "Leave the call" }).waitFor({ timeout: 20_000 });
  check((await page.locator(".call-stage").count()) === 0, "voice alone shows the call bar and no tiles");
  await page.getByRole("button", { name: "More call controls" }).click();
  await page.getByRole("menuitem", { name: "Turn camera on" }).click();
  await page.getByRole("button", { name: "Turn on camera" }).click();
  await page.locator(".call-stage video").first().waitFor({ timeout: 10_000 });
  check(true, "Julio's (synthetic) camera shows on his tile");
  await page.getByRole("button", { name: "Mute", exact: true }).click();
  await page.locator(".call-members .is-muted").first().waitFor({ timeout: 10_000 });
  check(true, "muting shows in the sidebar");

  // The call cues are lib/sound.ts's wood notes: sine oscillators at these frequencies (and their
  // fourth harmonics). The synthetic microphone's 180 Hz oscillator isn't one. The window is muted
  // (UPLINK_QUIET), so this counts the notes started rather than listening for them.
  await page.evaluate(() => {
    const w = window as unknown as { __cueNotes: number };
    w.__cueNotes = 0;
    const notes = new Set([587, 880, 2348, 3520]);
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (this: OscillatorNode, ...args: Parameters<OscillatorNode["start"]>) {
      if (notes.has(Math.round(this.frequency.value))) w.__cueNotes++;
      return start.apply(this, args);
    };
  });
  const cueNotes = () => page.evaluate(() => (window as unknown as { __cueNotes: number }).__cueNotes);
  const cuesPlayed = () => page.evaluate(() => Number((document.documentElement.dataset["cue"] ?? "none 0").split(" ")[1]));
  /** Waits for the app to play `name` (lib/sound.ts records each cue played on the page, sound on or off). */
  const nextCue = async (name: string) => {
    const before = await cuesPlayed();
    return async () =>
      page.waitForFunction(
        ([cue, n]) => {
          const [last, count] = (document.documentElement.dataset["cue"] ?? "none 0").split(" ");
          return last === cue && Number(count) > Number(n);
        },
        [name, before] as const,
        { timeout: 20_000 },
      );
  };
  const joinCue = await nextCue("join");

  // The Notetaker, as its own program with its own agent key.
  const notetaker = spawn("node", [join(repo, "packages/notetaker/src/bin.ts"), "--url", siteUrl, "--model", whisperModel], {
    cwd: join(repo, "packages/notetaker"),
    env: { ...process.env, UPLINK_AGENT_KEY: notetakerKey },
    stdio: ["ignore", "inherit", "inherit"],
  });
  children.push(notetaker);
  await settle(2500);
  await page.getByRole("button", { name: "More call controls" }).click();
  await page.locator(".call-menu").getByRole("menuitem", { name: /Notetaker/ }).click();
  await page.locator(".call-bar .call-notes").waitFor({ timeout: 30_000 });
  check(true, "the Notetaker joins, and the call bar says it's taking notes");
  await joinCue();
  check((await cueNotes()) > 0, "the Notetaker joining plays the join cue (Sounds on)");

  await page.locator(".call-bar .call-face.speaking").first().waitFor({ timeout: 20_000 });
  await page.locator(".call-member .call-face.speaking").first().waitFor({ timeout: 5_000 });
  check(true, "Ana's speaking ring shows in the call bar and under the channel");
  await both("24-call-stage");

  // ---- 4. Screen share through the picker ----
  await page.getByRole("button", { name: "Share a screen" }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("radio", { name: /Reef Runner \(Godot\)/ }).click();
  await settle(400);
  await both("25-screen-picker");
  await page.getByRole("dialog").getByRole("button", { name: "Share", exact: true }).click();
  await page.locator(".tile.screen video").waitFor({ timeout: 10_000 });
  await settle(2500);
  check(true, "a shared screen is the largest tile");
  await both("26-call-screen-share");
  await page.getByRole("button", { name: "Stop sharing" }).click();

  // Let the Notetaker hear Ana say it at least twice.
  await page.waitForTimeout(16_000);

  // Ana's media drops (her join stays in the room): the leave cue, with Sounds on.
  let notes = await cueNotes();
  const leaveCue = await nextCue("leave");
  anaVoice.kill("SIGTERM");
  await leaveCue();
  check((await cueNotes()) > notes, "Ana's media leaving plays the leave cue (Sounds on)");
  // With Sounds off (Settings, Notifications), her media coming back moves the cue (Link reacts) and plays nothing.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Notifications" }).click();
  // Sounds is a switch drawn as On and Off halves (UI SDK Switch); press the Off half.
  const sounds = page.getByRole("switch", { name: "Sounds" });
  await sounds.locator('[data-side="off"]').click();
  notes = await cueNotes();
  const silentJoin = await nextCue("join");
  const anaRejoin = await asAna.mutation<JoinResult>(api.calls.join, { teamId, channelId: reef, callId: anaJoin.callId });
  anaIn = anaRejoin.participationId;
  const anaBack = await voice(anaRejoin);
  await silentJoin();
  check((await cueNotes()) === notes, "with Sounds off, the join cue still reaches Link but plays no sound");
  await sounds.locator('[data-side="on"]').click();
  await page.locator(".sidebar button.nav-item", { hasText: "reef-runner" }).click();
  await page.locator(".call-bar").waitFor({ timeout: 10_000 });

  // What LiveKit itself reports for the room (with --livekit-secret-stdin): who's in and their tracks.
  const room = await liveKitRoom(anaJoin.url, `call_${anaJoin.callId}`);
  if (room) {
    console.log("LiveKit room:", JSON.stringify(room));
    check(room.length >= 3, `LiveKit reports ${room.length} participants in the room (Julio, Ana and the Notetaker)`);
    // Krisp needs a microphone from getUserMedia: its init sets noiseSuppression, voiceIsolation and
    // sampleRate constraints, which the synthetic microphone can't satisfy. So this only reports it.
    const julioMic = room.find((p) => p.tracks.some((t) => t.source === "CAMERA"))?.tracks.find((t) => t.source === "MICROPHONE");
    console.log(`Krisp on Julio's microphone, as LiveKit reports it: ${julioMic?.audioFeatures.includes("TF_ENHANCED_NOISE_CANCELLATION") ? "on" : "off"} (audio features: ${JSON.stringify(julioMic?.audioFeatures)})`);
  }

  // ---- Webhook: a client killed without leaving ----
  // Ana joins on a second device. Heartbeats keep that join alive in the room, so only LiveKit's
  // participant_left webhook can end it once its client is killed. Webhooks are optional on a local
  // setup (docs/calls.md), so this runs against a cloud deployment or with --webhook.
  if (cloud || process.argv.includes("--webhook")) {
  const tablet = await asAna.mutation<JoinResult>(api.calls.join, { teamId, channelId: reef, callId: anaJoin.callId });
  let tabletDropped = 0;
  const tabletBeat = setInterval(() => {
    asAna.mutation(api.calls.heartbeat, { teamId, participationId: tablet.participationId }).catch((error: unknown) => {
      if (!tabletDropped && (error as { data?: { code?: string } }).data?.code === "conflict") tabletDropped = Date.now();
    });
  }, 3_000);
  const tabletVoice = await voice(tablet);
  await page.waitForTimeout(4_000);
  const killedAt = Date.now();
  tabletVoice.kill("SIGKILL");
  while (!tabletDropped && Date.now() - killedAt < 120_000) await page.waitForTimeout(1_000);
  clearInterval(tabletBeat);
  check(
    tabletDropped,
    `LiveKit's webhook ended the killed client's join ${Math.round((tabletDropped - killedAt) / 1000)}s after the kill, though it was still heartbeating`,
  );
  const stillIn = await asAna.query<{ participants: { name: string }[] }>(api.calls.get, { teamId, callId: anaJoin.callId });
  check(stillIn.participants.length >= 3, "Ana's other join keeps her in the call: Julio, Ana and the Notetaker are still in");
  } else {
    console.log("Skipped the webhook check: local setup without --webhook (see docs/calls.md).");
  }

  // ---- 5. Everyone leaves; notes and proposed tasks ----
  await page.getByRole("button", { name: "Leave the call" }).click();
  clearInterval(anaBeat);
  anaBack.kill("SIGTERM");
  await asAna.mutation(api.calls.leave, { teamId, participationId: anaIn });
  await page.locator(".timeline-event", { hasText: "Call ended" }).waitFor({ timeout: 20_000 });
  check(true, "the call ends when the last person leaves");
  await page.locator(".proposal").first().waitFor({ timeout: 180_000 });
  await settle(1500);
  const proposals = await page.locator(".proposal").count();
  check(proposals > 0, `the Notetaker posted call notes and ${proposals} proposed task(s)`);
  await page.locator(".proposals").scrollIntoViewIfNeeded();
  await both("27-call-notes");

  await page.locator(".proposal").first().getByRole("button", { name: "Accept" }).click();
  await page.locator(".proposal.answered").first().waitFor({ timeout: 10_000 });
  const board = await asJulio.query<{ title: string; column: string }[]>(api.tasks.board, { teamId, projectId });
  check(board.length === 1 && board[0]!.column === "not_started", `an accepted task lands as Not started in Reef Runner ("${board[0]?.title}")`);
  await page.getByRole("button", { name: "Transcript" }).click();
  await page.locator(".transcript-line").first().waitFor({ timeout: 10_000 });
  await settle(600);
  await both("28-transcript");
  const transcript = await page.locator(".transcript").innerText();
  check(/save slot/i.test(transcript), "the transcript has what Ana said, under her name");
  await page.getByRole("button", { name: "Close transcript" }).click();

  // ---- 6. A call with a transcript but no notes (the summary never ran) still offers its transcript ----
  const second = await asAna.mutation<{ callId: string; participationId: string }>(api.calls.join, { teamId, channelId: reef });
  const anaTeams = await asAna.query<{ teamId: string; memberId: string }[]>(api.teams.mine, {});
  const anaId = anaTeams.find((m) => m.teamId === teamId)!.memberId;
  await asAna.mutation(api.calls.addTranscript, {
    teamId,
    callId: second.callId,
    lines: [{ speakerId: anaId, text: "Quick check before lunch.", at: Date.now() }],
  });
  await asAna.mutation(api.calls.leave, { teamId, participationId: second.participationId });
  const ended = page.locator(".timeline-event", { hasText: "Call ended" }).nth(1);
  await ended.waitFor({ timeout: 15_000 });
  const transcriptButtons = page.getByRole("button", { name: "Transcript" });
  await page.waitForFunction(() => document.querySelectorAll(".proposals .btn").length >= 2, undefined, { timeout: 10_000 });
  check((await transcriptButtons.count()) === 2, "a call with a transcript but no notes still shows its Transcript button");
  console.log("call smoke passed");
} catch (error) {
  await page.screenshot({ path: join(tmpdir(), "call-smoke-failure.png") }).catch(() => {});
  console.log("failure screenshot:", join(tmpdir(), "call-smoke-failure.png"));
  throw error;
} finally {
  for (const child of children) child.kill("SIGTERM");
  // The Notetaker's key was made for this run only.
  if (revokeKey) await revokeKey().then(() => console.log("revoked the Notetaker's key for this run"), (error: unknown) => console.log("couldn't revoke the Notetaker's key:", error));
  await julio.app.close();
  await ana.app.close();
  server.close();
}
