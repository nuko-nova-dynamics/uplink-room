import type { TokenStorage } from "@clerk/electron";

/**
 * Whether Electron's safeStorage really protects what it encrypts on this computer. macOS uses
 * the Keychain and Windows DPAPI. On Linux it depends on the backend Electron selected
 * (`safeStorage.getSelectedStorageBackend()`): without a supported keyring it picks `basic_text`,
 * which encrypts with a hard-coded key yet still reports encryption as available, so Clerk's
 * `storage()` would write the session to disk effectively in plain text (Electron's safeStorage
 * docs; Clerk's storage() reference says it doesn't check the backend). `unknown` means Electron
 * was asked before the app was ready, so it isn't trusted either.
 */
export function protectsTokens(platform: NodeJS.Platform, linuxBackend?: string): boolean {
  if (platform !== "linux") return true;
  return linuxBackend !== undefined && linuxBackend !== "basic_text" && linuxBackend !== "unknown";
}

/**
 * Wraps the on-disk token storage. While `persist()` is false, tokens stay in memory only (the
 * person signs in again on the next launch) and a copy already on disk is deleted. While it is
 * undefined (not decided yet), tokens also stay in memory, but the disk is left alone.
 */
export function guardedStorage(disk: TokenStorage, persist: () => boolean | undefined): TokenStorage {
  const memory = new Map<string, string>();
  const removed = new Set<string>();
  const removeFromDisk = async (key: string) => {
    if (removed.has(key)) return;
    removed.add(key);
    await disk.removeItem(key);
  };
  return {
    async getItem(key) {
      const held = memory.get(key);
      if (held !== undefined) return held;
      const decision = persist();
      if (decision) return disk.getItem(key);
      if (decision === false) await removeFromDisk(key);
      return null;
    },
    async setItem(key, value) {
      const decision = persist();
      if (decision) {
        memory.delete(key);
        return disk.setItem(key, value);
      }
      memory.set(key, value);
      if (decision === false) await removeFromDisk(key);
    },
    async removeItem(key) {
      memory.delete(key);
      await disk.removeItem(key);
    },
  };
}
