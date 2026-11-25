/** How long a routine webhook send may take, connect to answer. Tests shorten it. */
const NORMAL_MS = 15_000;

let override: number | undefined;

export function setWebhookTimeoutForTests(ms: number | undefined): void {
  override = ms;
}

export function webhookTimeoutMs(): number {
  return override ?? NORMAL_MS;
}

/**
 * When a send still shows as sending, the room stops waiting for it (webhooks.checkSending). Far
 * past the send's own deadline: Convex doesn't retry a scheduled action that fails
 * (docs.convex.dev/scheduling/scheduled-functions, "Error handling"), so without this a send whose
 * action died would show as sending for good.
 */
export const WEBHOOK_DEADLINE_MS = 2 * 60_000;
