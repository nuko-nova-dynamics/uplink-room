/**
 * A run on a bridge machine posting as itself (ADR 0026, slices 5 and 6 of #139): `uplink-bridge say`
 * and `uplink-bridge reply` reach `bridge:runSay` with the bridge's own token, so the agent never
 * holds a room key. The bridge names the terminal, or the T3 Code thread whose run key the command
 * gave (ADR 0037); the room finds its live run and posts as the run's driver with `asRun` (ADR 0029
 * D2), through the same checks as `messages.post`, so the run can't post where its driver can't
 * (ADR 0016). A run sends files the same way (ADR 0047): the bridge uploads each to a URL from
 * `bridge:runAttachUrl`, an upload of the run's driver, and names them in `bridge:runSay`, which keeps
 * them through `messages.post`'s checks.
 */
import { RUN_SAY_TEXT_MAX, type RunAttachTarget, type RunRef, type RunSaid, type RunSay } from "@uplink-room/protocol";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { postMessage } from "../messages";
import { accountableId, hasScope, type Actor } from "./actor";
import type { NewAttachment } from "./attachments";
import { canSee, channelAccess, isDirect, messageAccess } from "./channels";
import { roomError } from "./errors";
import { audit } from "./members";
import { agentSender } from "./router";
import { machineRun, placeOf } from "./runDelivery";
import { isLiveRun, runLabel } from "./runLabels";
import { isLive } from "./terminals";

/** At most this many of a team's channels are read to find one by name. */
const CHANNEL_SCAN = 1000;

/** The run's driver as the one who posts: a person as themselves, an agent with its keys' scopes. */
async function driverActor(ctx: QueryCtx, driver: Doc<"members">): Promise<Actor | null> {
  if (driver.removedAt !== undefined) return null;
  if (driver.kind === "agent") return agentSender(ctx, driver);
  return { kind: "person", teamId: driver.teamId, member: driver, role: driver.role, scopes: "all" };
}

/** A place a run names: a channel id, or a channel's name with or without `#`, that its driver can see. */
async function placeFor(ctx: QueryCtx, actor: Actor, place: string): Promise<Doc<"channels">> {
  const raw = place.trim();
  const id = ctx.db.normalizeId("channels", raw);
  if (id) return channelAccess(ctx, actor, id);
  const name = raw.replace(/^#/, "").trim().toLowerCase();
  const channels = await ctx.db
    .query("channels")
    .withIndex("by_team", (q) => q.eq("teamId", actor.teamId))
    .take(CHANNEL_SCAN);
  for (const channel of channels) {
    if (isDirect(channel) || channel.archivedAt !== undefined || channel.name.toLowerCase() !== name) continue;
    if (await canSee(ctx, actor, channel)) return channel;
  }
  throw roomError("not_found", `No channel named #${name} that ${actor.member.name} can see. Name a channel, such as #general, or give a channel id.`);
}

/** A run's posting arguments with its files' ids checked by the mutation's validator. */
export type RunSayArgs = RunRef & Pick<RunSay, "text" | "in" | "replyTo"> & { attachments?: NewAttachment[] };

/** The live run in one of this machine's terminals or T3 Code threads, and its driver acting for it. */
async function postingRun(ctx: MutationCtx, machine: Doc<"machines">, ref: RunRef) {
  const found = await machineRun(ctx, machine, ref.terminalRef !== undefined ? { terminalRef: ref.terminalRef } : { threadRef: ref.threadRef });
  const run = found?.run;
  if (!found || (found.terminal && !isLive(found.terminal)) || !run || !(await isLiveRun(ctx, run))) {
    const where = ref.terminalRef !== undefined ? "terminal" : "thread";
    throw roomError("not_found", `This ${where} has no live run in the room, so it can't post as one.`);
  }
  const driver = await ctx.db.get(run.driverId!);
  const actor = driver ? await driverActor(ctx, driver) : null;
  if (!driver || !actor) throw roomError("forbidden", "This run's driver is no longer in the team, so the run can't post.");
  if (!hasScope(actor, "messages.post")) throw roomError("forbidden", `${driver.name}, the agent driving this run, has no key that may post messages.`);
  return { run, driver, actor };
}

/**
 * A URL for one file the run sends with its next message (ADR 0047): an upload of its driver's, as
 * `messages.attachUrl` gives the driver, since the run posts as its driver (ADR 0029 D2).
 */
export async function runAttachUrl(ctx: MutationCtx, machine: Doc<"machines">, ref: RunRef): Promise<RunAttachTarget & { uploadId: Id<"uploads"> }> {
  const { actor } = await postingRun(ctx, machine, ref);
  const uploadId = await ctx.db.insert("uploads", { teamId: actor.teamId, uploaderId: actor.member._id });
  return { uploadUrl: await ctx.storage.generateUploadUrl(), uploadId };
}

/** Posts for the live run in one of this machine's terminals or T3 Code threads, with any files it sends. */
export async function runSays(ctx: MutationCtx, machine: Doc<"machines">, args: RunSayArgs): Promise<RunSaid> {
  const text = args.text.trim();
  const attachments = args.attachments ?? [];
  if (!text && !attachments.length) throw roomError("invalid", "A message needs text or a file.");
  if (text.length > RUN_SAY_TEXT_MAX) throw roomError("invalid", `A message can be at most ${RUN_SAY_TEXT_MAX} characters.`);
  if (!args.in?.trim() === !args.replyTo?.trim()) {
    throw roomError("invalid", 'Say where: uplink-bridge say --in "#place" "text" posts in a place, and uplink-bridge reply <messageId> "text" answers a message.');
  }
  const { run, driver, actor } = await postingRun(ctx, machine, args);

  let channel: Doc<"channels">;
  let replyTo: Doc<"messages">["_id"] | undefined;
  if (args.replyTo?.trim()) {
    const id = ctx.db.normalizeId("messages", args.replyTo.trim());
    if (!id) throw roomError("not_found", "Not found in this team.");
    ({ channel } = await messageAccess(ctx, actor, id));
    replyTo = id;
  } else {
    channel = await placeFor(ctx, actor, args.in!);
  }
  const label = await runLabel(ctx, run);
  const messageId = await postMessage(
    ctx,
    actor,
    { channelId: channel._id, body: text, ...(replyTo ? { replyTo } : {}), ...(attachments.length ? { attachments } : {}) },
    { runId: run._id, label },
  );
  await audit(ctx, actor, "run.said", run._id, {
    messageId,
    label,
    driverId: driver._id,
    accountableId: accountableId(actor),
    ...(attachments.length ? { files: attachments.length } : {}),
  });
  return { messageId, label, place: placeOf(channel, { replyTo }) };
}
