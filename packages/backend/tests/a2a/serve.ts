/**
 * Serves the local A2A agent (fakeAgent.ts) for a manual or end-to-end check
 * against a real deployment. A deployment in the cloud can't reach 127.0.0.1,
 * so put a tunnel in front and pass its public URL as --advertise:
 *
 *   cloudflared tunnel --url http://127.0.0.1:41241
 *   node packages/backend/tests/a2a/serve.ts --port 41241 --advertise https://<name>.trycloudflare.com/ \
 *     --bearer <token> --streaming
 *
 * Flags: --port, --advertise, --bearer, --streaming, --no-cancel, --no-list, --name, --work-ms,
 * --serve 0.3 (the official SDK at A2A 0.3) and --card 1.0 (a 1.0 card in front of 0.3's methods),
 * --chat (answers like Hermes, remembering each context, ADR 0024), --max-turns N (refuses a
 * context past N messages, as Hermes's anti-loop limit does) and --log (prints each call's method,
 * context and task).
 */
import { parseArgs } from "node:util";
import { startFakeAgent } from "./fakeAgent.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "41241" },
    advertise: { type: "string" },
    bearer: { type: "string" },
    streaming: { type: "boolean", default: false },
    "no-cancel": { type: "boolean", default: false },
    "no-list": { type: "boolean", default: false },
    name: { type: "string" },
    "work-ms": { type: "string" },
    serve: { type: "string" },
    card: { type: "string" },
    chat: { type: "boolean", default: false },
    "max-turns": { type: "string" },
    log: { type: "boolean", default: false },
  },
});

const agent = await startFakeAgent(
  {
    streaming: values.streaming,
    ...(values.advertise ? { advertiseUrl: values.advertise } : {}),
    ...(values.bearer ? { bearer: values.bearer } : {}),
    ...(values["no-cancel"] ? { cancel: "unsupported" as const } : {}),
    ...(values["no-list"] ? { listTasks: false } : {}),
    ...(values.name ? { name: values.name } : {}),
    ...(values["work-ms"] ? { workMs: Number(values["work-ms"]) } : {}),
    ...(values.serve === "0.3" ? { serve: "0.3" as const } : {}),
    ...(values.card === "1.0" || values.card === "0.3" ? { card: values.card } : {}),
    ...(values.chat ? { chat: true } : {}),
    ...(values["max-turns"] ? { maxTurns: Number(values["max-turns"]) } : {}),
  },
  Number(values.port),
);
if (values.log) {
  let printed = 0;
  setInterval(() => {
    for (const call of agent.calls.slice(printed)) {
      const m = call.params?.message;
      const text = String(m?.parts?.[0]?.text ?? "").split("\n")[0];
      console.log(JSON.stringify({ method: call.method, contextId: m?.contextId, taskId: m?.taskId ?? call.params?.id, referenceTaskIds: m?.referenceTaskIds, parts: m?.parts?.length, text }));
    }
    printed = agent.calls.length;
  }, 300).unref();
}
console.log(
  `A2A agent on ${agent.url} (card ${agent.cardUrl}), advertising ${values.advertise ?? agent.url}`,
);
process.on("SIGINT", () => void agent.close().then(() => process.exit(0)));
process.on("SIGTERM", () => void agent.close().then(() => process.exit(0)));
