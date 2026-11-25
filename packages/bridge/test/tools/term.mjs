// The program the bridge tests run in a real terminal, so the same tests work
// in a Unix pty and in Windows' ConPTY without depending on a shell's builtins.
//
//   term.mjs print TEXT [CODE] [MS]  write TEXT, wait MS, and exit with CODE (default 0)
//   term.mjs env NAME...         write each variable's value on its own line
//   term.mjs echo                write "ready", then "got:LINE" for every line typed
//   term.mjs quit                write "ready", then exit at the first line typed
//   term.mjs size                write "ready", then "ROWS COLS" for every line typed
//   term.mjs report STATE KIND MSG  report a program status (OSC 7501, as Rex reads it), then as echo
//   term.mjs query               ask the terminal's device attributes (ESC [ c), then write "asked"; at
//                                the first Enter, write `replies:` and everything else read, as JSON
//   term.mjs idle                wait until stopped
//   term.mjs child FILE          write this process's pid to FILE, then wait until stopped
//   term.mjs detached FILE       start a detached process (no console, so a closing terminal doesn't
//                                end it), write its pid to FILE, then wait until stopped
//   term.mjs orphan FILE [exit]  start tools/hold-console.cjs attached to this console through a parent
//                                that exits at once, so no tree kill reaches it (it writes its pid to
//                                FILE); write "ready", then wait until stopped (or exit)
//   term.mjs locked FILE [stay]  start tools/hold-console.cjs the same way, deny everyone the right to
//                                query it (tools/lock-process.ps1), write its pid to FILE and "ready",
//                                and exit (or wait until stopped)
const [mode, ...args] = process.argv.slice(2);

function lines(onLine) {
  // Raw mode turns off the terminal's echo, so only the program's answers appear.
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write("ready");
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const parts = buffer.split(/\r\n|\r|\n/);
    buffer = parts.pop() ?? "";
    for (const line of parts) onLine(line);
  });
}

if (mode === "print") {
  process.stdout.write(args[0] ?? "", () =>
    setTimeout(() => process.exit(Number(args[1] ?? 0)), Number(args[2] ?? 0)),
  );
} else if (mode === "env") {
  process.stdout.write(args.map((name) => `${process.env[name] ?? ""}\n`).join(""));
} else if (mode === "echo") {
  lines((line) => process.stdout.write(`got:${line}\n`));
} else if (mode === "quit") {
  lines(() => process.exit(0));
} else if (mode === "size") {
  lines(() => {
    const [cols, rows] = process.stdout.getWindowSize();
    process.stdout.write(`${rows} ${cols}\n`);
  });
} else if (mode === "report") {
  const [state, kind, msg] = args;
  process.stdout.write(`\x1b]7501;state=${state}:kind=${kind}:msg=${Buffer.from(msg ?? "").toString("base64")}\x1b\\`);
  lines((line) => process.stdout.write(`got:${line}\n`));
} else if (mode === "query") {
  if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdout.write("\x1b[casked\r\n");
  let read = "";
  process.stdin.on("data", (chunk) => {
    read += chunk.toString("utf8");
    const end = read.indexOf("\r");
    if (end >= 0) process.stdout.write(`replies:${JSON.stringify(read.slice(0, end))}\r\n`);
  });
} else if (mode === "idle") {
  setInterval(() => {}, 60_000);
} else if (mode === "child") {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(args[0], String(process.pid));
  setInterval(() => {}, 60_000);
} else if (mode === "detached") {
  const { spawn } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { detached: true, stdio: "ignore" });
  child.unref();
  writeFileSync(args[0], String(child.pid));
  setInterval(() => {}, 60_000);
} else if (mode === "orphan" || mode === "locked") {
  // Started through a PowerShell that exits at once: the process shares this console, its parent is
  // gone, and it isn't in the job Node puts its own children in (which would end it with this one).
  const { execFileSync, spawn } = await import("node:child_process");
  const { existsSync, readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const held = mode === "orphan" ? args[0] : `${args[0]}.held`;
  const quote = (word) => `'"${word.replaceAll("'", "''")}"'`;
  const script = `Start-Process -NoNewWindow -FilePath ${quote(process.execPath)} -ArgumentList ${[join(import.meta.dirname, "hold-console.cjs"), held].map(quote).join(",")}`;
  spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { stdio: "inherit" });
  for (let waited = 0; !(existsSync(held) && readFileSync(held, "utf8")) && waited < 60_000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  if (mode === "locked") {
    const pid = readFileSync(held, "utf8").trim();
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(import.meta.dirname, "lock-process.ps1"), pid], { stdio: "ignore" });
    writeFileSync(args[0], pid);
  }
  process.stdout.write("ready");
  // A locked terminal exits on its own unless told to stay; an orphan one stays unless told to exit.
  if ((mode === "locked" && args[1] !== "stay") || args[1] === "exit") process.exit(0);
  setInterval(() => {}, 60_000);
} else {
  process.stderr.write(`Unknown mode: ${mode}\n`);
  process.exit(2);
}
