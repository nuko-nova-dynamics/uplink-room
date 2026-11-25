// @vitest-environment happy-dom
/**
 * The composer's Send to chip (SendTarget), on UI SDK's Menu: Send to and Your Link are radio
 * groups that close the menu once chosen, and No Link is a plain item.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { settle } from "@ui-sdk/core/testing";
import { SendTarget, type LinkInfo, type SendTo } from "./LinkConversation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

const agent = (memberId: string, agentId: string, name: string) =>
  ({ memberId, agentId, name, who: { name, kind: "agent" as const } }) as never;
const grok = agent("m9", "a9", "Grok Bot");
const duet = agent("m7", "a7", "Duet");
const link = { memberId: "m9", agentId: "a9", name: "Grok Bot", channelId: "c1", reach: "a2a" } as unknown as LinkInfo;

async function open(to: SendTo) {
  const onTo = vi.fn();
  const onLink = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      <SendTarget to={to} link={link} agents={[grok, duet]} onTo={onTo} onLink={onLink} />,
    ),
  );
  act(() => host.querySelector<HTMLButtonElement>(".send-target-chip")!.click());
  await act(() => settle());
  const menu = document.querySelector<HTMLElement>(".send-target-menu")!;
  const item = (text: string) =>
    [...menu.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find((el) =>
      el.textContent?.includes(text),
    )!;
  return { menu, item, onTo, onLink };
}

test("Send to checks where the message goes, and choosing an agent gives it the task", async () => {
  const { menu, item, onTo } = await open({ kind: "link" });
  expect(menu.getAttribute("role")).toBe("menu");
  expect(item("Your Link: answers").getAttribute("aria-checked")).toBe("true");
  expect(item("New thread").getAttribute("aria-checked")).toBe("false");
  // The Link isn't offered again as a task agent.
  expect([...menu.querySelectorAll("[role=menuitemradio]")].filter((el) => el.textContent?.includes("Gets it as a task"))).toHaveLength(1);
  await act(async () => item("Gets it as a task").click());
  expect(onTo).toHaveBeenCalledWith({ kind: "agent", agentId: "a7", name: "Duet" });
  await act(() => settle());
  expect(document.querySelector(".send-target-menu")).toBeNull();
});

test("Your Link picks another agent, and No Link clears it", async () => {
  const first = await open({ kind: "thread" });
  const yours = [...first.menu.querySelectorAll<HTMLElement>("[role=menuitemradio]")].filter(
    (el) => el.textContent === "Duet",
  );
  await act(async () => yours[0]!.click());
  expect(first.onLink).toHaveBeenCalledWith("m7");
  for (const root of roots.splice(0)) act(() => root.unmount());

  const second = await open({ kind: "thread" });
  await act(async () => second.item("No Link").click());
  expect(second.onLink).toHaveBeenCalledWith(null);
});
