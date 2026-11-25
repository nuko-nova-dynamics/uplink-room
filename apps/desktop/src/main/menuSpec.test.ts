import { expect, test, vi } from "vitest";
import { appMenuTemplate, SettingsRequest } from "./menuSpec.ts";

test("Settings asked for with no window waits for the new window's shell, once", () => {
  const settings = new SettingsRequest();
  expect(settings.request(true)).toBe(false);
  expect(settings.take()).toBe(false);
  expect(settings.request(false)).toBe(true);
  expect(settings.take()).toBe(true);
  expect(settings.take()).toBe(false);
});

test("the app menu has Settings… on Command-comma, right after About", () => {
  const openSettings = vi.fn();
  const [appMenu] = appMenuTemplate({ openSettings, openWebsite: () => {} });
  const items = appMenu!.submenu as { role?: string; type?: string; label?: string; accelerator?: string; click?: () => void }[];
  expect(items[0]!.role).toBe("about");
  expect(items[1]!.type).toBe("separator");
  expect(items[2]).toMatchObject({ label: "Settings…", accelerator: "CommandOrControl+," });
  items[2]!.click!();
  expect(openSettings).toHaveBeenCalledOnce();
  expect(items.at(-1)!.role).toBe("quit");
});
