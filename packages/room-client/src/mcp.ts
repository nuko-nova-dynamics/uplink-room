#!/usr/bin/env node
/**
 * The Room API as an MCP server over stdio (ADR 0003).
 *
 * It lists one tool per function in `GET /api/v1/functions`, so a new Room API
 * function appears here without a change to this file. Tool names replace the
 * dots in a function name with underscores: `tasks.create` is `tasks_create`.
 *
 * Config: UPLINK_URL (the Convex site URL) and UPLINK_AGENT_KEY, or else what
 * `uplink login` saved: an agent key, or a person's CLI sign-in, with which the
 * server acts as that person (ADR 0030).
 *
 * `uplink-mcp --channel` (or UPLINK_MCP_CHANNEL=1) is also a Claude Code
 * channel: once its session joins the room with `uplink join`, it pushes the
 * joined run's messages into the session (channel.ts, ADR 0032).
 */
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { onClosedOutput } from "@uplink-room/protocol/closedOutput";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { isCliSignInToken, RoomApiError, RoomClient, runInTerminal, waitForRuns, waitForTerminal, type RoomFunction } from "./client.ts";
import { BUILT_IN_URL, roomCredentials, type Env } from "./config.ts";
import {
  INSTRUCTIONS,
  PERSON_INSTRUCTIONS,
  roomTool,
  RUN_TOOL,
  RUNS_WAIT_TOOL,
  toolName,
  UPLOAD_TOOL,
  WAIT_TOOL,
} from "@uplink-room/protocol/mcp";
import { CHANNEL_INSTRUCTIONS, startChannel } from "./channel.ts";

// The tool catalog and the instructions are shared with the remote connector (ADR 0031).
export { INSTRUCTIONS, PERSON_INSTRUCTIONS, RUN_TOOL, RUNS_WAIT_TOOL, toolName, UPLOAD_TOOL, WAIT_TOOL };

function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

async function uploadFile(client: RoomClient, args: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof args.path !== "string" || !args.path) return toolError("invalid: Pass the file's path.");
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(args.path));
  } catch (error) {
    return toolError(`invalid: Could not read ${args.path}: ${(error as Error).message}`);
  }
  try {
    const uploaded = await client.upload(
      bytes,
      typeof args.name === "string" && args.name ? args.name : basename(args.path),
      typeof args.contentType === "string" && args.contentType ? args.contentType : undefined,
      typeof args.teamId === "string" && args.teamId ? { teamId: args.teamId } : {},
    );
    return { content: [{ type: "text", text: JSON.stringify(uploaded, null, 2) }] };
  } catch (error) {
    if (error instanceof RoomApiError) return toolError(`${error.code}: ${error.message}`);
    return toolError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Which functions to list, from UPLINK_MCP_TOOLS: comma-separated modules (`tasks`) or functions
 * (`calls.join`). Unset or `all` lists every function. The client-side tools are always listed.
 */
export function toolFilter(spec: string | undefined): (fn: string) => boolean {
  const parts = (spec ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0 || parts.includes("all")) return () => true;
  return (fn) => parts.some((p) => fn === p || fn.startsWith(`${p}.`));
}

/** The teamId property of the tools that aren't Room API functions, worded as team functions word theirs. */
function teamIdProperty(found: string): Record<string, unknown> {
  return {
    type: "string",
    description: `The team. Optional with an agent key (the key's team is used) and with a CLI sign-in when you're in one team (people_me lists yours)${found}.`,
  };
}

/** What `members.me` says about this key's scopes, for marking tools it can't use. */
type KeyScopes = { lacks: Set<string>; addedBy?: string };

async function keyScopes(client: RoomClient): Promise<KeyScopes | undefined> {
  try {
    const me = (await client.call("members.me")) as { lacksScopes?: string[]; addedBy?: { name: string } };
    return me.lacksScopes ? { lacks: new Set(me.lacksScopes), addedBy: me.addedBy?.name } : undefined;
  } catch {
    return undefined;
  }
}

/** Builds an MCP server whose tools are the Room API functions `client` can reach. */
export function createRoomMcpServer(client: RoomClient, options: { tools?: string; channel?: boolean } = {}): Server {
  const listed = toolFilter(options.tools);
  const asPerson = isCliSignInToken(client.key);
  const instructions = asPerson ? PERSON_INSTRUCTIONS : INSTRUCTIONS;
  const server = new Server(
    { name: "uplink-room", version: "0.1.0" },
    {
      // A channel declares claude/channel (code.claude.com/docs/en/channels-reference).
      capabilities: { tools: {}, ...(options.channel ? { experimental: { "claude/channel": {} } } : {}) },
      instructions: options.channel ? `${instructions}\n\n${CHANNEL_INSTRUCTIONS}` : instructions,
    },
  );

  // Tool name -> function, from the last listing.
  let known = new Map<string, RoomFunction>();

  // Not a Room API function: it reads a file on this machine and uploads it for an attachment.
  const uploadTool: Tool = {
    name: UPLOAD_TOOL,
    description:
      "Upload a file from this machine to attach to a message. Returns { uploadId, storageId, name }; pass that object in messages_post (or messages_edit addAttachments) attachments. Images (PNG, JPEG, GIF, WebP) up to 20 MB and PDFs up to 50 MB show in the app; other files up to 50 MB are offered as downloads; SVG is refused.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file's path on this machine" },
        name: { type: "string", description: "The name to show (default: the file's own name)" },
        contentType: { type: "string", description: "The content type (default: from the extension)" },
        teamId: teamIdProperty(""),
      },
      required: ["path"],
    },
  };

  // Not a Room API function: terminals.input, then terminals.read until the output is complete.
  const runTool: Tool = {
    name: RUN_TOOL,
    description: `Run one command in a terminal you drive (one runs_start opened with harness "shell") and get what it printed, as plain text. Shells you open run with NO_COLOR=1, so a test runner's diff reads correctly. "exit 0" ends the shell, and the result has the run's state. It types the command and a newline, then waits until the terminal ends, the shell shows its prompt again, its output has been quiet for idleMs, or waitMs passes; stopped says which, and finished is true for the first two. It reads at most 50,000 characters of output per call: past that it stops with stopped "limit" and truncated, and waitMs holds however fast the command prints. When finished is false the command may still be running: read the rest with terminals_read {terminalId, afterSeq: cursor, afterOffset: cursorOffset}, as hint says. gap is true when output was dropped before it could be read. Needs the room.read and terminals.drive scopes.`,
    inputSchema: {
      type: "object",
      properties: {
        terminalId: { type: "string", description: "A terminalId, from runs_start or terminals_list" },
        command: { type: "string", description: "One command line, such as npm test" },
        waitMs: { type: "number", description: "The longest to wait, in ms (default 30000, at most 600000)" },
        idleMs: { type: "number", description: "Stop once the output has been quiet this long, in ms (default 2000)" },
        teamId: teamIdProperty("; in several teams it's found from the terminal"),
      },
      required: ["terminalId", "command"],
    },
    annotations: { readOnlyHint: false },
  };

  // Not a Room API function: terminals.read until the terminal ends.
  const waitTool: Tool = {
    name: WAIT_TOOL,
    description: `Wait for a terminal to end, such as one runs_start opened with a command, and get everything it printed, as plain text, with its exitCode and the run's state. It reads until the terminal ends, waitMs passes (default 60000, at most 600000) or it has read 50,000 characters of output; stopped is "ended", "timeout" or "limit" (truncated: read the rest from cursor and cursorOffset), and finished is true once it ended. An interactive shell ends only when you type exit, so use ${RUN_TOOL} for those. Needs the room.read scope.`,
    inputSchema: {
      type: "object",
      properties: {
        terminalId: { type: "string", description: "A terminalId, from runs_start or terminals_list" },
        waitMs: { type: "number", description: "The longest to wait, in ms (default 60000, at most 600000)" },
        afterSeq: { type: "number", description: "Read only what came after this cursor (default: all of it)" },
        afterOffset: { type: "number", description: "With afterSeq, the cursorOffset an earlier result returned" },
        teamId: teamIdProperty("; in several teams it's found from the terminal"),
      },
      required: ["terminalId"],
    },
    annotations: { readOnlyHint: true },
  };

  // Not a Room API function: runs.changes until a run you follow changes state.
  const runsWaitTool: Tool = {
    name: RUNS_WAIT_TOOL,
    description: `Wait until a run you follow changes state: the runs you drive or started, or those you name in runIds. It returns once one changes, with changes (each run as runs_get shows it, oldest change first) and cursor, or at waitMs (default 50000, at most 600000) with stopped "timeout"; wait again from cursor to keep waiting. Pass cursor as after next time, so a change that happened between two waits is never missed; without after, it waits from now. Use it to follow several runs at once instead of asking about each. Needs the room.read scope.`,
    inputSchema: {
      type: "object",
      properties: {
        after: { type: "number", description: "The cursor an earlier result returned (default: from now)" },
        runIds: { type: "array", items: { type: "string" }, description: "Follow these runs (at most 50) instead of the ones you drive or started" },
        waitMs: { type: "number", description: "The longest to wait, in ms (default 50000, at most 600000). Keep it under your MCP client's request timeout" },
        teamId: teamIdProperty(""),
      },
    },
    annotations: { readOnlyHint: true },
  };

  async function refresh(): Promise<RoomFunction[]> {
    const { functions } = await client.functions();
    // Run functions take a joined run's own token, which this server doesn't hold.
    const shown = functions.filter((f) => listed(f.name) && f.realm !== "run");
    known = new Map(shown.map((f) => [toolName(f.name), f]));
    return shown;
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const [functions, scopes] = await Promise.all([refresh(), keyScopes(client)]);
    // A tool this key can't use says so, so an agent knows before it calls (the room still checks).
    const tools = functions.map(
      (f) => roomTool(f, scopes?.lacks.has(f.scope) ? { addedBy: scopes.addedBy } : undefined) as Tool,
    );
    return { tools: [...tools, uploadTool, runTool, waitTool, runsWaitTool] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const name = request.params.name;
    if (name === UPLOAD_TOOL) return uploadFile(client, request.params.arguments ?? {});
    try {
      if (name === RUN_TOOL) {
        const args = request.params.arguments ?? {};
        if (typeof args.terminalId !== "string" || typeof args.command !== "string") {
          return toolError("invalid: Pass terminalId (from runs_start) and command.");
        }
        const result = await runInTerminal(client, {
          terminalId: args.terminalId,
          command: args.command,
          ...(typeof args.teamId === "string" && args.teamId ? { teamId: args.teamId } : {}),
          ...(typeof args.waitMs === "number" ? { waitMs: args.waitMs } : {}),
          ...(typeof args.idleMs === "number" ? { idleMs: args.idleMs } : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (name === WAIT_TOOL) {
        const args = request.params.arguments ?? {};
        if (typeof args.terminalId !== "string") return toolError("invalid: Pass terminalId (from runs_start).");
        const result = await waitForTerminal(client, {
          terminalId: args.terminalId,
          ...(typeof args.teamId === "string" && args.teamId ? { teamId: args.teamId } : {}),
          ...(typeof args.waitMs === "number" ? { waitMs: args.waitMs } : {}),
          ...(typeof args.afterSeq === "number" ? { afterSeq: args.afterSeq } : {}),
          ...(typeof args.afterOffset === "number" ? { afterOffset: args.afterOffset } : {}),
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (name === RUNS_WAIT_TOOL) {
        const args = request.params.arguments ?? {};
        const runIds = Array.isArray(args.runIds) ? args.runIds.filter((id): id is string => typeof id === "string") : undefined;
        const result = await waitForRuns(client, {
          ...(typeof args.after === "number" ? { after: args.after } : {}),
          ...(runIds ? { runIds } : {}),
          ...(typeof args.teamId === "string" && args.teamId ? { teamId: args.teamId } : {}),
          ...(typeof args.waitMs === "number" ? { waitMs: args.waitMs } : {}),
          signal: extra.signal,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
      if (!known.has(name)) await refresh();
      const fn = known.get(name);
      if (!fn) return toolError(`not_found: No Room API function is exposed as the tool ${name}.`);
      const result = await client.call(fn.name, request.params.arguments ?? {});
      // A function that returns nothing succeeded; "null" alone reads like a failure.
      const text = result === null ? "ok" : JSON.stringify(result, null, 2);
      return { content: [{ type: "text", text }] };
    } catch (error) {
      if (error instanceof RoomApiError) return toolError(`${error.code}: ${error.message}`);
      return toolError(error instanceof Error ? error.message : String(error));
    }
  });

  return server;
}

/**
 * Where the server connects and with what: UPLINK_URL and UPLINK_AGENT_KEY, else what `uplink
 * login` saved in `$UPLINK_HOME/cli.json` (an agent key or a person's CLI sign-in).
 */
export async function mcpConfig(env: Env): Promise<{ url?: string; key?: string }> {
  const { url, key } = await roomCredentials(env);
  return { ...(url ? { url } : {}), ...(key ? { key } : {}) };
}

/** Finds its address and credential (mcpConfig), then serves MCP on stdin and stdout. */
export async function runStdio(env: Env = process.env, argv: string[] = process.argv.slice(2)): Promise<void> {
  let config: { url?: string; key?: string };
  try {
    config = await mcpConfig(env);
  } catch (error) {
    process.stderr.write(`uplink-mcp: ${(error as Error).message}\n`);
    process.exitCode = 1;
    return;
  }
  const { url, key } = config;
  if (!url || !key) {
    process.stderr.write(
      BUILT_IN_URL
        ? "uplink-mcp needs a sign-in: run `uplink login` in a terminal, or set UPLINK_AGENT_KEY.\n"
        : "uplink-mcp needs UPLINK_URL (the Convex site URL) and UPLINK_AGENT_KEY, or a sign-in saved by `uplink login`.\n",
    );
    process.exitCode = 1;
    return;
  }
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const channel = argv.includes("--channel") || env.UPLINK_MCP_CHANNEL === "1";
  const server = createRoomMcpServer(new RoomClient({ url, key }), { tools: env.UPLINK_MCP_TOOLS, channel });
  await server.connect(new StdioServerTransport());
  if (channel) {
    const stop = startChannel(server, env);
    server.onclose = stop;
    process.once("exit", stop);
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // Inside the desktop app this runs on Electron as Node (resources/bin/uplink-mcp); nothing it starts inherits that.
  if (process.versions.electron) delete process.env["ELECTRON_RUN_AS_NODE"];
  // The MCP client that read stdout is gone, so this server has nobody left to answer (closedOutput.ts).
  onClosedOutput(() => process.exit());
  await runStdio();
}
