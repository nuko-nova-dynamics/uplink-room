/**
 * When a message gets a banner or a sound (spec #63). `messages.addressed` lists the new messages
 * addressed to you (direct messages, mentions, @everyone, replies, and channels set to all; the
 * backend already applied each channel's level). This decides which of them interrupt: none that
 * were there when the app opened, none you've already been told about, and none in the channel
 * you're looking at. Order is by `seq`, the order the alerts reached you: an @everyone in a large
 * channel can reach you after newer messages did. Banners follow the Banners switch and the cue follows the Sounds switch, so
 * one switch silences each. Pure, so it is tested without the app (messageSignals.test.ts).
 */
import type { MessageReason, NotifyRequest } from "../../main/notifySpec";

export type Addressed = {
  messageId: string;
  channelId: string;
  channel: { kind: "channel" | "direct" | "private"; label: string };
  author: { name: string };
  /** Posted by a live run as itself: the banner names the run. author is its driver, who answers for it. */
  asRun?: { label: string } | undefined;
  reason: MessageReason;
  preview: string;
  at: number;
  /** The order alerts reached you in; it only grows (0 on alerts from before seqs existed). */
  seq: number;
};

export type MessageWatch = {
  /** The channel open in the app, if any. */
  openChannelId: string | null;
  /** Whether the app's window has focus: you only look at a channel while it does. */
  focused: boolean;
  banners: boolean;
  sounds: boolean;
};

export type MessageNotices = { banners: NotifyRequest[]; cue: boolean; boundary: number };

export const messageKey = (messageId: string) => `message:${messageId}`;

/**
 * What to show for the latest list. `boundary` is the highest alert seq already handled: the list
 * that was there when the app opened (`boundary` null) only sets it, and shows nothing. Anything at
 * or below it never shows, so an older alert that comes into the list later (after a newer one is
 * deleted) gets no banner, and an alert that reached you after the last one handled always does.
 */
export function messageNotices(list: Addressed[], watch: MessageWatch, boundary: number | null): MessageNotices {
  const newest = Math.max(boundary ?? 0, ...list.map((a) => a.seq));
  if (boundary === null) return { banners: [], cue: false, boundary: newest };
  const unseen = list.filter((a) => a.seq > boundary);
  const result: MessageNotices = { banners: [], cue: false, boundary: newest };
  const loud = unseen.filter((a) => !(watch.focused && a.channelId === watch.openChannelId));
  if (loud.length === 0) return result;
  result.cue = watch.sounds;
  if (!watch.banners) return result;
  // In the order they reached you, so the newest banner ends up on top.
  for (const a of [...loud].sort((x, y) => x.seq - y.seq)) {
    result.banners.push({
      kind: "message",
      id: messageKey(a.messageId),
      who: a.asRun?.label ?? a.author.name,
      where: a.channel.label,
      direct: a.channel.kind === "direct",
      reason: a.reason,
      text: a.preview,
      channelId: a.channelId,
      messageId: a.messageId,
    });
  }
  return result;
}
