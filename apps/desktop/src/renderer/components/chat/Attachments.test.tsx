// @vitest-environment happy-dom
/** Attachments in a direct message or private channel come through short-lived links (ADR 0016). */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { Attachments, type AttachmentView } from "./Attachments";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** happy-dom never reports intersections: this one says an observed image is on screen at once. */
class OnScreen {
  private readonly callback: (entries: { isIntersecting: boolean }[]) => void;
  constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
    this.callback = callback;
  }
  observe() {
    this.callback([{ isIntersecting: true }]);
  }
  disconnect() {}
}
(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = OnScreen;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const restricted = (index: number, kind: AttachmentView["kind"], name: string): AttachmentView => ({
  index,
  name,
  kind,
  contentType: kind === "image" ? "image/png" : "text/plain",
  size: 10,
  restricted: true,
  url: null,
  downloadUrl: null,
});

test("a restricted image shows from a link asked for when it shows, and a file downloads through a fresh one (P3)", async () => {
  const link = vi.fn(async (index: number, download: boolean) => ({
    url: `https://room.test/attachments/grant/${index}${download ? "d" : "s"}/x`,
    expiresAt: Date.now() + 10 * 60 * 1000,
  }));
  const opened = vi.spyOn(window, "open").mockImplementation(() => null);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<Attachments attachments={[restricted(0, "image", "plan.png"), restricted(1, "file", "build.log")]} link={link} />);
  });
  expect(link).toHaveBeenCalledWith(0, false);
  expect(host.querySelector("img")?.getAttribute("src")).toBe("https://room.test/attachments/grant/0s/x");
  await act(async () => {
    host.querySelector<HTMLButtonElement>(".attachment-file .chip")!.click();
  });
  expect(link).toHaveBeenCalledWith(1, true);
  expect(opened).toHaveBeenCalledWith("https://room.test/attachments/grant/1d/x");
});

test("an image opens through a fresh link, an expired one is asked for again, and a changed attachment drops its link (M2)", async () => {
  let n = 0;
  let life = 10 * 60 * 1000;
  const link = vi.fn(async (index: number) => ({ url: `https://room.test/attachments/grant/${index}-${++n}/x`, expiresAt: Date.now() + life }));
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<Attachments attachments={[restricted(0, "image", "plan.png")]} link={link} />);
  });
  expect(host.querySelector("img")?.getAttribute("src")).toBe("https://room.test/attachments/grant/0-1/x");
  // Opening it full size asks again instead of reusing the thumbnail's link.
  await act(async () => {
    host.querySelector<HTMLButtonElement>(".attachment-image")!.click();
  });
  expect(link).toHaveBeenCalledTimes(2);
  expect(document.querySelector(".lightbox-stage img")?.getAttribute("src")).toBe("https://room.test/attachments/grant/0-2/x");

  // The same message edited so index 0 is another file: its kept link goes, and a new one is asked for.
  life = -1;
  await act(async () => {
    root.render(<Attachments attachments={[restricted(0, "image", "other.png")]} link={link} />);
  });
  expect(link).toHaveBeenCalledTimes(3);
  // That link came back already expired, so it is asked for again rather than kept.
  life = 10 * 60 * 1000;
  await act(async () => {
    host.querySelector("img")?.dispatchEvent(new Event("error"));
  });
  expect(link.mock.calls.length).toBeGreaterThanOrEqual(4);
  expect(host.querySelector("img")?.getAttribute("src")).toMatch(/grant\/0-\d+\/x$/);
  expect(host.querySelector("img")?.getAttribute("src")).not.toBe("https://room.test/attachments/grant/0-3/x");
});
