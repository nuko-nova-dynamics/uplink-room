import { expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { addAgent, addTeammate, callAsAgent, newRoom, newTeam } from "./setup";

/** A shape as Excalidraw sends it, with only the fields the merge looks at plus a few more. */
function shape(id: string, version: number, extra: Record<string, unknown> = {}) {
  return { id, type: "rectangle", x: 0, y: 0, width: 100, height: 60, version, versionNonce: 1000 + version, isDeleted: false, ...extra };
}

async function canvasIn() {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const projectId = await admin.as.mutation(api.projects.create, { teamId, name: "Reef Runner", repos: [] });
  const fileId = await admin.as.mutation(api.files.save, { teamId, projectId, name: "level-1.excalidraw", content: "" });
  return { t, teamId, admin, projectId, fileId };
}

test("two people's canvas saves merge shape by shape, and an older edit of a shape is ignored", async () => {
  const { t, teamId, admin, fileId } = await canvasIn();
  const ana = await addTeammate(t, teamId, admin, "Ana");

  await admin.as.mutation(api.canvas.save, { teamId, fileId, elements: [shape("a", 1), shape("b", 1)] });
  await ana.as.mutation(api.canvas.save, { teamId, fileId, elements: [shape("b", 3, { x: 40 }), shape("c", 1)] });
  // Julio's copy of b is older than Ana's, so it doesn't win.
  const result = await admin.as.mutation(api.canvas.save, { teamId, fileId, elements: [shape("a", 2, { x: 10 }), shape("b", 2, { x: 99 })] });
  expect(result).toEqual({ accepted: 1 });

  const { elements } = await ana.as.query(api.canvas.scene, { teamId, fileId });
  expect(elements.map((e: any) => [e.id, e.version, e.x]).sort()).toEqual([
    ["a", 2, 10],
    ["b", 3, 40],
    ["c", 1, 0],
  ]);
  expect(await admin.as.query(api.files.get, { teamId, fileId })).toMatchObject({ format: "canvas", elementCount: 3 });
});

test("a canvas refuses embedded web pages and drops links that aren't web or mail links", async () => {
  const { t, teamId, admin, fileId } = await canvasIn();

  await expect(
    admin.as.mutation(api.canvas.save, { teamId, fileId, elements: [shape("e", 1, { type: "embeddable", link: "https://example.com" })] }),
  ).rejects.toThrow(/can't hold embeddable/);
  await admin.as.mutation(api.canvas.save, {
    teamId,
    fileId,
    elements: [shape("x", 1, { link: "javascript:alert(1)" }), shape("y", 1, { link: "https://example.com/spec" })],
  });

  const { elements } = await admin.as.query(api.canvas.scene, { teamId, fileId });
  const byId = Object.fromEntries(elements.map((e: any) => [e.id, e]));
  expect(byId["x"].link).toBeNull();
  expect(byId["y"].link).toBe("https://example.com/spec");
  void t;
});

test("an Excalidraw file saved into a project becomes a canvas with its shapes", async () => {
  const t = newRoom();
  const { teamId, admin } = await newTeam(t);
  const projectId = await admin.as.mutation(api.projects.create, { teamId, name: "Reef Runner", repos: [] });
  const content = JSON.stringify({ type: "excalidraw", version: 2, elements: [shape("a", 4), shape("b", 1)], appState: {} });

  const fileId = await admin.as.mutation(api.files.save, { teamId, projectId, name: "flow.excalidraw", content });

  const { elements } = await admin.as.query(api.canvas.scene, { teamId, fileId });
  expect(elements.map((e: any) => e.id).sort()).toEqual(["a", "b"]);
  await expect(
    admin.as.mutation(api.files.save, { teamId, projectId, name: "bad.excalidraw", content: "{not json" }),
  ).rejects.toThrow(/isn't an Excalidraw file/);
});

test("an agent draws labelled boxes and an arrow over HTTP, and they appear in the scene", async () => {
  const { t, teamId, admin, fileId } = await canvasIn();
  const { key } = await addAgent(t, teamId, admin, "Scribe", ["room.read", "work.manage"]);

  const drawn = await callAsAgent(t, key, "canvas.draw", {
    fileId,
    shapes: [
      { type: "rectangle", x: 0, y: 0, width: 160, height: 80, label: "Title screen" },
      { type: "rectangle", x: 300, y: 0, width: 160, height: 80, label: "Level 1", color: "#4f6fb3" },
      { type: "arrow", x: 160, y: 40, width: 140, height: 0 },
      { type: "text", x: 0, y: 120, text: "Save slots load here" },
    ],
  });
  expect(drawn.ok).toBe(true);
  expect(drawn.result.elementIds).toHaveLength(4);

  const { elements } = await admin.as.query(api.canvas.scene, { teamId, fileId });
  const texts = elements.filter((e: any) => e.type === "text").map((e: any) => e.text).sort();
  expect(texts).toEqual(["Level 1", "Save slots load here", "Title screen"]);
  const box = elements.find((e: any) => e.id === drawn.result.elementIds[1])!;
  expect(box).toMatchObject({ type: "rectangle", x: 300, strokeColor: "#4f6fb3", version: 1 });
  // The label is bound to its box, the way Excalidraw draws text inside a shape.
  const label = elements.find((e: any) => e.text === "Level 1")!;
  expect(label.containerId).toBe(box.id);
  expect(box.boundElements).toEqual([{ type: "text", id: label.id }]);
});
