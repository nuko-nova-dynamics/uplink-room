/**
 * The bookkeeping half of sending an email (lib/email.ts): `emailSend.send` claims an attempt here,
 * sends, and records the result here. Mutations keep each step atomic, so an email is claimed by
 * one attempt at a time and a retry is scheduled exactly when an attempt fails.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { MAX_ATTEMPTS, mirrorOnInvite, RETRY_DELAYS_MS, STUCK_AFTER_MS, type SendResult } from "./lib/email";

/**
 * Why an invite or reminder email no longer applies, or null while it does. Checked on every
 * attempt, retries included, so a reminder whose team turned reminders off meanwhile stays unsent.
 */
async function moot(
  ctx: MutationCtx,
  email: Doc<"emails">,
  invite: Doc<"invites"> | null,
  now: number,
): Promise<string | null> {
  if (email.kind !== "invite" && email.kind !== "reminder") return null;
  if (!invite) return "The invite was deleted.";
  if (invite.acceptedAt !== undefined) return "The invite was accepted.";
  if (invite.revokedAt !== undefined) return "The invite was revoked.";
  if ((invite.generation ?? 0) !== (email.generation ?? 0)) return "A newer token replaced this one.";
  if (invite.expiresAt !== undefined && now >= invite.expiresAt) return "The invite expired.";
  if (email.kind === "reminder" && (await ctx.db.get(email.teamId))?.inviteReminders === "off") {
    return "Invite reminders were turned off.";
  }
  return null;
}

async function finish(
  ctx: MutationCtx,
  email: Doc<"emails">,
  patch: Partial<Doc<"emails">>,
): Promise<void> {
  await ctx.db.patch(email._id, { ...patch, updatedAt: Date.now() });
  const updated = await ctx.db.get(email._id);
  if (updated) await mirrorOnInvite(ctx, updated);
}

/**
 * Starts attempt `attempt` of an email, or returns null when it has nothing to do: it already
 * went, another attempt owns it, or the invite it belongs to moved on.
 */
export const claim = internalMutation({
  args: { emailId: v.id("emails"), attempt: v.number() },
  handler: async (ctx, { emailId, attempt }) => {
    const email = await ctx.db.get(emailId);
    if (!email || email.status !== "queued" || email.attempts !== attempt - 1) return null;
    const invite = await ctx.db.get(email.inviteId);
    const now = Date.now();
    const reason = await moot(ctx, email, invite, now);
    if (reason) {
      await finish(ctx, email, { status: "skipped", error: reason });
      return null;
    }
    await ctx.db.patch(emailId, { status: "sending", attempts: attempt, updatedAt: now });
    // An action that dies mid-send leaves no result; this tries it again with the same key.
    await ctx.scheduler.runAfter(STUCK_AFTER_MS, internal.emails.unstick, { emailId, attempt });
    const token =
      (email.kind === "invite" || email.kind === "reminder") && invite?.sealedToken
        ? { sealed: invite.sealedToken, generation: invite.generation ?? 0 }
        : null;
    return {
      kind: email.kind,
      to: email.to,
      inviteId: email.inviteId,
      idempotencyKey: email.idempotencyKey,
      data: email.data,
      token,
    };
  },
});

const vResult = v.union(
  v.object({ ok: v.literal(true), id: v.string() }),
  v.object({ ok: v.literal(false), retryable: v.boolean(), error: v.string() }),
);

async function settle(ctx: MutationCtx, emailId: Id<"emails">, attempt: number, result: SendResult) {
  const email = await ctx.db.get(emailId);
  // Only the attempt that holds the email may settle it.
  if (!email || email.status !== "sending" || email.attempts !== attempt) return;
  if (result.ok) {
    await finish(ctx, email, { status: "sent", resendId: result.id, sentAt: Date.now(), error: undefined });
    return;
  }
  if (result.retryable && attempt < MAX_ATTEMPTS) {
    await finish(ctx, email, { status: "queued", error: result.error });
    await ctx.scheduler.runAfter(RETRY_DELAYS_MS[attempt - 1]!, internal.emailSend.send, {
      emailId,
      attempt: attempt + 1,
    });
    return;
  }
  await finish(ctx, email, { status: "failed", error: result.error });
}

/** Records what one attempt got from Resend: sent, a retry later, or failed for good. */
export const recordResult = internalMutation({
  args: { emailId: v.id("emails"), attempt: v.number(), result: vResult },
  handler: async (ctx, { emailId, attempt, result }) => {
    await settle(ctx, emailId, attempt, result);
  },
});

/** An attempt still sending after STUCK_AFTER_MS lost its action: count it as a transient failure. */
export const unstick = internalMutation({
  args: { emailId: v.id("emails"), attempt: v.number() },
  handler: async (ctx, { emailId, attempt }) => {
    await settle(ctx, emailId, attempt, {
      ok: false,
      retryable: true,
      error: "The send didn't finish, so it's being tried again.",
    });
  },
});
