/**
 * A joined Claude Code session hearing through a channel (ADR 0027, ADR 0032): `uplink-mcp --channel`
 * declares `capabilities.experimental['claude/channel']`, and once its session has joined with
 * `uplink join` (which uses the channel when this server announced itself and Claude Code was started
 * with `--dangerously-load-development-channels`, or with `uplink join --channel`), it pushes each
 * waiting message as `notifications/claude/channel` {content, meta} (code.claude.com/docs/en/channels-reference).
 * During the research preview Claude Code drops a custom channel's notifications silently without
 * that flag (#138 test 5), which is why hooks are the default.
 *
 * The server knows its session by CLAUDE_CODE_SESSION_ID, which Claude Code sets for stdio MCP
 * servers (code.claude.com/docs/en/env-vars), and acts with the joined run's token only.
 */
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { RoomApiError, RoomClient } from "./client.ts";
import type { Env } from "./config.ts";
import { announceChannel, forgetChannel, readJoined, sessionKey, startedFromHarness, type JoinedSession } from "./joined.ts";
import { drainer, type Step } from "@uplink-room/protocol/drain";
import { runClient, runEnded, settleTaken, take, type RunIo } from "./joinedRun.ts";
import { ancestors } from "./processes.ts";
import { formatDeliveries } from "./runMessages.ts";

/** What the session reads when this server connects (MCP `instructions`), beside the room's own. */
export const CHANNEL_INSTRUCTIONS =
  'Messages from Uplink Room arrive as <channel source="uplink-room"> events once this session joins the room with `uplink join --team <team>`. Each is labelled with who sent it and the person accountable for it; whether to act on one is this session\'s decision. Answer with `uplink reply <message id> "text"`.';

/** How often the server looks for its session's join. */
const LOOK_MS = 2000;

export type ChannelIo = RunIo & {
  watch?: (client: RoomClient, onUpdate: (waiting: number) => void, onError: (error: RoomApiError) => void) => () => void;
};

/**
 * Starts pushing the session's messages through `server`. Returns a function that stops it. Without
 * CLAUDE_CODE_SESSION_ID (not a Claude Code session) it does nothing.
 */
export function startChannel(server: Server, env: Env, io: ChannelIo = {}): () => void {
  const sessionRef = env.CLAUDE_CODE_SESSION_ID;
  if (!sessionRef) return () => {};
  const key = sessionKey("claude-code", sessionRef);
  let stopped = false;
  let joined: JoinedSession | undefined;
  let unwatch: (() => void) | undefined;
  // The client the watch runs on: its live connection stays open until it is closed.
  let watching: RoomClient | undefined;
  void announceChannel(env, sessionRef, process.pid).catch(() => {});

  /**
   * One push: one take, sent as a notification. "more" while a take leaves some waiting (more than
   * 20), "retry" when the room can't be reached or the notification can't be sent (they were put
   * back), so a burst or a short failure doesn't wait for the count to change again.
   */
  const pushStep = async (): Promise<Step> => {
    const session = joined;
    if (!session || stopped) return "done";
    const taken = await take(session, "next_turn", io);
    if (taken === "ended") {
      stopWatching();
      return "done";
    }
    if (taken === "failed") return "retry";
    if (!taken) return "done";
    try {
      await server.notification({
        method: "notifications/claude/channel",
        params: { content: formatDeliveries(taken.messages), meta: { message_ids: taken.messages.map((m) => m.messageId).join(","), run: session.label } },
      } as never);
    } catch {
      // Claude Code's end of the connection is gone: they wait again.
      await settleTaken(session, taken.claimId, "release", io);
      return "retry";
    }
    await settleTaken(session, taken.claimId, "ack", io);
    return taken.waiting > 0 ? "more" : "done";
  };
  const pushes = drainer(pushStep, io.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.())));

  const stopWatching = () => {
    unwatch?.();
    unwatch = undefined;
    void watching?.close().catch(() => {});
    watching = undefined;
    joined = undefined;
  };

  const look = async () => {
    if (stopped) return;
    const found = await readJoined(env, key);
    // Only a server the session's own Claude Code started pushes its messages: anything else can
    // set CLAUDE_CODE_SESSION_ID too (joined.ts, startedFromHarness).
    if (found?.via === "channel" && found.token !== joined?.token && (await startedFromHarness(found, io.parents ?? (() => ancestors())))) {
      stopWatching();
      joined = found;
      const client = runClient(found, io);
      watching = client;
      const watch =
        io.watch ??
        ((c: RoomClient, onUpdate: (n: number) => void, onError: (e: RoomApiError) => void) =>
          c.watch("joined.waiting", {}, (result) => onUpdate((result as { waiting: number }).waiting), onError));
      unwatch = watch(
        client,
        (waiting) => {
          if (waiting > 0) pushes.kick();
        },
        (error) => {
          if (runEnded(error)) stopWatching();
        },
      );
    } else if (!found && joined) {
      stopWatching();
    }
  };

  void look();
  const timer = setInterval(() => void look(), LOOK_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    pushes.stop();
    clearInterval(timer);
    stopWatching();
    void forgetChannel(env, sessionRef).catch(() => {});
  };
}
