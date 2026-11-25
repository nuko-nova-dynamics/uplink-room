import { useEffect, useRef, type ReactNode } from "react";
import { Dialog, DialogClose, DialogContent } from "@ui-sdk/react/dialog";
import { Icon } from "./Icon";

/**
 * Settings as a dialog over the view you were on (Grok Bot's settings modal), on UI SDK's Dialog:
 * the dimmed page or Escape closes it. A dialog opened inside it (Link a machine, Invite a teammate)
 * is nested, so its Escape closes only it. It's open while it's rendered; the caller unmounts it.
 */
export function SettingsOverlay({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const opener = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => {
    const previous = opener.current;
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    <Dialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        details.cancel();
        close.current();
      }}
    >
      <DialogContent
        className="overlay settings-overlay"
        aria-label="Settings"
        initialFocus={() => box.current}
        finalFocus="none"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) close.current();
        }}
        // UI SDK has handled Escape by the time it bubbles here (it closes the topmost dialog), so a
        // menu left listening on the document in the view underneath never also takes it.
        onKeyDown={(event) => {
          if (event.key === "Escape") event.stopPropagation();
        }}
      >
        <div ref={box} className="settings-dialog" tabIndex={-1}>
          <DialogClose
            className="btn icon settings-close"
            title="Close settings"
            aria-label="Close settings"
          >
            <Icon name="close" />
          </DialogClose>
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
