/**
 * Files on their way into a message (spec #63), shared by the channel's composer, a thread's
 * message box (ADR 0043) and a Pair's (ADR 0048): each file picked, dropped or pasted is checked
 * against the room's limits (`attachmentProblem`) before anything uploads, then uploads at once to
 * an address from `messages.attachUrl`, or `pairs.attachUrl` in a Pair. A send takes the ready ones;
 * a refused file is named with the reason.
 */
import "./fileUploads.css";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { api, type Id } from "../../lib/api";
import { attachmentProblem, fileSize, shortName, uploadType } from "../../lib/chat";
import { useAct } from "../../lib/session";
import { Icon } from "../Icon";
import { Tip } from "../Tip";

/** A file in a box. `U` is the id of the upload it went to: a team's, or a Pair's. */
export type Pending<U extends string = Id<"uploads">> = {
  key: string;
  name: string;
  size: number;
  status: "uploading" | "ready" | "failed";
  error?: string;
  uploaded?: { uploadId: U; storageId: Id<"_storage">; name: string };
  /** A local preview of an image, until it's sent or removed. */
  thumb?: string;
};

const RASTER = /^image\/(png|jpeg|gif|webp)$/;

/**
 * Drag and drop for a box that takes files. A drop is taken here and goes no further, so a
 * composer inside the channel (a reply's) doesn't also hand the files to the channel's composer.
 */
export function fileDrop(addFiles: (files: File[]) => void) {
  return {
    onDragOver: (event: Pick<DragEvent, "dataTransfer" | "preventDefault" | "stopPropagation">) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault();
      event.stopPropagation();
    },
    onDrop: (event: Pick<DragEvent, "dataTransfer" | "preventDefault" | "stopPropagation">) => {
      if (event.dataTransfer.files.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      addFiles([...event.dataTransfer.files]);
    },
  };
}

/** The files in a team's box, uploaded to addresses from `messages.attachUrl`. */
export function useFileUploads() {
  const attachUrl = useAct(api.messages.attachUrl);
  return useUploads(useCallback(() => attachUrl({}), [attachUrl]));
}

/** Where one file uploads to, and its upload's id; undefined when the room gave none (it said why). */
export type UploadTarget<U extends string> = () => Promise<
  { uploadUrl: string; uploadId: U } | true | undefined
>;

/**
 * The files in a box: add them, remove one, and let thumbnails go once their files leave it. Each
 * uploads to an address from `target`, so a box outside any team (a Pair's) reads no team session.
 */
export function useUploads<U extends string>(target: UploadTarget<U>) {
  const [pending, setPending] = useState<Pending<U>[]>([]);
  const update = (key: string, patch: Partial<Pending<U>>) =>
    setPending((all) => all.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  // Thumbnails are local object URLs: let each go when its file leaves the box.
  const thumbs = useRef(new Set<string>());
  const dropThumbs = (gone: Pending<U>[]) => {
    for (const p of gone) {
      if (p.thumb && thumbs.current.has(p.thumb)) {
        URL.revokeObjectURL(p.thumb);
        thumbs.current.delete(p.thumb);
      }
    }
  };
  useEffect(
    () => () => {
      for (const url of thumbs.current) URL.revokeObjectURL(url);
    },
    [],
  );
  const removeFile = (key: string) =>
    setPending((all) => {
      dropThumbs(all.filter((p) => p.key === key));
      return all.filter((p) => p.key !== key);
    });

  const addFiles = (files: File[]) => {
    // A file the room refused earlier stops being news once you add another.
    setPending((all) => all.filter((p) => p.status !== "failed"));
    for (const file of files) {
      const key = `${Date.now()}-${Math.random()}`;
      const problem = attachmentProblem(file);
      const thumb =
        !problem && RASTER.test(uploadType(file)) ? URL.createObjectURL(file) : undefined;
      if (thumb) thumbs.current.add(thumb);
      setPending((all) => [
        ...all,
        {
          key,
          name: file.name || "pasted image.png",
          size: file.size,
          status: problem ? "failed" : "uploading",
          ...(problem ? { error: problem } : {}),
          ...(thumb ? { thumb } : {}),
        },
      ]);
      if (problem) continue;
      void (async () => {
        const to = await target();
        if (!to || to === true)
          return update(key, { status: "failed", error: "Couldn't get an upload address." });
        const type = uploadType(file);
        try {
          const response = await fetch(to.uploadUrl, {
            method: "POST",
            headers: { "Content-Type": type },
            body: file,
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const { storageId } = (await response.json()) as { storageId: Id<"_storage"> };
          update(key, {
            status: "ready",
            uploaded: {
              uploadId: to.uploadId,
              storageId,
              name: file.name || "pasted image.png",
            },
          });
        } catch (error) {
          update(key, {
            status: "failed",
            error: `${file.name} didn't upload: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      })();
    }
  };

  const ready = pending.filter((p) => p.status === "ready");
  const uploading = pending.some((p) => p.status === "uploading");
  return { pending, setPending, addFiles, removeFile, dropThumbs, ready, uploading };
}

/** The files waiting in a box, as chips with a thumbnail or a paperclip, and a remove button each. */
export function PendingFileChips({
  pending,
  onRemove,
}: {
  pending: Pending<string>[];
  onRemove: (key: string) => void;
}) {
  return (
    <>
      {pending
        .filter((p) => p.status !== "failed")
        .map((p) => (
          <li
            key={p.key}
            className={`pending-file ${p.status} ${p.thumb ? "has-thumb" : ""}`}
            title={p.name}
          >
            {p.thumb ? (
              <img className="pending-thumb" src={p.thumb} alt="" />
            ) : (
              <Icon name={p.status === "ready" ? "file" : "working"} size={14} />
            )}
            <span className="truncate">{shortName(p.name)}</span>
            <span className="muted">
              {p.status === "uploading" ? "Uploading" : fileSize(p.size)}
            </span>
            <Tip label={`Remove ${p.name}`}>
              <button
                className="icon-btn"
                type="button"
                aria-label={`Remove ${p.name}`}
                onClick={() => onRemove(p.key)}
              >
                <Icon name="close" size={14} />
              </button>
            </Tip>
          </li>
        ))}
    </>
  );
}

/** A file the room would refuse: one line of text each, not a chip among the files. */
export function PendingFileErrors({
  pending,
  onRemove,
}: {
  pending: Pending<string>[];
  onRemove: (key: string) => void;
}) {
  return (
    <>
      {pending
        .filter((p) => p.status === "failed")
        .map((p) => (
          <div key={p.key} className="pending-error" role="alert">
            <Icon name="alert" size={14} />
            <span>{p.error}</span>
            <Tip label={`Dismiss the note about ${p.name}`}>
              <button
                className="icon-btn"
                type="button"
                aria-label={`Dismiss the note about ${p.name}`}
                onClick={() => onRemove(p.key)}
              >
                <Icon name="close" size={14} />
              </button>
            </Tip>
          </div>
        ))}
    </>
  );
}
