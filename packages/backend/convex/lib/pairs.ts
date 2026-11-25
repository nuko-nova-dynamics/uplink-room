/**
 * Pairs (ADR 0027, ADR 0029 D9 to D13, ADR 0034, GLOSSARY "Pair"): a private conversation of 2 to 10
 * joined runs and agents, plus their people, who may be in different teams or in none.
 *
 * - A run makes a pair code, such as RIVER-4821-MAPLE-0937 (`joined.pairCode`, `uplink pair`), and so can one of the pair's people
 *   (`pairs.code`). It works once, for 10 minutes; only its SHA-256 is kept. One more run joins with
 *   it (`joined.pairJoin`, `uplink pair <code>`), or an agent with its key (`pairs.join`, D11). Each
 *   person (an agent's: its accountable person) gets at most MAX_CODE_FAILURES wrong codes an hour.
 * - It belongs to its people (`pairPeople`): a run's person, and an agent's. A run that ends leaves
 *   it, and its person's next run can rejoin (`joined.pairResume`, `uplink pair --resume`). It lasts
 *   until one of them ends it (`pairs.end`).
 * - Every message reaches every other live run in it, through the run's inbox as a joined run's
 *   messages do (`pairInbox`, `joined.take`), and is unread for every person and agent in it until
 *   they read it: what ADR 0026 says a direct message's members hear.
 * - Each side sees only the pair: names, pictures and run labels (D12), under ids that exist only in
 *   the pair (a `pairPeople`, `pairRuns` or `pairAgents` row's), never an email, a team or anything in
 *   one. These tables are outside every team, and no team function reads them (D9).
 * - Deleting an account (ADR 0035: accounts.cleanUp runs `forgetPairsStep` and `forgetMessagesStep`
 *   when Clerk deletes one) takes the person's runs and agents out, keeps their messages as "A
 *   deleted account", and ends a pair left with fewer than two people.
 */
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import type { PaginationOptions, PaginationResult } from "convex/server";
import { internal } from "../_generated/api";
import { RUN_MESSAGE_TEXT_MAX } from "@uplink-room/protocol";
import type { PairActor } from "./actor";
import { sha256 } from "./crypto";
import { roomError, roomRefusal, type RoomRefusal } from "./errors";
import { harnessName } from "./harnesses";
import { MAX_WAITING } from "./runDelivery";
import { checkPairAttachments, keepPairAttachments, pairAttachmentsOf, pairAttachmentView, type NewPairAttachment } from "./pairAttachments";

/** How long a pair code works. */
export const PAIR_CODE_MS = 10 * 60_000;
/** At most this many live runs and agents in one pair. */
export const MAX_IN_PAIR = 10;
/**
 * At most this many people in one pair. People stay when their runs leave, so they are counted
 * apart from MAX_IN_PAIR, and a pair's roster reads all of them in one bounded read.
 */
export const MAX_PAIR_PEOPLE = 20;
/** Wrong pair codes one person may try in a window of CODE_FAILURE_WINDOW_MS. */
export const MAX_CODE_FAILURES = 10;
export const CODE_FAILURE_WINDOW_MS = 60 * 60_000;
/** The longest Pair message, in characters, as a joined run's post. */
export const PAIR_TEXT_MAX = 20_000;
/** At most this many of a person's pairs are listed without paging; the app pages through all of them. */
export const PAIRS_LISTED = 100;
/** At most this many live Pairs one person made (ADR 0036): ending one makes room for another. */
export const MAX_OPEN_PAIRS = 20;
/** At most this many Pairs one person makes in any CREATE_WINDOW_MS (ADR 0036). */
export const MAX_NEW_PAIRS = 10;
export const CREATE_WINDOW_MS = 60 * 60_000;
/** The most messages one read of a pair returns. */
export const PAIR_PAGE_MAX = 200;
/** The name a message keeps once its author's account is deleted (D10). */
export const DELETED_ACCOUNT = "A deleted account";
/** The name a Pair shows for a person whose name is an email address (D12). */
export const NAMELESS = "Someone";

/**
 * The words of a pair code: 256, so one random byte picks one evenly. A code is two words, each
 * followed by four random digits, so it is one of 256² × 10⁸, about 6.6 trillion (42.6 bits). At
 * MAX_CODE_FAILURES wrong codes an hour per person, guessing any one of a thousand live codes takes
 * one person about 75,000 years on average, and a thousand accounts working together about 75.
 */
export const PAIR_WORDS = [
  "ACORN", "AMBER", "ANCHOR", "APPLE", "APRIL", "ARCH", "ARROW", "ASPEN", "ATLAS", "AUTUMN", "BADGE", "BAMBOO", "BANJO", "BARLEY", "BASIN", "BEACON",
  "BEACH", "BERRY", "BIRCH", "BISON", "BLOOM", "BONSAI", "BRAVO", "BREEZE", "BRICK", "BRIDGE", "BROOK", "BUTTON", "CABIN", "CACTUS", "CAMEL", "CANDLE",
  "CANOE", "CANYON", "CARGO", "CEDAR", "CHALK", "CHERRY", "CHESS", "CIRCLE", "CITRUS", "CLIFF", "CLOUD", "CLOVER", "COBALT", "COCOA", "COMET", "CORAL",
  "COTTON", "CRANE", "CREEK", "CRICKET", "CRYSTAL", "CUBE", "DAISY", "DELTA", "DESERT", "DIAMOND", "DOLPHIN", "DRAGON", "DUNE", "EAGLE", "EARTH", "ECHO",
  "EMBER", "EMERALD", "FALCON", "FERN", "FIELD", "FIG", "FJORD", "FLAME", "FLINT", "FLUTE", "FOREST", "FOSSIL", "FOX", "FROST", "GALAXY", "GARDEN",
  "GARNET", "GECKO", "GINGER", "GLACIER", "GLOBE", "GOLD", "GRAPE", "GRAVEL", "GROVE", "HARBOR", "HAZEL", "HELIUM", "HERON", "HONEY", "HORIZON", "ICEBERG",
  "INDIGO", "IRIS", "IRON", "IVORY", "JADE", "JASMINE", "JAZZ", "JELLY", "JUNGLE", "JUNIPER", "KAYAK", "KELP", "KETTLE", "KIWI", "KOALA", "LAGOON",
  "LAKE", "LANTERN", "LARCH", "LAVA", "LEMON", "LILAC", "LILY", "LIME", "LINEN", "LION", "LOTUS", "LUNAR", "LYNX", "MAGNET", "MANGO", "MAPLE",
  "MARBLE", "MEADOW", "MELON", "MESA", "METEOR", "MINT", "MOON", "MOSS", "MOUNT", "NECTAR", "NEON", "NICKEL", "NOVA", "OAK", "OASIS", "OCEAN",
  "OLIVE", "ONYX", "OPAL", "ORBIT", "ORCHID", "OTTER", "OWL", "PANDA", "PAPER", "PARROT", "PEACH", "PEARL", "PEBBLE", "PEPPER", "PETAL", "PIANO",
  "PILOT", "PINE", "PIXEL", "PLANET", "PLUM", "POLAR", "POPPY", "PRAIRIE", "PRISM", "PUFFIN", "QUARTZ", "QUILL", "RADAR", "RAIN", "RAVEN", "REED",
  "RIDGE", "RIVER", "ROBIN", "ROCKET", "ROSE", "RUBY", "SAFFRON", "SAGE", "SALMON", "SAND", "SAPPHIRE", "SATURN", "SEAL", "SHELL", "SIERRA", "SILVER",
  "SKY", "SLATE", "SNOW", "SOLAR", "SONNET", "SPARK", "SPRUCE", "SQUID", "STAR", "STONE", "STORM", "SUMMIT", "SUN", "SWAN", "TANGO", "TEAL",
  "THUNDER", "TIDE", "TIGER", "TIMBER", "TOPAZ", "TORCH", "TULIP", "TUNDRA", "TURTLE", "VALLEY", "VELVET", "VIOLET", "VOLCANO", "WALNUT", "WAVE", "WHALE",
  "WILLOW", "WIND", "WINTER", "WOLF", "WREN", "YARROW", "ZEBRA", "ZENITH", "ZEPHYR", "ALPINE", "BASALT", "BLAZE", "CARBON", "CHIME", "CINDER", "COPPER",
  "CYPRESS", "DUSK", "FEATHER", "GRANITE", "HAVEN", "HOLLY", "JASPER", "LAUREL", "MAGMA", "MARSH", "NUTMEG", "PAPRIKA", "QUAIL", "ROWAN", "SPICE", "THISTLE",
] as const;

const WORD_SET = new Set<string>(PAIR_WORDS);

/** Eight random digits, evenly: a 32-bit draw at or above the last whole multiple of 10^8 is drawn again. */
function randomDigits(): string {
  const limit = Math.floor(2 ** 32 / 1e8) * 1e8;
  for (;;) {
    const [n] = crypto.getRandomValues(new Uint32Array(1));
    if (n! < limit) return String(n! % 1e8).padStart(8, "0");
  }
}

/** A new pair code, such as RIVER-4821-MAPLE-0937. */
export function newPairCode(): string {
  const [first, second] = crypto.getRandomValues(new Uint8Array(2));
  const digits = randomDigits();
  return `${PAIR_WORDS[first!]}-${digits.slice(0, 4)}-${PAIR_WORDS[second!]}-${digits.slice(4)}`;
}

/**
 * A code as typed, in its one written form, or null when it can't be one: in any case, with any
 * spaces or punctuation between its parts (river 4821 maple 0937, River4821Maple0937).
 */
export function canonicalPairCode(raw: string): string | null {
  const match = /^([A-Z]+)([0-9]{4})([A-Z]+)([0-9]{4})$/.exec(raw.toUpperCase().replace(/[^A-Z0-9]/g, ""));
  if (!match || !WORD_SET.has(match[1]!) || !WORD_SET.has(match[3]!)) return null;
  return `${match[1]}-${match[2]}-${match[3]}-${match[4]}`;
}

// ---------- who is in a pair ----------

export async function pairPersonRow(ctx: QueryCtx, pairId: Id<"pairs">, personId: Id<"people">): Promise<Doc<"pairPeople"> | null> {
  const row = await ctx.db
    .query("pairPeople")
    .withIndex("by_pair_person", (q) => q.eq("pairId", pairId).eq("personId", personId))
    .unique();
  return row && row.removedAt === undefined ? row : null;
}

/** A pair's people, oldest first: every one of them, since a pair holds at most MAX_PAIR_PEOPLE. */
export async function currentPairPeople(ctx: QueryCtx, pairId: Id<"pairs">, limit = MAX_PAIR_PEOPLE): Promise<Doc<"pairPeople">[]> {
  return ctx.db
    .query("pairPeople")
    .withIndex("by_pair_removed", (q) => q.eq("pairId", pairId).eq("removedAt", undefined))
    .take(limit);
}

export async function livePairRuns(ctx: QueryCtx, pairId: Id<"pairs">): Promise<Doc<"pairRuns">[]> {
  return ctx.db
    .query("pairRuns")
    .withIndex("by_pair_ended", (q) => q.eq("pairId", pairId).eq("endedAt", undefined))
    .take(MAX_IN_PAIR);
}

export async function pairAgentsIn(ctx: QueryCtx, pairId: Id<"pairs">): Promise<Doc<"pairAgents">[]> {
  return ctx.db
    .query("pairAgents")
    .withIndex("by_pair_left", (q) => q.eq("pairId", pairId).eq("leftAt", undefined))
    .take(MAX_IN_PAIR);
}

/** A session's runs in pairs, live ones only: the ones that left are never read. */
export async function pairRunsOfSession(ctx: QueryCtx, sessionId: Id<"joinedSessions">): Promise<Doc<"pairRuns">[]> {
  return ctx.db
    .query("pairRuns")
    .withIndex("by_session_ended", (q) => q.eq("sessionId", sessionId).eq("endedAt", undefined))
    .collect();
}

/** The pair, for a caller who is in it; not found for anyone else, so a pair's existence isn't told. */
const NOT_IN_PAIR = "No such Pair, or you aren't in it.";

export async function livePair(ctx: QueryCtx, pairId: Id<"pairs">): Promise<Doc<"pairs">> {
  const pair = await ctx.db.get(pairId);
  if (!pair) throw roomError("not_found", NOT_IN_PAIR);
  if (pair.endedAt !== undefined) throw roomError("invalid", "This Pair has ended.");
  return pair;
}

/**
 * A Pair a person or agent may read: a person of it (even after it ended), or an agent still in it.
 * Anyone else gets not_found, the same as for a pair that doesn't exist.
 */
export async function pairForActor(ctx: QueryCtx, actor: PairActor, rawId: string): Promise<{ pair: Doc<"pairs">; agentRow?: Doc<"pairAgents">; personRow?: Doc<"pairPeople"> }> {
  const pairId = ctx.db.normalizeId("pairs", rawId);
  const pair = pairId ? await ctx.db.get(pairId) : null;
  if (!pair) throw roomError("not_found", NOT_IN_PAIR);
  if (actor.kind === "agent") {
    const agentRow = (await pairAgentsIn(ctx, pair._id)).find((a) => a.agentId === actor.agent._id);
    if (!agentRow) throw roomError("not_found", NOT_IN_PAIR);
    return { pair, agentRow };
  }
  const personRow = await pairPersonRow(ctx, pair._id, actor.person._id);
  if (!personRow) throw roomError("not_found", NOT_IN_PAIR);
  return { pair, personRow };
}

/**
 * The live pair a joined session names: `pairId`, or with none the session's only live pair. Not
 * found unless the session is a live run in it.
 */
export async function sessionPair(ctx: QueryCtx, sessionId: Id<"joinedSessions">, rawId?: string): Promise<{ pair: Doc<"pairs">; pairRun: Doc<"pairRuns"> }> {
  const runs = await pairRunsOfSession(ctx, sessionId);
  let pairRun: Doc<"pairRuns"> | undefined;
  if (rawId !== undefined && rawId !== "pair") {
    const pairId = ctx.db.normalizeId("pairs", rawId.trim());
    pairRun = pairId ? runs.find((r) => r.pairId === pairId) : undefined;
    if (!pairRun) throw roomError("not_found", "This run isn't in that Pair.");
  } else if (runs.length === 1) {
    pairRun = runs[0];
  } else if (runs.length === 0) {
    throw roomError("not_found", "This run is in no Pair. uplink pair makes a pair code; uplink pair <code> joins one; uplink pair --resume rejoins one of yours.");
  } else {
    throw roomError("invalid", `This run is in ${runs.length} Pairs: name one by its pairId (${runs.map((r) => r.pairId).join(", ")}).`);
  }
  const pair = await livePair(ctx, pairRun!.pairId);
  return { pair, pairRun: pairRun! };
}

// ---------- names (D12) ----------

/** Anything shaped like an email address, anywhere in a name. */
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/**
 * A person's name as a Pair shows it, which is never an email (D12). When Clerk sends an email and
 * no name, sign-in keeps the email as the name (lib/people.ts `recordPerson`), so a name that is or
 * holds an email address shows as "Someone". Not the address's local part: that is often the
 * person's full name or handle, and so part of what D12 keeps from the other side.
 */
export function pairPersonName(person: Doc<"people"> | null): string {
  if (!person) return DELETED_ACCOUNT;
  const name = person.name.trim();
  if (!name || EMAIL_LIKE.test(name) || (person.email && name.toLowerCase() === person.email.trim().toLowerCase())) return NAMELESS;
  return name;
}

async function personName(ctx: QueryCtx, personId: Id<"people"> | undefined): Promise<string> {
  return pairPersonName(personId ? await ctx.db.get(personId) : null);
}

/**
 * The names of a pair's live runs, made within the pair as a team's are (lib/runLabels.ts): harness
 * and person, numbered by when they joined when one person has two of one harness, so nothing about
 * anyone's team shows. "Claude Code (Pepe)", "Claude Code 2 (Pepe)".
 */
export async function pairRunLabels(ctx: QueryCtx, runs: Doc<"pairRuns">[]): Promise<Map<Id<"pairRuns">, string>> {
  const labels = new Map<Id<"pairRuns">, string>();
  const counts = new Map<string, number>();
  for (const run of [...runs].sort((a, b) => a.joinedAt - b.joinedAt || a._creationTime - b._creationTime)) {
    const key = `${run.personId}|${run.harness}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    labels.set(run._id, `${harnessName(run.harness)}${n > 1 ? ` ${n}` : ""} (${await personName(ctx, run.personId)})`);
  }
  return labels;
}

export async function pairRunLabel(ctx: QueryCtx, run: Doc<"pairRuns">): Promise<string> {
  const live = await livePairRuns(ctx, run.pairId);
  return (await pairRunLabels(ctx, live.some((r) => r._id === run._id) ? live : [...live, run])).get(run._id)!;
}

/** The name a session's run has before it is in any pair: as its first run of its harness in one. */
export function joinedLabel(harness: string, person: Doc<"people">): string {
  return `${harnessName(harness)} (${pairPersonName(person)})`;
}

/** Where a pair's message is, for one of its people: "a Pair with Pepe", "a Pair with Pepe and Ana". */
export async function pairPlace(ctx: QueryCtx, pairId: Id<"pairs">, forPerson: Id<"people">): Promise<string> {
  const names: string[] = [];
  for (const row of await currentPairPeople(ctx, pairId)) {
    if (row.personId === forPerson) continue;
    names.push(await personName(ctx, row.personId));
  }
  if (!names.length) return "a Pair";
  if (names.length === 1) return `a Pair with ${names[0]}`;
  return `a Pair with ${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// ---------- views ----------

/** Who is looking at a pair: a person (with the session they look from, for a run), or an agent. */
export type PairViewer = { personId: Id<"people">; sessionId?: Id<"joinedSessions">; agentId?: Id<"agents"> };

/**
 * A pair as one of its people, runs or agents sees it (D12): its people's names and pictures, its
 * live runs' labels and its agents' names, each under an id that exists only in this pair. Never an
 * email, a team, or an id from one.
 */
export async function pairView(ctx: QueryCtx, pair: Doc<"pairs">, viewer: PairViewer) {
  const peopleRows = await currentPairPeople(ctx, pair._id);
  const idOf = new Map(peopleRows.map((p) => [p.personId, p._id]));
  const people = [];
  for (const row of peopleRows) {
    const person = await ctx.db.get(row.personId);
    people.push({
      id: row._id,
      name: pairPersonName(person),
      ...(person?.avatarUrl ? { avatarUrl: person.avatarUrl } : {}),
      ...(row.personId === viewer.personId && !viewer.agentId ? { you: true } : {}),
    });
  }
  const live = pair.endedAt === undefined ? await livePairRuns(ctx, pair._id) : [];
  const labels = await pairRunLabels(ctx, live);
  const runs = live.map((run) => ({
    id: run._id,
    label: labels.get(run._id)!,
    harness: run.harness,
    ...(idOf.get(run.personId) ? { person: idOf.get(run.personId)! } : {}),
    ...(viewer.sessionId && run.sessionId === viewer.sessionId ? { you: true } : {}),
  }));
  const agents = [];
  for (const row of pair.endedAt === undefined ? await pairAgentsIn(ctx, pair._id) : []) {
    const member = await ctx.db.get(row.memberId);
    agents.push({
      id: row._id,
      name: member?.name ?? "An agent",
      ...(idOf.get(row.personId) ? { person: idOf.get(row.personId)! } : {}),
      ...(viewer.agentId === row.agentId ? { you: true } : {}),
    });
  }
  const read = viewer.agentId
    ? (await pairAgentsIn(ctx, pair._id)).find((a) => a.agentId === viewer.agentId)?.readSeq
    : peopleRows.find((p) => p.personId === viewer.personId)?.readSeq;
  return {
    pairId: pair._id,
    createdAt: pair.createdAt,
    ...(pair.lastMessageAt !== undefined ? { lastMessageAt: pair.lastMessageAt } : {}),
    ...(pair.endedAt !== undefined ? { endedAt: pair.endedAt, endReason: pair.endReason ?? ("ended" as const) } : {}),
    seq: pair.seq,
    unread: Math.max(0, pair.seq - (read ?? pair.seq)),
    people,
    runs,
    agents,
  };
}

/** The pairPeople row id of each person in the pair, for the ids messages show. */
async function pairPeopleIds(ctx: QueryCtx, pairId: Id<"pairs">): Promise<Map<Id<"people">, Id<"pairPeople">>> {
  return new Map((await currentPairPeople(ctx, pairId)).map((r) => [r.personId, r._id]));
}

/** Who wrote a pair message, as the pair shows it. */
async function authorOf(ctx: QueryCtx, message: Doc<"pairMessages">, ids: Map<Id<"people">, Id<"pairPeople">>) {
  if (message.deletedAuthor || !message.personId) {
    return { kind: "deleted" as const, name: DELETED_ACCOUNT, person: { name: DELETED_ACCOUNT } as { id?: Id<"pairPeople">; name: string } };
  }
  const name = await personName(ctx, message.personId);
  const person: { id?: Id<"pairPeople">; name: string } = { ...(ids.get(message.personId) ? { id: ids.get(message.personId)! } : {}), name };
  if (message.run) return { kind: "run" as const, id: message.run.pairRunId, name: message.run.label, person };
  if (message.agent) return { kind: "agent" as const, id: message.agent.pairAgentId, name: message.agent.name, person };
  return { kind: "person" as const, ...(person.id ? { id: person.id } : {}), name, person };
}

/** One message as a pair's people and agents read it. */
type PairMessageView = Awaited<ReturnType<typeof messageView>>;
async function messageView(ctx: QueryCtx, m: Doc<"pairMessages">, ids: Map<Id<"people">, Id<"pairPeople">>) {
  // Its files, with no lasting link: pairs.attachmentLink gives a short-lived one (ADR 0048).
  const files = (await pairAttachmentsOf(ctx, m)).map(pairAttachmentView);
  return { messageId: m._id, seq: m.seq, body: m.body, at: m.at, from: await authorOf(ctx, m, ids), ...(files.length ? { attachments: files } : {}) };
}

/**
 * A page of a pair's messages, newest first, as Convex's usePaginatedQuery reads them: the app loads
 * older pages as you scroll up, back to the first message (ADR 0036).
 */
export async function pairMessagesPage(ctx: QueryCtx, pair: Doc<"pairs">, opts: PaginationOptions): Promise<PaginationResult<PairMessageView>> {
  const result = await ctx.db
    .query("pairMessages")
    .withIndex("by_pair_seq", (q) => q.eq("pairId", pair._id))
    .order("desc")
    .paginate({ ...opts, numItems: Math.min(Math.max(1, Math.floor(opts.numItems)), PAIR_PAGE_MAX) });
  const ids = await pairPeopleIds(ctx, pair._id);
  const page = [];
  for (const m of result.page) page.push(await messageView(ctx, m, ids));
  return { ...result, page };
}

/** Messages of a pair, oldest first, as its people and agents read them. */
export async function pairMessagesView(ctx: QueryCtx, pair: Doc<"pairs">, opts: { afterSeq?: number; limit?: number }) {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), PAIR_PAGE_MAX);
  const rows =
    opts.afterSeq !== undefined
      ? await ctx.db
          .query("pairMessages")
          .withIndex("by_pair_seq", (q) => q.eq("pairId", pair._id).gt("seq", opts.afterSeq!))
          .take(limit)
      : (
          await ctx.db
            .query("pairMessages")
            .withIndex("by_pair_seq", (q) => q.eq("pairId", pair._id))
            .order("desc")
            .take(limit)
        ).reverse();
  const ids = await pairPeopleIds(ctx, pair._id);
  const messages = [];
  for (const m of rows) messages.push(await messageView(ctx, m, ids));
  return { pairId: pair._id, seq: pair.seq, messages };
}

// ---------- joining ----------

async function addPerson(ctx: MutationCtx, pairId: Id<"pairs">, personId: Id<"people">, seq: number): Promise<void> {
  const row = await ctx.db
    .query("pairPeople")
    .withIndex("by_pair_person", (q) => q.eq("pairId", pairId).eq("personId", personId))
    .unique();
  // Someone new reads from now on; what was said before is there to scroll back to, not unread.
  if (!row) await ctx.db.insert("pairPeople", { pairId, personId, joinedAt: Date.now(), readSeq: seq });
  // Someone who left and joins again with a new code is back, reading from now on.
  else if (row.removedAt !== undefined) await ctx.db.patch(row._id, { removedAt: undefined, joinedAt: Date.now(), readSeq: seq });
}

/** Whether one more run or agent of `personId` fits: MAX_IN_PAIR live, and MAX_PAIR_PEOPLE people if they are new to it. */
async function requireRoom(ctx: QueryCtx, pairId: Id<"pairs">, personId: Id<"people">): Promise<void> {
  const count = (await livePairRuns(ctx, pairId)).length + (await pairAgentsIn(ctx, pairId)).length;
  if (count >= MAX_IN_PAIR) throw roomError("conflict", `This Pair is full: it holds at most ${MAX_IN_PAIR} runs and agents.`);
  if (!(await pairPersonRow(ctx, pairId, personId)) && (await currentPairPeople(ctx, pairId)).length >= MAX_PAIR_PEOPLE) {
    throw roomError("conflict", `This Pair is full: it holds at most ${MAX_PAIR_PEOPLE} people.`);
  }
}

/**
 * Whether `personId` may make one more Pair (ADR 0036): fewer than MAX_OPEN_PAIRS live ones they
 * made, and fewer than MAX_NEW_PAIRS made in the last CREATE_WINDOW_MS. Both are bounded reads. Without
 * them, someone could make Pairs without end, and each is a row in their list.
 */
async function requireNewPairRoom(ctx: QueryCtx, personId: Id<"people">, now: number): Promise<void> {
  const recent = await ctx.db
    .query("pairs")
    .withIndex("by_creator", (q) => q.eq("createdBy", personId).gt("createdAt", now - CREATE_WINDOW_MS))
    .take(MAX_NEW_PAIRS);
  if (recent.length >= MAX_NEW_PAIRS) {
    const minutes = Math.max(1, Math.ceil((recent[0]!.createdAt + CREATE_WINDOW_MS - now) / 60_000));
    throw roomError(
      "conflict",
      `You can make at most ${MAX_NEW_PAIRS} Pairs an hour. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}, or make a code in one you have.`,
    );
  }
  const open = await ctx.db
    .query("pairs")
    .withIndex("by_creator_ended", (q) => q.eq("createdBy", personId).eq("endedAt", undefined))
    .take(MAX_OPEN_PAIRS);
  if (open.length >= MAX_OPEN_PAIRS) {
    throw roomError("conflict", `You have ${MAX_OPEN_PAIRS} open Pairs you made, the most there can be. End one to make another.`);
  }
}

/** A new pair, with this session's run and its person in it. */
export async function createPair(ctx: MutationCtx, session: Doc<"joinedSessions">): Promise<Doc<"pairs">> {
  const now = Date.now();
  await requireNewPairRoom(ctx, session.personId, now);
  const pairId = await ctx.db.insert("pairs", { createdBy: session.personId, createdAt: now, seq: 0 });
  await addPerson(ctx, pairId, session.personId, 0);
  await ctx.db.insert("pairRuns", { pairId, sessionId: session._id, personId: session.personId, harness: session.harness, joinedAt: now });
  return (await ctx.db.get(pairId))!;
}

/**
 * A new pair a person makes in the app (`pairs.create`), with only them in it and no run yet: a code
 * they make for it lets someone's run or agent join, or another person in the app.
 */
export async function createPersonPair(ctx: MutationCtx, personId: Id<"people">): Promise<Doc<"pairs">> {
  const now = Date.now();
  await requireNewPairRoom(ctx, personId, now);
  const pairId = await ctx.db.insert("pairs", { createdBy: personId, createdAt: now, seq: 0 });
  await addPerson(ctx, pairId, personId, 0);
  return (await ctx.db.get(pairId))!;
}

/** Puts a person in a live pair from the app, with no run (`pairs.join`), if there is room for one more person. */
async function addPersonByCode(ctx: MutationCtx, pair: Doc<"pairs">, personId: Id<"people">): Promise<void> {
  if (await pairPersonRow(ctx, pair._id, personId)) throw roomError("conflict", "You're already in that Pair.");
  if ((await currentPairPeople(ctx, pair._id)).length >= MAX_PAIR_PEOPLE) {
    throw roomError("conflict", `This Pair is full: it holds at most ${MAX_PAIR_PEOPLE} people.`);
  }
  await addPerson(ctx, pair._id, personId, pair.seq);
}

/** Puts a joined session's run in a live pair, and its person, if there is room. */
export async function addRun(ctx: MutationCtx, pair: Doc<"pairs">, session: Doc<"joinedSessions">): Promise<Doc<"pairRuns">> {
  if ((await pairRunsOfSession(ctx, session._id)).some((r) => r.pairId === pair._id)) {
    throw roomError("conflict", "This run is already in that Pair.");
  }
  await requireRoom(ctx, pair._id, session.personId);
  await addPerson(ctx, pair._id, session.personId, pair.seq);
  const id = await ctx.db.insert("pairRuns", { pairId: pair._id, sessionId: session._id, personId: session.personId, harness: session.harness, joinedAt: Date.now() });
  return (await ctx.db.get(id))!;
}

/** Puts an agent in a live pair (D11), and the person accountable for it. */
async function addAgent(ctx: MutationCtx, pair: Doc<"pairs">, agent: Extract<PairActor, { kind: "agent" }>): Promise<void> {
  if ((await pairAgentsIn(ctx, pair._id)).some((a) => a.agentId === agent.agent._id)) {
    throw roomError("conflict", "This agent is already in that Pair.");
  }
  await requireRoom(ctx, pair._id, agent.person._id);
  await addPerson(ctx, pair._id, agent.person._id, pair.seq);
  await ctx.db.insert("pairAgents", {
    pairId: pair._id,
    agentId: agent.agent._id,
    memberId: agent.actor.member._id,
    teamId: agent.actor.teamId,
    personId: agent.person._id,
    joinedAt: Date.now(),
    readSeq: pair.seq,
  });
}

/** Makes a code for one more run or agent to join a live pair, made by one of its people. */
export async function makePairCode(ctx: MutationCtx, pair: Doc<"pairs">, personId: Id<"people">): Promise<{ code: string; pairId: Id<"pairs">; expiresAt: number }> {
  const code = newPairCode();
  const expiresAt = Date.now() + PAIR_CODE_MS;
  await ctx.db.insert("pairCodes", { pairId: pair._id, codeHash: await sha256(code), createdBy: personId, expiresAt });
  return { code, pairId: pair._id, expiresAt };
}

const WRONG_CODE = "That pair code is wrong, was used already, or is more than 10 minutes old. Ask for a new one: uplink pair makes it in a run that's in the Pair.";

/**
 * Redeems a pair code for one run or agent, once. Convex runs a mutation as one serializable
 * transaction, so two redemptions of one code can't both see it unused: the second retries and finds
 * it used. A wrong, used or expired code is counted against `personId` (the redeeming run's person,
 * or the agent's accountable person) and answered as a refusal, not thrown, so the count stays; past
 * MAX_CODE_FAILURES in a window no code works for them until it ends. The code is used up only when
 * the join succeeds: a full pair, or one the caller is already in, throws and leaves it.
 */
export async function redeemPairCode(
  ctx: MutationCtx,
  personId: Id<"people">,
  raw: string,
  join:
    | { kind: "run"; session: Doc<"joinedSessions"> }
    | { kind: "agent"; agent: Extract<PairActor, { kind: "agent" }> }
    | { kind: "person" },
): Promise<Doc<"pairs"> | RoomRefusal> {
  const now = Date.now();
  const failures = await ctx.db
    .query("pairCodeFailures")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .unique();
  const windowOpen = failures !== null && failures.windowStart + CODE_FAILURE_WINDOW_MS > now;
  if (windowOpen && failures.failures >= MAX_CODE_FAILURES) {
    const minutes = Math.ceil((failures.windowStart + CODE_FAILURE_WINDOW_MS - now) / 60_000);
    return roomRefusal("forbidden", `Too many wrong pair codes: no pair code works for you for ${minutes} more minute${minutes === 1 ? "" : "s"}.`);
  }
  const canonical = canonicalPairCode(raw);
  const hash = canonical ? await sha256(canonical) : null;
  const code = hash
    ? await ctx.db
        .query("pairCodes")
        .withIndex("by_code", (q) => q.eq("codeHash", hash))
        .unique()
    : null;
  const pair = code ? await ctx.db.get(code.pairId) : null;
  if (!code || !pair || code.usedAt !== undefined || code.expiresAt <= now || pair.endedAt !== undefined) {
    if (failures && windowOpen) await ctx.db.patch(failures._id, { failures: failures.failures + 1 });
    else if (failures) await ctx.db.patch(failures._id, { windowStart: now, failures: 1 });
    else await ctx.db.insert("pairCodeFailures", { personId, windowStart: now, failures: 1 });
    return roomRefusal("not_found", WRONG_CODE);
  }
  if (join.kind === "run") await addRun(ctx, pair, join.session);
  else if (join.kind === "agent") await addAgent(ctx, pair, join.agent);
  else await addPersonByCode(ctx, pair, personId);
  await ctx.db.patch(code._id, { usedAt: now });
  return pair;
}

/**
 * Takes an agent out of a pair: it reads and writes there no more. Its person stays one of the
 * pair's people.
 */
export async function removeAgent(ctx: MutationCtx, agentRow: Doc<"pairAgents">): Promise<void> {
  if (agentRow.leftAt === undefined) await ctx.db.patch(agentRow._id, { leftAt: Date.now() });
}

// ---------- messages ----------

/**
 * Who posts in a pair: one of its people, one of its runs, or one of its agents. A run in a team
 * names its driver's member there (`teamMemberId`), whose uploads its files may be (ADR 0048).
 */
export type PairAuthor =
  | { kind: "person"; personId: Id<"people"> }
  | { kind: "run"; pairRun: Doc<"pairRuns">; teamMemberId?: Id<"members"> }
  | { kind: "agent"; agentRow: Doc<"pairAgents"> };

/**
 * Posts in a live pair and puts the message in the inbox of every other live run in it (ADR 0026:
 * everything in a direct message). Every person and agent in it has it unread, except its author.
 * A run whose inbox already holds MAX_WAITING doesn't get it, and `notDelivered` names it. With
 * files (ADR 0048), each an upload issued to its author, the text may be empty.
 */
export async function postInPair(
  ctx: MutationCtx,
  pair: Doc<"pairs">,
  author: PairAuthor,
  text: string,
  attachments: NewPairAttachment[] = [],
): Promise<{ messageId: Id<"pairMessages">; seq: number; label?: string; notDelivered: string[] }> {
  const body = text.trim();
  if (!body && !attachments.length) throw roomError("invalid", "A message needs text or a file.");
  if (body.length > PAIR_TEXT_MAX) throw roomError("invalid", `A message can be at most ${PAIR_TEXT_MAX} characters.`);
  const files = attachments.length ? await checkPairAttachments(ctx, pair._id, author, attachments) : [];
  const now = Date.now();
  const seq = pair.seq + 1;
  const personId = author.kind === "person" ? author.personId : author.kind === "run" ? author.pairRun.personId : author.agentRow.personId;
  const live = await livePairRuns(ctx, pair._id);
  const labels = await pairRunLabels(ctx, live);
  const label = author.kind === "run" ? labels.get(author.pairRun._id) : undefined;
  const agentName = author.kind === "agent" ? ((await ctx.db.get(author.agentRow.memberId))?.name ?? "An agent") : undefined;
  const messageId = await ctx.db.insert("pairMessages", {
    pairId: pair._id,
    seq,
    body,
    at: now,
    personId,
    ...(author.kind === "run" && label ? { run: { pairRunId: author.pairRun._id, label } } : {}),
    ...(author.kind === "agent" ? { agent: { pairAgentId: author.agentRow._id, name: agentName! } } : {}),
    ...(files.length ? { attachmentCount: files.length } : {}),
  });
  if (files.length) await keepPairAttachments(ctx, { _id: messageId, pairId: pair._id }, files);
  await ctx.db.patch(pair._id, { seq, lastMessageAt: now });
  // Its author has read it: a person and their runs as that person, an agent as itself.
  if (author.kind === "agent") await ctx.db.patch(author.agentRow._id, { readSeq: seq });
  else {
    const row = await pairPersonRow(ctx, pair._id, personId);
    if (row) await ctx.db.patch(row._id, { readSeq: seq });
  }

  const notDelivered: string[] = [];
  for (const run of live) {
    if (author.kind === "run" && run._id === author.pairRun._id) continue;
    if ((await openPairRows(ctx, run.sessionId)) >= MAX_WAITING) {
      notDelivered.push(labels.get(run._id)!);
      continue;
    }
    await ctx.db.insert("pairInbox", {
      pairId: pair._id,
      sessionId: run.sessionId,
      messageId,
      fromDriver: run.personId === personId,
      status: "waiting",
      at: now,
    });
  }
  return { messageId, seq, ...(label ? { label } : {}), notDelivered };
}

/** How many Pair messages wait for a session or are claimed by it, up to MAX_WAITING. */
async function openPairRows(ctx: QueryCtx, sessionId: Id<"joinedSessions">): Promise<number> {
  const waiting = await ctx.db
    .query("pairInbox")
    .withIndex("by_session_status", (q) => q.eq("sessionId", sessionId).eq("status", "waiting"))
    .take(MAX_WAITING);
  if (waiting.length >= MAX_WAITING) return waiting.length;
  const claimed = await ctx.db
    .query("pairInbox")
    .withIndex("by_session_status", (q) => q.eq("sessionId", sessionId).eq("status", "claimed"))
    .take(MAX_WAITING - waiting.length);
  return waiting.length + claimed.length;
}

/** How many Pair messages wait for a session (at most MAX_WAITING), for `joined.waiting`. */
export async function waitingPairRows(ctx: QueryCtx, sessionId: Id<"joinedSessions">): Promise<Doc<"pairInbox">[]> {
  return ctx.db
    .query("pairInbox")
    .withIndex("by_session_status", (q) => q.eq("sessionId", sessionId).eq("status", "waiting"))
    .take(MAX_WAITING);
}

/**
 * One Pair message as a joined run takes it (`joined.take`): a run delivery, labelled as a team's
 * are, with who sent it and the person accountable for it under ids that exist only in the pair, and
 * the pair it is in, which `uplink reply` answers in. `run_ended` when the pair ended, or the run is
 * no longer in it.
 */
export async function pairDelivery(ctx: QueryCtx, session: Doc<"joinedSessions">, row: Doc<"pairInbox">) {
  const pair = await ctx.db.get(row.pairId);
  const message = await ctx.db.get(row.messageId);
  if (!pair || pair.endedAt !== undefined || !message) return "run_ended" as const;
  if (!(await pairRunsOfSession(ctx, session._id)).some((r) => r.pairId === pair._id)) return "run_ended" as const;
  const author = await authorOf(ctx, message, await pairPeopleIds(ctx, pair._id));
  const cut = message.body.length > RUN_MESSAGE_TEXT_MAX;
  const from =
    author.kind === "run"
      ? { memberId: author.id, name: author.person.name, kind: "person" as const, run: author.name }
      : author.kind === "agent"
        ? { memberId: author.id, name: author.name, kind: "agent" as const }
        : { memberId: author.kind === "person" ? (author.id ?? "") : "", name: author.name, kind: "person" as const };
  return {
    deliveryId: row._id,
    messageId: message._id,
    pairId: pair._id,
    place: await pairPlace(ctx, pair._id, session.personId),
    // A cut can split a surrogate pair, and Convex refuses a string with half of one.
    text: cut ? message.body.slice(0, RUN_MESSAGE_TEXT_MAX).toWellFormed() : message.body,
    ...(cut ? { cut: true } : {}),
    // Its files stay in the room; the run saves them with uplink download (joined.download, ADR 0048).
    ...(message.attachmentCount ? { attachments: message.attachmentCount, downloadable: true as const } : {}),
    from,
    accountable: { memberId: author.person.id ?? "", name: author.person.name },
    fromDriver: message.personId !== undefined && message.personId === session.personId,
    at: row.at,
  };
}

// ---------- ending ----------

/**
 * The Pair messages a session's run can no longer get, in `pairId` or in every pair: they fail as
 * run_ended, in a scheduled step (`pairs.settleEnded`), as a team run's do when it ends.
 */
export async function settleEndedPairRun(ctx: MutationCtx, sessionId: Id<"joinedSessions">, pairId?: Id<"pairs">): Promise<void> {
  const open =
    (await ctx.db
      .query("pairInbox")
      .withIndex("by_session_status", (q) => q.eq("sessionId", sessionId).eq("status", "waiting"))
      .first()) ??
    (await ctx.db
      .query("pairInbox")
      .withIndex("by_session_status", (q) => q.eq("sessionId", sessionId).eq("status", "claimed"))
      .first());
  if (open) await ctx.scheduler.runAfter(0, internal.pairs.settleEnded, { sessionId, ...(pairId ? { pairId } : {}) });
}

/** One step of `settleEndedPairRun`: a session has at most about 2 × MAX_WAITING open rows. */
export async function failPairRows(ctx: MutationCtx, sessionId: Id<"joinedSessions">, pairId?: Id<"pairs">): Promise<void> {
  for (const status of ["waiting", "claimed"] as const) {
    const rows = await ctx.db
      .query("pairInbox")
      .withIndex("by_session_status", (q) => q.eq("sessionId", sessionId).eq("status", status))
      .take(MAX_WAITING * 2);
    for (const row of rows) {
      if (pairId && row.pairId !== pairId) continue;
      await ctx.db.patch(row._id, { status: "failed", error: "run_ended", claim: undefined });
    }
  }
}

/** A joined session ended: its runs leave their pairs, which go on, since they belong to their people. */
export async function endPairRunsOfSession(ctx: MutationCtx, sessionId: Id<"joinedSessions">): Promise<void> {
  const now = Date.now();
  for (const run of await pairRunsOfSession(ctx, sessionId)) await ctx.db.patch(run._id, { endedAt: now });
  await settleEndedPairRun(ctx, sessionId);
}

/**
 * Ends a pair, once: its runs leave it, its agents leave it, and no code for it works. Its people
 * can still read it. `endedBy`: the person who ended it; none when the room did (`too_few_people`).
 */
export async function endPair(ctx: MutationCtx, pair: Doc<"pairs">, endedBy: Id<"people"> | undefined, reason: "ended" | "too_few_people"): Promise<void> {
  if (pair.endedAt !== undefined) return;
  const now = Date.now();
  await ctx.db.patch(pair._id, { endedAt: now, endReason: reason, ...(endedBy ? { endedBy } : {}) });
  for (const run of await livePairRuns(ctx, pair._id)) {
    await ctx.db.patch(run._id, { endedAt: now });
    await settleEndedPairRun(ctx, run.sessionId, pair._id);
  }
  for (const agent of await pairAgentsIn(ctx, pair._id)) await removeAgent(ctx, agent);
}

/**
 * A person leaves a pair (`pairs.leave`): they stop being one of its people and read it no more,
 * their runs and agents in it leave with them, and a live pair left with fewer than two people
 * ends, as after an account deletion (D10). Their messages stay under their name.
 */
export async function leavePair(ctx: MutationCtx, pair: Doc<"pairs">, row: Doc<"pairPeople">): Promise<void> {
  const now = Date.now();
  await ctx.db.patch(row._id, { removedAt: now });
  if (pair.endedAt !== undefined) return;
  for (const run of await livePairRuns(ctx, pair._id)) {
    if (run.personId !== row.personId) continue;
    await ctx.db.patch(run._id, { endedAt: now });
    await settleEndedPairRun(ctx, run.sessionId, pair._id);
  }
  for (const agent of await pairAgentsIn(ctx, pair._id)) if (agent.personId === row.personId) await removeAgent(ctx, agent);
  if ((await currentPairPeople(ctx, pair._id, 2)).length < 2) await endPair(ctx, pair, undefined, "too_few_people");
}

/** At most this many messages are made anonymous in one step of `pairs.forgetMessages`. */
export const FORGET_STEP = 200;

/**
 * At most this many of a person's pairs are left in one step of account deletion. A pair costs
 * about 30 reads at most (its live runs, agents and people, and ending it), so a step stays well
 * under Convex's 4,096 index ranges a function, and its scheduled runs under 1,000.
 */
export const FORGET_PAIRS_STEP = 50;

/**
 * Account deletion's part in Pairs on its own (D10, `internal.pairs.forgetPerson`; accounts.cleanUp
 * runs the same steps as part of a whole deletion, ADR 0035): the person's runs and agents leave
 * their pairs, they stop being one of each pair's people, their messages stay as "A deleted account"
 * (in scheduled steps, `pairs.forgetMessages`), and a pair left with fewer than two people ends.
 * Their pairs' other people keep everything else.
 *
 * This is the first step: it forgets their wrong-code count, starts on their messages, and leaves
 * their first FORGET_PAIRS_STEP pairs; `pairs.forgetPairs` leaves the rest, a step at a time.
 */
export async function forgetPersonInPairs(ctx: MutationCtx, personId: Id<"people">): Promise<{ pairs: number; ended: number; more: boolean }> {
  const failures = await ctx.db
    .query("pairCodeFailures")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .unique();
  if (failures) await ctx.db.delete(failures._id);
  await ctx.scheduler.runAfter(0, internal.pairs.forgetMessages, { personId });
  return forgetPairsStep(ctx, personId);
}

/**
 * One step of leaving a deleted account's pairs, which schedules the next while any are left
 * (unless `scheduleNext` is false: accounts.cleanUp schedules its own steps). Each
 * step is one transaction that reads only the pairs the person is still in, so a step that fails
 * leaves nothing half done, and running deletion again starts where the last step stopped.
 */
export async function forgetPairsStep(
  ctx: MutationCtx,
  personId: Id<"people">,
  { scheduleNext = true }: { scheduleNext?: boolean } = {},
): Promise<{ pairs: number; ended: number; more: boolean }> {
  const now = Date.now();
  const stillIn = () =>
    ctx.db.query("pairPeople").withIndex("by_person_removed", (q) => q.eq("personId", personId).eq("removedAt", undefined));
  const rows = await stillIn().take(FORGET_PAIRS_STEP);
  let ended = 0;
  for (const row of rows) {
    await ctx.db.patch(row._id, { removedAt: now });
    const pair = await ctx.db.get(row.pairId);
    // An ended pair has no live runs or agents left (endPair took them out).
    if (!pair || pair.endedAt !== undefined) continue;
    for (const run of await livePairRuns(ctx, pair._id)) {
      if (run.personId !== personId) continue;
      await ctx.db.patch(run._id, { endedAt: now });
      await settleEndedPairRun(ctx, run.sessionId, pair._id);
    }
    for (const agent of await pairAgentsIn(ctx, pair._id)) if (agent.personId === personId) await removeAgent(ctx, agent);
    if ((await currentPairPeople(ctx, pair._id, 2)).length < 2) {
      await endPair(ctx, pair, undefined, "too_few_people");
      ended++;
    }
  }
  // The rows just patched have left the index, so this sees only pairs not reached yet.
  const more = (await stillIn().first()) !== null;
  if (more && scheduleNext) await ctx.scheduler.runAfter(0, internal.pairs.forgetPairs, { personId });
  return { pairs: rows.length, ended, more };
}

/** One step of making a deleted account's Pair messages anonymous. Returns how many it took: FORGET_STEP when more may be left. */
export async function forgetMessagesStep(ctx: MutationCtx, personId: Id<"people">): Promise<number> {
  const messages = await ctx.db
    .query("pairMessages")
    .withIndex("by_person", (q) => q.eq("personId", personId))
    .take(FORGET_STEP);
  for (const m of messages) await ctx.db.patch(m._id, { personId: undefined, run: undefined, agent: undefined, deletedAuthor: true });
  return messages.length;
}

/**
 * A page of a person's pairs, the ones they joined last first, as Convex's usePaginatedQuery reads
 * them, so the app reaches every one however many there are (ADR 0036); an agent's, those it is
 * still in.
 */
export async function pairsPage(ctx: QueryCtx, actor: PairActor, opts: PaginationOptions): Promise<PaginationResult<Doc<"pairs">>> {
  const sized = { ...opts, numItems: Math.min(Math.max(1, Math.floor(opts.numItems)), PAIRS_LISTED) };
  const rows =
    actor.kind === "agent"
      ? await ctx.db
          .query("pairAgents")
          .withIndex("by_agent_left", (q) => q.eq("agentId", actor.agent._id).eq("leftAt", undefined))
          .order("desc")
          .paginate(sized)
      : await ctx.db
          .query("pairPeople")
          .withIndex("by_person_removed", (q) => q.eq("personId", actor.person._id).eq("removedAt", undefined))
          .order("desc")
          .paginate(sized);
  const page: Doc<"pairs">[] = [];
  for (const row of rows.page) {
    if ("leftAt" in row && row.leftAt !== undefined) continue;
    const pair = await ctx.db.get(row.pairId);
    if (pair) page.push(pair);
  }
  return { ...rows, page };
}

/**
 * A person's pairs, newest first, at most PAIRS_LISTED; an agent's, those it is still in. Both read
 * an index of current memberships only, so pairs left (or, for a person, a deleted account's) never
 * take the places of current ones.
 */
export async function pairsOf(ctx: QueryCtx, actor: PairActor): Promise<Doc<"pairs">[]> {
  const ids =
    actor.kind === "agent"
      ? (
          await ctx.db
            .query("pairAgents")
            .withIndex("by_agent_left", (q) => q.eq("agentId", actor.agent._id).eq("leftAt", undefined))
            .order("desc")
            .take(PAIRS_LISTED)
        ).map((a) => a.pairId)
      : (
          await ctx.db
            .query("pairPeople")
            .withIndex("by_person_removed", (q) => q.eq("personId", actor.person._id).eq("removedAt", undefined))
            .order("desc")
            .take(PAIRS_LISTED)
        ).map((p) => p.pairId);
  const pairs: Doc<"pairs">[] = [];
  for (const id of ids.slice(0, PAIRS_LISTED)) {
    const pair = await ctx.db.get(id);
    if (pair) pairs.push(pair);
  }
  return pairs.sort((a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt));
}
