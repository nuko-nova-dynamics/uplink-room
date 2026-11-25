import { expect, test } from "vitest";
import { memberTile } from "./tiles";

const tile = (join: string, extra: { camera?: string; isLocal?: boolean } = {}) => ({
  identity: join.split(".")[0]!,
  join,
  isLocal: false,
  ...extra,
});

test("a member on two devices shows the camera from whichever device has it on", () => {
  const laptop = tile("m_ana.p1");
  const phone = tile("m_ana.p2", { camera: "phone camera" });
  expect(memberTile([laptop, phone], "m_ana")).toBe(phone);
  expect(memberTile([phone, laptop], "m_ana")).toBe(phone);
});

test("with no camera on, it's the member's first tile, and nothing for someone without one", () => {
  const laptop = tile("m_ana.p1");
  expect(memberTile([tile("m_julio.p3"), laptop, tile("m_ana.p2")], "m_ana")).toBe(laptop);
  expect(memberTile([laptop], "m_julio")).toBeUndefined();
});
