#!/usr/bin/env node
import { onClosedOutput } from "@uplink-room/protocol/closedOutput";
import { failureReason, main } from "./cli.ts";
import { isBug, reportError, sendTestError, startTelemetry } from "./telemetry/sentry.ts";

// The app quits right after it tells its bridge to stop, so the bridge's last log lines go to a
// closed pipe. It finishes stopping anyway; a bridge nobody stopped keeps its terminals (closedOutput.ts).
onClosedOutput();

// Before ELECTRON_RUN_AS_NODE goes, so reports can tell the app's bridge from a standalone one.
startTelemetry();
await sendTestError();

// Inside the desktop app the bridge runs on Electron acting as Node. Its
// terminals must not inherit that, or an Electron app started in one
// (VS Code, the Uplink Room app itself) would start as plain Node.
delete process.env["ELECTRON_RUN_AS_NODE"];

main().catch(async (error: unknown) => {
  console.error(`Bridge command failed: ${failureReason(error)}`);
  process.exitCode = 1;
  if (isBug(error)) await reportError(error);
});
