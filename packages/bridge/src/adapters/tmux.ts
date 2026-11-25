import { isCommand, lines, targetFlag } from "./process.ts";
import type { Adapter, AdapterContext, RunUpdate } from "./types.ts";
export class TmuxAdapter implements Adapter {
  name = "tmux";
  executable: string;
  private options: { executable?: string; target?: string; socketPath?: string };
  constructor(options: { executable?: string; target?: string; socketPath?: string } = {}) {
    this.options = options;
    this.executable = options.executable ?? "tmux";
  }
  matches(command: string) {
    return !!this.options.target || isCommand(command, "tmux");
  }
  start(context: AdapterContext) {
    const target = this.options.target ?? targetFlag(context.command, "-t");
    if (!target) {
      context.report({ state: "unknown" });
      return { close() {} };
    }
    // tmux has no built-in run state. A tool sets these user options explicitly.
    const socketPath = this.options.socketPath ?? targetFlag(context.command, "-S");
    return lines(
      this.executable,
      [...(socketPath ? ["-S", socketPath] : []), "-C", "attach", "-t", target],
      context,
      (line) => {
        if (!line.startsWith("%subscription-changed uplink ")) return;
        const [state, text, kind] = line.slice(line.indexOf(" : ") + 3).split("|");
        const update: RunUpdate =
          state === "waiting" && text
            ? { state, prompt: { kind: kind === "approval" ? "approval" : "question", text } }
            : {
                state:
                  state === "working" || state === "done" || state === "failed" ? state : "unknown",
              };
        context.report(update);
      },
      () => context.report({ state: "unknown" }),
      "refresh-client -B 'uplink::#{@uplink_state}|#{@uplink_prompt}|#{@uplink_prompt_kind}'\n",
    );
  }
}
