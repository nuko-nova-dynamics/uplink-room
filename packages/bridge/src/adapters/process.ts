import { createInterface } from "node:readline";
import { resolveExecutable, spawnExecutable } from "../platform.ts";
import type { AdapterHandle } from "./types.ts";
export async function available(executable: string) {
  return resolveExecutable(executable) !== undefined;
}
export function lines(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
  onLine: (line: string) => void,
  onLost: () => void,
  input?: string,
): AdapterHandle {
  const child = spawnExecutable(executable, args, { ...options, stdio: ["pipe", "pipe", "ignore"] });
  let stopped = false;
  const reader = createInterface({ input: child.stdout! });
  reader.on("line", (line) => {
    if (!stopped && line.length < 1024 * 1024) {
      try {
        onLine(line);
      } catch {
        onLost();
      }
    }
  });
  child.on("error", () => {
    if (!stopped) onLost();
  });
  child.on("exit", () => {
    if (!stopped) onLost();
  });
  child.stdin!.on("error", () => {});
  if (input) child.stdin!.write(input);
  return {
    close() {
      stopped = true;
      reader.close();
      child.kill();
    },
  };
}
/** Runs a tool once and parses its JSON output, giving up after 10 seconds or 4 MiB. */
export function jsonCommand(
  executable: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawnExecutable(executable, args, { ...options, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${executable} timed out`));
    }, 10000);
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        child.kill();
        reject(new Error(`${executable} wrote too much output`));
      } else chunks.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${executable} exited with ${code}`));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
  });
}
// Only the leading shell command is used to select an adapter. Complex shell
// expressions stay shareable and report unknown unless hooks identify them.
// On Windows a backslash separates folders, so it never escapes.
export function shellWords(command: string, windows = process.platform === "win32") {
  const words: string[] = [];
  let word = "",
    quote = "",
    active = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && quote === '"' && !windows) word += command[++i] ?? "";
      else word += char;
      active = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      active = true;
    } else if (char === "\\" && !windows) {
      word += command[++i] ?? "";
      active = true;
    } else if (/\s/.test(char)) {
      if (active) {
        words.push(word);
        word = "";
        active = false;
      }
    } else if (/[;&|()<>]/.test(char)) break;
    else {
      word += char;
      active = true;
    }
  }
  if (active) words.push(word);
  return words;
}
export function isCommand(command: string, executable: string) {
  const windows = process.platform === "win32";
  // PowerShell starts a quoted program with the call operator: `& 'C:\Program Files\x.exe'`.
  const program = shellWords(windows ? command.replace(/^\s*&\s*/, "") : command, windows)[0];
  const name = program?.split(windows ? /[\\/]/ : "/").at(-1);
  return (windows ? name?.toLowerCase().replace(/\.(exe|cmd|bat)$/, "") : name) === executable;
}
export function targetFlag(command: string, flag: string) {
  const words = shellWords(command);
  const index = words.indexOf(flag);
  return index < 0
    ? words.find((word) => word.startsWith(flag + "="))?.slice(flag.length + 1)
    : words[index + 1];
}
