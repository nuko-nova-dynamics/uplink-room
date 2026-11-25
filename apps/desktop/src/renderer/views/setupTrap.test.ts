// @vitest-environment happy-dom
import { expect, test } from "vitest";
import { trapMove, trapTargets } from "./setupSpec";

test("setup's focus trap includes the device pickers' selects and skips disabled controls", () => {
  const dialog = document.createElement("div");
  dialog.innerHTML = `
    <button id="back">Back</button>
    <select id="mic"><option>Built-in</option></select>
    <select id="camera" disabled><option>None</option></select>
    <input id="name" />
    <button id="link" disabled>Link</button>
    <button id="continue">Continue</button>`;
  expect(trapTargets(dialog).map((el) => el.id)).toEqual(["back", "mic", "name", "continue"]);
});

test("Shift+Tab from the dialog itself, or from the first control, wraps to the last", () => {
  const dialog = document.createElement("div");
  dialog.innerHTML = `<button id="a">Back</button><select id="b"></select><button id="c">Continue</button>`;
  const [a, b, c] = ["a", "b", "c"].map((id) => dialog.querySelector<HTMLElement>(`#${id}`)!);
  expect(trapMove(dialog, dialog, true)).toBe(c);
  expect(trapMove(dialog, a!, true)).toBe(c);
  expect(trapMove(dialog, b!, true)).toBeNull();
  expect(trapMove(dialog, c!, false)).toBe(a);
  expect(trapMove(dialog, document.body, false)).toBe(a);
});
