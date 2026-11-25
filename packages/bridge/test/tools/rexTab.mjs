// One tab of the fake Rex (tools/rex): runs the tab's command on a real pty, as Rex does, and stays
// up while the tab is open.
//
//   rexTab.mjs DIR SESSION BLOCK CWD COMMAND...
//
// Output goes to DIR/out/BLOCK. An OSC 7501 report in it becomes a program_status_changed event in
// DIR/events/SESSION (and the tab's records in DIR/records/BLOCK first, for `program_status`), and
// the command's exit a child_exited event, shaped as `rex events --json` prints them. A device
// attributes query (`ESC [ c`) is answered as Rex's server answers it, app or no app. SIGUSR1 applies the size in DIR/resize/BLOCK (a size_changed event follows). SIGTERM
// closes the tab: the program is hung up, as when a Rex tab closes or Rex quits.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pty from "node-pty";

const [dir, session, block, cwd, file, ...args] = process.argv.slice(2);
const events = join(dir, "events", session);
const event = (name, payload) =>
  appendFileSync(
    events,
    JSON.stringify({ type: "session_event", payload: { session_id: session, event: { type: "block_event", payload: { block_id: block, creator_name: "com.superlogical.terminal", name, payload } } } }) + "\n",
  );
const tab = pty.spawn(file, args, {
  name: "xterm-256color",
  cols: 100,
  rows: 30,
  cwd,
  env: { ...process.env, REX_SESSION: session, REX_BLOCK: block },
});
// OSC 7501 is an escape sequence: ESC ] 7501 ; pairs, ended by BEL or ESC \.
// oxlint-disable-next-line no-control-regex
const report = /\x1b\]7501;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
let pending = "";
const records = new Map();
tab.onData((data) => {
  appendFileSync(join(dir, "out", block), data);
  // Rex 0.0.1793741575's server answered this with no Rex app attached (checked 2026-11-04).
  if (data.includes("\x1b[c") || data.includes("\x1b[0c")) tab.write("\x1b[?62;22c");
  pending = (pending + data).slice(-8192);
  for (const match of pending.matchAll(report)) {
    const record = Object.fromEntries(match[1].split(":").map((pair) => pair.split("=")));
    if (record.msg) record.msg = Buffer.from(record.msg, "base64").toString("utf8");
    records.set(record.id ?? "", record);
    mkdirSync(join(dir, "records"), { recursive: true });
    writeFileSync(join(dir, "records", block), JSON.stringify({ records: [...records.values()] }));
    event("program_status_changed", { id: record.id ?? "", record });
  }
  pending = pending.replace(report, "");
});
process.on("SIGUSR1", () => {
  const { columns, rows } = JSON.parse(readFileSync(join(dir, "resize", block), "utf8"));
  tab.resize(columns, rows);
  event("size_changed", { columns, rows });
});
process.on("SIGTERM", () => tab.kill("SIGHUP"));
tab.onExit(({ exitCode }) => {
  event("child_exited", { exit_code: exitCode });
  // The tab closes with its program, and leaves Rex's session list.
  const file = join(dir, "sessions.json");
  const list = JSON.parse(readFileSync(file, "utf8"));
  for (const s of list) for (const w of s.windows) w.blocks = w.blocks.filter((b) => b.block_id !== block);
  for (const s of list) s.windows = s.windows.filter((w) => w.blocks.length);
  writeFileSync(file, JSON.stringify(list));
  setTimeout(() => process.exit(0), 50);
});
