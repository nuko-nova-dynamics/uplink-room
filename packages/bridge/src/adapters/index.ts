import { ClaudeCodeAdapter } from "./claude.ts";
import { CodexAdapter } from "./codex.ts";
import { HermesAdapter } from "./hermes.ts";
import { HerdrAdapter } from "./herdr.ts";
import { RexAdapter } from "./rex.ts";
import { TmuxAdapter } from "./tmux.ts";
import { T3CodeAdapter } from "./t3code.ts";
import { t3Executable } from "./t3pair.ts";
import { rexExecutable } from "../rex/rexCli.ts";
import type { T3Session } from "./t3client.ts";
import type { Adapter } from "./types.ts";
/**
 * The adapters for this machine. tmux and herdr don't run natively on
 * Windows, so a Windows bridge leaves them out: their terminals are still
 * shared as plain screen output, with status Unknown.
 */
export function defaultAdapters(
  platform: NodeJS.Platform = process.platform,
  t3?: T3Session,
  /** Reads the saved T3 Code session again, so `t3-pair` takes effect without a restart. */
  loadT3?: () => Promise<T3Session | undefined>,
  /** Pairs with this machine's T3 Code and saves the session, or undefined when it couldn't. */
  pairT3?: () => Promise<T3Session | undefined>,
): Adapter[] {
  return [
    new ClaudeCodeAdapter(),
    new CodexAdapter(),
    new HermesAdapter(),
    ...(platform === "win32" ? [] : [new HerdrAdapter(), new TmuxAdapter()]),
    // Found where Rex installs it too: the app's bridge has a GUI app's short PATH.
    new RexAdapter({ executable: rexExecutable() }),
    new T3CodeAdapter({
      executable: t3Executable() ?? "t3",
      project: process.env.UPLINK_T3_PROJECT,
      session: t3,
      ...(loadT3 ? { loadSession: loadT3 } : {}),
      ...(pairT3 ? { pairAgain: pairT3 } : {}),
    }),
  ];
}
export type { Adapter, AdapterContext, AdapterHandle, RunUpdate } from "./types.ts";
