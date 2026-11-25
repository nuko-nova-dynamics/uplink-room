import { isCommand, shellWords, lines } from "./process.ts";
import { programStatus, type Adapter, type AdapterContext } from "./types.ts";
export class HerdrAdapter implements Adapter {
  name = "herdr";
  executable: string;
  private options: { executable?: string; target?: string };
  constructor(options: { executable?: string; target?: string } = {}) {
    this.options = options;
    this.executable = options.executable ?? "hc";
  }
  matches(command: string) {
    return !!this.options.target || isCommand(command, "hc");
  }
  start(context: AdapterContext) {
    const target =
      this.options.target ??
      (shellWords(context.command)[1] === "attach"
        ? shellWords(context.command)[2]
        : context.env.HC_TERMINAL);
    if (!target) {
      context.report({ state: "unknown" });
      return { close() {} };
    }
    return lines(
      this.executable,
      ["events", "--json", "--terminal", target],
      context,
      (line) => {
        const event = JSON.parse(line);
        const change = event.params;
        if (event.method === "event" && change?.terminal === target) {
          if (change.type === "status") context.report(programStatus(change.data?.status));
          if (change.type === "finished")
            context.report({ state: change.data?.exit_code === 0 ? "done" : "failed" });
        }
        const terminals = event.terminals ?? (event.terminal ? [event.terminal] : []);
        for (const terminal of terminals) {
          if (terminal.address !== target) continue;
          context.report(
            terminal.state === "finished"
              ? { state: terminal.exit_code === 0 ? "done" : "failed" }
              : programStatus(terminal.status),
          );
        }
      },
      () => context.report({ state: "unknown" }),
    );
  }
}
