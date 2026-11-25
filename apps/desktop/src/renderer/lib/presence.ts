import { useCallback, useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "./api";
import { useRoomQuery, useSession } from "./session";
import { useNow } from "../components/useNow";

/**
 * Presence (members.heartbeat, members.presence): whether a teammate has the app open and is using
 * it. The app beats about once a minute and at once when its window gains or loses focus; anyone
 * whose last beat is older than ONLINE_MS reads as offline, by this computer's clock.
 */
export type Presence = "active" | "away" | "offline";

/** Two and a half missed minutes: a beat a minute, with room for one late one. */
export const ONLINE_MS = 150_000;
/** Input this recent keeps you active even with the window behind another. */
export const ACTIVE_INPUT_MS = 5 * 60_000;
const BEAT_MS = 60_000;
/**
 * This launch of the app, so the room keeps its presence apart from the same person's other
 * computers (members.heartbeat's sessionId): an idle window here doesn't hide an active one there.
 */
export const SESSION_ID = (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9_-]/g, "");

export function presenceOf(row: { lastSeenAt: number; active: boolean } | undefined, now: number): Presence {
  if (!row || now - row.lastSeenAt > ONLINE_MS) return "offline";
  return row.active ? "active" : "away";
}

/** "Active", "Away", or how long ago an offline teammate last had the app open. */
export function presenceLabel(presence: Presence, lastSeenAt: number | undefined, now: number): string {
  if (presence === "active") return "Active";
  if (presence === "away") return "Away";
  if (lastSeenAt === undefined) return "Offline";
  const minutes = Math.max(1, Math.round((now - lastSeenAt) / 60_000));
  if (minutes < 60) return `Last seen ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Last seen ${hours} h ago`;
  const days = Math.round(hours / 24);
  return `Last seen ${days} day${days === 1 ? "" : "s"} ago`;
}

/** Each member's presence, updated as their beats come in and as time passes. */
export function usePresence(): (memberId: string) => { presence: Presence; lastSeenAt: number | undefined } {
  const rows = useRoomQuery(api.members.presence, {});
  const now = useNow(30_000);
  return useCallback(
    (memberId: string) => {
      const row = rows?.find((r) => r.memberId === memberId);
      return { presence: presenceOf(row, now), lastSeenAt: row?.lastSeenAt };
    },
    [rows, now],
  );
}

/** Beats while the app is open (the Shell runs it once). An older room without presence is left alone. */
export function useHeartbeat(): void {
  const { teamId } = useSession();
  const beat = useMutation(api.members.heartbeat);
  const lastInput = useRef(Date.now());
  useEffect(() => {
    const active = () => document.hasFocus() || Date.now() - lastInput.current < ACTIVE_INPUT_MS;
    let sent: boolean | null = null;
    const send = (force = false) => {
      const now = active();
      if (!force && now === sent) return;
      sent = now;
      beat({ teamId, active: now, sessionId: SESSION_ID }).catch(() => {
        // A room without members.heartbeat yet, or offline: the next beat tries again.
        sent = null;
      });
    };
    const input = () => {
      lastInput.current = Date.now();
      send();
    };
    const focus = () => send();
    send(true);
    const timer = setInterval(() => send(true), BEAT_MS);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", focus);
    window.addEventListener("keydown", input, { passive: true });
    window.addEventListener("pointerdown", input, { passive: true });
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", focus);
      window.removeEventListener("keydown", input);
      window.removeEventListener("pointerdown", input);
    };
  }, [beat, teamId]);
}
