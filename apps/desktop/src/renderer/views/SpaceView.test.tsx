// @vitest-environment happy-dom
/** A Space's access control follows the room's permissions, whether or not this computer can reach the Space's viewer. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TableNames } from "@uplink-room/backend/dataModel";
import { afterEach, expect, test, vi } from "vitest";
import type { Id, MemberRow } from "../lib/api";
import { SpaceScreen, type SpaceScreenProps, type Stage } from "./SpaceView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

const id = <T extends TableNames>(value: string) => value as Id<T>;
const julio = { memberId: id<"members">("m_julio"), name: "Julio", kind: "person" as const };
const ana = { memberId: id<"members">("m_ana"), name: "Ana", kind: "person" as const };
const members = [
  { ...julio, role: "admin" },
  { ...ana, role: "member" },
] as unknown as MemberRow[];

function render(props: { me: Id<"members">; ownsMachine: boolean; stage: Stage; access?: SpaceScreenProps["space"]["access"] }) {
  const setAccess = vi.fn();
  const space: SpaceScreenProps["space"] = {
    spaceId: id<"spaces">("s_studio"),
    spaceRef: "local:playtest",
    name: "Playtest",
    os: "linux",
    kind: "container",
    status: "live",
    failReason: undefined,
    power: "running",
    access: props.access ?? "suggest",
    loweredFrom: undefined,
    machine: { machineId: id<"machines">("mc_box"), name: "studio-mac", mostOpenAccess: "open" },
    sharedBy: julio,
    driver: julio,
    watching: [julio, ana],
    runId: undefined,
    endedAt: undefined,
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const noop = () => {};
  act(() =>
    root.render(
      <SpaceScreen
        space={space}
        me={props.me}
        members={members}
        ownsMachine={props.ownsMachine}
        stage={props.stage}
        wheelRequests={[]}
        suggestions={[]}
        actions={[]}
        on={{
          back: noop,
          retry: noop,
          setAccess,
          takeWheel: noop,
          requestWheel: noop,
          passWheel: noop,
          answerWheel: noop,
          suggest: async () => true,
          answerSuggestion: noop,
          stopSharing: noop,
        }}
      />,
    ),
  );
  const button = (label: string) =>
    [...host.querySelectorAll<HTMLButtonElement>('.terminal-bar [role="group"] button')].find((b) => b.textContent?.includes(label))!;
  return { button, setAccess };
}

const unreachable: Stage = { kind: "unreachable", machine: "studio-mac" };

test("the sharer can change access while this computer can't reach the Space's viewer", () => {
  const { button, setAccess } = render({ me: julio.memberId, ownsMachine: false, stage: unreachable });
  expect(button("Ask for control").getAttribute("aria-disabled") === "true").toBe(false);
  act(() => button("Ask for control").click());
  expect(setAccess).toHaveBeenCalledWith("drive");
});

test("the machine's owner can lower access while the viewer is unreachable, and not open it up", () => {
  const { button, setAccess } = render({ me: ana.memberId, ownsMachine: true, stage: unreachable });
  expect(button("View").getAttribute("aria-disabled") === "true").toBe(false);
  expect(button("Ask for control").getAttribute("aria-disabled") === "true").toBe(true);
  act(() => button("View").click());
  expect(setAccess).toHaveBeenCalledWith("watch");
});
