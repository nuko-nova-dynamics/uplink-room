import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog as UiDialog, DialogContent } from "@ui-sdk/react/dialog";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuTrigger,
} from "@ui-sdk/react/menu";
import { fileSize } from "../../lib/chat";
import { formatTime } from "../../lib/format";
import { Dialog } from "../Dialog";
import { Icon } from "../Icon";
import { Tip } from "../Tip";
import { PdfFrame } from "../files/PdfFrame";

export type AttachmentView = {
  index: number;
  name: string;
  kind: "image" | "pdf" | "file";
  contentType: string;
  size: number;
  /**
   * In a direct message or private channel: there is no lasting link, so the app asks for a
   * short-lived one (messages.attachmentLink) each time it shows or downloads it (ADR 0016).
   */
  restricted?: boolean;
  /** Images and PDFs in a team channel: where the app shows them from (Convex storage). */
  url: string | null;
  /** In a team channel: served as a download, never shown. */
  downloadUrl: string | null;
};

/** Asks the room for a short-lived link to one of the message's attachments, and when it expires. */
export type AttachmentLink = (
  index: number,
  download: boolean,
) => Promise<{ url: string; expiresAt: number } | undefined>;

/** A link this close to expiring is asked for again rather than used. */
const LINK_MARGIN_MS = 30_000;

/** The attachment as a key: an edit that changes what sits at an index drops the links kept for it. */
const keyOf = (a: AttachmentView) => `${a.index}:${a.name}:${a.size}:${a.contentType}`;

/**
 * A message's attachments (spec #63). Images show inline and open full size on click. A PDF opens
 * in the sandboxed PDF viewer (spec #9). Anything else is a chip that downloads it in the system
 * browser, served with `Content-Disposition: attachment`, so nothing from outside runs in the app.
 * In a direct message or private channel each one comes through a short-lived link from `link`.
 */
export function Attachments({
  attachments,
  projects,
  onSave,
  link,
  from,
}: {
  attachments: AttachmentView[];
  projects?: { projectId: string; name: string }[];
  onSave?: (index: number, projectId: string) => void;
  link?: AttachmentLink;
  /** Who sent them and when, for the image viewer's line. */
  from?: { name: string; at: number };
}) {
  const [open, setOpen] = useState<AttachmentView | null>(null);
  if (attachments.length === 0) return null;
  // Every open and every download of a restricted attachment asks for a fresh link: one kept from
  // earlier may have expired while the channel stayed open.
  const fresh = async (a: AttachmentView, asDownload: boolean) =>
    a.restricted ? (await link?.(a.index, asDownload))?.url : asDownload ? a.downloadUrl : a.url;
  const download = async (a: AttachmentView) => {
    const url = await fresh(a, true);
    if (url) window.open(url);
  };
  const openShown = async (a: AttachmentView) => {
    const url = await fresh(a, false);
    if (url) setOpen({ ...a, url });
  };
  const images = attachments.filter((a) => a.kind === "image" && (a.restricted || a.url));
  const others = attachments.filter((a) => !(a.kind === "image" && (a.restricted || a.url)));
  // The viewer moves between this message's images, asking for a fresh link for private ones.
  const showImage = async (i: number) => {
    const a = images[i];
    if (!a) return;
    const url = await fresh(a, false);
    if (url) setOpen({ ...a, url });
  };
  const openIndex =
    open && open.kind === "image" ? images.findIndex((a) => a.index === open.index) : -1;
  return (
    <div className="attachments">
      {images.length > 0 ? (
        <div className={`attachment-images ${images.length > 1 ? "several" : ""}`}>
          {images.map((a) =>
            a.restricted && link ? (
              <RestrictedImage
                key={keyOf(a)}
                attachment={a}
                link={link}
                onOpen={(url) => setOpen({ ...a, url })}
              />
            ) : (
              <Tip key={keyOf(a)} label={`${a.name}, ${fileSize(a.size)}`}>
                <button
                  type="button"
                  className="attachment-image"
                  disabled={!a.url}
                  onClick={() => a.url && setOpen(a)}
                >
                  {a.url ? (
                    <img src={a.url} alt={a.name} loading="lazy" draggable={false} />
                  ) : (
                    <span className="attachment-wait">{a.name}</span>
                  )}
                </button>
              </Tip>
            ),
          )}
        </div>
      ) : null}
      {others.map((a) => (
        <div key={a.index} className="attachment-file">
          <Tip label={a.kind === "pdf" ? "Open in the PDF viewer" : "Download"}>
            <button
              type="button"
              className="chip"
              onClick={() =>
                void (a.kind === "pdf" && (a.url || a.restricted) ? openShown(a) : download(a))
              }
            >
              <Icon name={a.kind === "pdf" ? "pdf" : "file"} size={14} />
              <span className="truncate">{a.name}</span>
              <span className="muted">{fileSize(a.size)}</span>
            </button>
          </Tip>
          {a.kind === "file" ? null : (
            <SaveMenu attachment={a} projects={projects} onSave={onSave} />
          )}
        </div>
      ))}
      {open && open.kind === "image" ? (
        <Lightbox
          attachment={open}
          from={from}
          position={images.length > 1 ? { at: openIndex, of: images.length } : undefined}
          onPrev={openIndex > 0 ? () => void showImage(openIndex - 1) : undefined}
          onNext={
            openIndex >= 0 && openIndex < images.length - 1
              ? () => void showImage(openIndex + 1)
              : undefined
          }
          onClose={() => setOpen(null)}
          onDownload={() => void download(open)}
        >
          <SaveMenu attachment={open} projects={projects} onSave={onSave} />
        </Lightbox>
      ) : open ? (
        <Viewer
          attachment={open}
          onClose={() => setOpen(null)}
          onDownload={() => void download(open)}
        >
          <SaveMenu attachment={open} projects={projects} onSave={onSave} />
        </Viewer>
      ) : null}
    </div>
  );
}

/**
 * An image in a direct message or private channel (ADR 0016). It asks for its short-lived link when
 * it first scrolls into view, and again whenever the one it has is about to expire or fails to
 * load; opening it full size always asks for a fresh one. Its parent keys it by the attachment, so
 * a changed attachment starts with no link kept.
 */
function RestrictedImage({
  attachment,
  link,
  onOpen,
}: {
  attachment: AttachmentView;
  link: AttachmentLink;
  onOpen: (url: string) => void;
}) {
  const [current, setCurrent] = useState<{ url: string; expiresAt: number } | null>(null);
  const [visible, setVisible] = useState(false);
  const box = useRef<HTMLButtonElement>(null);
  const asking = useRef(false);
  // Lazy: only once it is on screen (where there's no IntersectionObserver, at once).
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setVisible(true);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const ask = useCallback(async () => {
    if (asking.current) return;
    asking.current = true;
    try {
      const got = await link(attachment.index, false);
      if (got) setCurrent(got);
    } finally {
      asking.current = false;
    }
  }, [link, attachment.index]);
  const stale = !current || current.expiresAt - LINK_MARGIN_MS <= Date.now();
  useEffect(() => {
    if (visible && stale) void ask();
  }, [visible, stale, ask]);
  return (
    <Tip label={`${attachment.name}, ${fileSize(attachment.size)}`}>
      <button
        ref={box}
        type="button"
        className="attachment-image"
        disabled={!current}
        onClick={async () => {
          const got = await link(attachment.index, false);
          if (got) {
            setCurrent(got);
            onOpen(got.url);
          }
        }}
      >
        {current ? (
          <img
            src={current.url}
            alt={attachment.name}
            draggable={false}
            // An expired link answers 404: ask for a fresh one (a live link that fails is left alone).
            onError={() => {
              if (current.expiresAt - LINK_MARGIN_MS <= Date.now()) void ask();
            }}
          />
        ) : (
          <span className="attachment-wait">{attachment.name}</span>
        )}
      </button>
    </Tip>
  );
}

/** Saving an attachment to one of the team's projects, from a UI SDK Menu. */
function SaveMenu({
  attachment,
  projects,
  onSave,
}: {
  attachment: AttachmentView;
  projects?: { projectId: string; name: string }[] | undefined;
  onSave?: ((index: number, projectId: string) => void) | undefined;
}) {
  if (!onSave || !projects || projects.length === 0) return null;
  return (
    <Menu>
      <MenuTrigger className="btn ghost">
        <Icon name="folder" size={14} />{" "}
        <span className="lightbox-action-label">Save to a project</span>
      </MenuTrigger>
      <MenuContent
        className="pop attachment-save-menu"
        side="bottom"
        align="start"
        sideOffset={4}
        collisionPadding={8}
      >
        <MenuGroup>
          <MenuGroupLabel className="pop-title">
            Keep in a project<span className="attachment-save-name">{attachment.name}</span>
          </MenuGroupLabel>
          {projects.map((p) => (
            <MenuItem
              render={(props) => <button {...props} type="button" />}
              key={p.projectId}
              onSelect={() => onSave(attachment.index, p.projectId)}
            >
              <Icon name="folder" /> <span className="truncate">{p.name}</span>
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuContent>
    </Menu>
  );
}

/** An image full size, or a PDF in the sandboxed viewer, with a download button. */
function Viewer({
  attachment,
  onClose,
  onDownload,
  children,
}: {
  attachment: AttachmentView;
  onClose: () => void;
  onDownload: () => void;
  children?: React.ReactNode;
}) {
  return (
    <Dialog
      title={attachment.name}
      onClose={onClose}
      wide
      footer={
        <>
          {children}
          <span className="grow" />
          <button className="btn" type="button" onClick={onDownload}>
            <Icon name="download" /> Download
          </button>
        </>
      }
    >
      {attachment.kind === "pdf" ? (
        <PdfAttachment url={attachment.url!} name={attachment.name} />
      ) : (
        <div className="attachment-full">
          <img src={attachment.url!} alt={attachment.name} />
        </div>
      )}
    </Dialog>
  );
}

/**
 * An image over the whole window (spec #63): who sent it and when on one thin line, Download and
 * Close; a click on the image shows it at full size; ← and → move between the message's images;
 * Escape or a click outside closes it. A modal UI SDK Dialog, open while it's rendered: Tab stays
 * inside and the page behind it is inert.
 */
function Lightbox({
  attachment,
  from,
  position,
  onPrev,
  onNext,
  onClose,
  onDownload,
  children,
}: {
  attachment: AttachmentView;
  from?: { name: string; at: number } | undefined;
  position?: { at: number; of: number } | undefined;
  onPrev?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
  onClose: () => void;
  onDownload: () => void;
  children?: React.ReactNode;
}) {
  const [zoom, setZoom] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  const closing = useRef(onClose);
  closing.current = onClose;
  // Remembered before the commit: the dialog moves focus to Close as it mounts.
  const opener = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => setZoom(false), [attachment.index]);
  useEffect(() => {
    const previous = opener.current;
    return () => {
      // Closed by unmounting, so focus goes back here rather than through a dialog close.
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <UiDialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        // Open while it's rendered: the caller unmounts it.
        details.cancel();
        closing.current();
      }}
    >
      <DialogContent
        className="lightbox"
        aria-label={attachment.name}
        initialFocus={() => close.current}
        finalFocus="none"
        onKeyDown={(event) => {
          // A menu in the bar (Save to a project) handles its own arrows first.
          if (event.defaultPrevented) return;
          if (event.key === "ArrowLeft") onPrev?.();
          else if (event.key === "ArrowRight") onNext?.();
        }}
        onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      >
        <div className="lightbox-bar">
          <span className="lightbox-who">
            {from ? (
              <>
                <b>{from.name}</b> <span>{formatTime(from.at)}</span>
              </>
            ) : null}
            <span className="lightbox-name">
              {attachment.name}, {fileSize(attachment.size)}
              {position ? ` (${position.at + 1} of ${position.of})` : ""}
            </span>
          </span>
          <span className="grow" />
          {children}
          <button className="btn ghost" type="button" onClick={onDownload}>
            <Icon name="download" size={14} />{" "}
            <span className="lightbox-action-label">Download</span>
          </button>
          <Tip label="Close">
            <button
              ref={close}
              className="btn icon"
              type="button"
              aria-label="Close"
              onClick={onClose}
            >
              <Icon name="close" />
            </button>
          </Tip>
        </div>
        <div
          role="presentation"
          className={`lightbox-stage ${zoom ? "zoomed" : ""}`}
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          {onPrev ? (
            <button
              className="icon-btn lightbox-nav prev"
              type="button"
              aria-label="Previous image"
              onClick={onPrev}
            >
              <Icon name="chevron" size={18} style={{ transform: "rotate(180deg)" }} />
            </button>
          ) : null}
          <Tip label={zoom ? "Fit to the window" : "Show at full size"}>
            <img
              role="button"
              tabIndex={0}
              aria-label={zoom ? "Fit image to the window" : "Show image at full size"}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setZoom((z) => !z);
                }
              }}
              src={attachment.url!}
              alt={attachment.name}
              onClick={() => setZoom((z) => !z)}
            />
          </Tip>
          {onNext ? (
            <button
              className="icon-btn lightbox-nav next"
              type="button"
              aria-label="Next image"
              onClick={onNext}
            >
              <Icon name="chevron" size={18} />
            </button>
          ) : null}
        </div>
      </DialogContent>
    </UiDialog>
  );
}

/** Downloads the PDF's bytes and hands them to the sandboxed frame, as project PDFs do (spec #9). */
function PdfAttachment({ url, name }: { url: string; name: string }) {
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Download failed (${response.status})`);
        const bytes = await response.arrayBuffer();
        if (!cancelled) setData(bytes);
      })
      .catch(
        (error: unknown) =>
          !cancelled && setFailed(error instanceof Error ? error.message : String(error)),
      );
    return () => {
      cancelled = true;
    };
  }, [url]);
  return (
    <div className="attachment-pdf">
      {failed ? (
        <div className="viewer-note">This PDF couldn't be downloaded: {failed}</div>
      ) : data ? (
        <PdfFrame
          data={data}
          title={name}
          pins={[]}
          selected={null}
          draft={null}
          placing={false}
          onPlace={() => {}}
          onSelect={() => {}}
        />
      ) : (
        <div className="viewer-loading">Downloading…</div>
      )}
    </div>
  );
}

export type Preview = {
  url: string;
  title?: string | undefined;
  description?: string | undefined;
  siteName?: string | undefined;
  imageUrl: string | null;
};

/**
 * Link previews (spec #63): the page's title, description and image as the backend fetched them.
 * The image comes from Convex storage, never from the linked site, and every field is plain text.
 */
export function LinkPreviews({ previews, onHide }: { previews: Preview[]; onHide?: () => void }) {
  if (previews.length === 0) return null;
  return (
    <div className="link-previews">
      {previews.map((p) => {
        const host = (() => {
          try {
            return new URL(p.url).hostname;
          } catch {
            return p.url;
          }
        })();
        return (
          <div key={p.url} className="link-preview">
            <div className="link-preview-text">
              <span className="muted truncate">{p.siteName ?? host}</span>
              {p.title ? (
                <a
                  href={p.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="link-preview-title"
                >
                  {p.title}
                </a>
              ) : null}
              {p.description ? <span className="link-preview-desc">{p.description}</span> : null}
            </div>
            {p.imageUrl ? (
              <img className="link-preview-image" src={p.imageUrl} alt="" loading="lazy" />
            ) : null}
            {onHide ? (
              <Tip label="Remove the previews">
                <button
                  className="icon-btn link-preview-hide"
                  type="button"
                  aria-label="Remove the previews"
                  onClick={onHide}
                >
                  <Icon name="close" size={14} />
                </button>
              </Tip>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
