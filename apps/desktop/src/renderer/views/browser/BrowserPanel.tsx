import { useState, type ReactNode } from "react";
import { Button } from "@ui-sdk/react/button";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import { Toggle, ToggleGroup } from "@ui-sdk/react/toggle";
import type { FunctionReturnType } from "convex/server";
import type { Access, Id, MemberRow } from "../../lib/api";
import type { api } from "../../lib/api";
import { ACCESS_LEVELS, accessRank } from "../../lib/format";
import { MemberFace } from "../../components/Faces";
import { Icon } from "../../components/Icon";
import { Tip } from "../../components/Tip";
import { accessLine, Watching } from "../../components/WorkHead";
import {
  LiveLogins,
  LoginsPicker,
  SavedLoginsList,
  type Keep,
  type LoginsChoice,
  type SavedLoginActions,
  type SavedLoginRow,
} from "./SavedLogins";
import "../../components/files/controls.css";
import "./browser.css";
import { NO_CAPTURE } from "../../lib/analytics";

export type BrowserRow = FunctionReturnType<typeof api.browsers.get>;
type Member = { memberId: Id<"members">; name: string; kind: "person" | "agent" };

/** What the panel shows. The dock (BrowserDock.tsx) fills it from the Room API; the harness from sample data. */
export type BrowserPanelData = {
  channelName: string;
  configured: boolean;
  envVar: string;
  idleMinutes: number;
  mostOpenAccess: Access;
  /** The live browser, or null when there is none. Undefined while loading. */
  browser: BrowserRow | null | undefined;
  /** The one that just ended here, to say why. */
  ended: BrowserRow | null;
  suggestions: { suggestionId: Id<"browserSuggestions">; url: string; from: Member }[];
  wheelRequests: { requestId: Id<"browserWheelRequests">; from: Member }[];
  me: Id<"members">;
  isAdmin: boolean;
  members: MemberRow[];
  /** The live page: the Hyperbeam frame in the app, a sample page in the harness. */
  stage: ReactNode;
  /** What the frame last said: connecting, playing, a close warning, a failure. */
  connection: { state: string; closingInMs?: number | null; message?: string } | null;
  /** The channel's saved logins (ADR 0011), and those forgotten lately. */
  savedLogins: SavedLoginRow[];
};

export type BrowserActions = SavedLoginActions & {
  start(args: {
    url?: string;
    access: Access;
    savedLoginId?: Id<"savedLogins">;
    newSavedLogin?: { name: string; keep: Keep };
  }): void;
  end(): void;
  openUrl(url: string): void;
  suggestUrl(url: string): void;
  openSuggestion(id: Id<"browserSuggestions">): void;
  dismissSuggestion(id: Id<"browserSuggestions">): void;
  setAccess(access: Access): void;
  takeWheel(): void;
  requestWheel(): void;
  passWheel(to: Id<"members">): void;
  answerWheelRequest(id: Id<"browserWheelRequests">, grant: boolean): void;
  reconnect(): void;
};

const ACCESS_ICON = { watch: "eye", suggest: "suggest", drive: "wheel", open: "open" } as const;
const ACCESS_LABEL: Record<Access, string> = {
  watch: "View",
  suggest: "Suggest",
  drive: "Ask for control",
  open: "Take control",
};
/** What each level lets teammates do in a shared browser. */
const ACCESS_HELP: Record<Access, string> = {
  watch: "Teammates see the page and can't click or type.",
  suggest: "Teammates suggest URLs. Whoever is in control decides whether to open them.",
  drive: "One person is in control. Teammates ask them for control.",
  open: "Anyone can take control. Only one mouse and keyboard work at a time.",
};

const END_REASON: Record<NonNullable<BrowserRow["endReason"]>, (b: BrowserRow) => string> = {
  ended: (b) => `${b.endedBy?.name ?? "Someone"} ended the browser.`,
  idle: (b) => `Nobody used the browser for ${b.idleMinutes} minutes, so it ended.`,
  nobody_connected: () => "Everyone left the browser, so it ended.",
  longest_session: (b) =>
    `The browser reached its longest session (${hours(b.longestMinutes)}) and ended.`,
  timed_out: () => "Hyperbeam ended the browser after a timeout.",
  failed: (b) => `The browser couldn't start${b.failReason ? `: ${b.failReason}` : "."}`,
};

function hours(minutes: number) {
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} minutes`;
}

export function BrowserPanel({
  data,
  actions,
  size,
  onToggleSize,
  onClose,
}: {
  data: BrowserPanelData;
  actions: BrowserActions;
  size: "side" | "full";
  onToggleSize: () => void;
  onClose: () => void;
}) {
  const { browser } = data;
  const live = browser && (browser.status === "live" || browser.status === "starting");
  return (
    <aside className={`browser-panel ${size} ${NO_CAPTURE}`} aria-label="Shared browser">
      <header className="main-head">
        <h1>
          <Icon className="head-glyph" name="browser" />
          <span className="browser-title">Shared browser</span>
        </h1>
        <span className="grow" />
        {live ? (
          <Tip label={size === "full" ? "Back to the conversation" : "Full size"}>
            <button
              className="btn icon"
              type="button"
              aria-label={size === "full" ? "Back to the conversation" : "Full size"}
              onClick={onToggleSize}
            >
              <Icon name={size === "full" ? "shrink" : "expand"} />
            </button>
          </Tip>
        ) : null}
        <Tip label="Close the browser panel">
          <button
            className="btn icon"
            type="button"
            aria-label="Close the browser panel"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </Tip>
      </header>
      <div className="browser-body">
        {!data.configured ? (
          <NotConfigured envVar={data.envVar} isAdmin={data.isAdmin} />
        ) : browser === undefined ? null : live ? (
          <LiveBrowser data={data} browser={browser} actions={actions} />
        ) : (
          <StartBrowser data={data} actions={actions} />
        )}
      </div>
    </aside>
  );
}

function NotConfigured({ envVar, isAdmin }: { envVar: string; isAdmin: boolean }) {
  return (
    <div className="browser-intro">
      <h2>Shared browsers aren't set up</h2>
      <p className="muted">
        {isAdmin
          ? "They run on Hyperbeam. Set its API key in this team's Convex environment, and the button here starts one."
          : "They run on Hyperbeam, and an admin needs to add its API key to this team's Convex environment first."}
      </p>
      <code className="browser-cmd mono">npx convex env set {envVar} &lt;key&gt;</code>
      <p className="hint">Hyperbeam's free plan includes 10,000 participant-minutes a month.</p>
    </div>
  );
}

function StartBrowser({ data, actions }: { data: BrowserPanelData; actions: BrowserActions }) {
  const [url, setUrl] = useState("");
  const [access, setAccess] = useState<Access>(
    accessRank("drive") <= accessRank(data.mostOpenAccess) ? "drive" : data.mostOpenAccess,
  );
  // Temporary unless the person picks otherwise: keeping logins is a choice someone makes (ADR 0011).
  const [logins, setLogins] = useState<LoginsChoice>({ kind: "temporary" });
  const needsName = logins.kind === "keep" && !logins.name.trim();
  const needsPick = logins.kind === "saved" && !logins.savedLoginId;
  const startWith = (choice: LoginsChoice) =>
    actions.start({
      ...(url.trim() ? { url: url.trim() } : {}),
      access,
      ...(choice.kind === "keep"
        ? { newSavedLogin: { name: choice.name.trim(), keep: choice.keep } }
        : {}),
      ...(choice.kind === "saved" && choice.savedLoginId
        ? { savedLoginId: choice.savedLoginId }
        : {}),
    });
  return (
    <>
      <form
        className="browser-intro"
        onSubmit={(event) => {
          event.preventDefault();
          if (needsName || needsPick) return;
          startWith(logins);
        }}
      >
        {data.ended?.endReason ? (
          <div className={`note ${data.ended.endReason === "failed" ? "warn" : ""}`}>
            {END_REASON[data.ended.endReason](data.ended)}
            {data.ended.status === "stopping"
              ? " It's shutting down at Hyperbeam and counts toward the team's limit until it's gone."
              : null}
          </div>
        ) : null}
        <h2>Browse together in #{data.channelName}</h2>
        <p className="muted">
          Everyone in the channel can watch. You're in control first and can hand off.
        </p>
        <Field className="field">
          <FieldLabel className="label">Open at</FieldLabel>
          <Input
            className="input"
            type="url"
            inputMode="url"
            placeholder="https://"
            value={url}
            onValueChange={setUrl}
          />
        </Field>
        <div className="field">
          <span className="label">Teammates can</span>
          <AccessSeg
            value={access}
            limit={data.mostOpenAccess}
            canChange={() => true}
            onChange={setAccess}
          />
          {/* You drive first, so the line speaks to the driver. */}
          <span className="hint">{accessLine(access, "browser", { me: true })}</span>
        </div>
        <LoginsPicker
          channelName={data.channelName}
          saved={data.savedLogins}
          value={logins}
          onChange={setLogins}
        />
        {/* Focusable while disabled, so its hint can say what's missing; the form's submit checks it too. */}
        <Tip label={needsName ? "Name the logins to keep them." : undefined}>
          <Button
            className="btn primary surface-btn"
            type="submit"
            disabled={needsName || needsPick}
            focusableWhenDisabled
            style={{ alignSelf: "flex-start" }}
          >
            <Icon name="browser" /> <span className="surface-label">Start browser</span>
          </Button>
        </Tip>
        <p className="hint">
          It ends after {data.idleMinutes} minutes without input, or 5 minutes with nobody watching.
        </p>
      </form>
      <SavedLoginsList
        channelName={data.channelName}
        rows={data.savedLogins}
        me={data.me}
        isAdmin={data.isAdmin}
        actions={actions}
        onStart={(savedLoginId) => startWith({ kind: "saved", savedLoginId })}
      />
    </>
  );
}

function AccessSeg({
  value,
  limit,
  canChange,
  onChange,
  disabled = false,
}: {
  value: Access;
  limit: Access;
  canChange: (level: Access) => boolean;
  onChange: (access: Access) => void;
  disabled?: boolean;
}) {
  // One level is always chosen. Unavailable levels stay focusable, so their hint says why.
  return (
    <ToggleGroup
      className="seg surface-seg"
      aria-label="Teammates can"
      style={{ alignSelf: "flex-start" }}
      value={[value]}
      deselectable={false}
      disabled={disabled}
      onValueChange={(next) => {
        const level = next[0] as Access | undefined;
        if (level && level !== value) onChange(level);
      }}
    >
      {ACCESS_LEVELS.map((level) => {
        const blocked = accessRank(level) > accessRank(limit);
        const allowed = canChange(level);
        return (
          <Tip
            key={level}
            label={
              blocked
                ? `This team allows shared browsers at most ${ACCESS_LABEL[limit]}.`
                : !allowed
                  ? "Only whoever started this browser can open it up; an admin can lower it."
                  : ACCESS_HELP[level]
            }
          >
            <Toggle value={level} disabled={blocked || !allowed}>
              <span className="segment-content">
                <Icon name={ACCESS_ICON[level]} />
                <span>{ACCESS_LABEL[level]}</span>
              </span>
            </Toggle>
          </Tip>
        );
      })}
    </ToggleGroup>
  );
}

function LiveBrowser({
  data,
  browser,
  actions,
}: {
  data: BrowserPanelData;
  browser: BrowserRow;
  actions: BrowserActions;
}) {
  const isDriver = browser.driver.memberId === data.me;
  const isStarter = browser.startedBy.memberId === data.me;
  const starting = browser.status === "starting";
  const [confirmEnd, setConfirmEnd] = useState(false);
  const connectionState = data.connection?.state;
  const connectionFailed =
    connectionState === "error" || connectionState === "failed" || connectionState === "ended";
  const connecting =
    starting || connectionState === "connecting" || connectionState === "reconnecting";
  const status = connectionFailed
    ? "Connection lost"
    : connecting
      ? "Connecting to browser…"
      : null;
  const canSuggest = isDriver || accessRank(browser.access) >= accessRank("suggest");

  return (
    <>
      <div className="browser-bar">
        <div className={`driver-pill ${isDriver ? "me" : ""}`} aria-label="Driver">
          <Icon name="wheel" />
          <MemberFace member={browser.driver} members={data.members} size={18} />
          <span>{isDriver ? "You're in control" : `${browser.driver.name} is in control`}</span>
        </div>
        <span className="grow" />
        {status ? (
          <span className="browser-connection" role="status">
            <Icon name={connectionFailed ? "alert" : "working"} /> <span>{status}</span>
          </span>
        ) : (
          <Watching
            watching={browser.watching}
            me={data.me}
            driverId={browser.driver.memberId}
            members={data.members}
          />
        )}
      </div>

      <LiveLogins
        savedLogin={browser.savedLogin}
        row={data.savedLogins.find((s) => s.savedLoginId === browser.savedLogin?.savedLoginId)}
        me={data.me}
        isAdmin={data.isAdmin}
        actions={actions}
      />

      <div className="browser-stage">
        {starting ? (
          <div className="browser-stage-note" role="status">
            Starting the browser…
          </div>
        ) : connectionFailed ? (
          <div className="browser-stage-note" role="status">
            Connection lost. Reconnect to continue browsing.
          </div>
        ) : (
          data.stage
        )}
      </div>
      {!starting ? (
        <StageStatus
          data={data}
          isDriver={isDriver}
          driverName={browser.driver.name}
          actions={actions}
        />
      ) : null}

      <UrlRow
        key={browser.browserId}
        isDriver={isDriver}
        canSuggest={canSuggest}
        disabled={starting}
        access={browser.access}
        onOpen={actions.openUrl}
        onSuggest={actions.suggestUrl}
      />

      {isDriver && data.wheelRequests.length > 0 ? (
        <div className="browser-list" aria-label="Control requests">
          {data.wheelRequests.map((r) => (
            <div key={r.requestId} className="browser-ask">
              <MemberFace member={r.from} members={data.members} size={20} />
              <span className="grow">
                <b>{r.from.name}</b> asks for control
              </span>
              <button
                className="btn amber"
                type="button"
                onClick={() => actions.answerWheelRequest(r.requestId, true)}
              >
                Hand it over
              </button>
              <button
                className="btn ghost"
                type="button"
                onClick={() => actions.answerWheelRequest(r.requestId, false)}
              >
                Not now
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {data.suggestions.length > 0 ? (
        <div className="browser-list" aria-label="Suggested URLs">
          <h2>Suggested</h2>
          {data.suggestions.map((s) => (
            <div key={s.suggestionId} className="browser-sugg">
              <MemberFace member={s.from} members={data.members} size={18} />
              <span className="truncate grow" title={s.url}>
                {s.url}
              </span>
              {isDriver ? (
                <>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => actions.openSuggestion(s.suggestionId)}
                  >
                    Open
                  </button>
                  <Tip label={`Dismiss ${s.url}`}>
                    <button
                      className="icon-btn"
                      type="button"
                      aria-label={`Dismiss ${s.url}`}
                      onClick={() => actions.dismissSuggestion(s.suggestionId)}
                    >
                      <Icon name="close" />
                    </button>
                  </Tip>
                </>
              ) : (
                <span className="muted">
                  {s.from.memberId === data.me ? "Waiting for whoever is in control" : s.from.name}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : null}

      <div className="browser-controls">
        <span className="label">Teammates can</span>
        {isStarter || data.isAdmin ? (
          <AccessSeg
            value={browser.access}
            limit={data.mostOpenAccess}
            disabled={starting}
            canChange={(level) =>
              isStarter || (data.isAdmin && accessRank(level) <= accessRank(browser.access))
            }
            onChange={actions.setAccess}
          />
        ) : (
          <span
            className="chip"
            title={`${browser.startedBy.name} started this browser and sets its access.`}
          >
            <Icon name={ACCESS_ICON[browser.access]} size={14} /> {ACCESS_LABEL[browser.access]}
          </span>
        )}
        {browser.loweredFrom ? (
          <span className="chip amber">
            {ACCESS_LABEL[browser.access]}, was {ACCESS_LABEL[browser.loweredFrom]}
          </span>
        ) : null}
        <span className="grow" />
        <WheelButton
          data={data}
          browser={browser}
          actions={actions}
          isDriver={isDriver}
          isStarter={isStarter}
        />
        {isStarter || isDriver || data.isAdmin ? (
          confirmEnd ? (
            <div
              className="browser-end-confirm"
              role="group"
              aria-label="End this browser for everyone?"
            >
              <span>End for everyone?</span>
              <button className="btn surface-btn" type="button" onClick={actions.end}>
                <Icon name="stop" /> <span className="surface-label">End browser</span>
              </button>
              <button className="btn" type="button" onClick={() => setConfirmEnd(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button className="btn surface-btn" type="button" onClick={() => setConfirmEnd(true)}>
              <Icon name="stop" /> <span className="surface-label">End</span>
            </button>
          )
        ) : null}
      </div>
      <p className="hint browser-foot">
        {accessLine(
          browser.access,
          "browser",
          isDriver ? { me: true } : { me: false, name: browser.driver.name },
        )}{" "}
        It ends after {browser.idleMinutes} minutes without input.
      </p>
    </>
  );
}

/** One line under the page: whose input reaches it, a close warning, or a lost connection. */
function StageStatus({
  data,
  isDriver,
  driverName,
  actions,
}: {
  data: BrowserPanelData;
  isDriver: boolean;
  driverName: string;
  actions: BrowserActions;
}) {
  const c = data.connection;
  if (c?.state === "closing" && c.closingInMs != null) {
    const seconds = Math.max(1, Math.round(c.closingInMs / 1000));
    return (
      <div className="browser-status needs">
        <Icon name="clock" /> <span>Ends in {seconds} seconds unless someone uses it</span>
      </div>
    );
  }
  if (c?.state === "error" || c?.state === "failed" || c?.state === "ended") {
    return (
      <div className="browser-status">
        <Icon name="alert" />{" "}
        <span className="grow">{c.message ?? "Lost the connection to the browser."}</span>
        <button className="btn" type="button" onClick={actions.reconnect}>
          Reconnect
        </button>
      </div>
    );
  }
  return (
    <div className="browser-status">
      <Icon name={isDriver ? "wheel" : "eye"} />
      <span>
        {isDriver
          ? "Your mouse and keyboard reach the page."
          : `You're watching. Only ${driverName}'s input reaches the page.`}
      </span>
    </div>
  );
}

function UrlRow({
  isDriver,
  canSuggest,
  disabled,
  access,
  onOpen,
  onSuggest,
}: {
  isDriver: boolean;
  canSuggest: boolean;
  disabled: boolean;
  access: Access;
  onOpen: (url: string) => void;
  onSuggest: (url: string) => void;
}) {
  const [url, setUrl] = useState("");
  const can = isDriver || canSuggest;
  return (
    <form
      className="browser-url"
      onSubmit={(event) => {
        event.preventDefault();
        if (!url.trim()) return;
        (isDriver ? onOpen : onSuggest)(url.trim());
        setUrl("");
      }}
    >
      <Icon name="link" className="muted" />
      <Input
        className="input"
        type="url"
        inputMode="url"
        aria-label={isDriver ? "Open a URL" : "Suggest a URL"}
        placeholder={
          isDriver
            ? "Open a URL"
            : can
              ? "Suggest a URL to whoever is in control"
              : `This browser is set to ${ACCESS_LABEL[access]}, so only whoever is in control opens pages`
        }
        disabled={disabled || !can}
        value={url}
        onValueChange={setUrl}
      />
      <button className="btn surface-btn" type="submit" disabled={disabled || !can || !url.trim()}>
        <span className="surface-label">{isDriver ? "Open" : "Suggest"}</span>
      </button>
    </form>
  );
}

function WheelButton({
  data,
  browser,
  actions,
  isDriver,
  isStarter,
}: {
  data: BrowserPanelData;
  browser: BrowserRow;
  actions: BrowserActions;
  isDriver: boolean;
  isStarter: boolean;
}) {
  if (browser.status !== "live") return null;
  if (!isDriver) {
    if (browser.access === "open" || (isStarter && browser.access !== "drive")) {
      return (
        <button className="btn amber" type="button" onClick={actions.takeWheel}>
          <Icon name="wheel" /> Take control
        </button>
      );
    }
    if (browser.access === "drive") {
      const asked = data.wheelRequests.some((r) => r.from.memberId === data.me);
      return (
        <button className="btn" type="button" disabled={asked} onClick={actions.requestWheel}>
          <Icon name="wheel" /> {asked ? "Asked for control" : "Ask for control"}
        </button>
      );
    }
    return null;
  }
  const candidates = data.members.filter(
    (m) =>
      m.memberId !== data.me &&
      (accessRank(browser.access) >= accessRank("drive") ||
        m.memberId === browser.startedBy.memberId),
  );
  return (
    <Menu onAction={(memberId) => actions.passWheel(memberId as Id<"members">)}>
      <MenuTrigger className="btn surface-btn">
        <Icon name="wheel" /> <span className="surface-label">Hand off</span>
      </MenuTrigger>
      <MenuContent
        className="pop browser-handoff"
        side="top"
        align="end"
        sideOffset={4}
        collisionPadding={8}
      >
        <MenuGroup>
          <MenuGroupLabel className="pop-title">Hand off to</MenuGroupLabel>
          {candidates.length === 0 ? (
            <div className="muted" style={{ padding: "6px 9px" }}>
              Nobody can take it at this access level.
            </div>
          ) : null}
          {candidates.map((m) => (
            <MenuItem key={m.memberId} value={m.memberId} label={m.name}>
              <MemberFace member={m} members={data.members} size={18} /> {m.name}
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuContent>
    </Menu>
  );
}
