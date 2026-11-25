import { useState } from "react";
import { BrowserFrame } from "../components/BrowserFrame";
import type { Id, MemberRow } from "../lib/api";
import type { TableNames } from "@uplink-room/backend/dataModel";
import {
  BrowserPanel,
  type BrowserActions,
  type BrowserPanelData,
  type BrowserRow,
} from "../views/browser/BrowserPanel";
import type { SavedLoginRow } from "../views/browser/SavedLogins";

export function InventoryBrowser({ scene: state }: { scene: string }) {
  const id = <T extends TableNames>(s: string) => s as Id<T>;
  const julio = { memberId: id<"members">("m-julio"), name: "Rosa Vega", kind: "person" as const };
  const ana = { memberId: id<"members">("m-ana"), name: "Ana Ruiz", kind: "person" as const };
  const bo = { memberId: id<"members">("m-bo"), name: "Bo Reyes", kind: "person" as const };
  const hermes = {
    memberId: id<"members">("m-hermes"),
    name: "Hermes",
    kind: "agent" as const,
    addedBy: { memberId: julio.memberId, name: julio.name },
  };
  const members = [
    { ...julio, role: "admin" },
    { ...ana, role: "member" },
    { ...bo, role: "member" },
    {
      ...hermes,
      role: "member",
      agentId: "a-hermes",
      character: { body: "triangle", color: "coral", accessory: "glasses" },
    },
  ] as unknown as MemberRow[];

  const now = Date.now();
  const DAY = 24 * 60 * 60_000;
  const stagingAdmin = id<"savedLogins">("l-staging");
  const savedLogins: SavedLoginRow[] = [
    {
      savedLoginId: stagingAdmin,
      channel: { channelId: id<"channels">("c-reef"), name: "reef-runner" },
      name: "staging admin",
      keep: "7d",
      expiresAt: now + 6 * DAY,
      status: "kept",
      savedBy: julio,
      createdAt: now - DAY,
      lastUsedAt: state === "start" ? now - 3 * 60 * 60_000 : now - 9 * 60_000,
      inUse: state !== "start",
      forgottenAt: undefined,
      forgetReason: undefined,
      forgottenBy: undefined,
    },
    {
      savedLoginId: id<"savedLogins">("l-vendor"),
      channel: { channelId: id<"channels">("c-reef"), name: "reef-runner" },
      name: "app store console",
      keep: "forever",
      expiresAt: undefined,
      status: "kept",
      savedBy: hermes,
      createdAt: now - 12 * DAY,
      lastUsedAt: now - 2 * DAY,
      inUse: false,
      forgottenAt: undefined,
      forgetReason: undefined,
      forgottenBy: undefined,
    },
    {
      savedLoginId: id<"savedLogins">("l-analytics"),
      channel: { channelId: id<"channels">("c-reef"), name: "reef-runner" },
      name: "analytics read-only",
      keep: "1d",
      expiresAt: undefined,
      status: "forgotten",
      savedBy: ana,
      createdAt: now - 3 * DAY,
      lastUsedAt: now - 2 * DAY,
      inUse: false,
      forgottenAt: now - DAY,
      forgetReason: "expired",
      forgottenBy: undefined,
    },
  ];

  if (state === "overflow")
    savedLogins[0]!.name =
      "Harbor observation station with an unusually long saved login name 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  if (state === "many")
    savedLogins.push(
      ...Array.from({ length: 20 }, (_, i) => ({
        ...savedLogins[0]!,
        savedLoginId: id<"savedLogins">(`sample-login-${i}`),
        name: `Station login ${i}`,
      })),
    );

  const live: BrowserRow = {
    browserId: id<"browsers">("b-1"),
    channel: { channelId: id<"channels">("c-reef"), name: "reef-runner" },
    status: "live",
    endReason: undefined,
    endedBy: undefined,
    failReason: undefined,
    access: state === "watcher" ? "suggest" : "drive",
    loweredFrom: undefined,
    startUrl: "https://staging.reefrunner.app/levels/3",
    navigationError: undefined,
    // The driver's browser keeps its logins; the watcher's is temporary.
    savedLogin:
      state === "watcher"
        ? undefined
        : {
            savedLoginId: stagingAdmin,
            name: "staging admin",
            keep: "7d",
            expiresAt: now + 6 * DAY,
            status: "kept",
            savedBy: julio.memberId,
          },
    startedBy: julio,
    driver: julio,
    watching: [julio, ana, hermes],
    idleMinutes: 10,
    longestMinutes: 120,
    startedAt: now - 9 * 60_000,
    liveAt: now - 9 * 60_000,
    endedAt: undefined,
  };

  const noop: BrowserActions = {
    start() {},
    end() {},
    openUrl() {},
    suggestUrl() {},
    openSuggestion() {},
    dismissSuggestion() {},
    setAccess() {},
    takeWheel() {},
    requestWheel() {},
    passWheel() {},
    answerWheelRequest() {},
    reconnect() {},
    setKeep() {},
    rename() {},
    forget() {},
  };

  function data(): BrowserPanelData {
    const base: BrowserPanelData = {
      channelName: "reef-runner",
      configured: true,
      envVar: "HYPERBEAM_API_KEY",
      idleMinutes: 10,
      mostOpenAccess: "open",
      browser: live,
      ended: null,
      suggestions: [],
      wheelRequests: [],
      me: julio.memberId,
      isAdmin: true,
      members,
      stage: <BrowserFrame connect={null} title="Sample browser frame" />,
      connection: { state: "playing" },
      savedLogins,
    };
    if (["driver", "error", "starting"].includes(state)) {
      return {
        ...base,
        browser: { ...live, status: state === "starting" ? "starting" : "live" },
        connection:
          state === "error"
            ? { state: "failed", message: "The sample connection ended." }
            : base.connection,
        wheelRequests: [{ requestId: id<"browserWheelRequests">("w-1"), from: ana }],
        suggestions: [
          {
            suggestionId: id<"browserSuggestions">("s-1"),
            url: "https://github.com/nuko/reef-runner/pull/42",
            from: bo,
          },
        ],
      };
    }
    if (state === "watcher" || state === "watcher-asked") {
      return {
        ...base,
        me: ana.memberId,
        isAdmin: false,
        ...(state === "watcher-asked"
          ? {
              browser: { ...live, access: "drive" as const },
              wheelRequests: [{ requestId: id<"browserWheelRequests">("asked"), from: ana }],
            }
          : {}),
        suggestions: [
          {
            suggestionId: id<"browserSuggestions">("s-2"),
            url: "https://staging.reefrunner.app/levels/4",
            from: ana,
          },
        ],
      };
    }
    if (["start", "many", "overflow"].includes(state)) {
      return {
        ...base,
        browser: null,
        ended: { ...live, status: "ended", endReason: "idle", endedAt: now - 2 * 60_000 },
      };
    }
    return { ...base, configured: false, browser: null, isAdmin: true };
  }

  const [size, setSize] = useState<"side" | "full">("full");
  return (
    <BrowserPanel
      data={data()}
      actions={noop}
      size={size}
      onToggleSize={() => setSize((s) => (s === "full" ? "side" : "full"))}
      onClose={() => {}}
    />
  );
}
