/**
 * The text a joined run reads for the messages it takes from its inbox (`joined.take`, ADR 0026,
 * ADR 0032): in a Claude Code hook's `additionalContext` or its idle waiter's wake, in a Codex
 * `turn/steer`, in a channel notification, or printed by `uplink inbox`. It is the text the bridge
 * writes for a run in one of its terminals (`formatRunMessages`, `@uplink-room/protocol/runMessages`):
 * each message's text quoted line by line under a label the room writes, split on every line break
 * a reader might honour and with control characters shown as escapes, so no text can pose as a label
 * or the hint. It ends with the `uplink` commands a joined run answers with.
 */
import { formatRunMessages, type RunDelivery } from "@uplink-room/protocol/runMessages";

/** One message as `joined.take` returns it: a run delivery, with its channel and thread, or its Pair. */
export type Delivery = RunDelivery & ({ channelId: string; replyTo?: string } | { pairId: string });

/** How a joined run answers (ADR 0029 D5): it posts as itself with its run token, never a key. */
export const ANSWER_HINT =
  'This run can answer a message with: uplink reply <message id> "text". It can post in a place with: uplink say --in "#place" "text". To send files or images with it, add --file PATH for each, up to 10.';

/** How it answers when a message came from one of its Pairs (ADR 0034), where a reply reaches everyone in it. */
export const PAIR_ANSWER_HINT =
  'This run can answer a message with: uplink reply <message id> "text" (in a Pair it reaches everyone there). It can post in its Pair with: uplink say --in pair "text", and in a place with: uplink say --in "#place" "text". To send files or images with it, add --file PATH for each, up to 10.';

/** The characters of a delivery `joined.take` leaves for the hint, so what it takes fits with either. */
export const HINT_RESERVE = Math.max(ANSWER_HINT.length, PAIR_ANSWER_HINT.length) + 2;

/**
 * The text that delivers messages to a joined run, written as facts about who sent what, as Claude
 * Code's hooks page advises for `additionalContext`: text framed as commands can trip the model's
 * prompt-injection defenses. Whether to act on a message is the run's own decision (ADR 0026).
 */
export function formatDeliveries(deliveries: Delivery[]): string {
  return formatRunMessages(deliveries, deliveries.some((d) => "pairId" in d) ? PAIR_ANSWER_HINT : ANSWER_HINT);
}
