/**
 * A process whose output closed keeps its own course instead of crashing.
 *
 * When whoever reads a process's stdout or stderr goes away (the app quit, a pipe's reader exited,
 * `uplink … | head` read enough), the next write fails with EPIPE. Node emits that as an `error`
 * event on the stream, and with no listener it is an uncaught exception: the app's bridge, told to
 * stop as the app quit, crashed on a log line of its own shutdown and reported it to Sentry as fatal
 * (UPLINK-ROOM-BRIDGE-3, `specs/BridgeQuit.tla`).
 *
 * Every Node entry point calls this first (lint rule `room/entry-handles-closed-output`). After the
 * output closes, writes to it are dropped and `onClosed` runs once: the bridge passes nothing, so it
 * finishes what it was doing (its shutdown, or its terminals when nobody stopped it); a command or
 * MCP server passes `process.exit`, so nothing keeps running for a reader that's gone.
 */
export function onClosedOutput(onClosed?: () => void, streams: NodeJS.WritableStream[] = [process.stdout, process.stderr]): void {
  let closed = false;
  for (const stream of streams) {
    stream.on("error", () => {
      if (closed) return;
      closed = true;
      onClosed?.();
    });
  }
}
