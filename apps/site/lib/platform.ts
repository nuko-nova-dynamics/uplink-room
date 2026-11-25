import type { Platform } from "./feed";

/**
 * The visitor's platform, from `navigator.userAgentData.platform` when the browser has it, else the
 * user agent. Null for phones, tablets and anything unrecognized: they get every platform, unsorted.
 */
export function platformOf(userAgent: string, uaPlatform?: string): Platform | null {
  const hint = (uaPlatform ?? "").toLowerCase();
  if (hint === "macos") return "mac";
  if (hint === "windows") return "windows";
  if (hint === "linux") return "linux";
  if (hint === "chrome os" || hint === "android" || hint === "ios") return null;
  if (/iphone|ipad|ipod|android/i.test(userAgent)) return null;
  if (/macintosh|mac os x/i.test(userAgent)) return "mac";
  if (/windows/i.test(userAgent)) return "windows";
  if (/linux|x11/i.test(userAgent)) return "linux";
  return null;
}

export const PLATFORM_NAMES: Record<Platform, string> = {
  mac: "macOS",
  windows: "Windows",
  linux: "Linux",
};
