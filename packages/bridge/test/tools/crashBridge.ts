// For the bridge's Windows console tests (#66): a bridge that records its terminals in the folder
// given as the first argument, starts one, and once that terminal is bound and recorded exits without
// stopping it, as a bridge that crashes does.
import { readdirSync } from "node:fs";
import { quoteCommand, terminalShell } from "../../src/platform.ts";
import { consoleCleanup, nodePtyHost } from "../../src/terminal.ts";

const [dir] = process.argv.slice(2);
consoleCleanup.recordIn(dir!);
const term = new URL("term.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const shell = terminalShell(quoteCommand([process.execPath, term, "echo"]));
const terminal = nodePtyHost.spawn(shell.file, shell.args, { name: "xterm-256color", cols: 120, rows: 30, cwd: process.cwd(), env: process.env });
let output = "";
const recorded = () => {
  try {
    return readdirSync(dir!).some((name) => name.endsWith(".json"));
  } catch {
    return false;
  }
};
terminal.onData((data) => {
  output += data;
});
const started = Date.now();
const timer = setInterval(() => {
  if ((!output.includes("ready") || !recorded()) && Date.now() - started < 30_000) return;
  clearInterval(timer);
  process.stdout.write(`started ${process.pid}\n`, () => process.exit(3));
}, 50);
