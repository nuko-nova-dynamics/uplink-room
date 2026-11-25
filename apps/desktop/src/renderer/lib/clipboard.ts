import { desktop } from "./desktop";

/**
 * Copies text. In the app it goes through Electron's clipboard (main/clipboard.ts), because the
 * window's own `navigator.clipboard` is refused there. Outside Electron (harness pages in a
 * browser) it falls back to `navigator.clipboard`. Rejects when the text wasn't copied.
 */
export async function copyText(text: string): Promise<void> {
  if (copyOverride) return copyOverride(text);
  if (desktop.copyText) return desktop.copyText(text);
  await navigator.clipboard.writeText(text);
}

let copyOverride: ((text: string) => Promise<void>) | null = null;

/**
 * Sends every copy somewhere other than the system clipboard. The UI gym uses it so its crawl, which
 * clicks every Copy button, never replaces what the person running it had copied.
 */
export function redirectCopies(to: (text: string) => Promise<void>): void {
  copyOverride = to;
}
