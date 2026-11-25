import { desktopPermissions, usePermissions, type PermissionsApi } from "../../lib/permissions";
import { CharacterView } from "../../characters/CharacterView";
import { LinkMascot } from "../../characters/LinkMascot";
import { Icon } from "../../components/Icon";
import { api } from "../../lib/api";
import { useAct, useRoomQuery } from "../../lib/session";
import { CUES, playCue, type Cue } from "../../lib/sound";
import type { Preferences } from "../../lib/theme";
import { notifySpec, type NotifyRequest } from "../../../main/notifySpec";
import { Switch } from "@ui-sdk/react/switch";
import "./onOff.css";

const platform =
  (window as unknown as { uplink?: { platform?: NodeJS.Platform } }).uplink?.platform ?? "darwin";

/** Sample banners, the kinds the app shows (DESIGN.md, Notifications). */
const SAMPLES: NotifyRequest[] = [
  {
    kind: "needs",
    id: "sample-allow",
    who: "Codex",
    task: "Tile map loader",
    text: "Wants to run pnpm add tiled-map",
    canAllow: true,
    runId: "sample-run-1",
  },
  {
    kind: "needs",
    id: "sample-deploy",
    who: "Codex",
    task: "Ship 0.4.2",
    text: "Wants to run deploy 0.4.2",
    canAllow: false,
    runId: "sample-run-2",
  },
  {
    kind: "wheel",
    id: "sample-wheel",
    terminal: "Tile map loader",
    machine: "julio-mbp",
    terminalId: "sample-terminal",
  },
  {
    kind: "message",
    id: "sample-message",
    who: "Ana",
    where: "#general",
    direct: false,
    reason: "mention",
    text: "Can you check the staging deploy before 5?",
    channelId: "sample-channel",
    messageId: "sample-message",
  },
];

const CUE_ORDER: Cue[] = ["needs", "wheel", "message", "join", "leave", "settle", "zero"];

export function Notifications({
  prefs,
  permissions = desktopPermissions,
}: {
  prefs: Preferences;
  permissions?: PermissionsApi;
}) {
  const { state } = usePermissions(permissions);
  const status = state?.statuses.notifications;
  const blocked = status === "denied" || status === "restricted";
  return (
    <>
      <div className="pane-title">
        <h2>Notifications</h2>
      </div>

      <div className="panel">
        <div className="panel-section sound-board">
          <div className="sound-link">
            <LinkMascot size={84} />
          </div>
          <div className="settings-copy">
            <span className="label" id="sounds-label">
              Sounds
            </span>
            <OnOff labelledBy="sounds-label" on={prefs.sounds} onChange={prefs.setSounds} />
            <span className="hint">
              Short wood cues for what needs you, control, messages for you, calls, settling and
              Inbox zero. Allowing an approval makes no sound. Link reacts to each cue, sound on or
              off.
            </span>
            <div className="cue-list" role="list" aria-label="Play a cue">
              {CUE_ORDER.map((cue) => (
                <button
                  key={cue}
                  type="button"
                  role="listitem"
                  className="btn cue"
                  onClick={() => playCue(cue, { preview: true })}
                >
                  <Icon name="play" size={14} /> {CUES[cue].label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="banner-section">
        <div className="settings-copy">
          <span className="label" id="banners-label">
            System notifications
          </span>
          <OnOff
            labelledBy="banners-label"
            on={prefs.notifications}
            onChange={prefs.setNotifications}
          />
          {blocked ? (
            <div className="notification-blocked" role="status">
              <Icon name="alert" />
              <span>System notifications are blocked in your operating system settings.</span>
              <button
                className="btn"
                type="button"
                onClick={() => void permissions.open("notifications")}
              >
                Open settings
              </button>
            </div>
          ) : null}
          <span className="hint">
            A banner when something needs you, you get control, or a message is for you: a direct
            message, a mention, @everyone or a reply. Only while you're in another app.
          </span>
          <span className="hint">
            Each channel's bell chooses how much it tells you about: all messages, mentions and
            replies (the default for channels), or nothing. Direct messages tell you about every
            message.
          </span>
          <span className="hint">
            Allow is on the banner only when the action can be undone. A deploy, or anything else
            hard to undo, shows Open, so you decide in the app.
          </span>
        </div>
        <div className="banner-stack" aria-label="Preview of the banners">
          {SAMPLES.map((sample) => (
            <BannerPreview key={sample.id} request={sample} />
          ))}
        </div>
      </div>

      <EmailNotifications />
    </>
  );
}

/** The emails a person can turn off for themselves in this team: for now, "someone you invited joins". */
function EmailNotifications() {
  const settings = useRoomQuery(api.members.emailNotifications, {});
  const set = useAct(api.members.setEmailNotifications);
  return (
    <div className="panel">
      <div className="panel-section">
        <div className="settings-copy">
          <span className="label">Email notifications</span>
          <span className="hint">
            {settings?.email
              ? `Uplink Room emails ${settings.email}, the address you sign in with.`
              : "Uplink Room has no email address for you, so it sends you none."}
          </span>
          <span className="label" id="joined-emails-label" style={{ marginTop: 8 }}>
            Someone you invited joins
          </span>
          <OnOff
            labelledBy="joined-emails-label"
            on={Boolean(settings?.email) && (settings?.joined ?? "on") === "on"}
            disabled={!settings?.email}
            onChange={(on) => void set({ joined: on ? "on" : "off" })}
          />
          <span className="hint">
            An email when a person you, or an agent you added, invited to this team accepts the
            invite. The invites, reminders and welcome emails other people get don't depend on it.
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * A setting that is on or off, on UI SDK's Switch, drawn as the On and Off segments settings have
 * always shown. Space or a press toggles it; a press on the half already showing changes nothing.
 */
export function OnOff({
  on,
  onChange,
  labelledBy,
  disabled = false,
}: {
  on: boolean;
  onChange: (value: boolean) => void;
  /** The id of the setting's label, which names the switch. */
  labelledBy: string;
  disabled?: boolean;
}) {
  return (
    <Switch
      className="seg on-off"
      checked={on}
      disabled={disabled}
      aria-labelledby={labelledBy}
      onCheckedChange={(checked, details) => {
        const target = details.event?.target;
        const side =
          target instanceof Element ? target.closest("[data-side]")?.getAttribute("data-side") : null;
        if (side && side === (on ? "on" : "off")) {
          details.cancel();
          return;
        }
        onChange(checked);
      }}
    >
      <span className="seg-label" data-side="on">
        On
      </span>
      <span className="seg-label" data-side="off">
        Off
      </span>
    </Switch>
  );
}

/** What the system banner says, built from the same spec the main process shows. */
function BannerPreview({ request }: { request: NotifyRequest }) {
  const spec = notifySpec(request, platform);
  return (
    <figure className="banner" aria-label={`Preview: ${spec.title}`}>
      <span className="banner-icon">
        <CharacterView link state="waiting" size={30} label="Uplink Room" />
      </span>
      <div className="banner-text">
        <div className="banner-app">
          <span>Uplink Room</span>
          <span>now</span>
        </div>
        <b>{spec.title}</b>
        {spec.subtitle ? <span className="banner-sub">{spec.subtitle}</span> : null}
        <span className="banner-body">
          {spec.body
            .split(/((?<=Wants to run )[^\n]+)/g)
            .map((part, index) => (index % 2 ? <code key={index}>{part}</code> : part))}
        </span>
      </div>
      <div className="banner-buttons">
        {spec.buttons.map((button) => (
          <span key={button.choice}>{button.text}</span>
        ))}
      </div>
    </figure>
  );
}
