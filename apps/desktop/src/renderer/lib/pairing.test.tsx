// @vitest-environment happy-dom
/** This computer's pairing in the renderer: read again after linking and on every refresh. */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { usePairing, type Pairing } from "./pairing";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

function mount(deps: Parameters<typeof usePairing>[0]) {
  const seen: { current: ReturnType<typeof usePairing> | null } = { current: null };
  function Probe() {
    seen.current = usePairing(deps);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  act(() => root.render(<Probe />));
  return seen;
}

test("linking reads the pairing again, so setup opened later shows the computer as linked", async () => {
  let onDisk: Pairing = { status: "unpaired" };
  const read = vi.fn(async () => onDisk);
  const link = vi.fn(async () => {
    onDisk = { status: "paired", machineId: "m1" };
  });
  const seen = mount({ read, makeCode: async () => "abcd-1234", link });
  await act(async () => {});
  expect(seen.current!.pairing).toEqual({ status: "unpaired" });

  await act(() => seen.current!.pair("Rosa's Mac", { replace: false }));
  expect(link).toHaveBeenCalledWith("abcd-1234", { replace: false });
  expect(seen.current!.pairing).toEqual({ status: "paired", machineId: "m1" });

  // Setup opening again refreshes: "checking" first, then what bridge.json says now.
  let done!: Promise<void>;
  act(() => {
    done = seen.current!.refresh();
  });
  expect(seen.current!.pairing).toBeUndefined();
  await act(() => done);
  expect(seen.current!.pairing).toEqual({ status: "paired", machineId: "m1" });
  expect(read).toHaveBeenCalledTimes(3);
});

test("a failed or refused link reads the pairing again too", async () => {
  const onDisk: Pairing = { status: "paired", machineId: "m1" };
  let calls = 0;
  const read = vi.fn(async (): Promise<Pairing> => (calls++ === 0 ? { status: "unpaired" } : onDisk));
  const link = vi.fn(async () => {
    throw new Error("This computer is already linked.");
  });
  const seen = mount({ read, makeCode: async () => "abcd-1234", link });
  await act(async () => {});
  expect(seen.current!.pairing).toEqual({ status: "unpaired" });
  await act(() => expect(seen.current!.pair("Rosa's Mac", { replace: false })).rejects.toThrow("already linked"));
  expect(seen.current!.pairing).toEqual({ status: "paired", machineId: "m1" });
});

test("an older read never overwrites a newer one", async () => {
  const answers: ((p: Pairing) => void)[] = [];
  const read = () => new Promise<Pairing>((resolve) => answers.push(resolve));
  const seen = mount({ read, makeCode: async () => undefined, link: undefined });
  let second!: Promise<void>;
  act(() => {
    second = seen.current!.refresh();
  });
  await act(async () => {
    answers[1]!({ status: "paired", machineId: "m2" });
    await second;
    answers[0]!({ status: "unpaired" });
  });
  expect(seen.current!.pairing).toEqual({ status: "paired", machineId: "m2" });
});

test("a read that fails is unknown, never unpaired", async () => {
  const seen = mount({
    read: async () => {
      throw new Error("Error invoking remote method 'uplink:bridge-pairing': EACCES");
    },
    makeCode: async () => undefined,
    link: undefined,
  });
  await act(async () => {});
  expect(seen.current!.pairing).toMatchObject({ status: "unknown" });
  const silent = mount({ read: async () => null, makeCode: async () => undefined, link: undefined });
  await act(async () => {});
  expect(silent.current!.pairing).toMatchObject({ status: "unknown" });
});
