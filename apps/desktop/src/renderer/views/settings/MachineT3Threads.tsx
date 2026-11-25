import { useContext, useEffect, useId, useMemo, useState } from "react";
import type { T3ThreadRow, T3ThreadState, T3ThreadsView } from "../../../main/t3ThreadsSpec";
import { matchesThread, pendingDraft, T3ThreadsContext, threadOrder, threadsToSave, useT3Threads, willShare } from "../../lib/t3Threads";
import { agoText } from "../../lib/format";
import { useToast } from "../../lib/session";
import { Icon } from "../../components/Icon";
import { Button } from "@ui-sdk/react/button";
import { Checkbox } from "@ui-sdk/react/checkbox";
import { Input } from "@ui-sdk/react/input";
import "./t3threads.css";

const STATE_LABEL: Record<T3ThreadState, string> = {
  working: "Working",
  waiting: "Waiting for an answer",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  idle: "Idle",
};

/**
 * The T3 Code threads on this computer, and which of them the room gets (ADR 0045). Shown only in
 * this computer's own machine settings: the list is read from the bridge here and never leaves it.
 * Every thread is private until it's picked and saved; one started from the room is always shared.
 */
export function MachineT3Threads({ machineId }: { machineId: string }) {
  const api = useContext(T3ThreadsContext);
  const { view, refresh, replace } = useT3Threads(api);
  const [paired, setPaired] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void api?.pairedMachine().then(
      (id) => live && setPaired(id),
      () => live && setPaired(null),
    );
    return () => {
      live = false;
    };
  }, [api]);
  if (!api || !view) return null;
  // Another machine's settings, or this computer paired as another machine now: nothing to show.
  const here = "machineId" in view && view.machineId ? view.machineId : paired;
  if (here !== machineId) return null;
  return <Picker view={view} refresh={refresh} replace={replace} />;
}

function Picker({ view, refresh, replace }: { view: T3ThreadsView; refresh: () => void; replace: (next: T3ThreadsView) => void }) {
  const api = useContext(T3ThreadsContext)!;
  const toast = useToast();
  const labelId = useId();
  const searchId = useId();
  const hintId = useId();
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Map<string, boolean>>(new Map());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listed = "threads" in view ? view : null;
  // A choice that now matches what's shared (saved elsewhere, or the thread went) is no longer a change.
  const changes = useMemo(() => (listed ? pendingDraft([...listed.threads, ...listed.missing.map((m) => ({ ...m, shared: true }))], draft) : new Map<string, boolean>()), [listed, draft]);
  const rows = useMemo(() => (listed ? [...listed.threads].sort(threadOrder) : []), [listed]);
  const shown = rows.filter((row) => matchesThread(row, query));
  const missing = listed?.missing ?? [];
  const shownMissing = missing.filter((row) => matchesThread({ id: row.id, title: row.title ?? "", project: row.project ?? "", state: "idle", shared: true, fromRoom: false }, query));
  const sharing = changes.size ? [...changes.values()].filter(Boolean).length : 0;
  const stopping = changes.size - sharing;
  const sharedNow = rows.filter((row) => row.shared).length + missing.length;
  const ready = view.state === "ready";

  const toggle = (id: string, share: boolean) => {
    setError(null);
    setDraft((current) => new Map(current).set(id, share));
  };
  const save = async () => {
    if (!listed || !listed.environmentId || !listed.machineId) return;
    setSaving(true);
    setError(null);
    try {
      const next = await api.share({
        machineId: listed.machineId,
        environmentId: listed.environmentId,
        revision: listed.revision,
        threads: threadsToSave(listed, changes),
      });
      replace(next);
      setDraft(new Map());
      toast.show(savedText(sharing, stopping), true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      // The list may have changed under the save (another save, T3 Code reconnecting): read it again.
      refresh();
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel-section t3-threads" aria-labelledby={labelId}>
      <div className="t3-threads-head">
        <span className="label" id={labelId}>
          T3 Code threads on this computer
        </span>
        {ready && rows.length + missing.length > 0 ? (
          <span className="hint" aria-live="polite">
            {sharedNow} of {rows.length + missing.length} shared
          </span>
        ) : null}
      </div>
      <span className="hint" id={hintId}>
        Private until you share them here. The room gets a shared thread's title, status, messages and tool calls, and its
        driver can message it. Threads started from the room are always shared.
      </span>
      <StateNote view={view} onRetry={refresh} />
      {listed?.otherEnvironment ? (
        <p className="t3-threads-state">
          {listed.otherEnvironment === 1 ? "1 thread was" : `${listed.otherEnvironment} threads were`} shared while T3 Code
          here was another environment, so none of them is shared now. Share threads again below.
        </p>
      ) : null}
      {ready && (rows.length > 0 || missing.length > 0) ? (
        <>
          <div className="t3-threads-search">
            <Icon name="search" />
            <Input
              id={searchId}
              className="input"
              type="search"
              placeholder="Search by title or repo"
              aria-label="Search T3 Code threads"
              value={query}
              onValueChange={setQuery}
            />
          </div>
          <ul className="t3-thread-list" aria-label="T3 Code threads" aria-describedby={hintId}>
            {shown.map((row) => (
              <ThreadRow key={row.id} row={row} share={willShare(row, changes)} changed={changes.has(row.id)} disabled={saving} onChange={(share) => toggle(row.id, share)} />
            ))}
            {shownMissing
              .map((row) => (
                <MissingRow key={row.id} row={row} share={changes.get(row.id) ?? true} disabled={saving} onChange={(share) => toggle(row.id, share)} />
              ))}
          </ul>
          {shown.length === 0 && shownMissing.length === 0 && query.trim() ? (
            <div className="t3-threads-none">
              <span className="muted">No thread matches “{query.trim()}”.</span>
              <button className="btn small" type="button" onClick={() => setQuery("")}>
                Clear search
              </button>
            </div>
          ) : null}
          {error ? (
            <p className="hint amber-text t3-threads-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="t3-threads-foot">
            <span className="hint" aria-live="polite">
              {changes.size ? changeText(sharing, stopping) : "Pick threads to share, then save."}
            </span>
            <span className="row-flex">
              {changes.size ? (
                <button
                  className="btn"
                  type="button"
                  disabled={saving}
                  onClick={() => {
                    setDraft(new Map());
                    setError(null);
                  }}
                >
                  Discard
                </button>
              ) : null}
              <Button className="btn primary" disabled={!changes.size} pendingAnnouncement="Saving" onClick={save}>
                {(state) => (state.pending ? "Saving…" : "Save changes")}
              </Button>
            </span>
          </div>
        </>
      ) : null}
    </section>
  );
}

function ThreadRow({ row, share, changed, disabled, onChange }: { row: T3ThreadRow; share: boolean; changed: boolean; disabled: boolean; onChange: (share: boolean) => void }) {
  const subId = useId();
  const updated = row.updatedAt ? Date.parse(row.updatedAt) : NaN;
  return (
    <li className="t3-thread" data-shared={share ? "true" : undefined}>
      <label className="t3-thread-pick">
        <span className="check-row">
          <Checkbox
            checked={share}
            disabled={disabled || row.fromRoom}
            aria-describedby={subId}
            onCheckedChange={(checked) => onChange(checked === true)}
          />
        </span>
        <span className="t3-thread-text">
          <span className="t3-thread-title">{row.title}</span>
          <span className="sub" id={subId} title={row.projectRoot}>
            {[
              row.project,
              STATE_LABEL[row.state],
              Number.isFinite(updated) ? `changed ${agoText(updated)}` : "",
              row.fromRoom ? "started from the room, so it stays shared until it ends" : "",
            ]
              .filter(Boolean)
              .join(", ")}
          </span>
        </span>
      </label>
      {row.fromRoom ? (
        <span className="chip">
          <Icon name="lock" size={12} />
          From the room
        </span>
      ) : changed ? (
        <span className="chip">{share ? "Will share" : "Will stop sharing"}</span>
      ) : null}
    </li>
  );
}

function MissingRow({ row, share, disabled, onChange }: { row: { id: string; title?: string; project?: string }; share: boolean; disabled: boolean; onChange: (share: boolean) => void }) {
  const subId = useId();
  return (
    <li className="t3-thread" data-shared={share ? "true" : undefined}>
      <label className="t3-thread-pick">
        <span className="check-row">
          <Checkbox checked={share} disabled={disabled} aria-describedby={subId} onCheckedChange={(checked) => onChange(checked === true)} />
        </span>
        <span className="t3-thread-text">
          <span className="t3-thread-title">{row.title ?? "A thread shared from here"}</span>
          <span className="sub" id={subId}>
            {[row.project, "not in T3 Code's list now, shared again if it comes back"].filter(Boolean).join(", ")}
          </span>
        </span>
      </label>
      {!share ? <span className="chip">Will stop sharing</span> : null}
    </li>
  );
}

/** Why there's no list, or what's left to see in an empty one. Plain lines in the panel, not boxes inside it. */
function StateNote({ view, onRetry }: { view: T3ThreadsView; onRetry: () => void }) {
  const line = (text: string) => <p className="t3-threads-state">{text}</p>;
  switch (view.state) {
    case "bridge_off":
      return line("The bridge isn't running on this computer, so its T3 Code threads can't be listed. Nothing is shared from it meanwhile.");
    case "unavailable":
      return (
        <div className="t3-threads-retry" role="alert">
          <span className="hint amber-text">{view.error}</span>
          <button className="btn small" type="button" onClick={onRetry}>
            Try again
          </button>
        </div>
      );
    case "sharing_stopped":
      return line("Sharing is stopped on this computer, so T3 Code isn't read and no thread is shared. Restart the bridge to share again.");
    case "no_t3":
      return line("The bridge on this computer doesn't run T3 Code threads.");
    case "not_paired":
    case "needs_pairing":
      return line("The bridge isn't paired with T3 Code on this computer. Open T3 Code here; the bridge pairs with it by itself.");
    case "connecting":
      return line("Connecting to T3 Code on this computer…");
    case "ready":
      return view.threads.length === 0 && view.missing.length === 0
        ? line("T3 Code has no threads on this computer yet. New threads show up here, private until you share them.")
        : null;
  }
}

const count = (n: number) => (n === 1 ? "1 thread" : `${n} threads`);
function changeText(sharing: number, stopping: number) {
  const parts = [sharing ? `share ${count(sharing)}` : "", stopping ? `stop sharing ${count(stopping)}` : ""].filter(Boolean).join(" and ");
  const line = `${parts[0]!.toUpperCase()}${parts.slice(1)} when you save.`;
  return stopping ? `${line} A thread you stop sharing keeps running in T3 Code, and what the room already has of it stays there.` : line;
}
function savedText(sharing: number, stopping: number) {
  if (sharing && stopping) return `Shared ${count(sharing)} and stopped sharing ${count(stopping)}`;
  return sharing ? `Shared ${count(sharing)} from this computer` : `Stopped sharing ${count(stopping)}`;
}
