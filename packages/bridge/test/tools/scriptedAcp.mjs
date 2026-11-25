#!/usr/bin/env node
/**
 * A scripted ACP agent (https://agentclientprotocol.com, protocol version 1) for live checks against
 * an isolated T3 Code server, added there as a Local ACP command provider. It needs no model, no
 * login and no network: what it does depends only on words in the prompt.
 *
 * - Every prompt gets a reply streamed in a few chunks: "Echo: <prompt>".
 * - APPROVE: runs a tool call that asks permission (Allow once / Deny) and writes uplink-probe.txt
 *   in the session's folder only when allowed. T3 Code turns the ask into a command approval.
 * - PLAN: sends a plan with three steps.
 * - TOOLS: runs three tool calls, one of them failing.
 * - SLOW: streams for about 8 seconds, so a turn can be interrupted or a message queued behind it.
 * - ASK: asks a question with ACP's form elicitation (`elicitation/create`, one choice), which T3
 *   Code shows as a question, and says what came back.
 *
 * JSON-RPC 2.0 over stdin and stdout, one message per line.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const log = process.env.SCRIPTED_ACP_LOG;
const note = (line) => {
  if (log) appendFileSync(log, `${new Date().toISOString()} ${line}\n`);
};
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let nextId = 1;
const waiting = new Map();
const request = (method, params) =>
  new Promise((resolve) => {
    const id = `agent-${nextId++}`;
    waiting.set(id, resolve);
    send({ id, method, params });
  });
const sessions = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const update = (sessionId, value) => send({ method: "session/update", params: { sessionId, update: value } });
const say = (sessionId, text) => update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });

async function prompt(id, params) {
  const session = sessions.get(params.sessionId);
  session.cancelled = false;
  const text = params.prompt
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  note(`prompt ${JSON.stringify(text)}`);
  if (/PLAN/.test(text)) {
    update(params.sessionId, {
      sessionUpdate: "plan",
      entries: [
        { content: "Read the invoice totals code", priority: "high", status: "completed" },
        { content: "Fix the rounding", priority: "high", status: "in_progress" },
        { content: "Run the tests", priority: "medium", status: "pending" },
      ],
    });
  }
  if (/TOOLS/.test(text)) {
    const tools = [
      { id: "tool-read", title: "Read src/totals.ts", kind: "read", ok: true, out: "export function total(lines) { ... }" },
      { id: "tool-test", title: "pnpm test", kind: "execute", ok: false, out: "1 failed: rounds 0.005 down" },
      { id: "tool-search", title: "Search for round(", kind: "search", ok: true, out: "src/totals.ts:12" },
    ];
    for (const tool of tools) {
      update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: tool.id, title: tool.title, kind: tool.kind, status: "in_progress", rawInput: { command: tool.title } });
      await sleep(150);
      update(params.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: tool.id,
        status: tool.ok ? "completed" : "failed",
        content: [{ type: "content", content: { type: "text", text: tool.out } }],
      });
    }
  }
  if (/ASK/.test(text)) {
    const answer = await request("elicitation/create", {
      sessionId: params.sessionId,
      mode: "form",
      message: "Which rounding should totals use?",
      requestedSchema: {
        type: "object",
        properties: { rounding: { type: "string", title: "Rounding", description: "Which rounding should totals use?", enum: ["Half up", "Banker's"] } },
        required: ["rounding"],
      },
    });
    note(`elicitation ${JSON.stringify(answer)}`);
    say(params.sessionId, `Question answer: ${JSON.stringify(answer ?? null)}. `);
  }
  if (/APPROVE/.test(text)) {
    const toolCall = { toolCallId: `probe-${Date.now()}`, title: "echo uplink-probe", kind: "execute", status: "pending", rawInput: { command: "echo uplink-probe" } };
    update(params.sessionId, { sessionUpdate: "tool_call", ...toolCall });
    const answer = await request("session/request_permission", {
      sessionId: params.sessionId,
      toolCall,
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    const allowed = answer?.outcome?.outcome === "selected" && answer.outcome.optionId === "allow";
    note(`permission ${allowed ? "allow" : "deny"}`);
    if (allowed) writeFileSync(join(session.cwd, "uplink-probe.txt"), "uplink-probe\n");
    update(params.sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: toolCall.toolCallId,
      status: allowed ? "completed" : "failed",
      content: [{ type: "content", content: { type: "text", text: allowed ? "uplink-probe" : "Denied." } }],
    });
    say(params.sessionId, `Approval outcome: ${allowed ? "allow" : "deny"}. `);
  }
  const chunks = /SLOW/.test(text) ? 16 : 3;
  for (let i = 0; i < chunks && !session.cancelled; i++) {
    say(params.sessionId, i === 0 ? `Echo: ${text.slice(0, 200)}` : ` (${i})`);
    await sleep(/SLOW/.test(text) ? 500 : 40);
  }
  send({ id, result: { stopReason: session.cancelled ? "cancelled" : "end_turn" } });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== undefined && message.method === undefined) {
    const resolve = waiting.get(message.id);
    waiting.delete(message.id);
    resolve?.(message.result ?? (message.error ? { error: message.error } : undefined));
    return;
  }
  const { id, method, params } = message;
  if (method === "initialize")
    return send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, promptCapabilities: {} }, authMethods: [] } });
  if (method === "session/new") {
    const sessionId = `scripted-${sessions.size + 1}`;
    sessions.set(sessionId, { cwd: params.cwd, cancelled: false });
    return send({ id, result: { sessionId } });
  }
  if (method === "session/prompt") return void prompt(id, params);
  if (method === "session/cancel") {
    const session = sessions.get(params.sessionId);
    if (session) session.cancelled = true;
    return;
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
});
