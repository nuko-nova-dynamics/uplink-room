import { createRoot } from "react-dom/client";
import "./styles.css";
import type { UpdateState } from "../main/updateSpec";
import { Icon } from "./components/Icon";
import { UpdateReadyView } from "./components/UpdateReady";
import { UpdatesView } from "./views/settings/Updates";
import type { LoginItemState } from "../main/loginItemSpec";
import "./look.css";

/**
 * Sample data only. Renders the real "Restart to update" prompt in a sidebar and the real Settings,
 * Updates pane, with no sign-in and no backend, so review screenshots can show each state:
 * `update-harness.html?theme=dark|light&state=ready|call|downloading|preparing|failed|signature|channel|idle|off|deb`,
 * with `&login=on|off|approval|none` for the "Open at login" panel (on by default).
 * The sidebar around the prompt is a static stand-in with sample names.
 */
const params = new URLSearchParams(location.search);
document.documentElement.dataset["theme"] = params.get("theme") === "light" ? "light" : "dark";
const now = Date.now();

const base: UpdateState = {
  phase: "idle",
  version: "0.2.0",
  channel: "latest",
  off: null,
  inCall: false,
  checkedAt: now - 3 * 60_000,
};
const STATES: Record<string, UpdateState> = {
  ready: { ...base, phase: "ready", next: "0.2.1" },
  call: { ...base, phase: "ready", next: "0.2.1", inCall: true },
  downloading: { ...base, phase: "downloading", next: "0.2.1", percent: 42 },
  preparing: { ...base, phase: "preparing", next: "0.2.1" },
  failed: { ...base, phase: "failed" },
  signature: { ...base, phase: "failed", failure: "signature" },
  channel: { ...base, phase: "failed", failure: "channel" },
  idle: base,
  test: { ...base, version: "0.2.1-test.1", channel: "test" },
  off: { ...base, phase: "off", off: "development", version: "0.2.0" },
  deb: { ...base, phase: "off", off: "linux-package" },
};
const state = STATES[params.get("state") ?? "ready"] ?? STATES["ready"]!;
const noop = async () => false;
const LOGIN: Record<string, LoginItemState | null> = {
  on: { supported: true, on: true, needsApproval: false },
  off: { supported: true, on: false, needsApproval: false },
  approval: { supported: true, on: true, needsApproval: true },
  none: null,
};
const login = LOGIN[params.get("login") ?? "on"] ?? LOGIN["on"]!;

type Item = { icon: Parameters<typeof Icon>[0]["name"]; label: string };
/** The sidebar's sections in Shell.tsx's order, with sample names. */
const SECTIONS: { heading?: string; items: Item[] }[] = [
  { items: [{ icon: "inbox", label: "Inbox" }] },
  {
    heading: "Roster",
    items: [
      { icon: "terminal", label: "Claude Code" },
      { icon: "terminal", label: "Codex" },
    ],
  },
  {
    heading: "Projects",
    items: [
      { icon: "folder", label: "Reef Runner" },
      { icon: "folder", label: "Website" },
    ],
  },
  {
    heading: "Channels",
    items: [
      { icon: "hash", label: "general" },
      { icon: "hash", label: "reef-runner" },
    ],
  },
  {
    heading: "Direct messages",
    items: [
      { icon: "user", label: "Mara Okafor" },
      { icon: "user", label: "Hermes" },
    ],
  },
];

function Harness() {
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-top">
          <span className="team-btn">Sample team</span>
        </div>
        <form className="sidebar-search" role="search" onSubmit={(event) => event.preventDefault()}>
          <Icon name="search" />
          <input type="search" placeholder="Search messages" aria-label="Search messages" />
        </form>
        <nav className="sidebar-scroll" aria-label="Sample sidebar">
          {SECTIONS.map((section) => (
            <div key={section.heading ?? "top"}>
              {section.heading ? (
                <div className="nav-heading">
                  <span className="grow">{section.heading}</span>
                </div>
              ) : null}
              {section.items.map((item) => (
                <button key={item.label} className="nav-item" type="button">
                  <Icon name={item.icon} />
                  <span className="label-text">{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
        <UpdateReadyView placement="sidebar" state={state} onRestart={noop} />
        <div className="sidebar-bottom">
          <span className="grow truncate muted">Ana Ruiz</span>
          <button className="icon-btn" type="button" aria-label="Settings" aria-pressed>
            <Icon name="gear" />
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="main-head">
          <h1>Settings</h1>
        </header>
        <div className="main-body">
          <div className="settings">
            <nav className="settings-nav" aria-label="Settings sections">
              <button className="nav-item" type="button">
                <Icon name="eye" />
                <span className="label-text">Privacy</span>
              </button>
              <button className="nav-item" type="button" aria-current="page">
                <Icon name="download" />
                <span className="label-text">Updates</span>
              </button>
            </nav>
            <div className="settings-pane">
              <UpdatesView state={state} onCheck={noop} onRestart={noop} openAtLogin={login} />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
