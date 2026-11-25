import { expect, test } from "vitest";
import { tooltipWindows } from "./native-tooltip";

test("finds native popup geometry without mistaking the app or utility windows for a tooltip", () => {
  const tree = `
     0x200016 (has no name): ()  96x26+1248+1372  +1248+1372
     0x200002 "Uplink Room gym: Inventory controls": ("uplink-room" "uplink-room")  1320x867+840+580  +840+580
     0x200004 (has no name): ()  1x1+0+0  +0+0
     0x200018 (has no name): ()  192x52+-10+20  -10+20
     0x200000 "Chromium clipboard": ()  10x10+-100+-100  +-100+-100
  `;
  expect(tooltipWindows(tree)).toEqual([
    { id: "0x200016", width: 96, height: 26, x: 1248, y: 1372 },
    { id: "0x200018", width: 192, height: 52, x: -10, y: 20 },
  ]);
});
