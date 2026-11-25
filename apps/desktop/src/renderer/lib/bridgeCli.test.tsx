// @vitest-environment happy-dom
/** `uplink-bridge` on PATH in the renderer: a PATH check that fails never hides linking this computer. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { BridgeCliRow } from "../components/BridgeCli";
import { BridgeCliContext, useBridgeCli, type BridgeCliApi, type BridgeCliView } from "./bridgeCli";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

function mount(api: BridgeCliApi) {
  const seen: { current: BridgeCliView | null } = { current: null };
  function Probe() {
    seen.current = useBridgeCli();
    return <BridgeCliRow cli={seen.current} />;
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      <BridgeCliContext.Provider value={api}>
        <Probe />
      </BridgeCliContext.Provider>,
    ),
  );
  return { seen, host };
}

const LAUNCHER = "'/Applications/Uplink Room.app/Contents/Resources/bin/uplink-bridge'";

test("a PATH check that fails keeps the bundled bridge, says why in the row, and can be run again", async () => {
  const read = vi.fn<BridgeCliApi["read"]>().mockRejectedValueOnce(new Error("PowerShell exited with 1"));
  const { seen, host } = mount({ bundled: async () => LAUNCHER, read, install: vi.fn() });
  await act(async () => {});
  // What Link a machine decides "This computer" on: known without the check.
  expect(seen.current).toMatchObject({ bundled: LAUNCHER, status: null, error: "Couldn't check uplink-bridge on PATH: PowerShell exited with 1" });
  expect(host.textContent).toContain("Couldn't check uplink-bridge on PATH: PowerShell exited with 1");

  read.mockResolvedValueOnce({ platform: "win32", state: "missing", launcher: "x", command: LAUNCHER, install: { kind: "user-path", at: "x" } });
  const again = [...host.querySelectorAll("button")].find((b) => b.textContent === "Check again")!;
  await act(async () => again.click());
  expect(seen.current).toMatchObject({ status: { state: "missing" }, error: null });
  expect(host.textContent).toContain("Add to PATH");
});

test("a development build carries no bridge: nothing to link here, and no row", async () => {
  const { seen, host } = mount({ bundled: async () => null, read: async () => null, install: vi.fn() });
  await act(async () => {});
  expect(seen.current).toMatchObject({ bundled: null, status: null, error: null });
  expect(host.textContent).toBe("");
});
