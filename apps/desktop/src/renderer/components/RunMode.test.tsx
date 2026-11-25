// @vitest-environment happy-dom
/**
 * What an agent may do (ADR 0043): the choices in plain words, those a machine's cap or the provider
 * rules out stay visible and off with why, and the header's chip says who set it.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import { MODE_META, ModeChip, ModeOptions, modeBlock } from "./RunMode";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(node: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return { host, unmount: () => act(() => root.unmount()) };
}

test("the modes read in plain words; those past the machine's cap or the provider's list are off and say why", () => {
  const onPick = vi.fn();
  const { host, unmount } = render(
    <ModeOptions
      label="What Codex may do"
      value="approval-required"
      cap="auto"
      offered={["approval-required", "auto-accept-edits", "full-access"]}
      machineName="julio-mbp"
      onPick={onPick}
    />,
  );
  const options = [...host.querySelectorAll<HTMLButtonElement>(".option-list button")];
  expect(options.map((o) => o.querySelector("span")?.textContent)).toEqual([
    "Ask before acting",
    "Edit files without asking",
    "Approve safe steps itself",
    "Full access",
  ]);
  // A choice that is off stays focusable in its group (UI SDK Toggle Group), so its hint can show.
  expect(options.map((o) => o.getAttribute("aria-disabled") === "true")).toEqual([false, false, true, true]);
  // Off for the provider, and for the cap, each with its own reason, in its tooltip (Tip).
  const hint = (option: HTMLElement) =>
    document.getElementById(option.getAttribute("aria-describedby") ?? "")?.textContent;
  expect(hint(options[2]!)).toBe("T3 Code's provider for this harness doesn't offer it.");
  expect(hint(options[3]!)).toMatch(
    /^julio-mbp allows up to Approve safe steps itself\. Whoever it belongs to can allow more/,
  );
  expect(options[0]!.getAttribute("aria-pressed")).toBe("true");
  act(() => options[1]!.click());
  expect(onPick).toHaveBeenCalledWith("auto-accept-edits");
  unmount();
});

test("someone else's machine shows its cap as text, not as choices that are off for no reason", () => {
  const { host, unmount } = render(
    <ModeOptions
      label="Most an agent may do on its own here"
      value="full-access"
      locked
      onPick={() => {}}
    />,
  );
  const options = [...host.querySelectorAll<HTMLButtonElement>(".option-list button")];
  expect(options.every((o) => o.getAttribute("aria-disabled") === "true" && o.classList.contains("locked"))).toBe(true);
  expect(options.at(-1)!.getAttribute("aria-pressed")).toBe("true");
  expect(host.textContent).toContain(MODE_META["full-access"].line);
  unmount();
});

test("the header chip names the mode, and its tooltip who set it, T3 Code, or the machine's cap", () => {
  const at = new Date("2026-11-05T10:42:00").getTime();
  const set = render(<ModeChip mode="full-access" setBy={{ name: "Julio" }} setAt={at} />);
  expect(set.host.textContent).toBe("Full access");
  expect(set.host.querySelector(".mode-chip")!.getAttribute("title")).toMatch(/Set by Julio at/);
  set.unmount();
  const there = render(<ModeChip mode="auto" setAt={at} />);
  expect(there.host.querySelector(".mode-chip")!.getAttribute("title")).toMatch(
    /Changed in T3 Code at/,
  );
  there.unmount();
  const lowered = render(
    <ModeChip mode="approval-required" loweredFrom="full-access" setAt={at} />,
  );
  expect(lowered.host.querySelector(".mode-chip")!.className).toContain("amber");
  expect(lowered.host.querySelector(".mode-chip")!.getAttribute("title")).toMatch(
    /Lowered from Full access by the machine's limit/,
  );
  lowered.unmount();
  // A change T3 Code hasn't confirmed: the chip keeps the mode in effect and says what's coming.
  const pending = render(<ModeChip mode="full-access" pending="approval-required" />);
  expect(pending.host.textContent).toBe("Full access");
  expect(pending.host.querySelector(".mode-chip")!.getAttribute("title")).toMatch(
    /Changing to Ask before acting once T3 Code confirms it/,
  );
  pending.unmount();
  // T3 Code didn't take a mode within the machine's limit: the room stopped the thread, and the chip says why.
  const over = render(<ModeChip mode="full-access" overCap />);
  expect(over.host.querySelector(".mode-chip")!.className).toContain("amber");
  expect(over.host.querySelector(".mode-chip")!.getAttribute("title")).toMatch(
    /Above the machine's limit: T3 Code didn't take a lower mode/,
  );
  over.unmount();
  expect(modeBlock("approval-required", { cap: undefined })).toBeUndefined();
});
