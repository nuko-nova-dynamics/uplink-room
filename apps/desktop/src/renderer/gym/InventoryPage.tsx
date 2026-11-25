import harborPng from "./harbor.png?url&no-inline";
import harborPdf from "./harbor.pdf?url&no-inline";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Attachments } from "../components/chat/Attachments";
import { TrackVideo } from "../components/Call";
import { ScreenTools } from "../components/CallQuality";
import { CameraPicture } from "../components/Devices";
import { ViewBoundary } from "../components/ViewBoundary";
import { Tip } from "../components/Tip";
import { Icon } from "../components/Icon";
import { Face, MemberFace, HarnessMark, StateIcon, StateDot } from "../components/Faces";
import { Empty } from "../components/Empty";
import { Dialog } from "../components/Dialog";
import { CopyButton } from "../components/Copy";
import { ModeOptions, ModeChip, type RuntimeMode } from "../components/RunMode";
import { Cmd } from "../components/Cmd";
import { Wordmark } from "../components/Wordmark";
import { PendingFileChips, PendingFileErrors, type Pending } from "../components/chat/FileUploads";
import { ReactionChips } from "../components/chat/Reactions";
import { UpdatesView } from "../views/settings/Updates";
import { UpdateReadyView } from "../components/UpdateReady";
import { HtmlFrame } from "../components/MessageBody";
import type { UpdateState } from "../../main/updateSpec";
import type { AnyState } from "../lib/states";
import "./inventory.css";

export type InventoryVariant =
  | "default"
  | "disabled"
  | "loading"
  | "error"
  | "empty"
  | "overflow"
  | "many";

export type InventorySpecimen = "html-message" | "update-ready";

const sampleTrack = { attach() {}, detach() {} } as unknown as ComponentProps<
  typeof TrackVideo
>["track"];
function FailedView(): never {
  throw new Error("Sample view failure");
}

/** Real controls with sample props, for states that do not depend on a room query. */
export function InventoryPage({
  variant,
  specimen,
}: {
  variant: InventoryVariant;
  specimen?: InventorySpecimen;
}) {
  const disabled = variant === "disabled";
  const long = variant === "overflow";
  const text = long
    ? "Harbor observation station with a very long unbroken identifier 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    : "Harbor observation";
  const [expanded, expand] = useState(false);
  const [selected, select] = useState(true);
  const [dialog, showDialog] = useState(false);
  const [menu, showMenu] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuBox = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<RuntimeMode>("approval-required");
  const [reaction, setReaction] = useState(false);
  const [pending, setPending] = useState<Pending[]>(() =>
    variant === "empty"
      ? []
      : Array.from({ length: variant === "many" ? 18 : 1 }, (_, i) => ({
          key: String(i),
          name: `${text}-${i}.png`,
          size: 2048,
          status: variant === "loading" ? "uploading" : variant === "error" ? "failed" : "ready",
          error: `${text} could not upload. The sample connection ended.`,
        })),
  );
  const update: UpdateState = {
    phase: variant === "loading" ? "checking" : variant === "error" ? "failed" : "ready",
    version: "0.0.0",
    next: "0.0.1",
    channel: "latest",
    off: null,
    inCall: false,
  };
  const states: AnyState[] = ["waiting", "working", "done", "failed", "stopped", "unknown"];
  useEffect(() => {
    if (!menu) return;
    menuBox.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      showMenu(false);
      menuButton.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);
  if (specimen === "html-message")
    return (
      <main className="inventory-page">
        <section aria-label="HTML message">
          <HtmlFrame
            title="Harbor observation report"
            html={
              '<!doctype html><html style="height:220px"><head><style>body{font:15px sans-serif;margin:16px}h1{font-size:20px}th,td{text-align:left;padding:4px 20px 4px 0}</style></head><body><h1>Harbor observations</h1><p>The north pier gauge is <strong>ready</strong>.</p><table><tr><th>Station</th><th>Reading</th></tr><tr><td>Bayview</td><td>1.8 m</td></tr></table></body></html>'
            }
          />
        </section>
      </main>
    );
  if (specimen === "update-ready")
    return (
      <main className="inventory-page">
        <section aria-label="Update prompt">
          <UpdateReadyView
            placement="sidebar"
            state={{ ...update, phase: "ready" }}
            onRestart={() => new Promise(() => {})}
          />
        </section>
      </main>
    );
  return (
    <main className="inventory-page">
      <h1>Component inventory</h1>
      <section className="inventory-media panel">
        <TrackVideo track={sampleTrack} fit="contain" />
        <CameraPicture stream={null} />
        <ScreenTools
          join="sample-screen"
          isLocal={false}
          expanded={expanded}
          onExpand={() => expand(!expanded)}
        />
      </section>
      <section className="inventory-boundary">
        <ViewBoundary onLeave={() => {}}>
          {variant === "error" ? <FailedView /> : <Empty>No sample results.</Empty>}
        </ViewBoundary>
      </section>
      <section data-inventory="attachments" className="panel">
        <Attachments
          attachments={[
            {
              index: 0,
              name: "harbor-readings.pdf",
              kind: "pdf",
              contentType: "application/pdf",
              size: 512,
              url: harborPdf,
              downloadUrl: null,
            },
            {
              index: 1,
              name: "private-harbor.png",
              kind: "image",
              contentType: "image/png",
              size: 512,
              restricted: true,
              url: null,
              downloadUrl: null,
            },
          ]}
          link={async () =>
            disabled ? undefined : { url: harborPng, expiresAt: Date.now() + 60000 }
          }
        />
      </section>
      <section data-inventory="controls" className="panel">
        <div className="panel-section row-flex">
          <button type="button" className="btn" data-inventory="button" disabled={disabled}>
            {text}
          </button>
          <button
            type="button"
            className="btn icon"
            data-inventory="icon-button"
            disabled={disabled}
            aria-label="Sample icon"
            title="Sample icon"
          >
            <Icon name="plus" />
          </button>
          <button type="button" className="btn primary" disabled={disabled}>
            {text}
          </button>
          <button
            type="button"
            className="icon-btn"
            disabled={disabled}
            aria-label="Sample close"
            title="Sample close"
          >
            <Icon name="close" />
          </button>
          <button className="link-btn" type="button" disabled={disabled}>
            Open run
          </button>
          <CopyButton
            text={
              variant === "error"
                ? async () => {
                    throw new Error("Sample copy failure");
                  }
                : "Sample only"
            }
            disabled={disabled}
            label={long ? text : "Copy"}
          />
          <button
            type="button"
            className="btn icon"
            data-inventory="native-tooltip"
            aria-label="About this sample"
            title="About this sample"
          >
            <Icon name="dots" />
          </button>
          <Tip label="About this sample">
            <button
              type="button"
              className="btn icon"
              data-inventory="tip"
              aria-label="About this sample"
            >
              <Icon name="dots" />
            </button>
          </Tip>
        </div>
        <div className="panel-section">
          <label className="field">
            Name
            <input className="input" disabled={disabled} defaultValue={text} />
          </label>
          <label className="field">
            Description
            <textarea className="textarea" disabled={disabled} defaultValue={text} />
          </label>
          <label className="field">
            Station
            <select className="select" disabled={disabled}>
              <option>{text}</option>
              <option>Bayview</option>
            </select>
          </label>
          <label className="check-row">
            <input type="checkbox" disabled={disabled} />
            Include station
          </label>
          <div className="seg" role="group" aria-label="Sample choice">
            <button
              type="button"
              disabled={disabled}
              aria-pressed={!selected}
              onClick={() => select(false)}
            >
              <span className="seg-label">First</span>
            </button>
            <button
              type="button"
              disabled={disabled}
              aria-pressed={selected}
              onClick={() => select(true)}
            >
              <span className="seg-label">Second</span>
            </button>
          </div>
          <div className="tabs" role="tablist" aria-label="Sample tabs">
            <button
              type="button"
              role="tab"
              disabled={disabled}
              aria-selected={!selected}
              onClick={() => select(false)}
            >
              First
            </button>
            <button
              type="button"
              role="tab"
              disabled={disabled}
              aria-selected={selected}
              onClick={() => select(true)}
            >
              Second
            </button>
          </div>
        </div>
        <div className="panel-section row-flex">
          <span className="chip">{text}</span>
          <span className="badge">18</span>
          <span className="tag">{text}</span>
          <Face
            who={{
              name: text,
              kind: "person",
              avatarUrl: "",
            }}
          />
          <span data-inventory="agent-avatar">
            <Face
              who={{
                name: "Harbor assistant",
                kind: "agent",
                character: { body: "deploy", color: "sand", accessory: "deploy" },
              }}
            />
          </span>
          <MemberFace
            member={{ name: text, kind: "person", memberId: "sample" }}
            presence={{ presence: "active", label: "Active" }}
          />
          <HarnessMark harness="codex" />
          <Cmd text="pnpm test" />
          <Wordmark size={16} />
          {states.map((state) => (
            <span key={state}>
              <StateIcon state={state} />
              <StateDot state={state} />
            </span>
          ))}
        </div>
        <div className="panel-section">
          <ModeOptions
            value={mode}
            onPick={setMode}
            disabled={disabled}
            label="Sample permission mode"
          />
          <ModeChip
            mode={mode}
            pending={variant === "loading" ? "auto" : undefined}
            overCap={variant === "error"}
          />
          <ReactionChips
            reactions={[{ emoji: "👍", count: 3, mine: reaction, names: ["Rosa", "Ana", "Theo"] }]}
            readOnly={disabled}
            onToggle={() => setReaction(!reaction)}
          />
          <ul className="pending-files">
            <PendingFileChips
              pending={pending}
              onRemove={(key) => setPending((p) => p.filter((f) => f.key !== key))}
            />
          </ul>
          <PendingFileErrors
            pending={pending}
            onRemove={(key) => setPending((p) => p.filter((f) => f.key !== key))}
          />
        </div>
        <div className="panel-section">
          <button
            ref={menuButton}
            type="button"
            className="btn"
            aria-haspopup="menu"
            aria-expanded={menu}
            onClick={() => showMenu(!menu)}
          >
            Sample menu
          </button>
          {menu ? (
            <div
              ref={menuBox}
              className="pop"
              role="menu"
              aria-label="Sample menu"
              onKeyDown={(event) => {
                if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const items = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
                );
                const current = items.indexOf(document.activeElement as HTMLButtonElement);
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) %
                        items.length;
                items[next]?.focus();
              }}
            >
              <button
                type="button"
                role="menuitem"
                disabled={disabled}
                onClick={() => showDialog(true)}
              >
                Delete sample
              </button>
            </div>
          ) : null}
          <button type="button" className="btn" onClick={() => showDialog(true)}>
            Sample dialog
          </button>
          <Empty
            action={
              <button type="button" className="btn">
                Add a station
              </button>
            }
          >
            No stations yet.
          </Empty>
          <div className="note warn">{text}</div>
        </div>
      </section>
      <section data-inventory="updates">
        <UpdatesView
          state={update}
          onCheck={async () => {}}
          onRestart={() => new Promise(() => {})}
        />
      </section>
      {dialog ? (
        <Dialog
          title="Delete sample"
          onClose={() => showDialog(false)}
          footer={
            <button className="btn danger" type="button" onClick={() => showDialog(false)}>
              Delete
            </button>
          }
        >
          This only closes the sample dialog.
        </Dialog>
      ) : null}
    </main>
  );
}
