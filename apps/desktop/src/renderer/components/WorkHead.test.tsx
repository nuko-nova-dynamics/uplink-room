// @vitest-environment happy-dom
/** The terminal and Space header: who else is watching, what Access means, and the side panel. */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { AccessControl, RailToggle, useRail, watchingText } from "./WorkHead";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A terminal's header and panel, as TerminalView lays them out. */
function Terminal({ live }: { live: boolean }) {
  const rail = useRail(live);
  return (
    <>
      <RailToggle open={rail.open} onToggle={rail.toggle} waiting={0} urgent={false} label={live ? "Suggestions" : "Activity"} />
      {rail.open ? <aside>Who typed what</aside> : null}
    </>
  );
}

test("an ended terminal's panel starts folded and opens again from Activity", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(<Terminal live={false} />));
  expect(host.querySelector("aside")).toBeNull();
  const toggle = host.querySelector("button");
  expect(toggle?.textContent).toContain("Activity");
  act(() => toggle!.click());
  expect(host.querySelector("aside")?.textContent).toBe("Who typed what");
  act(() => root.unmount());
});

const people = (...names: string[]) => names.map((name) => ({ name }));

test("who else is watching reads as a sentence about them, never as your own mode", () => {
  // The driver: Julio drove a run on Axel's machine and read "Watching [Axel]" as his own mode.
  expect(watchingText([], true)).toBe("No one else is watching");
  expect(watchingText(people("Axel"), true)).toBe("Axel is watching");
  expect(watchingText(people("Axel", "Ana"), true)).toBe("Axel and Ana are watching");
  expect(watchingText(people("Axel", "Ana", "Mia"), true)).toBe("Axel and 2 others are watching");
  // Someone who isn't driving is watching too.
  expect(watchingText([], false)).toBe("You're watching");
  expect(watchingText(people("Axel"), false)).toBe("You and Axel are watching");
  expect(watchingText(people("Axel", "Ana", "Mia"), false)).toBe("You, Axel and 2 others are watching");
});

function renderAccess(driver: Parameters<typeof AccessControl>[0]["driver"], canOpenUp: boolean) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <AccessControl
        access="suggest"
        loweredFrom={undefined}
        mostOpen="open"
        machineName="loiko-machine"
        canOpenUp={canOpenUp}
        canLower={false}
        live
        onSet={() => {}}
        starterLabel="whoever started this terminal"
        surface="terminal"
        driver={driver}
      />,
    ),
  );
  return { host, unmount: () => act(() => root.unmount()) };
}

test("Access is labeled as what teammates can do, and tells the driver their keyboard stays on", () => {
  const driving = renderAccess({ me: true }, true);
  const group = driving.host.querySelector('[role="group"]')!;
  expect(document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent).toBe("Teammates can");
  expect(driving.host.querySelector(".access-line")?.textContent).toBe(
    "They can propose commands, and you choose which to send. Your keyboard stays on at every level.",
  );
  driving.unmount();

  const watching = renderAccess({ me: false, name: "Axel" }, false);
  expect(watching.host.querySelector(".access-read .label")?.textContent).toBe("Teammates can");
  expect(watching.host.querySelector(".access-line")?.textContent).toBe("You can propose commands, and Axel chooses which to send.");
  watching.unmount();
});

test("in the thread's menu, the machine's limit and the level's line sit under the four levels at every access level, never over them", async () => {
  // The menu's buttons are full-width rows (styles.css `:where(.pop) button`), which stacked the levels
  // inside the control's fixed height and drew "julio-mbp allows up to Suggest." over Suggest and Take control.
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const css = await readFile(join(import.meta.dirname, "../views/thread.css"), "utf8");
  const rule = /\.access-pop \.seg \{([^}]*)\}/.exec(css)?.[1] ?? "";
  expect(rule).toMatch(/display: grid/);
  expect(rule).toMatch(/grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  expect(rule).toMatch(/height: auto/);
  expect(/\.access-pop \.seg button \{[^}]*width: auto/.test(css)).toBe(true);
  for (const mostOpen of ["watch", "suggest", "drive", "open"] as const)
    for (const me of [true, false]) {
      const host = document.createElement("div");
      host.className = "pop access-pop";
      document.body.append(host);
      const root = createRoot(host);
      act(() =>
        root.render(
          <AccessControl
            access="watch"
            loweredFrom={undefined}
            mostOpen={mostOpen}
            machineName="julio-mbp"
            canOpenUp
            canLower
            live
            onSet={() => {}}
            starterLabel="whoever started this thread"
            surface="thread"
            driver={me ? { me: true } : { me: false, name: "Ana" }}
          />,
        ),
      );
      const seg = host.querySelector(".seg")!;
      expect(seg.querySelectorAll("button")).toHaveLength(4);
      // Everything after the levels is a sibling in flow, below them, not inside the control.
      const after = [...host.children].slice([...host.children].indexOf(seg) + 1);
      expect(after.every((el) => !seg.contains(el))).toBe(true);
      expect(after.some((el) => el.classList.contains("access-line"))).toBe(true);
      expect(after.some((el) => el.classList.contains("access-cap"))).toBe(mostOpen !== "open");
      act(() => root.unmount());
      host.remove();
    }
});
