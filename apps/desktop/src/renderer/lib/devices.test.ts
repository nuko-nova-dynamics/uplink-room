// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("./desktop", () => ({ fakeMedia: false, desktop: {} }));
vi.mock("./log", () => ({ log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } }));
const { DEFAULT_DEVICE, deviceConstraint, deviceFor, levelOf, listDevices, onSavedDeviceChange, resetSavedDevices, saveDevice, savedDevice } = await import("./devices");

beforeEach(() => {
  localStorage.clear();
  resetSavedDevices();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: async () => [
        { kind: "audioinput", deviceId: "default", label: "Default - MacBook Pro Microphone", groupId: "g1" },
        { kind: "audioinput", deviceId: "mic-built-in", label: "MacBook Pro Microphone", groupId: "g1" },
        { kind: "audioinput", deviceId: "mic-usb", label: "USB mic", groupId: "g2" },
        { kind: "audiooutput", deviceId: "default", label: "Default - Speakers", groupId: "g1" },
        { kind: "videoinput", deviceId: "cam-1", label: "FaceTime HD Camera", groupId: "g3" },
      ],
    },
  });
});

test("each kind's choice is kept on this computer, and the system default is the default", () => {
  expect(savedDevice("audioinput")).toBe(DEFAULT_DEVICE);
  const changed = vi.fn();
  const stop = onSavedDeviceChange(changed);
  saveDevice("audioinput", "mic-usb");
  saveDevice("audioinput", "mic-usb");
  expect(changed).toHaveBeenCalledTimes(1);
  resetSavedDevices();
  expect(savedDevice("audioinput")).toBe("mic-usb");
  expect(savedDevice("videoinput")).toBe(DEFAULT_DEVICE);
  saveDevice("audioinput", DEFAULT_DEVICE);
  expect(localStorage.getItem("uplink.device.audioinput")).toBeNull();
  stop();
});

test("the list puts the system default first and says which device it is", async () => {
  const { devices, labelled } = await listDevices("audioinput");
  expect(labelled).toBe(true);
  expect(devices.map((d) => d.label)).toEqual(["System default (MacBook Pro Microphone)", "MacBook Pro Microphone", "USB mic"]);
  expect((await listDevices("videoinput")).devices.map((d) => d.id)).toEqual([DEFAULT_DEVICE, "cam-1"]);
});

test("a chosen device that's unplugged falls back to the system default until it's back", async () => {
  const { devices } = await listDevices("audioinput");
  expect(deviceFor("audioinput", devices, "mic-usb")).toEqual({ id: "mic-usb", missing: false });
  expect(deviceFor("audioinput", devices.filter((d) => d.id !== "mic-usb"), "mic-usb")).toEqual({ id: DEFAULT_DEVICE, missing: true });
  expect(deviceConstraint("audioinput", "mic-usb")).toEqual({ deviceId: { exact: "mic-usb" } });
  expect(deviceConstraint("audioinput", DEFAULT_DEVICE)).toEqual({ deviceId: "default" });
  // A camera has no system default: no constraint, so the first camera opens.
  expect(deviceConstraint("videoinput", DEFAULT_DEVICE)).toEqual({});
});

test("the level meter reads silence as 0 and speech-loud samples near the top", () => {
  expect(levelOf(new Float32Array(1024))).toBe(0);
  const loud = new Float32Array(1024).map((_, i) => 0.3 * Math.sin(i / 3));
  expect(levelOf(loud)).toBeGreaterThan(0.7);
  const quiet = new Float32Array(1024).map((_, i) => 0.003 * Math.sin(i / 3));
  expect(levelOf(quiet)).toBeLessThan(0.3);
});
