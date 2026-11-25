import { useEffect, useState } from "react";
import type { FunctionReturnType } from "convex/server";
import { api, type Access } from "../../lib/api";
import { ACCESS_LEVELS } from "../../lib/format";
import { useAct, useRoomQuery, useSession } from "../../lib/session";
import { Field, FieldDescription, FieldLabel } from "@ui-sdk/react/field";
import { NumberInput, NumberInputControl, NumberInputGroup } from "@ui-sdk/react/number-input";
import { SegmentedControl, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import "../../components/files/controls.css";
import "./browsers.css";
import { Icon } from "../../components/Icon";

type Settings = FunctionReturnType<typeof api.browsers.settings>;
type Limits = Pick<Settings, "mostOpenAccess" | "maxLive" | "idleMinutes" | "longestMinutes">;

const ACCESS_LABEL: Record<Access, string> = {
  watch: "View",
  suggest: "Suggest",
  drive: "Ask for control",
  open: "Take control",
};
const FREE_MINUTES = 10_000;

/** Team settings for shared browsers (spec #7): whether they're set up, their limits, and this month's use. */
export function Browsers() {
  const session = useSession();
  const settings = useRoomQuery(api.browsers.settings, {});
  const save = useAct(api.browsers.setSettings, { success: "Saved" });
  if (!settings) return null;
  return (
    <BrowserSettingsView
      settings={settings}
      isAdmin={session.isAdmin}
      onSave={(next) => void save(next)}
    />
  );
}

export function BrowserSettingsView({
  settings,
  isAdmin,
  onSave,
}: {
  settings: Settings;
  isAdmin: boolean;
  onSave: (next: Limits) => void;
}) {
  const [draft, setDraft] = useState<Limits>(settings);
  useEffect(() => setDraft(settings), [settings]);
  const changed = (Object.keys(draft) as (keyof Limits)[]).some((k) => draft[k] !== settings[k]);
  const number = (
    key: "maxLive" | "idleMinutes" | "longestMinutes",
    label: string,
    unit: string,
    hint: string,
  ) => {
    const { min, max } = settings.limits[key];
    return (
      <Field className="field">
        <FieldLabel className="label">{label}</FieldLabel>
        <NumberInput
          min={min}
          max={max}
          step={1}
          disabled={!isAdmin}
          value={draft[key]}
          onValueChange={(value) => {
            if (value !== null) setDraft({ ...draft, [key]: value });
          }}
        >
          <NumberInputGroup className="row-flex" style={{ gap: 8 }}>
            <NumberInputControl className="input" style={{ width: 84 }} />
            <span className="muted">{unit}</span>
          </NumberInputGroup>
        </NumberInput>
        <FieldDescription className="hint">{hint}</FieldDescription>
      </Field>
    );
  };

  return (
    <div className="browser-settings">
      <div className="pane-title">
        <h2>Shared browsers</h2>
        <span className={`chip ${settings.configured ? "" : "amber"}`}>
          {settings.configured ? "API key set" : "Not set up"}
        </span>
      </div>

      {!settings.configured ? (
        <div className="note warn">
          Shared browsers run on Hyperbeam and need its API key in this team's Convex environment:{" "}
          <code className="mono">npx convex env set {settings.envVar} &lt;key&gt;</code>. Until then
          the Browser button in each channel says they aren't set up.
        </div>
      ) : null}

      <div className="panel">
        <div className="panel-section">
          <span className="label">This month</span>
          <div className="row-flex" style={{ gap: 18, alignItems: "baseline" }}>
            <span>
              <b>{settings.minutesThisMonth.toLocaleString()}</b>{" "}
              <span className="muted">browser minutes</span>
            </span>
            <span>
              <b>{settings.live}</b> <span className="muted">live now</span>
            </span>
          </div>
          <span className="hint">
            Hyperbeam bills per participant-minute after {FREE_MINUTES.toLocaleString()} free a
            month, so three people in a browser for an hour use 180. Its dashboard has the exact
            count.
          </span>
        </div>

        <form
          className="panel-section"
          onSubmit={(event) => {
            event.preventDefault();
            onSave(draft);
          }}
        >
          <div className="field">
            <span className="label">Most open access</span>
            <SegmentedControl
              className="seg surface-seg"
              aria-label="Most open access"
              style={{ alignSelf: "flex-start" }}
              disabled={!isAdmin}
              value={draft.mostOpenAccess}
              onValueChange={(level) => {
                if (level) setDraft({ ...draft, mostOpenAccess: level as Access });
              }}
            >
              {ACCESS_LEVELS.map((level) => (
                <SegmentedControlItem key={level} value={level}>
                  <span className="surface-label">{ACCESS_LABEL[level]}</span>
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
            <span className="hint">Lowering it lowers live browsers above it right away.</span>
          </div>
          <div className="browser-settings-grid">
            {number(
              "maxLive",
              "Live at once",
              "browsers",
              "Starting one more fails until one ends.",
            )}
            {number(
              "idleMinutes",
              "Idle timeout",
              "minutes",
              "Without any input for this long, a browser ends.",
            )}
            {number(
              "longestMinutes",
              "Longest session",
              "minutes",
              "A browser ends this long after it starts.",
            )}
          </div>
          {isAdmin ? (
            <div className="row-flex" style={{ gap: 8 }}>
              <button className="btn primary" type="submit" disabled={!changed}>
                <Icon name="check" /> Save
              </button>
              <span className="hint">New limits apply to browsers started after you save.</span>
            </div>
          ) : (
            <span className="hint">Only admins change these.</span>
          )}
        </form>
      </div>
    </div>
  );
}
