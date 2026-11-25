import { execFile } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@uplink-room/backend/api";
import electronPath from "electron";
import { appDir } from "./lib.ts";

/**
 * The call soak (issue: calls ending after a minute; docs/calls.md, "The soak").
 *
 * Two copies of the built app, each signed in as its own throwaway test person on the Clerk
 * development instance, sit in one call on a cloud dev deployment (VITE_CONVEX_URL in .env.local)
 * through LiveKit Cloud. The app is served from `uplink-room://app`, as the installed app serves
 * itself, so the main process's own content security policy applies. Chromium's fake devices stand
 * in for the microphone and camera (`--use-fake-device-for-media-stream`), so no real device opens,
 * and `--use-mock-keychain` keeps the sign-in out of the computer's Keychain.
 *
 * Person A moves around the app while B stays in the call's channel:
 *  - the call's channel, then Inbox, Settings (Calls, Diagnostics), another channel and a direct
 *    message, every 30 to 60 seconds;
 *  - the window minimized for `--background` minutes (10 by default), then hidden for 4;
 *  - more moving around until the end.
 *
 * Every 5 seconds it records, for each person:
 *  - the join's `lastSeenAt` and `leftAt` from `callParticipations` (`npx convex data`): a
 *    heartbeat is missed when `lastSeenAt` stops moving for more than 30 seconds;
 *  - every RTCPeerConnection's state changes (a disconnect is a connection leaving `connected`);
 *  - the received audio from WebRTC stats: an audio gap is a 5 second interval with no audio
 *    packets, or with more than 100 ms of concealed (not silent) samples.
 * With `--livekit-secret-stdin`, it also lists the room from LiveKit's API (each track's audio
 * features; 5 is Krisp) at the start and end.
 *
 * `--plan join` only joins and waits `--minutes`, for checking one join. `--plan devices` has A join
 * by clicking the channel's room in the sidebar's Voice list, turn the camera on through its preview, and switch
 * the microphone, camera and speaker mid-call, checking each reached the device. `--plan sleep`
 * freezes A's app (every process it started, with SIGSTOP) for `--sleep-seconds` (90), longer than
 * the room's 60 second window, as a computer asleep, then lets it go and measures how the call
 * comes back. `--plan drop` (10 minutes by default) has A mute, then the room drop A's join (A's
 * own `calls.leave`, the same server-side drop the presence check makes), and checks A joins again
 * still muted (the dock, the room's row and LiveKit's track), then moves around and sits minimized
 * for 3 minutes. `--app <dir>`
 * runs another build (a folder with this package.json and an `out/`).
 *
 *   pnpm --filter @uplink-room/desktop build
 *   npx convex env get LIVEKIT_API_SECRET | LIVEKIT_API_KEY=<key> node scripts/call-soak.ts --livekit-secret-stdin
 *
 * Results go to `.soak/<label>.json`. The two people and their team stay on the deployment for
 * the next run; `.soak/` holds their profiles and passwords (git-ignored).
 */

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const minutes = Number(arg("minutes", "30"));
const backgroundMinutes = Number(arg("background", "10"));
const plan = arg("plan", "soak") as "soak" | "join" | "devices" | "sleep" | "drop";
/** With `--plan sleep`: how long A's app is frozen, as a computer asleep. */
const frozenSeconds = Number(arg("sleep-seconds", "90"));
/** With `--plan join`: how many times both people join, each wait `--minutes` long. */
const joinCount = Number(arg("joins", "1"));
const label = arg("label", `soak-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const app = resolve(arg("app", appDir));
const soakDir = join(appDir, ".soak");
const backendDir = join(appDir, "..", "..", "packages", "backend");

const convexUrl = (await readFile(join(appDir, ".env.local"), "utf8")).match(/^VITE_CONVEX_URL=(.+)$/m)?.[1]?.trim();
if (!convexUrl || !new URL(convexUrl).hostname.endsWith(".convex.cloud")) throw new Error("Point .env.local at a cloud dev deployment.");
// The production deployment (docs/error-reports.md) is never a soak target.
if (convexUrl.includes("fleet-jaguar-632")) throw new Error("That's the production deployment.");

const liveKitSecret = process.argv.includes("--livekit-secret-stdin")
  ? await new Promise<string>((done) => {
      let text = "";
      process.stdin.on("data", (d) => (text += String(d))).on("end", () => done(text.trim().split("\n").at(-1)!.trim()));
    })
  : undefined;
const liveKitKey = process.env["LIVEKIT_API_KEY"];

const started = Date.now();
const at = () => `${((Date.now() - started) / 1000).toFixed(0).padStart(5)}s`;
const log = (...parts: unknown[]) => console.log(at(), ...parts);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const run = promisify(execFile);

// ---------- what each page records about itself ----------

/**
 * Runs in each window before the app: keeps every RTCPeerConnection and its state changes, and
 * the page's uncaught errors (type, message, where), for this script only. Blob scripts are
 * recorded by size and type, with the first characters of JavaScript ones, to tell which library
 * made them.
 */
const observer = () => {
  const w = window as unknown as Record<string, unknown>;
  const pcs: RTCPeerConnection[] = [];
  const states: { at: number; pc: number; state: string }[] = [];
  const errors: { at: number; type: string; message: string; where: string }[] = [];
  const blobs: { at: number; url: string; type: string; size: number; head: string }[] = [];
  w["__soak"] = { pcs, states, errors, blobs };
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Native {
    constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
      super(...args);
      const index = pcs.push(this) - 1;
      this.addEventListener("connectionstatechange", () => states.push({ at: Date.now(), pc: index, state: this.connectionState }));
    }
  } as typeof RTCPeerConnection;
  window.addEventListener("error", (event) => {
    const error = event.error as Error | undefined;
    errors.push({
      at: Date.now(),
      type: error?.constructor?.name ?? typeof event.error,
      message: String(error?.message ?? event.message).slice(0, 300),
      where: `${event.filename}:${event.lineno}:${event.colno}`,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    const error = event.reason as Error | undefined;
    errors.push({ at: Date.now(), type: `rejection ${error?.constructor?.name}`, message: String(error?.message ?? error).slice(0, 300), where: String(error?.stack ?? "").split("\n")[1] ?? "" });
  });
  // Krisp tells LiveKit it's on with a DOM event on its processed track: note any such event.
  const krispEvents: string[] = [];
  (w["__soak"] as Record<string, unknown>)["krispEvents"] = krispEvents;
  const dispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (event: Event) {
    if (/krisp/i.test(event.type)) krispEvents.push(`${event.type} on ${this?.constructor?.name}`);
    return dispatch.call(this, event);
  };
  // Which devices the page asked for, to check a switch reached the device.
  const asked: string[] = [];
  (w["__soak"] as Record<string, unknown>)["asked"] = asked;
  const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = (constraints?: MediaStreamConstraints) => {
    for (const kind of ["audio", "video"] as const) {
      const c = constraints?.[kind];
      if (c) asked.push(`${kind}:${JSON.stringify(typeof c === "object" ? (c.deviceId ?? "any") : "any")}`);
    }
    return gum(constraints);
  };
  const create = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (object: Blob | MediaSource) => {
    const url = create(object);
    if (object instanceof Blob) {
      const entry = { at: Date.now(), url, type: object.type, size: object.size, head: "" };
      blobs.push(entry);
      if (/javascript|text/.test(object.type)) void object.slice(0, 160).text().then((t) => (entry.head = t));
    }
    return url;
  };
};

type Snapshot = {
  krispEvents: string[];
  visibility: string;
  focused: boolean;
  route: string;
  status: string;
  states: { at: number; pc: number; state: string }[];
  errors: { at: number; type: string; message: string; where: string }[];
  blobs: { at: number; url: string; type: string; size: number; head: string }[];
  audio: { packets: number; lost: number; concealed: number; silent: number; samples: number; tracks: number };
};

/** What one page says about itself now: visibility, the dock's status, and its received audio. */
function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(async () => {
    const soak = (window as unknown as { __soak: { pcs: RTCPeerConnection[]; states: never[]; errors: never[]; blobs: never[] } }).__soak;
    const audio = { packets: 0, lost: 0, concealed: 0, silent: 0, samples: 0, tracks: 0 };
    for (const pc of soak.pcs) {
      if (pc.connectionState === "closed") continue;
      const stats = await pc.getStats();
      stats.forEach((s: Record<string, unknown>) => {
        if (s["type"] !== "inbound-rtp" || s["kind"] !== "audio") return;
        audio.tracks++;
        audio.packets += Number(s["packetsReceived"] ?? 0);
        audio.lost += Number(s["packetsLost"] ?? 0);
        audio.concealed += Number(s["concealedSamples"] ?? 0);
        audio.silent += Number(s["silentConcealedSamples"] ?? 0);
        audio.samples += Number(s["totalSamplesReceived"] ?? 0);
      });
    }
    return {
      krispEvents: (soak as unknown as { krispEvents: string[] }).krispEvents,
      visibility: document.visibilityState,
      focused: document.hasFocus(),
      route: document.querySelector("[aria-current='page']")?.textContent?.trim() ?? "",
      status: document.querySelector(".call-dock-where b")?.textContent ?? "no dock",
      states: soak.states,
      errors: soak.errors,
      blobs: soak.blobs,
      audio,
    };
  });
}

// ---------- people ----------

type Person = { name: "a" | "b"; email: string; password: string; app: ElectronApplication; page: Page; memberId?: string };

async function credentials(name: "a" | "b") {
  const file = join(soakDir, `credentials-${name}.json`);
  try {
    return JSON.parse(await readFile(file, "utf8")) as { email: string; password: string };
  } catch {
    const creds = { email: `uplink-soak-${name}+clerk_test@example.com`, password: randomBytes(18).toString("base64url") };
    await writeFile(file, JSON.stringify(creds), { mode: 0o600 });
    return creds;
  }
}

async function launch(name: "a" | "b"): Promise<Person> {
  const env = {
    ...process.env,
    UPLINK_QUIET: "1",
    UPLINK_NO_TELEMETRY: "1",
    UPLINK_NO_BRIDGE: "1",
    UPLINK_NO_UPDATES: "1",
    UPLINK_NOTIFY_LOG: join(soakDir, `notifications-${name}.jsonl`),
  } as Record<string, string>;
  delete env["ELECTRON_RUN_AS_NODE"];
  delete env["ELECTRON_RENDERER_URL"];
  const electronApp = await electron.launch({
    args: [app, `--user-data-dir=${join(soakDir, `profile-${name}`)}`, "--use-fake-device-for-media-stream=device-count=2", "--use-fake-ui-for-media-stream", "--use-mock-keychain"],
    executablePath: electronPath as unknown as string,
    env,
  });
  await electronApp.context().addInitScript(observer);
  const page = await electronApp.firstWindow();
  page.on("console", (m) => {
    if (m.type() === "error" || /krisp|noise|heartbeat/i.test(m.text())) log(`[${name} console ${m.type()}]`, m.text().slice(0, 240));
  });
  page.on("pageerror", (e) => log(`[${name} pageerror]`, e.name, e.message.slice(0, 200)));
  await page.waitForLoadState("domcontentloaded");
  // No banners or sounds on the computer this runs on, and no welcome tour.
  await page.evaluate(() => {
    localStorage.setItem("uplink.notifications", "off");
    localStorage.setItem("uplink.sounds", "off");
    localStorage.setItem("uplink.onboarded", "yes");
  });
  await page.reload();
  return { name, ...(await credentials(name)), app: electronApp, page };
}

async function signIn(person: Person) {
  const { page } = person;
  const gate = page.locator("input[name='identifier'], input[name='emailAddress']").first();
  const signedIn = page.getByText("Hi, I'm Link").or(page.locator(".sidebar")).first();
  await gate.or(signedIn).waitFor({ timeout: 60_000 });
  if (await gate.isVisible()) {
    await gate.fill(person.email);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.locator("input[type='password']").first().waitFor({ timeout: 15_000 });
    await page.locator("input[type='password']").first().fill(person.password);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const code = page.locator("input[autocomplete='one-time-code'], input[name='codeInput']").first();
    await code.or(signedIn).waitFor({ timeout: 20_000 });
    if (await code.isVisible()) await page.keyboard.type("424242", { delay: 80 });
  }
  await signedIn.waitFor({ timeout: 60_000 });
}

type ClerkGlobal = { Clerk: { session: { getToken(o?: { skipCache?: boolean }): Promise<string> } } };
function room(person: Person) {
  const convex = new ConvexHttpClient(convexUrl!);
  const auth = async () =>
    convex.setAuth(await person.page.evaluate(() => (window as unknown as ClerkGlobal).Clerk.session.getToken({ skipCache: true })));
  return {
    async mutation<T>(ref: unknown, args: Record<string, unknown>): Promise<T> {
      await auth();
      return (convex.mutation as (r: unknown, a: unknown) => Promise<T>)(ref, args);
    },
    async query<T>(ref: unknown, args: Record<string, unknown>): Promise<T> {
      await auth();
      return (convex.query as (r: unknown, a: unknown) => Promise<T>)(ref, args);
    },
  };
}

// ---------- the deployment's rows ----------

type Participation = { _id: string; memberId: string; joinedAt: number; lastSeenAt: number; leftAt?: number; callId: string };

async function participations(): Promise<Participation[]> {
  const { stdout } = await run("npx", ["convex", "data", "callParticipations", "--limit", "40", "--order", "desc", "--format", "jsonLines"], {
    cwd: backendDir,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Participation);
}

/** LiveKit's AudioTrackFeature numbers (livekit_models.proto). */
const AUDIO_FEATURES: Record<string, number> = {
  TF_STEREO: 0,
  TF_NO_DTX: 1,
  TF_AUTO_GAIN_CONTROL: 2,
  TF_ECHO_CANCELLATION: 3,
  TF_NOISE_SUPPRESSION: 4,
  TF_ENHANCED_NOISE_CANCELLATION: 5,
  TF_PRECONNECT_BUFFER: 6,
};

/** The call's LiveKit room from LiveKit's API: each track and its audio features (5 is Krisp). */
async function liveKitRoom(url: string, callId: string) {
  if (!liveKitSecret || !liveKitKey) return null;
  const roomName = `call_${callId}`;
  const now = Math.floor(Date.now() / 1000);
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${part({ alg: "HS256", typ: "JWT" })}.${part({ iss: liveKitKey, sub: "call-soak", nbf: now - 10, exp: now + 120, video: { roomAdmin: true, room: roomName, roomList: true } })}`;
  const token = `${unsigned}.${createHmac("sha256", liveKitSecret).update(unsigned).digest("base64url")}`;
  const base = url.replace(/^ws/, "http");
  const post = async (method: string, body: unknown) => {
    const response = await fetch(`${base}/twirp/livekit.RoomService/${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method}: ${response.status}`);
    return response.json();
  };
  const { rooms = [] } = (await post("ListRooms", {})) as { rooms?: { name: string }[] };
  const name = rooms.find((r) => r.name.endsWith(callId))?.name ?? roomName;
  type ListedTrack = { source?: string; type?: string; audioFeatures?: (string | number)[]; audio_features?: (string | number)[] };
  const { participants = [] } = (await post("ListParticipants", { room: name })) as { participants?: { identity: string; tracks?: ListedTrack[] }[] };
  // Twirp's JSON can use the proto's own field names (audio_features) and enum names.
  return participants.map((p) => ({
    identity: p.identity,
    tracks: (p.tracks ?? []).map((t) => ({
      source: t.source ?? t.type,
      muted: Boolean((t as { muted?: boolean }).muted),
      audioFeatures: (t.audioFeatures ?? t.audio_features ?? []).map((f) => (typeof f === "number" ? f : (AUDIO_FEATURES[f] ?? f))),
    })),
  }));
}

// ---------- the run ----------

await mkdir(soakDir, { recursive: true });
log(`soak ${label}: ${plan}, ${minutes} min, app ${app}, deployment ${new URL(convexUrl).hostname}`);
const a = await launch("a");
const b = await launch("b");
const people = [a, b];
const result: Record<string, unknown> = { label, plan, minutes, backgroundMinutes, app, startedAt: new Date(started).toISOString() };
try {
  await Promise.all(people.map(signIn));
  log("both signed in");
  const asA = room(a);
  const asB = room(b);
  // One team for the soak, made once and reused.
  type Team = { teamId: string; name: string; memberId: string };
  let teams = await asA.query<Team[]>(api.teams.mine, {});
  let team = teams.find((t) => t.name === "Call soak (test data)");
  if (!team) {
    await asA.mutation(api.teams.create, { name: "Call soak (test data)" });
    teams = await asA.query<Team[]>(api.teams.mine, {});
    team = teams.find((t) => t.name === "Call soak (test data)")!;
  }
  const teamId = team.teamId;
  a.memberId = team.memberId;
  let bTeam = (await asB.query<Team[]>(api.teams.mine, {})).find((t) => t.teamId === teamId);
  if (!bTeam) {
    const { token } = await asA.mutation<{ token: string }>(api.invites.create, { teamId, email: b.email });
    await asB.mutation(api.invites.accept, { token });
    bTeam = (await asB.query<Team[]>(api.teams.mine, {})).find((t) => t.teamId === teamId)!;
  }
  b.memberId = bTeam.memberId;
  type Channel = { channelId: string; name: string; kind?: string };
  const channels = await asA.query<Channel[]>(api.channels.list, { teamId });
  if (!channels.some((c) => c.name === "soak-other")) await asA.mutation(api.channels.create, { teamId, name: "soak-other" });
  await asA.mutation(api.channels.openDirect, { teamId, memberIds: [b.memberId] });
  log("team ready", teamId);

  // Each app opens the team (the only one) and its #general.
  for (const p of people) {
    await p.page.reload();
    await p.page.locator(".sidebar").waitFor({ timeout: 60_000 });
    // A conversation row opens the channel; its room in Voice (an option, not a button) would join.
    await p.page.locator(".sidebar button.nav-item", { hasText: /^general/ }).first().click();
  }
  // B starts the call by joining it; A joins from the call bar, or with `--plan devices` from the
  // channel's room in Voice (DESIGN.md, Calls).
  await b.page.getByRole("button", { name: "Join call" }).click();
  await b.page.locator(".call-dock").waitFor({ timeout: 30_000 });
  await a.page.getByRole("button", { name: "Join call" }).waitFor({ timeout: 30_000 });
  if (plan === "devices") {
    const room = a.page.locator(".voice-rooms .voice-room", { hasText: /^general/ }).first();
    log(`A's #general room says: "${await room.getAttribute("aria-label")}"`);
    await a.page.locator(".sidebar .nav-item", { hasText: /^Inbox/ }).first().click();
    await room.click();
    result["voiceRoomJoined"] = await a.page.locator(".call-dock").waitFor({ timeout: 30_000 }).then(() => true, () => false);
    log(`A joined from #general's room in Voice: ${result["voiceRoomJoined"]}`);
  } else {
    await a.page.getByRole("button", { name: "Join call" }).click();
  }
  await a.page.locator(".call-dock").waitFor({ timeout: 30_000 });
  const joinedAt = Date.now();
  log("both joined");

  // ---- sampling ----
  const samples: { t: number; a: Snapshot; b: Snapshot; rows: Participation[] }[] = [];
  let stop = false;
  const sampler = (async () => {
    while (!stop) {
      const t = Date.now();
      try {
        const [sa, sb, rows] = await Promise.all([snapshot(a.page), snapshot(b.page), participations()]);
        samples.push({ t, a: sa, b: sb, rows: rows.filter((r) => r.memberId === a.memberId || r.memberId === b.memberId) });
      } catch (error) {
        log("sample failed:", (error as Error).message.slice(0, 200));
      }
      await sleep(Math.max(0, 5000 - (Date.now() - t)));
    }
  })();
  const firstRoom = await (async () => {
    await sleep(8000);
    const rows = await participations();
    const mine = rows.find((r) => r.memberId === a.memberId && r.leftAt === undefined);
    return mine ? await liveKitRoom("wss://uplink-room-8az2pkns.livekit.cloud", mine.callId).catch((e: Error) => e.message) : null;
  })();
  result["liveKitAtStart"] = firstRoom;
  log("LiveKit room at start:", JSON.stringify(firstRoom));

  // ---- what A does ----
  const window = (method: "minimize" | "restore" | "hide" | "show" | "blur" | "focus") =>
    a.app.evaluate(({ BrowserWindow }, m) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      (win as unknown as Record<string, () => void>)[m]!();
    }, method);
  const click = async (what: string) => {
    const page = a.page;
    try {
      if (what === "inbox") await page.locator(".sidebar .nav-item", { hasText: /^Inbox/ }).first().click();
      else if (what === "settings-calls") {
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.locator(".settings-nav .nav-item", { hasText: "Calls" }).click();
      } else if (what === "settings-diagnostics") {
        await page.getByRole("button", { name: "Settings", exact: true }).click();
        await page.locator(".settings-nav .nav-item", { hasText: "Diagnostics" }).click();
      } else if (what === "other") await page.locator(".sidebar button.nav-item", { hasText: /^soak-other/ }).first().click();
      else if (what === "dm") await page.locator(".sidebar .dm-item").first().click();
      else if (what === "general") await page.locator(".sidebar button.nav-item", { hasText: /^general/ }).first().click();
      log(`A opened ${what}`);
    } catch (error) {
      log(`A couldn't open ${what}:`, (error as Error).message.split("\n")[0]);
    }
  };
  const until = (minute: number) => joinedAt + minute * 60_000;
  const tour = ["inbox", "settings-calls", "other", "dm", "settings-diagnostics", "general"];
  const wander = async (end: number) => {
    let i = 0;
    while (Date.now() < end - 5000) {
      await click(tour[i++ % tour.length]!);
      await sleep(Math.min(30_000 + Math.random() * 30_000, Math.max(0, end - Date.now())));
    }
  };
  if (plan === "drop") {
    await wander(until(2));
    // A mutes from the dock.
    await a.page.locator(".call-dock").getByRole("button", { name: "Mute", exact: true }).click();
    log("A muted");
    await sleep(Math.max(0, until(3) - Date.now()));
    // The room drops A's join, as the presence check does for a quiet one.
    const live = (await participations()).find((r) => r.memberId === a.memberId && r.leftAt === undefined)!;
    await asA.mutation(api.calls.leave, { teamId, participationId: live._id });
    const droppedAt = Date.now();
    log(`room dropped A's join ${live._id.slice(0, 8)}`);
    let back: Participation | undefined;
    for (let i = 0; i < 24 && !back; i++) {
      await sleep(2500);
      back = (await participations()).find((r) => r.memberId === a.memberId && r.leftAt === undefined && r._id !== live._id);
    }
    await sleep(6000);
    const row = back ? (await participations()).find((r) => r._id === back!._id) : undefined;
    const dockMuted = await a.page.locator(".call-dock").getByRole("button", { name: "Unmute", exact: true }).isVisible().catch(() => false);
    const liveKit = back ? await liveKitRoom("wss://uplink-room-8az2pkns.livekit.cloud", back.callId).catch((e: Error) => e.message) : null;
    const aTrack = Array.isArray(liveKit) ? liveKit.find((p) => p.identity.endsWith(back!._id))?.tracks.find((t) => t.source === "MICROPHONE") : undefined;
    result["drop"] = {
      rejoinedAfterSeconds: back ? Math.round((back.joinedAt - droppedAt) / 1000) : null,
      newJoin: back?._id.slice(0, 8) ?? null,
      roomRowMuted: (row as (Participation & { muted?: boolean }) | undefined)?.muted ?? null,
      dockShowsUnmute: dockMuted,
      liveKitMicMuted: aTrack?.muted ?? null,
      liveKitMicFeatures: aTrack?.audioFeatures ?? null,
    };
    log("drop result", JSON.stringify(result["drop"]));
    await wander(until(5));
    log("A minimized");
    await window("minimize");
    await sleep(Math.max(0, until(8) - Date.now()));
    await window("restore");
    log("A restored");
    await wander(until(minutes));
  } else if (plan === "sleep") {
    await sleep(60_000);
    const root = a.app.process().pid!;
    const tree = async (pid: number): Promise<number[]> => {
      const { stdout } = await run("pgrep", ["-P", String(pid)]).catch(() => ({ stdout: "" }));
      const kids = stdout.split("\n").filter(Boolean).map(Number);
      return [pid, ...(await Promise.all(kids.map(tree))).flat()];
    };
    const pids = await tree(root);
    log(`A asleep: stopping ${pids.length} processes for ${frozenSeconds} s`);
    const asleepAt = Date.now();
    for (const pid of pids) process.kill(pid, "SIGSTOP");
    await sleep(frozenSeconds * 1000);
    for (const pid of pids.reverse()) process.kill(pid, "SIGCONT");
    const wokeAt = Date.now();
    log("A awake");
    // How long until A is in the call again with a live join that's beating.
    let back: number | null = null;
    for (let i = 0; i < 36 && back === null; i++) {
      await sleep(5000);
      const rows = await participations();
      const live = rows.find((r) => r.memberId === a.memberId && r.leftAt === undefined && r.lastSeenAt > wokeAt);
      const status = await a.page.locator(".call-dock-where b").textContent().catch(() => null);
      if (live && status === "In call") back = Date.now() - wokeAt;
    }
    result["sleep"] = { asleepSeconds: Math.round((wokeAt - asleepAt) / 1000), backAfterSeconds: back === null ? null : Math.round(back / 1000) };
    log("sleep result", JSON.stringify(result["sleep"]));
    await sleep(Math.max(0, minutes * 60_000 - (Date.now() - joinedAt)));
  } else if (plan === "devices") {
    await sleep(8000);
    const page = a.page;
    const asked = () => page.evaluate(() => (window as unknown as { __soak: { asked: string[] } }).__soak.asked.slice());
    const before = (await asked()).length;
    // The camera: its preview first, then on.
    await page.getByRole("button", { name: "Turn camera on" }).click();
    await page.getByRole("dialog", { name: "Camera preview" }).waitFor();
    await sleep(2500);
    result["previewOpened"] = (await asked()).slice(before);
    await page.getByRole("button", { name: "Turn on camera", exact: true }).click();
    await sleep(4000);
    // Call settings: another microphone, camera and speaker.
    await page.getByRole("button", { name: "Call settings" }).click();
    const pick = async (id: string) => {
      // The list loads after the popover opens.
      await page.waitForFunction((sel) => document.querySelectorAll(`${sel} option`).length > 1, `#${id}`, { timeout: 10_000 }).catch(() => {});
      const options = await page.locator(`#${id} option`).evaluateAll((all) => all.map((o) => [(o as HTMLOptionElement).value, o.textContent ?? ""]));
      // Another device than the one chosen now (a profile keeps the last run's choice).
      const now = await page.locator(`#${id}`).inputValue();
      const other = options.find(([value]) => value !== "default" && value !== now);
      if (!other) return `no other device for ${id}`;
      await page.selectOption(`#${id}`, other[0]!);
      await sleep(3000);
      return `${id}: picked "${other[1]}"`;
    };
    const mark = (await asked()).length;
    result["picked"] = [await pick("call-mic"), await pick("call-camera"), await pick("call-speaker")];
    result["askedAfterPicking"] = (await asked()).slice(mark);
    log("picked", JSON.stringify(result["picked"]), "asked for", JSON.stringify(result["askedAfterPicking"]));
    await page.keyboard.press("Escape");
    await sleep(Math.max(0, minutes * 60_000 - 25_000));
  } else if (plan === "join") {
    for (let n = 1; n <= joinCount; n++) {
      if (n > 1) {
        // Join again in the same app session: B starts or joins, then A.
        for (const p of [b, a]) {
          await p.page.getByRole("button", { name: "Leave the call" }).click().catch(() => {});
          await p.page.locator(".call-dock").waitFor({ state: "detached", timeout: 30_000 }).catch(() => {});
        }
        await b.page.getByRole("button", { name: "Join call" }).click();
        await b.page.locator(".call-dock").waitFor({ timeout: 30_000 });
        await a.page.getByRole("button", { name: "Join call" }).click();
        await a.page.locator(".call-dock").waitFor({ timeout: 30_000 });
        log(`both joined again (join ${n})`);
      }
      await sleep(minutes * 60_000);
    }
  } else {
    await wander(until(8));
    log("A minimized");
    await window("minimize");
    await sleep(Math.max(0, until(8 + backgroundMinutes) - Date.now()));
    await window("restore");
    log("A restored");
    await wander(until(8 + backgroundMinutes + 1));
    log("A hidden");
    await window("hide");
    await sleep(Math.max(0, until(8 + backgroundMinutes + 5) - Date.now()));
    await window("show");
    log("A shown");
    await wander(until(minutes));
  }
  result["liveKitAtEnd"] = await (async () => {
    const rows = await participations();
    const mine = rows.find((r) => r.memberId === a.memberId && r.leftAt === undefined);
    return mine ? await liveKitRoom("wss://uplink-room-8az2pkns.livekit.cloud", mine.callId).catch((e: Error) => e.message) : null;
  })();
  stop = true;
  await sampler;

  // ---- the numbers ----
  const summary: Record<string, unknown> = {};
  for (const p of people) {
    const key = p.name;
    const rows = samples.flatMap((s) => s.rows.filter((r) => r.memberId === p.memberId && r.joinedAt >= joinedAt - 60_000));
    const joins = [...new Set(rows.map((r) => r._id))];
    const dropped = joins.filter((id) => rows.some((r) => r._id === id && r.leftAt !== undefined)).length;
    // Heartbeats: lastSeenAt as each sample saw it; a stretch over 30 s without a new value is missed beats.
    let missed = 0;
    let longest = 0;
    for (const id of joins) {
      const seen = samples
        .map((s) => ({ t: s.t, row: s.rows.find((r) => r._id === id) }))
        .filter((x) => x.row && x.row.leftAt === undefined)
        .map((x) => ({ t: x.t, last: x.row!.lastSeenAt }));
      let last = seen[0]?.last ?? 0;
      for (const s of seen) {
        if (s.last !== last) last = s.last;
        const quiet = s.t - last;
        longest = Math.max(longest, quiet);
      }
      const beats = [...new Set(seen.map((s) => s.last))].sort();
      for (let i = 1; i < beats.length; i++) {
        const gap = beats[i]! - beats[i - 1]!;
        if (gap > 30_000) missed += Math.round(gap / 20_000) - 1;
      }
      // A join that never beat again before the end counts from its last beat.
      const end = seen.at(-1);
      if (end && end.t - end.last > 30_000) missed += Math.floor((end.t - end.last) / 20_000);
    }
    const snaps = samples.map((s) => s[key]);
    const states = snaps.at(-1)?.states ?? [];
    const disconnects = states.filter((s) => s.state === "disconnected" || s.state === "failed").length;
    let audioGaps = 0;
    let concealedMs = 0;
    for (let i = 1; i < snaps.length; i++) {
      const before = snaps[i - 1]!.audio;
      const now = snaps[i]!.audio;
      if (now.tracks === 0 || before.tracks === 0) continue;
      const loud = now.concealed - now.silent - (before.concealed - before.silent);
      concealedMs += Math.max(0, loud) / 48;
      if (now.packets - before.packets <= 0 || loud > 4800) audioGaps++;
    }
    summary[key] = {
      joins: joins.length,
      droppedJoins: dropped,
      disconnects,
      missedHeartbeats: missed,
      longestQuietSeconds: Math.round(longest / 1000),
      audioGaps,
      concealedMs: Math.round(concealedMs),
      packetsLost: snaps.at(-1)?.audio.lost ?? 0,
      hiddenSamples: snaps.filter((s) => s.visibility === "hidden").length,
      errors: snaps.at(-1)?.errors ?? [],
      blobs: (snaps.at(-1)?.blobs ?? []).map((x) => ({ type: x.type, size: x.size, head: x.head.slice(0, 80) })),
      lastStatus: snaps.at(-1)?.status,
      krispEvents: snaps.at(-1)?.krispEvents ?? [],
    };
  }
  result["summary"] = summary;
  result["samples"] = samples.map((s) => ({
    t: s.t - joinedAt,
    a: { v: s.a.visibility, f: s.a.focused, status: s.a.status, packets: s.a.audio.packets, concealed: s.a.audio.concealed - s.a.audio.silent, lost: s.a.audio.lost },
    b: { v: s.b.visibility, status: s.b.status, packets: s.b.audio.packets, concealed: s.b.audio.concealed - s.b.audio.silent, lost: s.b.audio.lost },
    rows: s.rows.map((r) => ({ id: r._id.slice(0, 8), member: r.memberId === a.memberId ? "a" : "b", lastSeen: r.lastSeenAt - joinedAt, left: r.leftAt ? r.leftAt - joinedAt : null })),
  }));
  log("summary", JSON.stringify(summary, null, 2));
  // Leave cleanly.
  for (const p of people) await p.page.getByRole("button", { name: "Leave the call" }).click().catch(() => {});
  await sleep(2000);
} finally {
  result["endedAt"] = new Date().toISOString();
  await writeFile(join(soakDir, `${label}.json`), JSON.stringify(result, null, 2));
  for (const p of people) await p.app.close().catch(() => {});
  log(`wrote .soak/${label}.json`);
}
