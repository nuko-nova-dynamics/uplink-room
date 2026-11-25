import { useCallback, useRef } from "react";
import { useMutation } from "convex/react";
import { api, type Id } from "../../lib/api";
import { useRoomQuery, useSession } from "../../lib/session";
import { useNow } from "../useNow";

/** How long after someone's last keystroke they show as typing (channels.typing's TYPING_SHOWN_MS). */
export const TYPING_SHOWN_MS = 6000;
/** A row already this old by this computer's clock when it arrives is past typing (lib/typing.ts TYPING_FRESH_MS). */
export const TYPING_FRESH_MS = 8000;
/** The composer says you're typing at most this often while you write. */
const PING_MS = 3000;

type Typist = { name: string; kind: "person" | "agent" };

/** "Ana is typing", "Ana and Theo are typing", an agent "is writing"; four or more are "Several people". */
export function typingText(typists: Typist[]): string {
  if (typists.length === 0) return "";
  if (typists.length > 3) return "Several people are typing";
  const names = typists.map((t) => t.name);
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  if (typists.length === 1) return `${list} ${typists[0]!.kind === "agent" ? "is writing" : "is typing"}`;
  return `${list} are typing`;
}

/**
 * The composer's side: tells the room you're writing here (or in this thread), at most every few
 * seconds while the text changes, and that you stopped when the box empties. Posting ends it in the
 * room. A room without channels.typing is left alone.
 */
export function useTypingPing(channelId: Id<"channels">, replyTo: Id<"messages"> | undefined): (body: string) => void {
  const { teamId } = useSession();
  const ping = useMutation(api.channels.typing);
  const last = useRef(0);
  return useCallback(
    (body: string) => {
      const now = Date.now();
      const quiet = () => undefined;
      if (!body.trim()) {
        if (last.current === 0) return;
        last.current = 0;
        ping({ teamId, channelId, ...(replyTo ? { replyTo } : {}), stop: true }).catch(quiet);
        return;
      }
      if (now - last.current < PING_MS) return;
      last.current = now;
      ping({ teamId, channelId, ...(replyTo ? { replyTo } : {}) }).catch(quiet);
    },
    [ping, teamId, channelId, replyTo],
  );
}

/** `working`: an agent working on a message sent to it over A2A (ADR 0024), shown for as long as the row is there. */
type TypingRow = { member: Typist & { memberId: string }; at: number; replyTo?: string | undefined; working?: boolean | undefined };
type Seen = Map<string, { at: number; seenAt: number }>;

/**
 * Notes when each typist's latest keystroke reached this computer. A row whose keystroke is already
 * older than TYPING_FRESH_MS by this computer's clock is never activity, however late it arrives: a
 * draft abandoned days ago doesn't come back as typing when the channel opens.
 */
export function noteTyping(seen: Seen, rows: TypingRow[], now: number): void {
  for (const r of rows) {
    const known = seen.get(r.member.memberId);
    if (known && known.at === r.at) continue;
    seen.set(r.member.memberId, { at: r.at, seenAt: now - r.at > TYPING_FRESH_MS ? Number.NEGATIVE_INFINITY : now });
  }
}

/** Who is typing here now: in this channel (no replyTo) or this thread, noted within TYPING_SHOWN_MS. */
export function typistsNow(seen: Seen, rows: TypingRow[], replyTo: string | undefined, now: number): Typist[] {
  return rows
    .filter((r) => (r.replyTo ?? undefined) === replyTo)
    .filter((r) => {
      if (r.working) return true;
      const known = seen.get(r.member.memberId);
      return known !== undefined && known.at === r.at && known.seenAt > now - TYPING_SHOWN_MS;
    })
    .map((r) => r.member);
}

/**
 * Who else is writing here: under the composer, in the channel (not in a thread) or in the thread
 * open in Replies. A typist shows for a few seconds after their last keystroke reached this
 * computer, timed by this computer's clock.
 */
export function TypingLine({ channelId, replyTo }: { channelId: Id<"channels">; replyTo?: Id<"messages"> | undefined }) {
  const rows = useRoomQuery(api.channels.whoIsTyping, { channelId });
  const seen = useRef<Seen>(new Map());
  // Noted as the rows arrive, before this render reads them.
  if (rows) noteTyping(seen.current, rows, Date.now());
  const here = (rows ?? []).filter((r) => (r.replyTo ?? undefined) === replyTo);
  const now = useNow(here.length ? 1000 : 60_000);
  const text = typingText(typistsNow(seen.current, rows ?? [], replyTo, now));
  return (
    <div className="typing-line" aria-live="polite">
      {text ? <span className="truncate">{text}…</span> : null}
    </div>
  );
}
