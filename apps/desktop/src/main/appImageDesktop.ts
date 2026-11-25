import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { execArgument } from "./loginItemSpec";

/** Repair only an existing user menu entry for this AppImage installation (#128).
 * Synchronous: electron-updater emits its move event during quit, just before exit.
 * Custom wrappers, other install directories and other release channels remain untouched.
 */
export function repairAppImageDesktopEntries(
  image: string,
  version = /^Uplink-Room-(\d+\.\d+\.\d+)-/.exec(basename(image))?.[1] ?? "",
  dataHome = process.env["XDG_DATA_HOME"] || join(homedir(), ".local", "share"),
): void {
  const name = /^Uplink-Room-(\d+\.\d+\.\d+)-linux-(.+)\.AppImage$/.exec(basename(image));
  const executable = execArgument(image);
  if (!name || !executable || /[\r\n]/.test(version)) return;
  const file = join(dataHome, "applications", "uplink-room.desktop");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let section = "";
  let repaired = false;
  const lines = text.split("\n").map((line) => {
    if (/^\[.*\]\r?$/.test(line)) section = line.trim();
    if (section !== "[Desktop Entry]") return line;
    // Compare encoded arguments rather than shell-parsing desktop entries. Only the
    // numeric version may differ; the directory, architecture and %U must match.
    if (line.startsWith("Exec=")) {
      const versions = line.match(/\d+\.\d+\.\d+/g) ?? [];
      const ours = versions.some((old) => {
        const previous = join(dirname(image), `Uplink-Room-${old}-linux-${name[2]}.AppImage`);
        return line.replace(/\r$/, "") === `Exec=${execArgument(previous)} %U`;
      });
      if (ours) {
        repaired = true;
        return `Exec=${executable} %U${line.endsWith("\r") ? "\r" : ""}`;
      }
    }
    return line;
  });
  if (!repaired) return;
  section = "";
  const updated = lines
    .map((line) => {
      if (/^\[.*\]\r?$/.test(line)) section = line.trim();
      return section === "[Desktop Entry]" && line.startsWith("X-AppImage-Version=")
        ? `X-AppImage-Version=${version}${line.endsWith("\r") ? "\r" : ""}`
        : line;
    })
    .join("\n");
  if (updated !== text) writeFileSync(file, updated);
}
