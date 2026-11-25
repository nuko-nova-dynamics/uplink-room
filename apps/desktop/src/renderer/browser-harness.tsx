import { useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import type { Id, MemberRow } from "./lib/api";
import type { TableNames } from "@uplink-room/backend/dataModel";
import { Icon } from "./components/Icon";
import { MemberFace } from "./components/Faces";
import { BrowserPanel, type BrowserActions, type BrowserPanelData, type BrowserRow } from "./views/browser/BrowserPanel";
import { BrowserSettingsView } from "./views/settings/Browsers";
import type { SavedLoginRow } from "./views/browser/SavedLogins";
import "./look.css";

/**
 * Sample data only. Renders the real shared-browser components with no
 * sign-in and no backend, so review screenshots can show every state:
 * `browser-harness.html?state=driver|watcher|start|unset|settings&theme=dark|light`.
 */
const params = new URLSearchParams(location.search);
const state = params.get("state") ?? "driver";
document.documentElement.dataset["theme"] = params.get("theme") === "light" ? "light" : "dark";

const id = <T extends TableNames>(s: string) => s as Id<T>;
const julio = { memberId: id<"members">("m-julio"), name: "Julio Díaz", kind: "person" as const };
const ana = { memberId: id<"members">("m-ana"), name: "Ana Torres", kind: "person" as const };
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
  { ...hermes, role: "member", agentId: "a-hermes", character: { body: "triangle", color: "coral", accessory: "glasses" } },
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
      : { savedLoginId: stagingAdmin, name: "staging admin", keep: "7d", expiresAt: now + 6 * DAY, status: "kept", savedBy: julio.memberId },
  startedBy: julio,
  driver: julio,
  watching: [julio, ana, hermes],
  idleMinutes: 10,
  longestMinutes: 120,
  startedAt: now - 9 * 60_000,
  liveAt: now - 9 * 60_000,
  endedAt: undefined,
};

function SamplePage() {
  return (
    <div className="sample-page">
      <div className="sample-chrome">
        <span className="mono">staging.reefrunner.app/levels/3</span>
      </div>
      <div className="sample-body">
        <h1>Level 3: The kelp maze</h1>
        <p className="sample-build">Reef Runner staging, build 0.4.2</p>
        <p>
          The current pulls the diver left every eight seconds. Collect the three pearls before the tide gate closes,
          then surface through the wreck.
        </p>
        <table>
          <tbody>
            <tr>
              <td>Tile map</td>
              <td>48 × 32, loaded in 140 ms</td>
            </tr>
            <tr>
              <td>Pearls</td>
              <td>3 placed, 1 behind the anchor</td>
            </tr>
            <tr>
              <td>Tide gate</td>
              <td>Closes at 1:30</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

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
    stage: <SamplePage />,
    connection: { state: "playing" },
    savedLogins,
  };
  if (state === "driver") {
    return {
      ...base,
      wheelRequests: [{ requestId: id<"browserWheelRequests">("w-1"), from: ana }],
      suggestions: [
        { suggestionId: id<"browserSuggestions">("s-1"), url: "https://github.com/nuko/reef-runner/pull/42", from: bo },
      ],
    };
  }
  if (state === "watcher") {
    return {
      ...base,
      me: ana.memberId,
      isAdmin: false,
      suggestions: [
        { suggestionId: id<"browserSuggestions">("s-2"), url: "https://staging.reefrunner.app/levels/4", from: ana },
      ],
    };
  }
  if (state === "start") {
    return {
      ...base,
      browser: null,
      ended: { ...live, status: "ended", endReason: "idle", endedAt: now - 2 * 60_000 },
    };
  }
  return { ...base, configured: false, browser: null, isAdmin: true };
}

const MESSAGES = [
  { who: julio, text: "Starting a browser on the staging build so we can walk level 3 together." },
  { who: ana, text: "The pearl behind the anchor is still clipping through the rock. Can I take control for a minute?" },
  { who: hermes, text: "Opened the tile map diff from PR 42 in the browser. The anchor collider moved 6 px." },
];

function Channel() {
  const [size, setSize] = useState<"side" | "full">(state === "watcher" ? "full" : "side");
  return (
    <div className="app no-mac-inset">
      <aside className="sidebar">
        <div className="sidebar-top">
          <b>Nuko Nova</b>
        </div>
        <nav style={{ padding: "8px 10px", display: "flex", flexDirection: "column", gap: 2 }}>
          <button className="nav-item" type="button">
            <Icon name="inbox" /> <span className="label-text">Inbox</span>
          </button>
          <button className="nav-item" type="button">
            <Icon name="hash" /> <span className="label-text">general</span>
          </button>
          <button className="nav-item" type="button" aria-current="page">
            <Icon name="hash" /> <span className="label-text">reef-runner</span>
          </button>
        </nav>
      </aside>
      <main className="main" style={{ position: "relative" }}>
        <div className={`channel-layout ${size === "full" ? "with-browser-full" : "with-browser"}`}>
          <div className="channel-col" hidden={size === "full"}>
            <header className="main-head">
              <Icon name="hash" size={16} />
              <h1>reef-runner</h1>
              <span className="grow" />
              <button className="btn small browser-btn" type="button" aria-pressed="true">
                <span className={`lamp ${data().browser ? "on" : ""}`} aria-hidden="true" />
                <Icon name="browser" /> Browser
              </button>
            </header>
            <div className="messages">
              {MESSAGES.map((m, i) => (
                <div key={i} className="msg">
                  <MemberFace member={m.who} members={members} size={28} />
                  <div style={{ minWidth: 0 }}>
                    <div className="msg-head">
                      <b>{m.who.name}</b>
                      {m.who.kind === "agent" ? <span className="tag">Agent, added by Julio Díaz</span> : null}
                    </div>
                    <div className="bubble">{m.text}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <BrowserPanel
            data={data()}
            actions={noop}
            size={size}
            onToggleSize={() => setSize((s) => (s === "full" ? "side" : "full"))}
            onClose={() => {}}
          />
        </div>
      </main>
    </div>
  );
}

function SettingsPage() {
  return (
    <div className="app no-mac-inset">
      <aside className="sidebar">
        <div className="sidebar-top">
          <b>Nuko Nova</b>
        </div>
      </aside>
      <main className="main">
        <header className="main-head">
          <h1>Settings</h1>
        </header>
        <div className="main-body">
          <div className="settings-pane">
            <BrowserSettingsView
              isAdmin
              onSave={() => {}}
              settings={{
                configured: true,
                envVar: "HYPERBEAM_API_KEY",
                mostOpenAccess: "open",
                maxLive: 2,
                idleMinutes: 10,
                longestMinutes: 120,
                limits: {
                  maxLive: { min: 1, max: 10 },
                  idleMinutes: { min: 1, max: 60 },
                  longestMinutes: { min: 10, max: 480 },
                },
                live: 1,
                minutesThisMonth: 312,
              }}
            />
          </div>
        </div>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(state === "settings" ? <SettingsPage /> : <Channel />);
