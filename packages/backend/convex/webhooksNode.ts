"use node";
/**
 * Sends one message to an agent's routine webhook (webhooks.ts), in Convex's Node.js runtime so the
 * request goes through guardedFetch, as the A2A worker's do (ADR 0012): public https only, each
 * connection's address checked as it opens (so a name that rebinds to a private address is refused
 * at the send), the body sent whole with its Content-Length, redirects never followed, and a
 * deadline on the whole exchange.
 *
 * Grok Bot's docs: "A 200 response means Grok Bot accepted the call and started a run ... Any other
 * response means a run didn't start" (docs.x.ai/grok-bot/skills-routines-and-automations). So only
 * 200 is sent; anything else is failed with the reason, and the key is taken out of every reason
 * before it is kept. Nothing is sent twice: a send that timed out may have started a run, and a
 * second would start another.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { BlockedAddressError, guardedFetch } from "./lib/a2a/guardedFetch";
import { redactor, type Redactor } from "./lib/a2a/redact";
import { openSecret } from "./lib/a2a/secrets";
import { webhookTimeoutMs } from "./lib/webhookTiming";

/** How much of an answer's body the room reads, for the reason a send failed. */
const MAX_ANSWER_BYTES = 2048;

async function readSome(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_ANSWER_BYTES && !signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(chunk.value);
      size += chunk.value.byteLength;
    }
  } catch {
    // What was read so far is enough for a reason.
  } finally {
    reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all.slice(0, MAX_ANSWER_BYTES)).replace(/\s+/g, " ").trim();
}

/** POSTs the body and says how it went: sent on a 200, else why not, cleaned of the key. */
async function post(url: string, key: string, body: string, agent: string, clean: Redactor) {
  // A 2xx other than 200 still means no run started (docs.x.ai: "Any other response means a run didn't start").
  const timeoutMs = webhookTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const reason = (text: string) => clean.cut(text, 300).text;
  try {
    const response = await guardedFetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json, text/plain, */*",
        "user-agent": "Uplink Room",
      },
      body,
      signal: controller.signal,
    });
    if (response.status === 200) {
      response.body?.cancel().catch(() => {});
      return { status: "sent" as const };
    }
    if (response.status >= 300 && response.status < 400) {
      response.body?.cancel().catch(() => {});
      const to = response.headers.get("location");
      return {
        status: "failed" as const,
        reason: reason(`The webhook answered with a redirect (HTTP ${response.status}${to ? ` to ${to}` : ""}), which the room doesn't follow. Copy the routine's POST to URL again.`),
      };
    }
    const said = await readSome(response, controller.signal);
    const hint =
      response.status === 401 || response.status === 403
        ? " Check that the key is the routine's current key."
        : response.status === 404
          ? " Check that the routine still exists and isn't paused."
          : response.status === 429
            ? " Grok Bot's routines have hourly limits."
            : "";
    return {
      status: "failed" as const,
      reason: reason(`The webhook answered HTTP ${response.status}${said ? `: ${said}` : ""}.${hint}`),
    };
  } catch (error) {
    if (error instanceof BlockedAddressError) return { status: "failed" as const, reason: reason(error.message) };
    if (controller.signal.aborted) {
      return {
        status: "failed" as const,
        reason: `The webhook didn't answer within ${Math.round(timeoutMs / 1000)} seconds. ${agent} may have started a run anyway, so the room doesn't send it again.`,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { status: "failed" as const, reason: reason(`The room couldn't reach the webhook: ${message}`) };
  } finally {
    clearTimeout(timer);
  }
}

export const send = internalAction({
  args: { deliveryId: v.id("agentDeliveries") },
  handler: async (ctx, { deliveryId }) => {
    // Takes the delivery: a failure found here is recorded there, and a second run gets "skip".
    const request = await ctx.runMutation(internal.webhooks.request, { deliveryId });
    if (request.kind === "skip") return null;
    let key: string;
    try {
      key = await openSecret(request.sealed, request.binding);
    } catch {
      await ctx.runMutation(internal.webhooks.settle, {
        deliveryId,
        status: "failed",
        reason: "The room couldn't open the webhook's key. Set the webhook again.",
      });
      return null;
    }
    const outcome = await post(request.url, key, request.body, request.agentName, redactor({ kind: "bearer", secret: key }));
    await ctx.runMutation(internal.webhooks.settle, { deliveryId, ...outcome });
    return null;
  },
});
