/**
 * Quoting for commands people paste into a shell, shared by the main process (bridgeCommand) and
 * the renderer (lib/bridgeInstall.ts). Pure, so both sides and the tests use the same code.
 */

/**
 * sh, bash and zsh: inside single quotes only `'` is special, so it closes, is escaped, and reopens.
 * fish reads `'\''` the same way; it also reads a backslash inside quotes, which plain text never has.
 */
export const shQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * PowerShell: a single-quoted string ends at ' and also at the curly quotes ‘ ’ ‚ ‛, and doubling
 * any of them keeps it in the string (about_Quoting_Rules).
 */
export const psQuote = (value: string) => `'${value.replace(/['‘’‚‛]/g, "$&$&")}'`;

/** A launcher run by its full path: PowerShell's call operator on Windows, the quoted path elsewhere. */
export function launcherCommand(launcher: string, platform: string): string {
  return platform === "win32" ? `& ${psQuote(launcher)}` : shQuote(launcher);
}
