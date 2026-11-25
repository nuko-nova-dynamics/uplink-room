import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import {
  Dialog as UiDialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@ui-sdk/react/dialog";
import { Icon } from "./Icon";
import "./remaining.css";

/** Where a dialog's focus starts: a marked control, then its first field, its primary button, or its first control. */
function initialControl(content: HTMLElement | null): HTMLElement | null {
  if (!content) return null;
  const controls = Array.from(
    content.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter(
    (element) =>
      element.getClientRects().length > 0 &&
      !element.closest("[inert]") &&
      // UI SDK's Checkbox, Radio and Segmented Control add a hidden form input beside each button.
      !element.matches('[aria-hidden="true"], [tabindex="-1"]'),
  );
  return (
    controls.find((element) => element.matches("[data-dialog-initial-focus]")) ??
    controls.find((element) => element.matches("input, select, textarea")) ??
    controls.find((element) => element.matches("button.primary")) ??
    controls.find((element) => !element.matches('[data-slot="dialog-close"]')) ??
    controls[0] ??
    content
  );
}

/**
 * A modal dialog, on UI SDK's Dialog: the page behind it is inert, Tab stays inside, and Escape or a
 * press on the dimmed page closes it. It's open while it's rendered; the caller unmounts it in
 * onClose. The content element is the dimmed full-window `.overlay`, and the `.dialog` box sits in
 * it, so the app's `.overlay` and `.dialog` styles and checks keep working.
 */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  wide = false,
  returnFocus,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** A surviving trigger when the menu item that opened this dialog is removed. */
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  // A child with autoFocus runs before effects, so remember the opener before the commit.
  const opener = useRef(document.activeElement as HTMLElement | null);
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = opener.current;
    return () => {
      // The caller closes a dialog by unmounting it, so focus goes back here, not through a close.
      const target = returnFocus?.current ?? previous;
      if (target?.isConnected) target.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <UiDialog
      open
      onOpenChange={(open, details) => {
        if (open) return;
        // The dialog stays open until its caller unmounts it.
        details.cancel();
        close.current();
      }}
    >
      <DialogContent
        className="overlay"
        initialFocus={() => initialControl(box.current)}
        finalFocus="none"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) close.current();
        }}
      >
        <div ref={box} className={`dialog ${wide ? "wide" : ""}`}>
          <div className="dialog-head">
            <DialogTitle>{title}</DialogTitle>
            <DialogClose className="btn icon" aria-label="Close" title="Close">
              <Icon name="close" />
            </DialogClose>
          </div>
          <div className="dialog-body">{children}</div>
          {footer ? <div className="dialog-foot">{footer}</div> : null}
        </div>
      </DialogContent>
    </UiDialog>
  );
}
