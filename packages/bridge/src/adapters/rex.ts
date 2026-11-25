import { isCommand, jsonCommand, lines, shellWords, targetFlag } from "./process.ts";
import { programStatus, type Adapter, type AdapterContext } from "./types.ts";
import { rexServerArgs } from "../rex/rexCli.ts";
/** How long the adapter waits for `rex events` to start before it takes the program-status snapshot anyway. */
const SNAPSHOT_WAIT_MS = 2000;
export class RexAdapter implements Adapter {
  name = "rex";
  executable: string;
  private options: { executable?: string; target?: string; block?: string };
  constructor(options: { executable?: string; target?: string; block?: string } = {}) {
    this.options = options;
    this.executable = options.executable ?? "rex";
  }
  matches(command: string) {
    // For `run` and `split`, -b names an anchor, not the new terminal.
    // Never report that anchor's state as the new run's state.
    const action = shellWords(command)[1];
    return (
      !!this.options.target ||
      (isCommand(command, "rex") && action !== "run" && action !== "split" && action !== "new")
    );
  }
  start(context: AdapterContext) {
    const target =
      this.options.target ??
      targetFlag(context.command, "-s") ??
      targetFlag(context.command, "--session") ??
      context.env.REX_SESSION;
    const block =
      this.options.block ??
      targetFlag(context.command, "-b") ??
      targetFlag(context.command, "--block") ??
      context.env.REX_BLOCK;
    if (!target || !block) {
      context.report({ state: "unknown" });
      return { close() {} };
    }
    let changed = false;
    let closed = false;
    // The snapshot catches a status reported before the stream started. It's taken once the stream is
    // live, so nothing falls between the two: Rex's `events -s` first prints its own client_connected
    // (seen with Rex 0.0.1793741575), and a Rex that doesn't gets the snapshot after SNAPSHOT_WAIT_MS.
    let snapped = false;
    const snapshot = () => {
      if (snapped || closed) return;
      snapped = true;
      clearTimeout(fallback);
      void jsonCommand(
        this.executable,
        [...rexServerArgs(context.env), "block", "call", "-s", target, "-b", block, "program_status", "--autostart=false"],
        context,
      )
        .then((value) => {
          const records = (value as { records?: { state?: string; kind?: string; msg?: string }[] }).records;
          if (!closed && !changed && records?.length)
            context.report(programStatus(records.find((r) => r.state === "blocked") ?? records[0], { answerable: false }));
        })
        .catch(() => {});
    };
    const fallback = setTimeout(snapshot, SNAPSHOT_WAIT_MS);
    fallback.unref();
    const handle = lines(
      this.executable,
      [...rexServerArgs(context.env), "events", "-s", target, "--json", "--autostart=false"],
      context,
      (line) => {
        snapshot();
        const event = JSON.parse(line);
        if (event.type !== "session_event" || event.payload?.session_id !== target) return;
        const wrapped = event.payload.event;
        if (wrapped?.type !== "block_event") return;
        const data = wrapped.payload;
        if (data?.block_id !== block || data.creator_name !== "com.superlogical.terminal") return;
        changed = true;
        if (data.name === "program_status_changed")
          context.report(programStatus(data.payload?.record, { answerable: false }));
        if (data.name === "program_status_removed") context.report({ state: "unknown" });
        if (data.name === "child_exited")
          context.report({ state: data.payload?.exit_code === 0 ? "done" : "failed" });
      },
      () => context.report({ state: "unknown" }),
    );
    return {
      close() {
        closed = true;
        clearTimeout(fallback);
        handle.close();
      },
    };
  }
}
