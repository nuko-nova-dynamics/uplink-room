/**
 * Links the app was opened with (main/deepLink.ts): a join link's token, which waits until the
 * person is signed in and then asks "Join <team>?" (components/JoinInvite.tsx), and an open link
 * from the welcome email, which opens that team and place. Both are kept in sessionStorage too,
 * because Clerk reloads the page as it signs someone in, and go when used, refused, or the window
 * closes.
 *
 * An open link is only ever a request: before the app goes anywhere it checks the place against
 * the teams and channels this person can see (resolveOpen), and anything else stays put with
 * NOTHING_TO_OPEN.
 */
import { useEffect, useSyncExternalStore } from "react";
import { api, type Id } from "./api";
import { desktop } from "./desktop";
import { useRoomQuery, useToast } from "./session";
import type { Nav, Route } from "../Shell";
import type { SettingsSection } from "../views/Settings";

export type PendingOpen = { teamId: string; path: string[] };
type State = { invite: string | null; open: PendingOpen | null };

export const NOTHING_TO_OPEN = "This link doesn't open anything you can see.";

const INVITE_KEY = "uplink.pendingInvite";
const OPEN_KEY = "uplink.pendingOpen";
const TOKEN = /^[A-Za-z0-9_-]{8,128}$/;
const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/** An open link's team and place, from main or from storage, or null when it isn't one. */
function pendingOpen(teamId: unknown, path: unknown): PendingOpen | null {
  if (typeof teamId !== "string" || !SEGMENT.test(teamId)) return null;
  if (!Array.isArray(path) || path.length > 4) return null;
  if (!path.every((s) => typeof s === "string" && SEGMENT.test(s))) return null;
  return { teamId, path: path as string[] };
}

function read<T>(key: string, parse: (value: string) => T | null): T | null {
  try {
    const value = sessionStorage.getItem(key);
    return value ? parse(value) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    // Storage unavailable: the link still waits in memory until a reload.
  }
}

let state: State = {
  invite: read(INVITE_KEY, (v) => (TOKEN.test(v) ? v : null)),
  open: read(OPEN_KEY, (v) => {
    try {
      const parsed = JSON.parse(v) as { teamId?: unknown; path?: unknown };
      return pendingOpen(parsed.teamId, parsed.path);
    } catch {
      return null;
    }
  }),
};
const listeners = new Set<() => void>();

function set(next: Partial<State>): void {
  state = { ...state, ...next };
  if ("invite" in next) write(INVITE_KEY, state.invite);
  if ("open" in next) write(OPEN_KEY, state.open ? JSON.stringify(state.open) : null);
  for (const listener of listeners) listener();
}

/** Takes one link from main. Main checked it; this checks the shape again before keeping it. */
export function receive(link: unknown): void {
  if (!link || typeof link !== "object") return;
  const value = link as { kind?: unknown; token?: unknown; path?: unknown };
  if (value.kind === "invite" && typeof value.token === "string" && TOKEN.test(value.token)) {
    set({ invite: value.token });
    return;
  }
  if (value.kind === "open" && Array.isArray(value.path) && value.path[0] === "team") {
    const open = pendingOpen(value.path[1], value.path.slice(2));
    if (open) set({ open });
  }
}

/** Takes the links waiting in main now and whenever more arrive. Returns a function that stops. */
export function startDeepLinks(): () => void {
  const take = async () => {
    for (const link of (await desktop.takeDeepLinks?.()) ?? []) receive(link);
  };
  void take();
  return desktop.onDeepLink?.(() => void take()) ?? (() => {});
}

/** The links waiting now. */
export function pendingLinks(): State {
  return state;
}

export function useDeepLinks(): State {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, pendingLinks);
}

export function clearInvite(): void {
  set({ invite: null });
}

export function clearOpen(): void {
  set({ open: null });
}

const SECTIONS: readonly SettingsSection[] = [
  "machines",
  "profiles",
  "agents",
  "members",
  "github",
  "browsers",
  "chat",
  "calls",
  "appearance",
  "notifications",
  "privacy",
  "updates",
  "activity",
];

/**
 * Where an open link points inside its team, checked against what this person can see: the
 * team's Inbox, one of its channels (`channels`, the channels this member is in or can open), or
 * a settings section. Null when it names nothing they can see, and undefined while the channels
 * are still loading.
 */
export function resolveOpen(path: string[], channels: readonly { channelId: string }[] | undefined): Route | null | undefined {
  if (path.length === 0) return { name: "inbox" };
  const [kind, id, ...rest] = path;
  if (!id) return null;
  // A message link (Copy link on a message): the channel, opened at the message. The channel opens
  // at the newest instead when the message is gone or was never in it (ChannelView checks).
  const message = kind === "channel" && rest.length === 2 && rest[0] === "message" ? rest[1] : undefined;
  if (rest.length > 0 && !message) return null;
  if (kind === "channel") {
    if (channels === undefined) return undefined;
    const channel = channels.find((c) => c.channelId === id);
    if (!channel) return null;
    return { name: "channel", channelId: channel.channelId as Id<"channels">, ...(message ? { messageId: message as Id<"messages"> } : {}) };
  }
  if (kind === "settings" && SECTIONS.includes(id as SettingsSection)) {
    return { name: "settings", section: id as SettingsSection };
  }
  return null;
}

/**
 * What the team level does with an open link for `teamId` before the Shell can open it: nothing
 * (no link, or the current team's Shell already shows), close the team picker over the current
 * team (`show-team`), open another of the person's teams (`switch`), or refuse a team they aren't
 * in (`refuse`).
 */
export function openLinkTeamStep(
  teamId: string | undefined,
  current: string | undefined,
  teams: readonly { teamId: string }[],
  choosing: boolean,
): "none" | "show-team" | "switch" | "refuse" {
  if (!teamId) return "none";
  if (teamId === current) return choosing ? "show-team" : "none";
  return teams.some((t) => t.teamId === teamId) ? "switch" : "refuse";
}

/** In the open team's Shell: goes where an open link for this team points, once, if it can. */
export function useOpenLink(nav: Nav, teamId: string): void {
  const { open } = useDeepLinks();
  const channels = useRoomQuery(api.channels.list, {});
  const toast = useToast();
  useEffect(() => {
    if (!open || open.teamId !== teamId) return;
    const route = resolveOpen(open.path, channels);
    if (route === undefined) return;
    clearOpen();
    if (route) nav.go(route);
    else toast.show(NOTHING_TO_OPEN);
  }, [open, teamId, nav, channels, toast]);
}

/** Where links into the app point: the site's open page hands the place to the app (apps/site/app/open). */
export const SITE_ORIGIN = "https://uplinkroom.com";

/** A link to one message, for Copy link: it opens the app at the message for anyone who can see it. */
export function messageLink(teamId: string, channelId: string, messageId: string): string {
  return `${SITE_ORIGIN}/open#team/${teamId}/channel/${channelId}/message/${messageId}`;
}
