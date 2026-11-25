/**
 * Prints a deployment's function logs for a while, then stops:
 *
 *   pnpm --filter @uplink-room/backend logs [--for <seconds>] [convex logs options]
 *
 * for example `-- --history 1000 --success --jsonl --deployment dev:focused-fish-459`. It stops
 * after 30 seconds unless `--for` says otherwise.
 *
 * `convex logs` streams until it is stopped, and a time limit around `npx convex logs`, as in
 * `perl -e 'alarm 40; exec @ARGV' npx convex logs …`, ends npx but not the `convex` process npx
 * started: one ran on for five days with parent pid 1. This script runs the Convex CLI in its own
 * process, so the time limit, or anything that stops this process, stops the CLI too.
 */
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
// pnpm passes on the `--` in `pnpm logs -- --history 10`.
if (args[0] === "--") args.shift();
let seconds = 30;
const at = args.indexOf("--for");
if (at >= 0) {
  seconds = Number(args[at + 1]);
  args.splice(at, 2);
  if (!(seconds > 0)) {
    process.stderr.write("--for takes a number of seconds greater than 0\n");
    process.exit(2);
  }
}

// What `convex`'s bin (convex/bin/main.js) loads, with this command line.
const cli = fileURLToPath(new URL("../node_modules/convex/dist/cli.bundle.cjs", import.meta.url));
process.argv = [process.argv[0]!, cli, "logs", ...args];
setTimeout(() => process.stdout.write("", () => process.exit(0)), seconds * 1000).unref();
await import(pathToFileURL(cli).href);
