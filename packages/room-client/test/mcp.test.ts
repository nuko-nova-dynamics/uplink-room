import { api } from "@uplink-room/backend/api";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { RoomClient } from "../src/client.ts";
import { main } from "../src/cli.ts";
import { createRoomMcpServer, mcpConfig, RUN_TOOL, toolName, UPLOAD_TOOL, WAIT_TOOL } from "../src/mcp.ts";
import { bridgeSays, browserFor, fetchTo, fetchToRoomAndClerk, newBackend, newTeamWithAgent, personInTwoTeams, SITE_URL, tempDir, useFakeClerk } from "./support.ts";

async function connect(t: ReturnType<typeof newBackend>, key: string, tools?: string) {
  const server = createRoomMcpServer(new RoomClient({ url: SITE_URL, key, fetch: fetchTo(t) }), { tools });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

test("the MCP server lists a tool per function and returns the function's result", async () => {
  const t = newBackend();
  const { admin, teamId, key } = await newTeamWithAgent(t);
  const client = await connect(t, key);

  const { tools } = await client.listTools();
  const post = tools.find((tool) => tool.name === "messages_post");
  expect(toolName("tasks.create")).toBe("tasks_create");
  expect(post?.inputSchema.properties).toHaveProperty("channelId");
  expect(tools.every((tool) => !tool.name.includes("."))).toBe(true);

  const result = await client.callTool({ name: "channels_list", arguments: {} });
  const fromApp = await admin.query(api.channels.list, { teamId });
  expect(result.isError).toBeFalsy();
  expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual(
    JSON.parse(JSON.stringify(fromApp)),
  );
});

test("a Room API error becomes a tool error with the code and message", async () => {
  const t = newBackend();
  // A key without the messages.post scope.
  const { key, generalId } = await newTeamWithAgent(t, ["room.read"]);
  const client = await connect(t, key);

  const result = await client.callTool({
    name: "messages_post",
    arguments: { channelId: generalId, body: "hello" },
  });
  expect(result.isError).toBe(true);
  expect((result.content as { text: string }[])[0]!.text).toMatch(/^forbidden: /);
});

test("agents get the chat functions as tools, and upload_attachment attaches a local file", async () => {
  const t = newBackend();
  const { admin, teamId, key, generalId } = await newTeamWithAgent(t);
  const client = await connect(t, key);
  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  for (const fn of [
    "messages_edit",
    "messages_delete",
    "messages_react",
    "messages_unreact",
    "messages_around",
    "messages_search",
    "messages_pin",
    "messages_unpin",
    "messages_hidePreview",
    "messages_attachUrl",
    "messages_addressed",
    "channels_openDirect",
    "channels_createPrivate",
    "channels_addMembers",
    "channels_removeMember",
    "channels_leave",
    "channels_members",
    "messages_attachmentLink",
    "channels_markRead",
    "channels_setNotify",
    "channels_pins",
    "files_saveAttachment",
    UPLOAD_TOOL,
  ]) {
    expect(names).toContain(fn);
  }

  const dir = await tempDir("uplink-mcp-");
  const file = join(dir, "shot.png");
  await writeFile(file, "png bytes");
  const uploaded = await client.callTool({ name: UPLOAD_TOOL, arguments: { path: file } });
  expect(uploaded.isError).toBeFalsy();
  const attachment = JSON.parse((uploaded.content as { text: string }[])[0]!.text);
  const posted = await client.callTool({
    name: "messages_post",
    arguments: { channelId: generalId, body: "Here's the screen", attachments: [attachment] },
  });
  expect(posted.isError).toBeFalsy();
  const messageId = JSON.parse((posted.content as { text: string }[])[0]!.text);
  const message = await admin.query(api.messages.get, { teamId, messageId });
  expect(message?.attachments).toMatchObject([{ name: "shot.png", kind: "image", contentType: "image/png" }]);

  const reacted = await client.callTool({ name: "messages_react", arguments: { messageId, emoji: "👀" } });
  expect(reacted.isError).toBeFalsy();
  expect((await admin.query(api.messages.get, { teamId, messageId }))?.reactions).toMatchObject([{ emoji: "👀", count: 1 }]);
});

test("the server tells an agent where to start, and a function that returns nothing answers ok", async () => {
  const t = newBackend();
  const { key, generalId } = await newTeamWithAgent(t);
  const client = await connect(t, key);
  expect(client.getInstructions()).toMatch(/^Uplink Room is your team's shared workspace/);
  expect(client.getInstructions()).toContain("Start with members_me");

  const { tools } = await client.listTools();
  expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["members_me", "terminals_read", RUN_TOOL, WAIT_TOOL]));
  const marked = await client.callTool({ name: "channels_markRead", arguments: { channelId: generalId } });
  expect(marked.isError).toBeFalsy();
  const me = await client.callTool({ name: "members_me", arguments: {} });
  expect(JSON.parse((me.content as { text: string }[])[0]!.text)).toMatchObject({ name: "Deploy bot", kind: "agent" });

  const missing = await client.callTool({ name: RUN_TOOL, arguments: { command: "ls" } });
  expect(missing.isError).toBe(true);
  expect((missing.content as { text: string }[])[0]!.text).toMatch(/^invalid: Pass terminalId/);
});

test("a tool the key lacks the scope for says so, and UPLINK_MCP_TOOLS narrows the list", async () => {
  const t = newBackend();
  const { key } = await newTeamWithAgent(t, ["room.read"]);
  const { tools } = await (await connect(t, key)).listTools();
  expect(tools.find((tool) => tool.name === "messages_post")?.description).toMatch(
    /\(scope: messages\.post; your key lacks it, and Julio, who added you, can add it\)$/,
  );
  expect(tools.find((tool) => tool.name === "channels_list")?.description).toMatch(/\(scope: room\.read\)$/);

  const narrow = await (await connect(t, key, "tasks, members.me")).listTools();
  const names = narrow.tools.map((tool) => tool.name);
  expect(names).toEqual(expect.arrayContaining(["tasks_board", "tasks_create", "members_me", UPLOAD_TOOL, RUN_TOOL, WAIT_TOOL]));
  expect(names).not.toContain("messages_post");
  expect(names).not.toContain("members_remove");
});

test("with a person's CLI sign-in, the MCP server acts as that person, in their team and at the account level", async () => {
  const t = newBackend();
  const { admin, teamId } = await newTeamWithAgent(t);
  const clerk = await useFakeClerk();
  const home = await tempDir("uplink-mcp-");
  await main(["login", "--url", SITE_URL], {
    fetch: fetchToRoomAndClerk(t, clerk),
    stdout: () => {},
    stderr: () => {},
    env: { UPLINK_HOME: home },
    openBrowser: browserFor(clerk, { subject: "user_julio", name: "Julio", email: "julio@example.com" }).open,
  });

  // uplink-mcp finds the sign-in `uplink login` saved, as it finds an agent key in UPLINK_AGENT_KEY.
  const config = await mcpConfig({ UPLINK_HOME: home });
  expect(config).toEqual({ url: SITE_URL, key: expect.stringMatching(/^urs_/) });
  const server = createRoomMcpServer(new RoomClient({ url: config.url!, key: config.key!, fetch: fetchTo(t) }));
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  expect(client.getInstructions()).toMatch(/^Uplink Room is a shared workspace\. You act as the person signed in on this computer/);
  const { tools } = await client.listTools();
  const me = tools.find((tool) => tool.name === "people_me")!;
  expect(me.description).toMatch(/\(account: for the signed-in person, in no team\)$/);
  expect(Object.keys(me.inputSchema.properties ?? {})).not.toContain("teamId");

  const who = await client.callTool({ name: "people_me", arguments: {} });
  expect(JSON.parse((who.content as { text: string }[])[0]!.text)).toMatchObject({ name: "Julio", teams: [{ teamId, name: "Nuko Nova" }] });
  const channels = await client.callTool({ name: "channels_list", arguments: {} });
  expect(JSON.parse((channels.content as { text: string }[])[0]!.text)).toEqual(JSON.parse(JSON.stringify(await admin.query(api.channels.list, { teamId }))));
});

test("uplink-mcp takes UPLINK_URL and UPLINK_AGENT_KEY over what was saved", async () => {
  const home = await tempDir("uplink-mcp-");
  await writeFile(join(home, "cli.json"), JSON.stringify({ url: "http://saved.test", signIn: "urs_saved" }));
  expect(await mcpConfig({ UPLINK_HOME: home, UPLINK_URL: "http://env.test", UPLINK_AGENT_KEY: "urk_env" })).toEqual({ url: "http://env.test", key: "urk_env" });
  expect(await mcpConfig({ UPLINK_HOME: await tempDir("uplink-mcp-") })).toEqual({});
});

test("a saved sign-in or agent key is used only with the deployment it was saved for", async () => {
  const home = await tempDir("uplink-mcp-");
  await writeFile(join(home, "cli.json"), JSON.stringify({ url: "https://a.test", signIn: "urs_a" }));
  // The same origin, written differently, still uses it.
  expect(await mcpConfig({ UPLINK_HOME: home, UPLINK_URL: "https://a.test/" })).toEqual({ url: "https://a.test/", key: "urs_a" });
  // Another deployment never gets it: uplink-mcp refuses and says how to sign in there.
  await expect(mcpConfig({ UPLINK_HOME: home, UPLINK_URL: "https://b.test" })).rejects.toThrow(
    /saved for https:\/\/a\.test, not https:\/\/b\.test.*uplink login --url https:\/\/b\.test/s,
  );
  await writeFile(join(home, "cli.json"), JSON.stringify({ url: "https://a.test", key: "urk_a" }));
  await expect(mcpConfig({ UPLINK_HOME: home, UPLINK_URL: "https://b.test" })).rejects.toThrow(/saved for https:\/\/a\.test/);
  // A key given for the other deployment is used, and the saved one isn't.
  expect(await mcpConfig({ UPLINK_HOME: home, UPLINK_URL: "https://b.test", UPLINK_AGENT_KEY: "urk_b" })).toEqual({ url: "https://b.test", key: "urk_b" });
});

test("a person in two teams uses run_in_terminal, wait_for_terminal and upload_attachment in their second team", async () => {
  const t = newBackend();
  const { sideTeamId, bridgeToken: token, machineId, signIn, home } = await personInTwoTeams(t);
  const client = await connect(t, signIn);
  const text = (result: Awaited<ReturnType<typeof client.callTool>>) => (result.content as { text: string }[])[0]!.text;

  const { tools } = await client.listTools();
  for (const name of [RUN_TOOL, WAIT_TOOL, UPLOAD_TOOL]) {
    expect(Object.keys(tools.find((tool) => tool.name === name)!.inputSchema.properties ?? {})).toContain("teamId");
  }

  const started = await client.callTool({ name: "runs_start", arguments: { teamId: sideTeamId, machineId, harness: "shell", command: "echo hi" } });
  const { terminalId } = JSON.parse(text(started)) as { terminalId: string };
  await bridgeSays(t, token, { type: "terminal_started", terminalId, localRef: "pty-1", title: "Terminal", tool: "shell", access: "watch" });
  await bridgeSays(t, token, { type: "terminal_output", terminalId, seq: 1, data: "hi\r\n" });
  await bridgeSays(t, token, { type: "terminal_ended", terminalId, reason: "exited", exitCode: 0 });

  // The terminal's team is found from it; teamId may also be named.
  const waited = await client.callTool({ name: WAIT_TOOL, arguments: { terminalId } });
  expect(waited.isError).toBeFalsy();
  expect(JSON.parse(text(waited))).toMatchObject({ text: "hi\n", stopped: "ended", exitCode: 0 });
  const ran = await client.callTool({ name: RUN_TOOL, arguments: { terminalId, teamId: sideTeamId, command: "ls" } });
  expect(text(ran)).toMatch(/^invalid: This terminal has ended/);

  const file = join(home, "notes.txt");
  await writeFile(file, "notes");
  const unsaid = await client.callTool({ name: UPLOAD_TOOL, arguments: { path: file } });
  expect(text(unsaid)).toMatch(/^invalid: You're in 2 teams: pass teamId/);
  const uploaded = await client.callTool({ name: UPLOAD_TOOL, arguments: { path: file, teamId: sideTeamId } });
  expect(uploaded.isError).toBeFalsy();
  expect(JSON.parse(text(uploaded))).toMatchObject({ name: "notes.txt", uploadId: expect.any(String) });
});
