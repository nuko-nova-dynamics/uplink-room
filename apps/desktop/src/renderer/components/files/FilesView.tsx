import "./files.css";
import "./controls.css";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { Textarea } from "@ui-sdk/react/textarea";
import { Toggle, ToggleGroup } from "@ui-sdk/react/toggle";
import { api, type FileRow, type Id } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { agoText } from "../../lib/format";
import { useAct, useRoomQuery, useSession, useToast } from "../../lib/session";
import { NO_CAPTURE, track } from "../../lib/analytics";
import { Dialog } from "../Dialog";
import { Icon } from "../Icon";
import { HtmlFrame } from "../MessageBody";
import { Tip } from "../Tip";
import type { IconName } from "../../lib/states";
import { CommentRail } from "./CommentRail";
import { ImageViewer } from "./ImageViewer";
import { PdfFrame } from "./PdfFrame";
import type { Pin, PinView } from "./pins";
import type { SaveResult } from "./DocViewer";
import type { CanvasAttempt } from "./sync";

// The editors are large; they load when a doc or canvas is first opened.
const DocViewer = lazy(() => import("./DocViewer"));
const CanvasViewer = lazy(() => import("./CanvasViewer"));

type Format = FileRow["format"];

const KIND: Record<Format, { icon: IconName; label: string; hint: string }> = {
  markdown: {
    icon: "doc",
    label: "Doc",
    hint: "To comment on a passage, select it in the doc and choose Comment.",
  },
  html: { icon: "file", label: "HTML page", hint: "" },
  pdf: { icon: "pdf", label: "PDF", hint: "Click the page where the comment goes." },
  image: { icon: "image", label: "Image", hint: "Click the image where the comment goes." },
  canvas: { icon: "canvas", label: "Canvas", hint: "Click the canvas where the comment goes." },
};

function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const UPLOAD_ACCEPT = ".pdf,.png,.jpg,.jpeg,.gif,.webp";

/** A project's files: the list, a viewer for the open file, and its pinned comments (spec #9). */
export function FilesView({ projectId }: { projectId: Id<"projects"> }) {
  const { teamId, members, me, isAdmin } = useSession();
  const toast = useToast();
  const files = useRoomQuery(api.files.list, { projectId });
  const [openId, setOpenId] = useState<Id<"files"> | null>(null);
  const [creating, setCreating] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const selectedId =
    openId && files?.some((f) => f.fileId === openId) ? openId : (files?.[0]?.fileId ?? null);

  const uploadUrl = useMutation(api.files.uploadUrl);
  const addUpload = useMutation(api.files.addUpload);

  const upload = async (file: File) => {
    setUploading(file.name);
    try {
      const { uploadUrl: url, uploadId } = await uploadUrl({ teamId });
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!response.ok) throw new Error(`The upload failed (${response.status}).`);
      const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
      const fileId = await addUpload({ teamId, projectId, name: file.name, uploadId, storageId });
      setOpenId(fileId);
      toast.show(`Uploaded ${file.name}`, true);
    } catch (error) {
      toast.show(errorMessage(error));
    } finally {
      setUploading(null);
    }
  };

  return (
    <div className={`files-layout ${NO_CAPTURE}`}>
      <nav className="file-list" aria-label="Files">
        <div className="row-flex file-list-actions">
          <button className="btn" type="button" onClick={() => setCreating(true)}>
            <Icon name="plus" /> New
          </button>
          <button
            className="btn"
            type="button"
            disabled={uploading !== null}
            onClick={() => picker.current?.click()}
          >
            <Icon name="upload" /> {uploading ? "Uploading…" : "Upload"}
          </button>
          <input
            ref={picker}
            type="file"
            accept={UPLOAD_ACCEPT}
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
          />
        </div>
        {(files ?? []).map((f) => (
          <button
            key={f.fileId}
            className="file-item"
            type="button"
            aria-current={f.fileId === selectedId ? "page" : undefined}
            onClick={() => setOpenId(f.fileId)}
          >
            <Icon name={KIND[f.format].icon} />
            <span className="truncate">{f.name}</span>
            {f.openComments ? (
              <span
                className="file-count"
                title={`${f.openComments} open comment${f.openComments === 1 ? "" : "s"}`}
              >
                <Icon name="comment" />
                {f.openComments}
              </span>
            ) : null}
          </button>
        ))}
        {files && files.length === 0 ? (
          <div className="file-empty">
            Docs, canvases, PDFs and images kept in this project show up here. People and agents can
            pin comments to any spot in them.
          </div>
        ) : null}
      </nav>

      {selectedId ? (
        <OpenFile
          key={selectedId}
          fileId={selectedId}
          teamId={teamId}
          members={members}
          myMemberId={me.memberId}
          isAdmin={isAdmin}
        />
      ) : (
        <div className="empty files-empty">
          <p>No file open.</p>
          <div className="row-flex" style={{ justifyContent: "center" }}>
            <button className="btn" type="button" onClick={() => setCreating(true)}>
              <Icon name="plus" /> New doc or canvas
            </button>
            <button className="btn" type="button" onClick={() => picker.current?.click()}>
              <Icon name="upload" /> Upload a PDF or image
            </button>
          </div>
        </div>
      )}

      {creating ? (
        <NewFileDialog
          projectId={projectId}
          onClose={() => setCreating(false)}
          onCreated={(fileId) => {
            setCreating(false);
            setOpenId(fileId);
          }}
        />
      ) : null}
    </div>
  );
}

function OpenFile({
  fileId,
  teamId,
  members,
  myMemberId,
  isAdmin,
}: {
  fileId: Id<"files">;
  teamId: Id<"teams">;
  members: ReturnType<typeof useSession>["members"];
  myMemberId: string;
  isAdmin: boolean;
}) {
  const file = useRoomQuery(api.files.get, { fileId });
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const threads = useRoomQuery(api.comments.list, { fileId, status });
  const openThreads = useRoomQuery(api.comments.list, { fileId });
  const scene = useRoomQuery(api.canvas.scene, file?.format === "canvas" ? { fileId } : "skip");
  const [selected, setSelected] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [draft, setDraft] = useState<Pin | null>(null);
  const [found, setFound] = useState<ReadonlySet<string> | null>(null);
  /** The downloaded bytes, with the URL they came from: a replaced file has a new URL. */
  const [download, setDownload] = useState<{ url: string; data: ArrayBuffer } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const add = useAct(api.comments.add);
  const reply = useAct(api.comments.reply);
  const resolve = useAct(api.comments.resolve, { success: "Resolved" });
  const reopen = useAct(api.comments.reopen, { success: "Reopened" });
  const remove = useAct(api.comments.delete, { success: "Comment deleted" });
  const saveCanvas = useMutation(api.canvas.save);
  const toast = useToast();
  const edit = useMutation(api.files.edit);

  const format = file?.format;
  // Analytics: what kind of file was opened, never which one or what it holds.
  useEffect(() => {
    if (format) track("file_opened", { file_kind: format === "markdown" ? "doc" : format });
  }, [fileId, format]);
  const url = file && "url" in file ? file.url : null;

  // PDFs and images are downloaded here, so the viewer gets bytes, never a URL.
  // When the file is replaced under the same name, its URL changes and the new bytes are fetched.
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    setFailed(null);
    void fetch(url)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Download failed (${response.status})`);
        const data = await response.arrayBuffer();
        if (!cancelled) setDownload({ url, data });
      })
      .catch((error: unknown) => !cancelled && setFailed(errorMessage(error)));
    return () => {
      cancelled = true;
    };
  }, [url]);

  // Only bytes from the file's current URL are shown, never the previous file's.
  const bytes = download && download.url === url ? download.data : null;
  const contentType = file && "contentType" in file ? file.contentType : "";
  const imageSrc = useMemo(() => {
    if (format !== "image" || !bytes) return null;
    return URL.createObjectURL(new Blob([bytes], { type: contentType }));
  }, [format, bytes, contentType]);
  useEffect(() => () => void (imageSrc && URL.revokeObjectURL(imageSrc)), [imageSrc]);

  // Esc leaves pin placing.
  useEffect(() => {
    if (!placing) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setPlacing(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [placing]);

  const pins: PinView[] = useMemo(
    () => (threads ?? []).map((t, i) => ({ commentId: t.commentId, n: i + 1, pin: t.pin })),
    [threads],
  );
  const detached = useMemo(() => {
    if (format !== "markdown" || !found) return new Set<string>();
    return new Set(
      (threads ?? [])
        .filter((t) => t.pin.kind === "text" && !found.has(t.commentId))
        .map((t) => t.commentId),
    );
  }, [format, found, threads]);

  if (!file) return <div className="viewer-col" />;

  const viewerPins = {
    pins,
    selected,
    draft,
    placing,
    onPlace: (pin: Pin) => {
      setPlacing(false);
      setDraft(pin);
      setSelected(null);
    },
    onSelect: (commentId: string) => {
      setSelected(commentId);
      setDraft(null);
    },
  };

  const onSaveDoc = async (content: string, baseVersion: number): Promise<SaveResult> => {
    try {
      return await edit({ teamId, fileId, content, baseVersion });
    } catch (error) {
      if (error instanceof ConvexError && (error.data as { code?: string }).code === "conflict") {
        return { conflict: (error.data as { message: string }).message };
      }
      return { conflict: errorMessage(error) };
    }
  };

  const kind = KIND[file.format];
  let viewer: React.ReactNode;
  if (failed) {
    viewer = <div className="viewer-note">This file couldn't be downloaded: {failed}</div>;
  } else if (file.format === "pdf") {
    // Keyed by URL: a replaced PDF gets a fresh frame, which loads the new bytes.
    viewer =
      bytes && url ? (
        <PdfFrame key={url} data={bytes} title={file.name} {...viewerPins} />
      ) : (
        <div className="viewer-loading">Downloading…</div>
      );
  } else if (file.format === "image") {
    viewer = imageSrc ? (
      <ImageViewer src={imageSrc} name={file.name} {...viewerPins} />
    ) : (
      <div className="viewer-loading">Downloading…</div>
    );
  } else if (file.format === "html" && "content" in file) {
    viewer = (
      <div className="html-viewer">
        {/* The frame renders only its first page, so a new version needs a new frame. */}
        <HtmlFrame key={`${file.fileId}:${file.version}`} html={file.content} title={file.name} />
      </div>
    );
  } else if (file.format === "markdown" && "content" in file) {
    viewer = (
      <DocViewer
        fileId={file.fileId}
        content={file.content}
        version={file.version}
        updatedBy={file.updatedBy.name}
        onSave={onSaveDoc}
        onFound={(ids) => setFound(new Set(ids))}
        {...viewerPins}
      />
    );
  } else if (file.format === "canvas") {
    viewer = scene ? (
      <CanvasViewer
        fileId={file.fileId}
        elements={scene.elements}
        onSave={async (elements): Promise<CanvasAttempt> => {
          try {
            await saveCanvas({ teamId, fileId, elements });
            return { ok: true };
          } catch (error) {
            const code =
              error instanceof ConvexError ? (error.data as { code?: string }).code : undefined;
            const message = errorMessage(error);
            // The room's own refusals don't change on retry; anything else (offline, a blip) may.
            if (code === "invalid") return { ok: false, kind: "invalid", message };
            if (code === "forbidden" || code === "not_found" || code === "unauthenticated") {
              return {
                ok: false,
                kind: "refused",
                message: `The canvas can't be saved: ${message}`,
              };
            }
            return { ok: false, kind: "retry", message };
          }
        }}
        onRejected={(message) => toast.show(message)}
        {...viewerPins}
      />
    ) : (
      <div className="viewer-loading">Opening the canvas…</div>
    );
  }

  return (
    <>
      <section className="viewer-col" aria-label={file.name}>
        <header className="viewer-head">
          <Icon name={kind.icon} />
          <b className="truncate">{file.name}</b>
          <span className="tag">{kind.label}</span>
          {"size" in file && file.size ? (
            <span className="muted file-size">{sizeText(file.size)}</span>
          ) : null}
          <span className="grow" />
          <span className="muted truncate">
            {file.updatedBy.name}, {agoText(file.updatedAt)}
          </span>
          {url ? (
            <Tip label="Download">
              <button
                className="btn icon"
                type="button"
                aria-label="Download"
                onClick={() => window.open(url)}
              >
                <Icon name="upload" style={{ transform: "rotate(180deg)" }} />
              </button>
            </Tip>
          ) : null}
          <Tip label="Delete file">
            <button
              className="btn icon"
              type="button"
              aria-label="Delete file"
              onClick={() => setDeleting(true)}
            >
              <Icon name="trash" />
            </button>
          </Tip>
        </header>
        <div className={`viewer-body ${placing ? "is-placing" : ""}`}>
          <Suspense fallback={<div className="viewer-loading">Opening…</div>}>{viewer}</Suspense>
        </div>
      </section>
      <CommentRail
        pinBy={file.format === "html" ? "none" : file.format === "markdown" ? "select" : "click"}
        pinHint={kind.hint}
        placing={placing}
        onStartPin={() => {
          setSelected(null);
          setDraft(null);
          setStatus("open");
          setPlacing(true);
        }}
        onCancelPin={() => {
          setPlacing(false);
          setDraft(null);
        }}
        draft={draft}
        onComment={async (pin, body) => {
          const id = await add({ fileId, body, pin });
          if (id === undefined) return false;
          setDraft(null);
          setStatus("open");
          setSelected(id);
          return true;
        }}
        threads={threads}
        status={status}
        onStatus={(next) => {
          setStatus(next);
          setSelected(null);
        }}
        openCount={openThreads?.length ?? 0}
        selected={selected}
        onSelect={(id) => {
          setSelected(id);
          setDraft(null);
        }}
        detached={detached}
        members={members}
        canDelete={(thread) =>
          isAdmin ||
          thread.author.memberId === myMemberId ||
          (thread.author.kind === "agent" && thread.author.addedBy?.memberId === myMemberId)
        }
        onReply={async (commentId, body) =>
          (await reply({ commentId: commentId as Id<"comments">, body })) !== undefined
        }
        onResolve={(commentId) => {
          setSelected(null);
          void resolve({ commentId: commentId as Id<"comments"> });
        }}
        onReopen={(commentId) => {
          setSelected(null);
          void reopen({ commentId: commentId as Id<"comments"> });
        }}
        onDelete={(commentId) => {
          setSelected(null);
          void remove({ commentId: commentId as Id<"comments"> });
        }}
      />
      {deleting ? (
        <DeleteFileDialog fileId={fileId} name={file.name} onClose={() => setDeleting(false)} />
      ) : null}
    </>
  );
}

function DeleteFileDialog({
  fileId,
  name,
  onClose,
}: {
  fileId: Id<"files">;
  name: string;
  onClose: () => void;
}) {
  const remove = useAct(api.files.delete, { success: `Deleted ${name}` });
  return (
    <Dialog
      title={`Delete ${name}?`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Keep it
          </button>
          <button
            className="btn"
            type="button"
            onClick={async () => {
              if ((await remove({ fileId })) !== undefined) onClose();
            }}
          >
            Delete file
          </button>
        </>
      }
    >
      <p className="file-delete-copy">
        The file and all of its comments are deleted for everyone in the team. This can't be undone.
      </p>
    </Dialog>
  );
}

const NEW_KINDS = [
  { format: "markdown", label: "Doc", ext: ".md", name: "notes" },
  { format: "canvas", label: "Canvas", ext: ".excalidraw", name: "sketch" },
  { format: "html", label: "HTML page", ext: ".html", name: "page" },
] as const;

function NewFileDialog({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: Id<"projects">;
  onClose: () => void;
  onCreated: (fileId: Id<"files">) => void;
}) {
  const save = useAct(api.files.save, { success: "File created" });
  const [kind, setKind] = useState<(typeof NEW_KINDS)[number]>(NEW_KINDS[0]);
  const [name, setName] = useState("notes");
  const [html, setHtml] = useState("");
  const base = name.trim().replace(/\.(md|markdown|excalidraw|html?)$/i, "");
  const fullName = `${base}${kind.ext}`;
  const content = kind.format === "markdown" ? `# ${base}\n` : kind.format === "html" ? html : "";
  return (
    <Dialog
      title="New file"
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            type="button"
            disabled={!base || (kind.format === "html" && !html.trim())}
            onClick={async () => {
              // A new file never replaces one with the same name (the Room API refuses it).
              const fileId = await save({ projectId, name: fullName, content, onlyIfNew: true });
              if (fileId !== undefined) onCreated(fileId);
            }}
          >
            Create {kind.label.toLowerCase()}
          </button>
        </>
      }
    >
      <div className="field file-kind">
        <span className="label">Kind</span>
        <ToggleGroup
          className="seg surface-seg"
          aria-label="Kind"
          value={[kind.format]}
          deselectable={false}
          onValueChange={(next) => {
            const k = NEW_KINDS.find((option) => option.format === next[0]);
            if (!k || k.format === kind.format) return;
            if (name === kind.name) setName(k.name);
            setKind(k);
          }}
        >
          {NEW_KINDS.map((k) => (
            <Toggle key={k.format} value={k.format}>
              <span className="surface-label">{k.label}</span>
            </Toggle>
          ))}
        </ToggleGroup>
        <span className="hint">
          {kind.format === "markdown"
            ? "Rich text, kept as Markdown so agents read and write it too."
            : kind.format === "canvas"
              ? "Shapes, arrows and text that people and agents draw on together."
              : "A page that runs in a sandboxed frame, like an HTML message."}
        </span>
      </div>
      <Field className="field">
        <FieldLabel className="label">Name</FieldLabel>
        <div className="row-flex file-name-field">
          <Input className="input" value={name} onValueChange={setName} />
          <span className="muted file-extension">{kind.ext}</span>
        </div>
      </Field>
      {kind.format === "html" ? (
        <Field className="field">
          <FieldLabel className="label">HTML</FieldLabel>
          <Textarea
            className="textarea"
            style={{ minHeight: 160 }}
            value={html}
            onValueChange={setHtml}
          />
        </Field>
      ) : null}
    </Dialog>
  );
}
