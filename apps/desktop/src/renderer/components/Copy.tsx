import { useEffect, useRef, useState } from "react";
import { copyText } from "../lib/clipboard";
import { Icon } from "./Icon";
import { Tip } from "./Tip";
import "./copy.css";

type CopyState = "idle" | "copied" | "failed";

const FAILED = "Couldn't copy";

/**
 * A button that copies `text`, or what `text()` resolves to for a link fetched on click, and says
 * so: "Copied" with a tick for two seconds, or "Couldn't copy" when the clipboard refused, in which
 * case the text next to it can still be selected and copied by hand. The button keeps its width
 * while its label changes, and the result is announced.
 */
export function CopyButton({
  text,
  label = "Copy",
  primary = false,
  disabled = false,
  title,
}: {
  text: string | (() => Promise<string>);
  label?: string;
  primary?: boolean;
  disabled?: boolean;
  title?: string | undefined;
}) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const shown = state === "copied" ? "Copied" : state === "failed" ? FAILED : label;
  return (
    <>
      <Tip label={title} disabled={!title}>
        <button
          className={`btn small copy-btn${primary ? " primary" : ""}${state === "failed" ? " copy-failed" : ""}`}
          type="button"
          aria-label={shown}
          disabled={disabled}
          onClick={async () => {
            clearTimeout(timer.current);
            let next: CopyState;
            try {
              await copyText(typeof text === "function" ? await text() : text);
              next = "copied";
            } catch {
              next = "failed";
            }
            setState(next);
            timer.current = setTimeout(() => setState("idle"), next === "copied" ? 2000 : 4000);
          }}
        >
          <Icon name={state === "copied" ? "tick" : state === "failed" ? "alert" : "copy"} />
          {/* The label and "Copied" share one cell, so confirming never resizes the button. */}
          <span className="copy-labels" aria-hidden="true">
            {(state === "failed" ? [label, "Copied", FAILED] : [label, "Copied"]).map((option) => (
              <span key={option} data-shown={option === shown || undefined}>
                {option}
              </span>
            ))}
          </span>
        </button>
      </Tip>
      <span className="sr-only" role="status">
        {state === "copied" ? `${label}: copied` : state === "failed" ? `${FAILED}. Select the text and copy it.` : ""}
      </span>
    </>
  );
}
