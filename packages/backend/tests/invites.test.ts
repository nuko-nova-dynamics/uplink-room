import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
  reservedDomain,
  resendFailure,
  resendSender,
  scrubError,
  setEmailSenderForTests,
  type OutgoingEmail,
  type SendResult,
} from "../convex/lib/email";
import { openInviteToken, sealInviteToken } from "../convex/lib/inviteToken";
import { addAgent, callAsAgent, DAY, newRoom, newTeam, signIn, type Person, type Room } from "./setup";

/** Invites: their Room API actions, expiry, and the emails each step sends, with a fake sender. */

const MINUTE = 60 * 1000;
/** WebCrypto (sealing tokens) and React's server renderer finish in real time, whatever the fake clock says. */
const realSetTimeout = globalThis.setTimeout;
const realSleep = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));

/** Test keys for INVITE_TOKEN_KEYS: 32 bytes each, in base64. */
const KEY_A = "a:" + btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i)));
const KEY_B = "b:" + btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => 255 - i)));

let sent: OutgoingEmail[];
/** What the fake sender answers next; it answers ok once these run out. */
let answers: SendResult[];

beforeEach(() => {
  vi.useFakeTimers({
    now: new Date("2026-11-04T15:00:00Z"),
    toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
  });
  // Test keys that seal invite tokens. The fake sender stands in for Resend, so nothing is sent.
  vi.stubEnv("INVITE_TOKEN_KEYS", KEY_A);
  sent = [];
  answers = [];
  setEmailSenderForTests(async (email) => {
    sent.push(email);
    return answers.shift() ?? { ok: true, id: `resend-${sent.length}` };
  });
});

afterEach(() => {
  setEmailSenderForTests(null);
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/**
 * Moves the clock `ms` ahead and runs what the room scheduled up to then, as the scheduler would.
 * Four rounds cover the longest chain here: a reminder, the send it schedules, and that send's
 * claim and result.
 */
async function run(t: Room, ms = 0) {
  if (ms) vi.advanceTimersByTime(ms);
  for (let i = 0; i < 4; i++) {
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
    await realSleep(5);
  }
}

/** Runs each retry an email schedules after a failure, one delay at a time. */
async function runRetries(t: Room) {
  for (const delay of RETRY_DELAYS_MS) await run(t, delay);
}

async function invite(t: Room, teamId: Id<"teams">, admin: Person, email = "ana@example.com", extra = {}) {
  const made = await admin.as.mutation(api.invites.create, { teamId, email, ...extra });
  await run(t);
  return made;
}

async function waiting(admin: Person, teamId: Id<"teams">) {
  return admin.as.query(api.invites.list, { teamId });
}

test("an invite emails a join link with the token in its fragment, who invited them and to which team", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const made = await invite(t, teamId, admin);

  expect(made.url).toBe(`https://uplinkroom.com/invite#${made.token}`);
  expect(sent).toHaveLength(1);
  const [email] = sent;
  expect(email!.to).toBe("ana@example.com");
  expect(email!.subject).toBe("Julio invited you to Nuko Nova on Uplink Room");
  expect(email!.idempotencyKey).toBe(`invite/${made.inviteId}/1`);
  for (const body of [email!.html, email!.text]) {
    expect(body).toContain(made.url);
    expect(body).toContain(made.token);
    expect(body).toContain("https://uplinkroom.com/download");
  }
  expect(email!.html).toContain("Join on Uplink Room");
  // One title, the subject; the text version keeps the heading's case.
  expect(email!.html.match(/<title>/g)).toHaveLength(1);
  expect(email!.html).toContain(`<title>${email!.subject}</title>`);
  expect(email!.text).toContain("Join Nuko Nova on Uplink Room");
  // Nothing in it loads from anywhere: no pixel, no remote image or font.
  expect(email!.html).not.toMatch(/<img|<link|@import|url\(/i);

  const [row] = await waiting(admin, teamId);
  expect(row).toMatchObject({ email: "ana@example.com", canCopyLink: true });
  expect(row!.expiresAt! - row!.invitedAt).toBe(7 * DAY);
  expect(row!.emailState).toMatchObject({ kind: "invite", status: "sent", error: null });
});

test("invites.create stays as it was for callers that pass only an email, and sendEmail false sends nothing", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const quiet = await invite(t, teamId, admin, "sam@example.com", { sendEmail: false });
  expect(quiet).toMatchObject({ inviteId: expect.any(String), token: expect.stringMatching(/^uri_[0-9a-f]{48}$/) });
  await run(t, 4 * DAY);
  expect(sent).toHaveLength(0);

  const sam = await signIn(t, "Sam");
  await sam.as.mutation(api.invites.accept, { token: quiet.token });
  expect((await admin.as.query(api.teams.members, { teamId })).map((m) => m.name)).toContain("Sam");
});

test("regenerate makes a new token at once, the old one stops working, and the new link is emailed", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const first = await invite(t, teamId, admin);
  const second = await admin.as.mutation(api.invites.regenerate, { teamId, inviteId: first.inviteId });
  await run(t);

  expect(second.token).not.toBe(first.token);
  expect(second.emailed).toBe(true);
  const ana = await signIn(t, "Ana");
  await expect(ana.as.mutation(api.invites.accept, { token: first.token })).rejects.toThrow(/isn't valid/);
  expect(await ana.as.query(api.invites.preview, { token: first.token })).toEqual({ state: "invalid" });
  expect(sent.map((e) => e.idempotencyKey)).toEqual([`invite/${first.inviteId}/1`, `invite/${first.inviteId}/2`]);
  expect(sent[1]!.html).toContain(second.url);

  await ana.as.mutation(api.invites.accept, { token: second.token });
  expect(await waiting(admin, teamId)).toEqual([]);
});

test("resend emails the invite again with a fresh token, and the old token stops working", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const first = await invite(t, teamId, admin, "ana@example.com", { sendEmail: false });
  const again = await admin.as.mutation(api.invites.resend, { teamId, inviteId: first.inviteId });
  await run(t);

  expect(sent).toHaveLength(1);
  expect(sent[0]!.html).toContain(again.token);
  const ana = await signIn(t, "Ana");
  await expect(ana.as.mutation(api.invites.accept, { token: first.token })).rejects.toThrow(/isn't valid/);
  await ana.as.mutation(api.invites.accept, { token: again.token });
});

test("revoke stops the token at once, drops the invite from the list, and no reminder follows", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const made = await invite(t, teamId, admin);
  await admin.as.mutation(api.invites.revoke, { teamId, inviteId: made.inviteId });
  await run(t, 4 * DAY);

  expect(sent.map((e) => e.idempotencyKey)).toEqual([`invite/${made.inviteId}/1`]);
  expect(await waiting(admin, teamId)).toEqual([]);
  const ana = await signIn(t, "Ana");
  await expect(ana.as.mutation(api.invites.accept, { token: made.token })).rejects.toThrow(/isn't valid/);
  await expect(admin.as.mutation(api.invites.link, { teamId, inviteId: made.inviteId })).rejects.toThrow(/revoked/);
});

test("an invite expires after 7 days unless it says otherwise, and accept refuses an expired token", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const week = await invite(t, teamId, admin, "ana@example.com");
  const day = await invite(t, teamId, admin, "ben@example.com", { expiresInDays: 1 });
  await expect(admin.as.mutation(api.invites.create, { teamId, email: "x@example.com", expiresInDays: 0 })).rejects.toThrow(
    /1 to 30 days/,
  );
  const listed = await waiting(admin, teamId);
  expect(listed.map((i) => i.expiresAt! - i.invitedAt)).toEqual([7 * DAY, DAY]);

  vi.advanceTimersByTime(DAY + MINUTE);
  const ben = await signIn(t, "Ben");
  await expect(ben.as.mutation(api.invites.accept, { token: day.token })).rejects.toThrow(/expired/);
  expect(await ben.as.query(api.invites.preview, { token: day.token })).toMatchObject({ state: "expired", teamName: "Nuko Nova" });

  vi.advanceTimersByTime(6 * DAY);
  const ana = await signIn(t, "Ana");
  await expect(ana.as.mutation(api.invites.accept, { token: week.token })).rejects.toThrow(/expired/);
  // Still listed, so an admin can regenerate it.
  expect((await waiting(admin, teamId)).map((i) => i.email)).toEqual(["ana@example.com", "ben@example.com"]);
});

test("an invite nobody accepted gets one reminder after 3 days, with the same link, and never a second", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const made = await invite(t, teamId, admin);
  await run(t, 3 * DAY - MINUTE);
  expect(sent).toHaveLength(1);

  await run(t, 2 * MINUTE);
  expect(sent.map((e) => e.idempotencyKey)).toEqual([`invite/${made.inviteId}/1`, `reminder/${made.inviteId}`]);
  expect(sent[1]!.subject).toBe("Reminder: Julio invited you to Nuko Nova on Uplink Room");
  expect(sent[1]!.html).toContain(made.url);
  expect((await waiting(admin, teamId))[0]!.emailState).toMatchObject({ kind: "reminder", status: "sent" });

  // A second run of the reminder (a duplicate schedule) sends nothing more.
  await t.mutation(internal.invites.remind, { inviteId: made.inviteId, generation: 1 });
  await run(t, 3 * DAY);
  expect(sent).toHaveLength(2);
});

test("no reminder goes out after the token is regenerated, or while the team has reminders off", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const regenerated = await invite(t, teamId, admin, "ana@example.com");
  await admin.as.mutation(api.invites.regenerate, { teamId, inviteId: regenerated.inviteId });
  await admin.as.mutation(api.teams.setInviteReminders, { teamId, inviteReminders: "off" });
  await invite(t, teamId, admin, "ben@example.com");
  await run(t, 4 * DAY);

  expect(sent.map((e) => e.idempotencyKey.split("/")[0])).toEqual(["invite", "invite", "invite"]);
  expect(await admin.as.query(api.teams.settings, { teamId })).toMatchObject({ inviteReminders: "off" });
});

test("joining sends the person a welcome with links into the app, and the inviter a joined email they can turn off", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const general = (await admin.as.query(api.channels.list, { teamId })).find((c) => c.name === "general")!;

  const forAna = await invite(t, teamId, admin, "ana@example.com");
  const ana = await signIn(t, "Ana");
  await ana.as.mutation(api.invites.accept, { token: forAna.token });
  await run(t);
  const welcome = sent.find((e) => e.idempotencyKey === `welcome/${forAna.inviteId}`)!;
  expect(welcome.to).toBe("ana@example.com");
  expect(welcome.subject).toBe("Welcome to Nuko Nova on Uplink Room");
  for (const place of [`channel/${general.channelId}`, "settings/machines", "settings/agents"]) {
    expect(welcome.html).toContain(`https://uplinkroom.com/open#team/${teamId}/${place}`);
  }
  expect(welcome.html).toContain("https://uplinkroom.com/download");
  const joined = sent.find((e) => e.idempotencyKey === `joined/${forAna.inviteId}`)!;
  expect(joined).toMatchObject({ to: "julio@example.com", subject: "Ana joined Nuko Nova" });

  // Julio turns "someone you invited joins" off: Ben's joining sends only Ben's welcome.
  await admin.as.mutation(api.members.setEmailNotifications, { teamId, joined: "off" });
  expect(await admin.as.query(api.members.emailNotifications, { teamId })).toEqual({ joined: "off", email: "julio@example.com" });
  const forBen = await invite(t, teamId, admin, "ben@example.com");
  const ben = await signIn(t, "Ben");
  await ben.as.mutation(api.invites.accept, { token: forBen.token });
  await run(t);
  expect(sent.filter((e) => e.idempotencyKey.endsWith(forBen.inviteId)).map((e) => e.idempotencyKey.split("/")[0])).toEqual([
    "welcome",
  ]);
});

test("a transient send failure is retried with the same idempotency key and recorded as sent", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  answers = [{ ok: false, retryable: true, error: "Resend answered 503: Service unavailable" }];
  const made = await invite(t, teamId, admin);
  expect((await waiting(admin, teamId))[0]!.emailState).toEqual({
    kind: "invite",
    status: "sending",
    at: expect.any(Number),
    error: "Resend answered 503: Service unavailable",
  });

  await run(t, 30_000);
  expect(sent.map((e) => e.idempotencyKey)).toEqual([`invite/${made.inviteId}/1`, `invite/${made.inviteId}/1`]);
  expect((await waiting(admin, teamId))[0]!.emailState).toMatchObject({ status: "sent", error: null });
});

test("a permanent failure, or one that outlasts every retry, is recorded as failed with its error", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  answers = [{ ok: false, retryable: false, error: "Resend answered 422: Invalid `to` field." }];
  await invite(t, teamId, admin, "ana@example.com");
  await run(t, 2 * 60 * MINUTE);
  expect(sent).toHaveLength(1);
  expect((await waiting(admin, teamId))[0]!.emailState).toMatchObject({
    status: "failed",
    error: "Resend answered 422: Invalid `to` field.",
  });

  answers = Array.from({ length: MAX_ATTEMPTS }, () => ({ ok: false as const, retryable: true, error: "Resend answered 500" }));
  await invite(t, teamId, admin, "ben@example.com");
  await runRetries(t);
  expect(sent).toHaveLength(1 + MAX_ATTEMPTS);
  expect((await waiting(admin, teamId))[1]!.emailState).toMatchObject({ status: "failed", error: "Resend answered 500" });
});

test("addresses at reserved test domains, such as Clerk's +clerk_test@example.com, never reach Resend", async () => {
  vi.stubEnv("RESEND_API_KEY", "re_test_never_used_0123");
  vi.stubEnv("EMAIL_FROM", "Uplink Room <hello@mail.uplinkroom.com>");
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  try {
    for (const to of ["ana+clerk_test@example.com", "bo@Example.ORG", "x@mail.example", "y@host.invalid", "z@a.test"]) {
      expect(reservedDomain(to)).toBe(true);
      const result = await resendSender({ to, subject: "s", html: "<p>h</p>", text: "t", idempotencyKey: "k", tags: [] });
      expect(result).toEqual({ ok: false, retryable: false, error: `${to} is at a reserved test domain that receives no mail, so nothing was sent.` });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const to of ["jdiaz@miamiweb.ai", "ana@examples.com", "bo@example.co", "c@testing.dev"]) expect(reservedDomain(to)).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("Resend's answers map to retry or fail, and no recorded error carries the API key", () => {
  expect(resendFailure(429, { name: "rate_limit_exceeded", message: "Too many requests" }).retryable).toBe(true);
  expect(resendFailure(500, null).retryable).toBe(true);
  expect(resendFailure(409, { name: "concurrent_idempotent_requests" }).retryable).toBe(true);
  expect(resendFailure(409, { name: "invalid_idempotent_request" }).retryable).toBe(false);
  expect(resendFailure(422, { message: "Invalid `to` field." })).toEqual({
    ok: false,
    retryable: false,
    error: "Resend answered 422: Invalid `to` field.",
  });
  const env = { RESEND_API_KEY: "re_live_SECRETsecret123" };
  expect(scrubError("401: API key re_live_SECRETsecret123 is invalid", env)).toBe("401: API key [key] is invalid");
  expect(scrubError("key re_otherKEY_998877 leaked", env)).toBe("key [key] leaked");
});

test("Copy link gives back the token the email carried; only admins get it", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const made = await invite(t, teamId, admin, "carla@example.com");
  expect(await admin.as.mutation(api.invites.link, { teamId, inviteId: made.inviteId })).toMatchObject({
    token: made.token,
    url: made.url,
  });
  const forAna = await invite(t, teamId, admin, "ana@example.com");
  const ana = await signIn(t, "Ana");
  await ana.as.mutation(api.invites.accept, { token: forAna.token });
  await expect(
    ana.as.mutation(api.invites.link, { teamId, inviteId: made.inviteId }),
  ).rejects.toThrow(/Only admins/);
});

test("the Join dialog's preview names the team and who invited them", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const made = await invite(t, teamId, admin, "ana@example.com", { role: "admin" });
  const ana = await signIn(t, "Ana");
  expect(await ana.as.query(api.invites.preview, { token: made.token })).toMatchObject({
    state: "valid",
    teamId,
    teamName: "Nuko Nova",
    inviterName: "Julio",
    role: "admin",
    alreadyMember: false,
    account: "match",
    email: "ana@example.com",
  });
  await expect(t.query(api.invites.preview, { token: made.token })).rejects.toThrow(/Sign in/);
});

test("an invite works only for its address: another account is refused, told whom it's for, and the invite stays", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const made = await invite(t, teamId, admin, "ana@company.com", { role: "admin" });
  const bob = await signIn(t, "Bob", "bob@x.com");

  expect(await bob.as.query(api.invites.preview, { token: made.token })).toMatchObject({
    state: "valid",
    account: "other",
    inviteFor: "a…@company.com",
    signedInAs: "b…@x.com",
    email: null,
  });
  await expect(bob.as.mutation(api.invites.accept, { token: made.token })).rejects.toThrow(
    "This invite is for a…@company.com. You're signed in as b…@x.com.",
  );
  // Another address is another account whether or not it's verified.
  const unverifiedBob = await signIn(t, "Bo", "bo@x.com", false);
  expect(await unverifiedBob.as.query(api.invites.preview, { token: made.token })).toMatchObject({ account: "other" });
  await expect(unverifiedBob.as.mutation(api.invites.accept, { token: made.token })).rejects.toThrow(/You're signed in as b…@x.com/);
  expect((await admin.as.query(api.teams.members, { teamId })).map((m) => m.name)).not.toContain("Bob");

  const ana = await signIn(t, "Ana", "ana@company.com");
  await ana.as.mutation(api.invites.accept, { token: made.token });
  expect((await admin.as.query(api.teams.members, { teamId })).find((m) => m.name === "Ana")?.role).toBe("admin");
});

test("a sign-in without a verified email can't accept, even at the invited address", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const made = await invite(t, teamId, admin, "ana@example.com");
  const unverified = await signIn(t, "Ana", "ana@example.com", false);
  expect(await unverified.as.query(api.invites.preview, { token: made.token })).toMatchObject({ account: "unverified" });
  await expect(unverified.as.mutation(api.invites.accept, { token: made.token })).rejects.toThrow(
    /doesn't show a verified email address/,
  );
  expect(await waiting(admin, teamId)).toHaveLength(1);
});

test("the invited address matches whatever its case", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const made = await invite(t, teamId, admin, "Ana.Ruiz@Example.com");
  const ana = await signIn(t, "Ana", "ANA.RUIZ@example.COM");
  expect(await ana.as.query(api.invites.preview, { token: made.token })).toMatchObject({ account: "match" });
  await ana.as.mutation(api.invites.accept, { token: made.token });
  expect(await waiting(admin, teamId)).toEqual([]);
});

test("a token sealed with key A still opens after key B is put in front, and new tokens use B", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const made = await invite(t, teamId, admin);
  const keyOf = async () => (await t.run((ctx) => ctx.db.get(made.inviteId)))!.sealedToken?.keyId;
  expect(await keyOf()).toBe("a");

  vi.stubEnv("INVITE_TOKEN_KEYS", `${KEY_B},${KEY_A}`);
  expect(await admin.as.mutation(api.invites.link, { teamId, inviteId: made.inviteId })).toMatchObject({ token: made.token });
  // The reminder 3 days in reads the same token back and sends it.
  await run(t, 3 * DAY);
  expect(sent.map((e) => e.idempotencyKey.split("/")[0])).toEqual(["invite", "reminder"]);
  expect(sent[1]!.html).toContain(made.token);

  const fresh = await admin.as.mutation(api.invites.regenerate, { teamId, inviteId: made.inviteId });
  expect(await keyOf()).toBe("b");
  vi.stubEnv("INVITE_TOKEN_KEYS", KEY_B);
  expect(await admin.as.mutation(api.invites.link, { teamId, inviteId: made.inviteId })).toMatchObject({ token: fresh.token });

  // A seal names its key: with A gone, a token sealed under A no longer opens.
  vi.stubEnv("INVITE_TOKEN_KEYS", KEY_A);
  const underA = (await sealInviteToken("uri_x", made.inviteId, 9))!;
  vi.stubEnv("INVITE_TOKEN_KEYS", KEY_B);
  expect(await openInviteToken(underA, made.inviteId, 9)).toBeNull();
});

test("without INVITE_TOKEN_KEYS an invite still works, but its email is recorded as failed and nothing is sent", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  vi.stubEnv("INVITE_TOKEN_KEYS", "");
  const made = await invite(t, teamId, admin);
  expect(made.emailed).toBe(false);
  await run(t, 4 * DAY);
  expect(sent).toEqual([]);
  expect((await waiting(admin, teamId))[0]).toMatchObject({
    canCopyLink: false,
    emailState: { kind: "invite", status: "failed", error: expect.stringMatching(/INVITE_TOKEN_KEYS/) },
  });
  const ana = await signIn(t, "Ana");
  await ana.as.mutation(api.invites.accept, { token: made.token });
});

test("a reminder whose send failed isn't retried once the team turns reminders off", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  await invite(t, teamId, admin);
  answers = [{ ok: false, retryable: true, error: "Resend answered 503" }];
  await run(t, 3 * DAY);
  expect(sent.map((e) => e.idempotencyKey.split("/")[0])).toEqual(["invite", "reminder"]);

  await admin.as.mutation(api.teams.setInviteReminders, { teamId, inviteReminders: "off" });
  await runRetries(t);
  expect(sent).toHaveLength(2);
  expect((await waiting(admin, teamId))[0]!.emailState).toMatchObject({
    kind: "reminder",
    status: "skipped",
    error: "Invite reminders were turned off.",
  });
});

test("agents with the invite scope regenerate, resend and revoke over the Room API", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const { key } = await addAgent(t, teamId, admin, "Hermes", ["people.invite", "room.read"]);
  await admin.as.mutation(api.members.setRole, {
    teamId,
    memberId: (await admin.as.query(api.teams.members, { teamId })).find((m) => m.name === "Hermes")!.memberId,
    role: "admin",
  });
  const made = await callAsAgent(t, key, "invites.create", { email: "ana@example.com" });
  expect(made.ok).toBe(true);
  await run(t);
  expect(sent[0]!.subject).toBe("Hermes, an agent Julio added invited you to Nuko Nova on Uplink Room");
  const inviteId = made.result.inviteId as Id<"invites">;
  expect((await callAsAgent(t, key, "invites.regenerate", { inviteId })).ok).toBe(true);
  expect((await callAsAgent(t, key, "invites.resend", { inviteId })).ok).toBe(true);
  expect((await callAsAgent(t, key, "invites.revoke", { inviteId })).ok).toBe(true);

  const catalog = (await (await t.fetch("/api/v1/functions")).json()) as { functions: { name: string }[] };
  const names = catalog.functions.map((f) => f.name);
  for (const name of ["invites.regenerate", "invites.resend", "invites.revoke", "invites.link", "teams.setInviteReminders"]) {
    expect(names).toContain(name);
  }
});
