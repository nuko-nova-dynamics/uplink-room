"use node";
/**
 * Sends one attempt of an email (lib/email.ts). It runs in Node because React Email renders there.
 * Mutations can't call out, so `emails.claim` hands it the email, it renders and posts it, and
 * `emails.recordResult` records what Resend said and schedules the next attempt if there is one.
 */
import type { FunctionReturnType } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { emailSender, scrubError, type SendResult } from "./lib/email";
import { openInviteToken } from "./lib/inviteToken";
import { renderEmail } from "../emails/render";

type Job = NonNullable<FunctionReturnType<typeof internal.emails.claim>>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function attempt(job: Job): Promise<SendResult> {
  const token = job.token ? await openInviteToken(job.token.sealed, job.inviteId, job.token.generation) : null;
  if ((job.kind === "invite" || job.kind === "reminder") && !token) {
    return {
      ok: false,
      retryable: false,
      // INVITE_TOKEN_KEYS lost the key this token was sealed with (lib/inviteToken.ts). Retrying
      // can't bring it back; regenerating seals a new token with the current key.
      error:
        "The invite's link was sealed with a key INVITE_TOKEN_KEYS no longer has. Regenerate the token to send a new one.",
    };
  }
  let rendered;
  try {
    rendered = await renderEmail(job.kind, job.data, { token, now: Date.now() });
  } catch (error) {
    return { ok: false, retryable: false, error: scrubError(`Couldn't build the email: ${message(error)}`) };
  }
  try {
    return await emailSender()({
      to: job.to,
      ...rendered,
      idempotencyKey: job.idempotencyKey,
      tags: [{ name: "kind", value: job.kind }],
    });
  } catch (error) {
    // A sender that throws, rather than answering, is treated like a network failure.
    return { ok: false, retryable: true, error: scrubError(`Sending failed: ${message(error)}`) };
  }
}

export const send = internalAction({
  args: { emailId: v.id("emails"), attempt: v.number() },
  handler: async (ctx, args) => {
    const job = await ctx.runMutation(internal.emails.claim, args);
    if (!job) return null;
    const result = await attempt(job);
    await ctx.runMutation(internal.emails.recordResult, { ...args, result });
    return null;
  },
});
