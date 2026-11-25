import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const cli = fileURLToPath(new URL("../../src/bin.ts", import.meta.url));
const call = (event, payload) => {
  const result = spawnSync(process.execPath, [cli, "hook", event], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
};
call("UserPromptSubmit", {});
const answer = call("PermissionRequest", { tool_name: "Bash", tool_input: { command: "build" } });
console.log("decision:" + answer.hookSpecificOutput.decision.behavior);
call("Stop", {});
