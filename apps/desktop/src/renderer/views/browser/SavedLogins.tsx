import { useState } from "react";
import "./browser.css";
import type { FunctionReturnType } from "convex/server";
import type { api, Id } from "../../lib/api";
import { agoText } from "../../lib/format";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { Toggle, ToggleGroup } from "@ui-sdk/react/toggle";
import { Icon } from "../../components/Icon";
import { Tip } from "../../components/Tip";

/**
 * Saved logins for shared browsers (ADR 0011): choosing how long a new browser
 * keeps its logins, the channel's list of saved logins, and the controls to
 * change how long they're kept, rename them or forget them.
 */

export type SavedLoginRow = FunctionReturnType<typeof api.savedLogins.list>[number];
export type Keep = SavedLoginRow["keep"];

export const KEEP_CHOICES: Keep[] = ["1d", "7d", "30d", "forever"];
export const KEEP_LABEL: Record<Keep, string> = {
  "1d": "1 day",
  "7d": "7 days",
  "30d": "30 days",
  forever: "Until deleted",
};
/** Offered first once someone decides to keep logins: long enough for a week of work, short enough to lapse. */
export const DEFAULT_KEEP: Keep = "7d";

/** What Hyperbeam can and can't do, in the words the app uses wherever forgetting comes up. */
export const FORGET_FACTS =
  "Hyperbeam stores saved logins encrypted. Forgetting means no browser here loads them again. Once the last browser using them has ended, the room saves an empty browser over them at Hyperbeam, which erases the logins.";

/** Who may rename, change or forget saved logins: whoever saved them (or the person behind that agent), or an admin. */
export function mayChange(row: SavedLoginRow, me: Id<"members">, isAdmin: boolean) {
  return isAdmin || row.savedBy.memberId === me || row.savedBy.addedBy?.memberId === me;
}

function day(ts: number) {
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** "Kept until Nov 9", or "Kept until someone forgets them". */
export function keptText(row: { keep: Keep; expiresAt?: number }) {
  if (row.keep === "forever" || row.expiresAt === undefined)
    return "Kept until someone forgets them";
  return `Kept until ${day(row.expiresAt)}`;
}

function forgottenText(row: SavedLoginRow) {
  const when = row.forgottenAt ? day(row.forgottenAt) : "";
  if (row.forgetReason === "expired")
    return `Forgotten ${when}: their ${KEEP_LABEL[row.keep]} ran out.`;
  return `${row.forgottenBy?.name ?? "Someone"} forgot them ${when}.`;
}

// ---------------------------------------------------------------------------
// Picking logins when a browser starts

export type LoginsChoice =
  | { kind: "temporary" }
  | { kind: "keep"; name: string; keep: Keep }
  | { kind: "saved"; savedLoginId: Id<"savedLogins"> | null };

export function LoginsPicker({
  channelName,
  saved,
  value,
  onChange,
}: {
  channelName: string;
  saved: SavedLoginRow[];
  value: LoginsChoice;
  onChange: (choice: LoginsChoice) => void;
}) {
  const usable = saved.filter((s) => s.status === "kept");
  const firstFree = usable.find((s) => !s.inUse)?.savedLoginId ?? null;
  const savedItems = usable.map((s) => ({
    value: s.savedLoginId as string,
    label: `${s.name}${s.inUse ? " (a browser is still saving them)" : ""}`,
    disabled: s.inUse,
  }));
  return (
    <div className="field logins-picker">
      <span className="label">Logins</span>
      {/* One choice is always made. Use saved stays focusable while unavailable, so its hint says why. */}
      <ToggleGroup
        className="seg surface-seg"
        aria-label="Logins"
        style={{ alignSelf: "flex-start" }}
        value={[value.kind]}
        deselectable={false}
        onValueChange={(next) => {
          const kind = next[0];
          if (kind === value.kind) return;
          if (kind === "temporary") onChange({ kind: "temporary" });
          else if (kind === "keep") onChange({ kind: "keep", name: "", keep: DEFAULT_KEEP });
          else if (kind === "saved") onChange({ kind: "saved", savedLoginId: firstFree });
        }}
      >
        <Toggle value="temporary">
          <span className="seg-label surface-label">Temporary</span>
        </Toggle>
        <Toggle value="keep">
          <span className="seg-label surface-label">Keep logins</span>
        </Toggle>
        <Tip label={usable.length === 0 ? `#${channelName} has no saved logins yet.` : undefined}>
          <Toggle value="saved" disabled={usable.length === 0}>
            <span className="seg-label surface-label">Use saved</span>
          </Toggle>
        </Tip>
      </ToggleGroup>
      {value.kind === "temporary" ? (
        <span className="hint">
          Nothing you sign in to is kept after the browser ends.
          {usable.length === 0
            ? ` Use saved turns on once someone keeps a login in #${channelName}.`
            : ""}
        </span>
      ) : value.kind === "keep" ? (
        <div className="logins-keep">
          <Field className="field">
            <FieldLabel className="label">Name</FieldLabel>
            <Input
              className="input"
              placeholder="staging admin"
              maxLength={60}
              value={value.name}
              onValueChange={(name) => onChange({ ...value, name })}
            />
          </Field>
          <div className="field">
            <span className="label">Keep for</span>
            <KeepSeg value={value.keep} onChange={(keep) => onChange({ ...value, keep })} />
          </div>
          <span className="hint">
            The browser's cookies, passwords and history are saved when it ends, and load into the
            next browser started with them. Anyone in #{channelName} can start a browser with them.
          </span>
        </div>
      ) : (
        <>
          <Select
            items={savedItems}
            value={value.savedLoginId}
            onValueChange={(next) =>
              onChange({
                kind: "saved",
                savedLoginId: (next || null) as Id<"savedLogins"> | null,
              })
            }
          >
            <SelectTrigger className="select" aria-label="Saved logins">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="pop" align="start" sideOffset={4} collisionPadding={8}>
              {savedItems.map((item) => (
                <SelectItem
                  key={item.value}
                  value={item.value}
                  label={item.label}
                  disabled={item.disabled}
                >
                  {item.label}
                  <SelectItemIndicator>
                    <Icon name="check" size={14} />
                  </SelectItemIndicator>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="hint">New logins are saved back to them when the browser ends.</span>
        </>
      )}
    </div>
  );
}

function KeepSeg({ value, onChange }: { value: Keep; onChange: (keep: Keep) => void }) {
  return (
    <ToggleGroup
      className="seg surface-seg"
      aria-label="Keep for"
      style={{ alignSelf: "flex-start" }}
      value={[value]}
      deselectable={false}
      onValueChange={(next) => {
        const keep = next[0] as Keep | undefined;
        if (keep && keep !== value) onChange(keep);
      }}
    >
      {KEEP_CHOICES.map((k) => (
        <Toggle key={k} value={k}>
          <span className="seg-label surface-label">{KEEP_LABEL[k]}</span>
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

// ---------------------------------------------------------------------------
// Changing saved logins

/** The Keep for… choices, each of which restarts the clock from now. */
const KEEP_ITEMS = KEEP_CHOICES.map((k) => ({
  value: k as string,
  label: k === "forever" ? "Keep until deleted" : `Keep ${KEEP_LABEL[k]} from now`,
}));

export type SavedLoginActions = {
  setKeep(id: Id<"savedLogins">, keep: Keep): void;
  rename(id: Id<"savedLogins">, name: string): void;
  forget(id: Id<"savedLogins">): void;
};

/** Keep for, Rename and Forget, for whoever saved them or an admin. Forgetting asks once more. */
export function SavedLoginControls({
  row,
  actions,
}: {
  row: { savedLoginId: Id<"savedLogins">; name: string; keep: Keep };
  actions: SavedLoginActions;
}) {
  const [mode, setMode] = useState<"idle" | "rename" | "forget">("idle");
  const [name, setName] = useState(row.name);
  if (mode === "rename") {
    return (
      <form
        className="saved-login-controls"
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() && name.trim() !== row.name)
            actions.rename(row.savedLoginId, name.trim());
          setMode("idle");
        }}
      >
        <Input
          className="input"
          aria-label={`New name for ${row.name}`}
          maxLength={60}
          autoFocus
          value={name}
          onValueChange={setName}
        />
        <button className="btn" type="submit">
          Save
        </button>
        <button className="btn ghost" type="button" onClick={() => setMode("idle")}>
          Cancel
        </button>
      </form>
    );
  }
  if (mode === "forget") {
    return (
      <div className="saved-login-controls" role="group" aria-label={`Forget ${row.name}`}>
        <span className="grow">Forget "{row.name}" now?</span>
        <button
          className="btn"
          type="button"
          onClick={() => {
            actions.forget(row.savedLoginId);
            setMode("idle");
          }}
        >
          Forget
        </button>
        <button className="btn ghost" type="button" onClick={() => setMode("idle")}>
          Cancel
        </button>
      </div>
    );
  }
  return (
    <div className="saved-login-controls">
      <Select
        items={KEEP_ITEMS}
        // A prompt, not the current choice: picking any time, even the same one, restarts the clock from now.
        value={null}
        placeholder="Keep for…"
        onValueChange={(keep) => {
          if (typeof keep === "string") actions.setKeep(row.savedLoginId, keep as Keep);
        }}
      >
        <SelectTrigger className="select" aria-label={`Keep ${row.name} for`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="pop" align="start" sideOffset={4} collisionPadding={8}>
          {KEEP_ITEMS.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <button
        className="btn ghost"
        type="button"
        onClick={() => {
          setName(row.name);
          setMode("rename");
        }}
      >
        Rename
      </button>
      <button className="btn ghost" type="button" onClick={() => setMode("forget")}>
        <Icon name="trash" size={14} /> Forget
      </button>
    </div>
  );
}

/** The channel's saved logins, and what was forgotten lately. */
export function SavedLoginsList({
  channelName,
  rows,
  me,
  isAdmin,
  actions,
  onStart,
}: {
  channelName: string;
  rows: SavedLoginRow[];
  me: Id<"members">;
  isAdmin: boolean;
  actions: SavedLoginActions;
  onStart: (id: Id<"savedLogins">) => void;
}) {
  if (rows.length === 0) return null;
  const kept = rows.filter((r) => r.status === "kept");
  const forgotten = rows.filter((r) => r.status === "forgotten");
  return (
    <section className="browser-list saved-logins" aria-label={`Saved logins in #${channelName}`}>
      <h2>Saved logins in #{channelName}</h2>
      {kept.map((r) => (
        <div key={r.savedLoginId} className="saved-login">
          <div className="saved-login-head">
            <Icon name="user" size={14} className="faint" />
            <b className="truncate">{r.name}</b>
            <span className="grow" />
            {r.inUse ? (
              <span className="chip">In a browser now</span>
            ) : (
              <button className="btn" type="button" onClick={() => onStart(r.savedLoginId)}>
                <Icon name="browser" size={14} /> Start with these
              </button>
            )}
          </div>
          <div className="saved-login-meta">
            {keptText(r)}. Saved by {r.savedBy.name}.
            {r.lastUsedAt ? ` Last used ${agoText(r.lastUsedAt)}.` : " Not used yet."}
          </div>
          {mayChange(r, me, isAdmin) ? <SavedLoginControls row={r} actions={actions} /> : null}
        </div>
      ))}
      {forgotten.length > 0 ? (
        <>
          <h2>Forgotten</h2>
          {forgotten.map((r) => (
            <div key={r.savedLoginId} className="saved-login forgotten">
              <div className="saved-login-head">
                <Icon name="trash" size={14} className="faint" />
                <b className="truncate">{r.name}</b>
              </div>
              <div className="saved-login-meta">{forgottenText(r)}</div>
            </div>
          ))}
        </>
      ) : null}
      <p className="hint">{FORGET_FACTS}</p>
    </section>
  );
}

/** One line in a live browser: temporary, or which saved logins it saves to, with their controls. */
export function LiveLogins({
  savedLogin,
  row,
  me,
  isAdmin,
  actions,
}: {
  savedLogin:
    | {
        savedLoginId: Id<"savedLogins">;
        name: string;
        keep: Keep;
        expiresAt?: number;
        status: "kept" | "forgotten";
      }
    | undefined;
  row: SavedLoginRow | undefined;
  me: Id<"members">;
  isAdmin: boolean;
  actions: SavedLoginActions;
}) {
  if (!savedLogin) {
    return (
      <div className="browser-logins">
        <Icon name="user" size={14} /> Temporary: nothing signed in to here is kept after it ends.
      </div>
    );
  }
  if (savedLogin.status === "forgotten") {
    return (
      <div className="browser-logins warn">
        <Icon name="alert" size={14} /> "{savedLogin.name}" was forgotten. This browser keeps
        running, and no browser loads its logins again.
      </div>
    );
  }
  return (
    <div className="browser-logins saved">
      <div className="browser-logins-line">
        <Icon name="user" size={14} />
        <span>
          Saving logins to <b>{savedLogin.name}</b> when it ends. {keptText(savedLogin)}.
        </span>
      </div>
      {row && mayChange(row, me, isAdmin) ? (
        <SavedLoginControls row={savedLogin} actions={actions} />
      ) : null}
    </div>
  );
}
