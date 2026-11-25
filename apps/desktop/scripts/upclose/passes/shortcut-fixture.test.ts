import { expect, it } from "vitest";
import { World } from "../../../src/renderer/gym/world.ts";
import { STATES } from "../../../src/renderer/gym/states.ts";

it("provides eligible approval and finished rows for the Inbox keyboard checks", () => {
  const world = new World();
  STATES.find((s) => s.id === "inventory-inbox-shortcuts")!.world!(world);
  type Row = {
    taskId: string;
    state: string;
    runs: {
      state: string;
      driver: { memberId: string };
      prompt?: { kind: string; promptId: string };
    }[];
  };
  const inbox = world.get<{ needsYou: Row[]; working: Row[]; done: Row[] }>("inbox:get", {
    view: "mine",
  });
  expect(inbox.needsYou).toHaveLength(1);
  expect(inbox.done).toHaveLength(1);
  expect(inbox.needsYou[0]!.runs[0]!.prompt).toMatchObject({
    kind: "approval",
    promptId: "gym-shortcut-approval",
  });
  expect(inbox.needsYou[0]!.runs[0]!.driver.memberId).toBe(world.me["memberId"]);
  expect(inbox.done[0]!.runs[0]!.state).toBe("done");
  expect(
    new Set([...inbox.needsYou, ...inbox.working, ...inbox.done].map((row) => row.taskId)).size,
  ).toBe(3);
});
