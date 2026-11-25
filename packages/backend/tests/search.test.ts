/**
 * Message search (spec #63): every channel and direct message you can see, with filters, and
 * never a direct message you aren't in, even when it is the best match.
 */
import { expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { addAgent, addTeammate, callAsAgent, newRoom, newTeam, type Person, present } from "./setup";

async function team() {
  const t = newRoom();
  const { teamId, admin: julio } = await newTeam(t);
  const ana = await addTeammate(t, teamId, julio, "Ana");
  const ben = await addTeammate(t, teamId, julio, "Ben");
  const [general] = await julio.as.query(api.channels.list, { teamId });
  const ops = await julio.as.mutation(api.channels.create, { teamId, name: "ops" });
  return { t, teamId, julio, ana, ben, general: general!.channelId, ops };
}

test("search finds a word across channels, honours each filter, and never shows a DM you aren't in or a deleted message", async () => {
  const { t, teamId, julio, ana, ben, general, ops } = await team();
  const post = (who: Person, channelId: Id<"channels">, body: string, extra = {}) =>
    who.as.mutation(api.messages.post, { teamId, channelId, body, ...extra });

  const dm = (await julio.as.mutation(api.channels.openDirect, { teamId, memberIds: [ana.memberId] })).channelId;
  const secret = await post(julio, dm, "rollback rollback rollback the staging database");
  const inGeneral = await post(ana, general, "the rollback plan is in the doc");
  const inOps = await post(ben, ops, "rollback finished, see https://status.example.com");
  const deleted = await post(ben, ops, "rollback attempt two");
  await ben.as.mutation(api.messages.delete, { teamId, messageId: deleted });
  await post(ben, general, "unrelated chatter");

  const ids = async (who: Person, args: Record<string, unknown>) =>
    (await who.as.query(api.messages.search, { teamId, query: "rollback", ...args })).results.map((r) => r.messageId);

  expect(new Set(await ids(ben, {}))).toEqual(new Set([inGeneral, inOps]));
  expect(new Set(await ids(ana, {}))).toEqual(new Set([secret, inGeneral, inOps]));
  expect(await ids(ben, { channelId: ops })).toEqual([inOps]);
  expect(await ids(ben, { authorId: ana.memberId })).toEqual([inGeneral]);
  expect(await ids(ben, { has: "link" })).toEqual([inOps]);
  await expect(ben.as.query(api.messages.search, { teamId, query: "rollback", channelId: dm })).rejects.toThrow(/Not found/);
  await expect(ben.as.query(api.messages.search, { teamId, query: "  " })).rejects.toThrow(/at least one word/);

  const results = (await ana.as.query(api.messages.search, { teamId, query: "staging" })).results;
  expect(results).toMatchObject([{ messageId: secret, channel: { kind: "direct" } }]);

  // Dates.
  const after = present(await ana.as.query(api.messages.get, { teamId, messageId: inGeneral })).postedAt;
  expect(new Set(await ids(ben, { from: after }))).toEqual(new Set([inGeneral, inOps]));
  expect(await ids(ben, { to: after - 1 })).toEqual([]);

  // An agent searches with the same rules.
  const { key } = await addAgent(t, teamId, ben, "Scribe", ["room.read"]);
  const found = await callAsAgent(t, key, "messages.search", { query: "rollback" });
  expect(new Set((found.result.results as { messageId: string }[]).map((r) => r.messageId))).toEqual(new Set([inGeneral, inOps]));
});

test("search pages on past the direct messages it has to leave out", async () => {
  const { teamId, julio, ana, ben, general } = await team();
  const dm = (await julio.as.mutation(api.channels.openDirect, { teamId, memberIds: [ana.memberId] })).channelId;
  for (let i = 0; i < 30; i++) await julio.as.mutation(api.messages.post, { teamId, channelId: dm, body: `deploy secret ${i}` });
  const open: string[] = [];
  for (let i = 0; i < 7; i++) open.push(await ana.as.mutation(api.messages.post, { teamId, channelId: general, body: `deploy note ${i}` }));

  const seen: string[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 10; pages++) {
    const page: { results: { messageId: string }[]; cursor: string | null; isDone: boolean } = await ben.as.query(
      api.messages.search,
      { teamId, query: "deploy", cursor, limit: 3 },
    );
    seen.push(...page.results.map((r) => r.messageId));
    if (page.isDone) break;
    cursor = page.cursor;
  }
  expect(new Set(seen)).toEqual(new Set(open));
  expect(seen).toHaveLength(7);
});
