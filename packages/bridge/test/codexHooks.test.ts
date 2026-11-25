/**
 * The hooks the bridge gives a Codex terminal's own app server (codexHooks.ts, ADR 0038), and the
 * trust Codex needs before it runs them, passed in the same `-c` layer so nothing is written to the
 * person's Codex home.
 */
import { expect, test } from "vitest";
import { codexHookHash, codexServerConfig } from "../src/codexHooks.ts";
import { overridesIn, sessionFlags } from "./tools/codexConfig.ts";

/**
 * Hashes Codex 0.166.0 reported for hooks passed with `-c` (`hooks/list`, `currentHash`), on
 * 2026-11-05: each ran `probe.sh <Event>` with `timeout = 30` and no matcher. Codex clamps an
 * `Interrupt` or `SessionEnd` hook's timeout to 3 seconds before it hashes it.
 */
const PROBE = "/private/tmp/claude-501/-Users-judiazm--t3-worktrees-uplink-room-t3-3d0cc1b3/4cf09058-b6f2-4180-aa6f-b7731509fe77/scratchpad/cx/probe.sh";
const CODEX_0_166_HASHES: [string, string][] = [
  ["PreToolUse", "sha256:990f1cd06823fd015f5418ffda26312a31a8fb28961a96e2156b5e4a2291afdd"],
  ["PermissionRequest", "sha256:6f835896526ca9c1b231c219490092fc880e8f86458d17c93de3d85ac0ad3392"],
  ["PostToolUse", "sha256:4ef57e19df0d9038daf0013ba6fe63cd17eba27a4fcca9a7bccee194313fb088"],
  ["SessionStart", "sha256:5e8ce04492c9ea957c2be7f672e8e02a68e5c28ee1950ebece9dd5c608e747ed"],
  ["UserPromptSubmit", "sha256:15641666c3bad4e77b6078cca67c8b06d50dab838ae95da56121c04d8b7f4d1b"],
  ["Stop", "sha256:0f2a2d8025d3832c3cccfc30b7571d8027c0fd33836e127936048edfe6bf9ba6"],
  ["Interrupt", "sha256:5a49db5665a855a87675b2fc36cfbcca46f6eed50d8d84772c1f7a5e88839b88"],
  ["SessionEnd", "sha256:45ef80842db2ffc7b718989a53ae862bfe356ff4037e076479704ae8c8257085"],
];

test.each(CODEX_0_166_HASHES)("a %s hook hashes as Codex 0.166.0 hashes it, so the trust the bridge passes matches", (event, hash) => {
  expect(codexHookHash(event, { command: `${PROBE} ${event}`, timeout: 30 })).toBe(hash);
});

test("the app server's -c values give each hook and trust that hook's exact definition, keyed as Codex keys session hooks", () => {
  const { values } = codexServerConfig(["/opt/uplink/node", "/opt/uplink/bridge.mjs"], { platform: "linux" });
  const stop = values.find((value) => value.startsWith("hooks.Stop="));
  expect(stop).toBe(`hooks.Stop=[{hooks=[{type="command",command="'/opt/uplink/node' '/opt/uplink/bridge.mjs' 'codex-hook' 'Stop'",timeout=30}]}]`);
  const state = values.find((value) => value.startsWith("hooks.state="));
  const hash = codexHookHash("Stop", { command: "'/opt/uplink/node' '/opt/uplink/bridge.mjs' 'codex-hook' 'Stop'", timeout: 30 });
  expect(state).toContain(`"/<session-flags>/config.toml:stop:0:0"={trusted_hash="${hash}"}`);
  // An approval waits as long as Codex lets a hook run by default; after that Codex asks in the terminal.
  expect(values.find((value) => value.startsWith("hooks.PermissionRequest="))).toContain("timeout=600");
  expect(values.map((value) => value.split("=")[0])).toEqual([
    "hooks.SessionStart",
    "hooks.UserPromptSubmit",
    "hooks.PreToolUse",
    "hooks.PostToolUse",
    "hooks.PermissionRequest",
    "hooks.Stop",
    "hooks.Interrupt",
    "hooks.state",
  ]);
});

test("hooks the person passes with -c, and the trust they pass for them, stay, and the bridge's hooks come after theirs", () => {
  const bridge = ["/opt/uplink/node", "/opt/uplink/bridge.mjs"];
  const theirs = [
    `hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command="/opt/guard/block-rm.sh"}]}]`,
    `hooks.state={"/<session-flags>/config.toml:pre_tool_use:0:0"={trusted_hash="sha256:guard"}}`,
    `hooks.PermissionRequest=[{hooks=[{type="command",command="/opt/guard/ask.sh",timeout=5}]}]`,
  ];
  const given = ["-c", theirs[0]!, `--config=${theirs[1]!}`, "-c", theirs[2]!];
  const { values } = codexServerConfig(bridge, { platform: "linux", given });
  // Codex applies the person's values first, then the bridge's, in one layer.
  const { hooks } = sessionFlags([...overridesIn(given), ...values]);
  const ours = (event: string, timeout: number) => ({ type: "command", command: `'/opt/uplink/node' '/opt/uplink/bridge.mjs' 'codex-hook' '${event}'`, timeout });
  expect(hooks.PreToolUse).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: "/opt/guard/block-rm.sh" }] }, { hooks: [ours("PreToolUse", 30)] }]);
  expect(hooks.PermissionRequest).toEqual([{ hooks: [{ type: "command", command: "/opt/guard/ask.sh", timeout: 5 }] }, { hooks: [ours("PermissionRequest", 600)] }]);
  expect(hooks.Stop).toEqual([{ hooks: [ours("Stop", 30)] }]);
  expect(hooks.state).toEqual({
    "/<session-flags>/config.toml:pre_tool_use:0:0": { trusted_hash: "sha256:guard" },
    "/<session-flags>/config.toml:session_start:0:0": { trusted_hash: codexHookHash("SessionStart", ours("SessionStart", 30)) },
    "/<session-flags>/config.toml:user_prompt_submit:0:0": { trusted_hash: codexHookHash("UserPromptSubmit", ours("UserPromptSubmit", 30)) },
    "/<session-flags>/config.toml:pre_tool_use:1:0": { trusted_hash: codexHookHash("PreToolUse", ours("PreToolUse", 30)) },
    "/<session-flags>/config.toml:post_tool_use:0:0": { trusted_hash: codexHookHash("PostToolUse", ours("PostToolUse", 30)) },
    "/<session-flags>/config.toml:permission_request:1:0": { trusted_hash: codexHookHash("PermissionRequest", ours("PermissionRequest", 600)) },
    "/<session-flags>/config.toml:stop:0:0": { trusted_hash: codexHookHash("Stop", ours("Stop", 30)) },
    "/<session-flags>/config.toml:interrupt:0:0": { trusted_hash: codexHookHash("Interrupt", ours("Interrupt", 3)) },
  });
});
