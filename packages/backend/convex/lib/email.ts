/**
 * The room's email: invites, their one reminder, the welcome after joining, and "<name> joined" for
 * whoever sent the invite. All transactional, sent through Resend (https://resend.com/docs).
 *
 * One helper does every send: `queueEmail` records the email as a row in `emails` and schedules
 * `emailSend.send`, which renders it (emails/, React Email) and posts it. Each email has one
 * Resend `Idempotency-Key`, reused by every retry, so a retry inside Resend's 24-hour window never
 * sends it twice. Failures Resend calls transient (429, 5xx, a request still in progress) and
 * network errors are retried on `RETRY_DELAYS_MS`; anything else fails at once. The row, and for
 * invite and reminder emails the invite's `lastEmail`, say where it stands, with the error in words
 * and never a secret.
 *
 * Nothing in an email tracks its reader: no pixel, no remote image or font, links as written.
 * Open and click tracking are Resend domain settings, and stay off for mail.uplinkroom.com.
 *
 * `RESEND_API_KEY` (a sending-only key) and `EMAIL_FROM` come from the deployment's environment,
 * and invite emails also need `INVITE_TOKEN_KEYS` to seal their link (lib/inviteToken.ts,
 * docs/email.md). The Resend key is never logged or stored, and never reaches an error message
 * (`scrubError`).
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internal } from "../_generated/api";

export type EmailKind = Doc<"emails">["kind"];
export type EmailData = Doc<"emails">["data"];

/** The waits before attempts 2 to 5: about 73 minutes in all, well inside Resend's 24 hours. */
export const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000];
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
/** An attempt still marked sending after this died with its action; it's tried again. */
export const STUCK_AFTER_MS = 5 * 60_000;

/** One email, ready to send. */
export type OutgoingEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
  /** Resend tags: ASCII letters, digits, `_` and `-` only. */
  tags: { name: string; value: string }[];
};

export type SendResult =
  | { ok: true; id: string }
  | { ok: false; retryable: boolean; error: string };

export type EmailSender = (email: OutgoingEmail) => Promise<SendResult>;

let testSender: EmailSender | null = null;

/** Tests: send through this fake instead of Resend, or `null` to go back. */
export function setEmailSenderForTests(sender: EmailSender | null): void {
  testSender = sender;
}

/** Whether this deployment can send email: Resend's settings, or a test's fake sender. */
export function emailConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return testSender !== null || Boolean(env["RESEND_API_KEY"] && env["EMAIL_FROM"]);
}

export function emailSender(): EmailSender {
  return testSender ?? resendSender;
}

export const NOT_CONFIGURED =
  "Email isn't set up on this deployment: it needs RESEND_API_KEY and EMAIL_FROM.";

/** Keeps an error message short and free of anything shaped like a Resend key. */
export function scrubError(message: string, env: Record<string, string | undefined> = process.env): string {
  let out = message;
  const key = env["RESEND_API_KEY"];
  if (key) out = out.split(key).join("[key]");
  out = out.replace(/re_[A-Za-z0-9_]{6,}/g, "[key]").replace(/\s+/g, " ").trim();
  return out.length > 300 ? `${out.slice(0, 297)}...` : out;
}

/**
 * Whether an address is at a domain that never receives mail (RFC 2606 and RFC 6761): example.com,
 * .net and .org, and the .example, .invalid, .test and .localhost names. Test accounts use them,
 * such as Clerk's `+clerk_test@example.com`, and a send there only bounces against our domain.
 */
export function reservedDomain(address: string): boolean {
  const domain = address.slice(address.lastIndexOf("@") + 1).trim().toLowerCase().replace(/\.$/, "");
  return /^example\.(com|net|org)$/.test(domain) || /(^|\.)(example|invalid|test|localhost)$/.test(domain);
}

/**
 * POST https://api.resend.com/emails, with the email's idempotency key. An address at a reserved
 * domain gets no request: the email is recorded as failed with the reason.
 */
export async function resendSender(email: OutgoingEmail): Promise<SendResult> {
  if (reservedDomain(email.to)) {
    return { ok: false, retryable: false, error: `${email.to} is at a reserved test domain that receives no mail, so nothing was sent.` };
  }
  const key = process.env["RESEND_API_KEY"];
  const from = process.env["EMAIL_FROM"];
  if (!key || !from) return { ok: false, retryable: false, error: NOT_CONFIGURED };
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "idempotency-key": email.idempotencyKey,
        "user-agent": "uplink-room",
      },
      body: JSON.stringify({
        from,
        to: [email.to],
        subject: email.subject,
        html: email.html,
        text: email.text,
        tags: email.tags,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      error: scrubError(`Couldn't reach Resend: ${error instanceof Error ? error.message : String(error)}`),
    };
  }
  const body = (await response.json().catch(() => null)) as
    | { id?: unknown; name?: unknown; message?: unknown }
    | null;
  if (response.ok && typeof body?.id === "string") return { ok: true, id: body.id };
  return resendFailure(response.status, body);
}

/** What a Resend error answer means for the room. */
export function resendFailure(
  status: number,
  body: { name?: unknown; message?: unknown } | null,
): Extract<SendResult, { ok: false }> {
  const name = typeof body?.name === "string" ? body.name : "";
  // https://resend.com/docs/dashboard/emails/idempotency-keys: another attempt with this key is
  // still running, and retrying later is safe. Every other 409 needs a new key or payload.
  const retryable = status === 429 || status >= 500 || name === "concurrent_idempotent_requests";
  const detail = typeof body?.message === "string" ? `: ${body.message}` : "";
  return { ok: false, retryable, error: scrubError(`Resend answered ${status}${detail}`) };
}

/**
 * The email's idempotency key: one business event, one key. An invite email is per token
 * generation, so a resend (a new token) is a new email; the other kinds happen once per invite.
 */
export function idempotencyKey(kind: EmailKind, inviteId: Id<"invites">, generation?: number): string {
  return kind === "invite" ? `invite/${inviteId}/${generation ?? 0}` : `${kind}/${inviteId}`;
}

/**
 * Records an email and schedules its first attempt, or, with `failure`, records it as failed at
 * once with that reason (an email that can't be built, such as an invite whose link can't be
 * sealed). Returns null, recording nothing, when the deployment can't send email or there's no
 * address to send to.
 */
export async function queueEmail(
  ctx: MutationCtx,
  email: {
    teamId: Id<"teams">;
    kind: EmailKind;
    to: string | undefined;
    inviteId: Id<"invites">;
    generation?: number;
    data: EmailData;
    failure?: string;
  },
): Promise<{ emailId: Id<"emails">; scheduled: boolean } | null> {
  if (!email.to || !emailConfigured()) return null;
  const now = Date.now();
  const emailId = await ctx.db.insert("emails", {
    teamId: email.teamId,
    kind: email.kind,
    to: email.to,
    inviteId: email.inviteId,
    ...(email.generation !== undefined ? { generation: email.generation } : {}),
    idempotencyKey: idempotencyKey(email.kind, email.inviteId, email.generation),
    data: email.data,
    status: email.failure ? "failed" : "queued",
    attempts: 0,
    ...(email.failure ? { error: email.failure } : {}),
    createdAt: now,
    updatedAt: now,
  });
  if (email.kind === "invite" || email.kind === "reminder") {
    await ctx.db.patch(email.inviteId, {
      lastEmail: email.failure
        ? { emailId, kind: email.kind, status: "failed", at: now, error: email.failure }
        : { emailId, kind: email.kind, status: "sending", at: now },
    });
  }
  if (email.failure) return { emailId, scheduled: false };
  await ctx.scheduler.runAfter(0, internal.emailSend.send, { emailId, attempt: 1 });
  return { emailId, scheduled: true };
}

/**
 * Mirrors an invite or reminder email's state onto its invite, if it is still the invite's latest.
 * A skipped one shows why (reminders turned off); one skipped because the invite moved on is no
 * longer its latest, so it changes nothing.
 */
export async function mirrorOnInvite(ctx: MutationCtx, email: Doc<"emails">): Promise<void> {
  if (email.kind !== "invite" && email.kind !== "reminder") return;
  const invite = await ctx.db.get(email.inviteId);
  if (!invite || invite.lastEmail?.emailId !== email._id) return;
  const status =
    email.status === "sent" || email.status === "failed" || email.status === "skipped" ? email.status : "sending";
  await ctx.db.patch(invite._id, {
    lastEmail: {
      emailId: email._id,
      kind: email.kind,
      status,
      at: email.sentAt ?? email.updatedAt,
      // While it retries, the error says what it's retrying after.
      ...(status !== "sent" && email.error ? { error: email.error } : {}),
    },
  });
}
