import "./shell.css";
import { Fragment } from "react";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import { api } from "../lib/api";
import { ago } from "../lib/format";
import { useRoomQuery } from "../lib/session";
import type { Preferences } from "../lib/theme";
import { Icon } from "../components/Icon";
import { Empty } from "../components/Empty";
import type { IconName } from "../lib/states";
import type { Nav } from "../Shell";
import { Machines } from "./settings/Machines";
import { Profiles } from "./settings/Profiles";
import { Agents } from "./settings/Agents";
import { Members } from "./settings/Members";
import { GitHub } from "./settings/GitHub";
import { Browsers } from "./settings/Browsers";
import { Notifications } from "./settings/Notifications";
import { Privacy } from "./settings/Privacy";
import { Updates } from "./settings/Updates";
import { Chat } from "./settings/Chat";
import { Calls } from "./settings/Calls";
import { SetupSettings } from "./settings/Setup";
import { desktopPermissions, type PermissionsApi } from "../lib/permissions";
import { Diagnostics } from "./settings/Diagnostics";
import { CommandLine } from "./settings/CommandLine";

/** What Settings shows someone in no team: only what belongs to them, not to a team. */
export const ACCOUNT_SECTIONS: SettingsSection[] = ["commandLine", "appearance"];

export type SettingsSection =
  | "machines"
  | "profiles"
  | "agents"
  | "members"
  | "github"
  | "browsers"
  | "chat"
  | "calls"
  | "appearance"
  | "notifications"
  | "privacy"
  | "commandLine"
  | "updates"
  | "diagnostics"
  | "activity"
  | "setup";

/** Grouped under short headings so a section can be found by scanning (Machines first: the default). */
const SECTIONS: { key: SettingsSection; label: string; icon: IconName; group: string }[] = [
  { key: "machines", label: "Machines", icon: "machine", group: "Machines" },
  { key: "profiles", label: "Profiles", icon: "lock", group: "Machines" },
  { key: "setup", label: "Setup", icon: "check", group: "Machines" },
  { key: "agents", label: "Agents", icon: "terminal", group: "Team" },
  { key: "members", label: "Members", icon: "user", group: "Team" },
  { key: "github", label: "GitHub", icon: "repo", group: "Team" },
  { key: "browsers", label: "Shared browsers", icon: "browser", group: "Team" },
  { key: "chat", label: "Chat", icon: "comment", group: "You" },
  { key: "calls", label: "Calls", icon: "volume", group: "You" },
  { key: "appearance", label: "Appearance", icon: "sun", group: "You" },
  { key: "notifications", label: "Notifications", icon: "bell", group: "You" },
  { key: "privacy", label: "Privacy", icon: "eye", group: "You" },
  { key: "commandLine", label: "Command line", icon: "terminal", group: "You" },
  { key: "updates", label: "Updates", icon: "download", group: "App" },
  { key: "diagnostics", label: "Diagnostics", icon: "file", group: "App" },
  { key: "activity", label: "Activity", icon: "clock", group: "App" },
];

export function SettingsView({
  section,
  nav,
  prefs,
  permissions = desktopPermissions,
  only,
  onSection,
}: {
  section: SettingsSection;
  nav?: Nav | undefined;
  prefs: Preferences;
  permissions?: PermissionsApi;
  /** Only these sections (ACCOUNT_SECTIONS for someone in no team); all of them by default. */
  only?: SettingsSection[] | undefined;
  /** Opens a section, where there is no team's Nav to go through. */
  onSection?: ((section: SettingsSection) => void) | undefined;
}) {
  const shown = only ? SECTIONS.filter((s) => only.includes(s.key)) : SECTIONS;
  const open = (key: SettingsSection) =>
    onSection ? onSection(key) : nav?.go({ name: "settings", section: key });
  return (
    <>
      <header className="main-head">
        <h1>Settings</h1>
      </header>
      <div className="main-body">
        <div className="settings">
          <nav className="settings-nav" aria-label="Settings sections">
            {shown.map((s, i) => (
              <Fragment key={s.key}>
                {s.group !== shown[i - 1]?.group ? (
                  <div className="settings-nav-group">{s.group}</div>
                ) : null}
                <button
                  className="nav-item"
                  type="button"
                  aria-current={s.key === section ? "page" : undefined}
                  onClick={() => open(s.key)}
                >
                  <Icon name={s.icon} />
                  <span className="label-text">{s.label}</span>
                </button>
              </Fragment>
            ))}
          </nav>
          <div className="settings-pane" data-section={section}>
            {section === "machines" && nav ? <Machines nav={nav} /> : null}
            {section === "profiles" ? <Profiles /> : null}
            {section === "agents" ? <Agents /> : null}
            {section === "members" ? <Members /> : null}
            {section === "github" ? <GitHub /> : null}
            {section === "browsers" ? <Browsers /> : null}
            {section === "chat" ? <Chat /> : null}
            {section === "calls" ? <Calls /> : null}
            {section === "appearance" ? <Appearance prefs={prefs} /> : null}
            {section === "notifications" ? (
              <Notifications prefs={prefs} permissions={permissions} />
            ) : null}
            {section === "privacy" ? <Privacy /> : null}
            {section === "commandLine" ? <CommandLine /> : null}
            {section === "updates" ? <Updates /> : null}
            {section === "diagnostics" ? <Diagnostics /> : null}
            {section === "activity" ? <Activity /> : null}
            {section === "setup" ? (
              <SetupSettings permissions={permissions} onRunSetup={nav?.runSetup} />
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}

const DENSITIES = ["compact", "default", "spacious"] as const;

function Appearance({ prefs }: { prefs: Preferences }) {
  return (
    <>
      <div className="pane-title">
        <h2>Appearance</h2>
      </div>
      <div className="panel">
        <div className="panel-section">
          <span className="label">Theme</span>
          <SegmentedControl
            className="seg"
            aria-label="Theme"
            style={{ alignSelf: "flex-start" }}
            value={prefs.theme}
            onValueChange={(theme) => {
              if (theme === "dark" || theme === "light") prefs.setTheme(theme);
            }}
          >
            <SegmentedControlItem value="dark">
              <Icon name="moon" />
              <span className="seg-label">Dark</span>
            </SegmentedControlItem>
            <SegmentedControlItem value="light">
              <Icon name="sun" />
              <span className="seg-label">Light</span>
            </SegmentedControlItem>
          </SegmentedControl>
        </div>
        <div className="panel-section">
          <span className="label">Row density</span>
          <SegmentedControl
            className="seg"
            aria-label="Row density"
            style={{ alignSelf: "flex-start" }}
            value={prefs.density}
            onValueChange={(density) => {
              const d = DENSITIES.find((option) => option === density);
              if (d) prefs.setDensity(d);
            }}
          >
            {DENSITIES.map((d) => (
              <SegmentedControlItem key={d} value={d}>
                <span className="seg-label">{d[0]!.toUpperCase() + d.slice(1)}</span>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
          <span className="hint">
            How much room each row in the Inbox and the lists gets. Compact is the default.
          </span>
        </div>
      </div>
    </>
  );
}

function Activity() {
  const entries = useRoomQuery(api.activity.list, { limit: 100 });
  return (
    <>
      <div className="pane-title">
        <h2>Activity</h2>
      </div>
      <div className="panel">
        <table className="table">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>What</th>
            </tr>
          </thead>
          <tbody>
            {(entries ?? []).map((e, i) => (
              <tr key={`${e.at}-${i}`}>
                <td className="muted activity-age">{ago(e.at)}</td>
                <td>
                  {e.actor.name}
                  {e.accountable ? <span className="muted">, for {e.accountable.name}</span> : null}
                </td>
                <td>
                  <code>{e.action}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries && entries.length === 0 ? (
          <Empty>
            Nothing recorded yet. Changes to the team, its machines and its runs show up here.
          </Empty>
        ) : null}
      </div>
    </>
  );
}
