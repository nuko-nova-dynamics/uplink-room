/**
 * The gym's Pairs (slice 12 of #139): sample Pairs of Rosa Vega with people outside Harbor Labs,
 * her command line sign-ins, and answers for the Pair functions the app calls. Sample data: the
 * names, codes and computers are made up.
 */
import harborPng from "./harbor.png?url&no-inline";

type Json = Record<string, unknown>;

export type PairScene = "none" | "some" | "many";

export const GYM_PAIRS = {
  pepe: "gym-pair-pepe",
  lena: "gym-pair-lena",
  marco: "gym-pair-marco",
  fresh: "gym-pair-new",
} as const;
/** The code the gym makes; joining with anything else is refused, as a wrong code is. */
export const GYM_PAIR_CODE = "RIVER-4821-MAPLE-0937";

const MIN = 60_000;

export class PairsWorld {
  private readonly scene: PairScene;
  private readonly me: string;
  private pairs: Json[];
  private readonly messages = new Map<string, Json[]>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private readonly cache = new Map<string, { version: number; value: unknown }>();

  constructor(scene: PairScene, me: string) {
    this.scene = scene;
    this.me = me;
    const now = Date.now();
    const at = (minutesAgo: number) => now - minutesAgo * MIN;
    const you = { id: "gym-pp-rosa", name: me, you: true };
    const pepe = { id: "gym-pp-pepe", name: "Pepe Ortiz" };
    const lena = { id: "gym-pp-lena", name: "Lena Okafor" };
    const sam = { id: "gym-pp-sam", name: "Sam Ito" };
    const marco = { id: "gym-pp-marco", name: "Marco Bianchi" };
    const person = (p: { id: string; name: string }) => ({ id: p.id, name: p.name });
    const run = (id: string, label: string, by: { id: string; name: string }) => ({
      kind: "run",
      id,
      name: label,
      person: person(by),
    });
    const said = (by: { id: string; name: string }) => ({
      kind: "person",
      id: by.id,
      name: by.name,
      person: person(by),
    });
    const msg = (pairId: string, seq: number, minutesAgo: number, from: Json, body: string) => ({
      messageId: `${pairId}-m${seq}`,
      seq,
      at: at(minutesAgo),
      from,
      body,
    });

    this.pairs =
      scene === "none"
        ? []
        : [
            {
              pairId: GYM_PAIRS.pepe,
              createdAt: at(95),
              lastMessageAt: at(2),
              seq: 7,
              unread: 0,
              people: [you, pepe],
              runs: [
                {
                  id: "gym-pr-pepe",
                  label: "Claude Code (Pepe Ortiz)",
                  harness: "claude-code",
                  person: pepe.id,
                },
                { id: "gym-pr-rosa", label: "Codex (Rosa Vega)", harness: "codex", person: you.id },
              ],
              agents: [],
            },
            {
              pairId: GYM_PAIRS.lena,
              createdAt: at(300),
              lastMessageAt: at(26),
              seq: 5,
              unread: 3,
              people: [you, lena, sam],
              runs: [
                {
                  id: "gym-pr-lena",
                  label: "Claude Code (Lena Okafor)",
                  harness: "claude-code",
                  person: lena.id,
                },
              ],
              agents: [{ id: "gym-pa-scout", name: "Scout", person: lena.id }],
            },
            {
              pairId: GYM_PAIRS.marco,
              createdAt: at(3 * 24 * 60),
              lastMessageAt: at(2 * 24 * 60),
              endedAt: at(2 * 24 * 60 - 5),
              endReason: "ended",
              seq: 4,
              unread: 0,
              people: [you, marco],
              runs: [],
              agents: [],
            },
          ];

    if (scene === "many") {
      this.pairs.push(
        ...Array.from({ length: 70 }, (_, i) => ({
          ...this.pairs[0]!,
          pairId: `gym-extra-pair-${i}`,
          unread: i % 3,
          people: [you, { ...pepe, id: `gym-extra-person-${i}`, name: `Harbor observer ${i + 1}` }],
        })),
      );
    }
    this.messages.set(GYM_PAIRS.pepe, [
      msg(
        GYM_PAIRS.pepe,
        1,
        41,
        run("gym-pr-pepe", "Claude Code (Pepe Ortiz)", pepe),
        "I'm on the station API side. Which schema does your export read, v1 or v2?",
      ),
      msg(
        GYM_PAIRS.pepe,
        2,
        40,
        run("gym-pr-rosa", "Codex (Rosa Vega)", you),
        "v2, from `harbor-labs/tide-tables` main. Heights are in centimeters and times in UTC.",
      ),
      msg(
        GYM_PAIRS.pepe,
        3,
        22,
        said(pepe),
        "Codex, can you send one sample row? Our parser chokes on the station name column.",
      ),
      msg(
        GYM_PAIRS.pepe,
        4,
        21,
        run("gym-pr-rosa", "Codex (Rosa Vega)", you),
        "```\nstation_id,station_name,time_utc,height_cm\n8410140,Eastport,2026-11-05T06:12:00Z,412\n```\nA station without a name is an empty cell, not its id.",
      ),
      msg(
        GYM_PAIRS.pepe,
        5,
        9,
        said(you),
        "Pepe, that column moved last week. I'll keep the old order until Friday so your parser has time.",
      ),
      msg(
        GYM_PAIRS.pepe,
        6,
        3,
        run("gym-pr-pepe", "Claude Code (Pepe Ortiz)", pepe),
        "Parser fixed: it reads columns by header now. All 2,976 rows from March load.",
      ),
      // A file in a Pair (ADR 0048): no lasting link, so the box asks pairs.attachmentLink for one.
      {
        ...msg(
          GYM_PAIRS.pepe,
          7,
          2,
          run("gym-pr-pepe", "Claude Code (Pepe Ortiz)", pepe),
          "Here's the March chart from the fixed parser, with its load log.",
        ),
        attachments: [
          { index: 0, name: "march-tides.png", kind: "image", contentType: "image/png", size: 182_400, restricted: true, url: null, downloadUrl: null },
          { index: 1, name: "load.log", kind: "file", contentType: "application/octet-stream", size: 4_210, restricted: true, url: null, downloadUrl: null },
        ],
      },
    ]);
    this.messages.set(GYM_PAIRS.lena, [
      msg(
        GYM_PAIRS.lena,
        1,
        60,
        said(lena),
        "Scout watches the harbor cameras. Your tide chart and its alerts should agree.",
      ),
      msg(GYM_PAIRS.lena, 2, 58, said(you), "They should. The chart redraws every 6 minutes."),
      msg(
        GYM_PAIRS.lena,
        3,
        31,
        { kind: "agent", id: "gym-pa-scout", name: "Scout", person: person(lena) },
        "Camera 3 shows the tide 8 cm above the chart's 14:00 reading.",
      ),
      msg(
        GYM_PAIRS.lena,
        4,
        28,
        said(sam),
        "8 cm is inside the gauge's error. Lena, can Scout allow 10?",
      ),
      msg(
        GYM_PAIRS.lena,
        5,
        26,
        run("gym-pr-lena", "Claude Code (Lena Okafor)", lena),
        "Scout's threshold is 10 cm now, on `main`.",
      ),
    ]);
    this.messages.set(GYM_PAIRS.marco, [
      msg(
        GYM_PAIRS.marco,
        1,
        3 * 24 * 60,
        said(marco),
        "Our Codex needs your station list once, for the buoy map.",
      ),
      msg(
        GYM_PAIRS.marco,
        2,
        3 * 24 * 60 - 4,
        run("gym-pr-rosa-old", "Codex (Rosa Vega)", you),
        "Sent: 214 stations, with ids and coordinates.",
      ),
      msg(GYM_PAIRS.marco, 3, 2 * 24 * 60 + 2, said(marco), "The map has all of them. Thanks."),
      msg(GYM_PAIRS.marco, 4, 2 * 24 * 60, said(you), "Good. I'll end this Pair."),
    ]);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  /** Pair and account queries, or undefined for the rest of the gym to answer. */
  answer(udfPath: string, args: Json): unknown {
    // One object per answer until something changes, as Convex keeps a result's identity.
    const key = `${udfPath} ${JSON.stringify(args)}`;
    const hit = this.cache.get(key);
    if (hit && hit.version === this.version) return hit.value;
    const value = this.compute(udfPath, args);
    if (value !== undefined) this.cache.set(key, { version: this.version, value });
    return value;
  }

  private compute(udfPath: string, args: Json): unknown {
    switch (udfPath) {
      case "pairs:list":
        return this.pairs;
      // One page holds every sample Pair, and every sample message, newest first.
      case "pairs:listPage": {
        const options = args["paginationOpts"] as
          | { numItems?: number; cursor?: string }
          | undefined;
        const start = Number(options?.cursor ?? 0);
        const end = start + (options?.numItems ?? this.pairs.length);
        return {
          page: this.pairs.slice(start, end),
          isDone: end >= this.pairs.length,
          continueCursor: String(end),
          splitCursor: null,
          pageStatus: null,
        };
      }
      case "pairs:messagesPage": {
        const pair = this.pairs.find((p) => p["pairId"] === args["pairId"]);
        if (!pair) return undefined;
        const page = [...(this.messages.get(pair["pairId"] as string) ?? [])].reverse();
        return { page, isDone: true, continueCursor: "", splitCursor: null, pageStatus: null };
      }
      case "pairs:get":
        return this.pairs.find((p) => p["pairId"] === args["pairId"]);
      case "pairs:messages": {
        const pair = this.pairs.find((p) => p["pairId"] === args["pairId"]);
        return pair
          ? {
              pairId: pair["pairId"],
              seq: pair["seq"],
              messages: this.messages.get(pair["pairId"] as string) ?? [],
            }
          : undefined;
      }
      case "people:signIns": {
        const now = Date.now();
        const day = 24 * 60 * MIN;
        return [
          {
            signInId: "gym-signin-1",
            name: "rosa-mbp",
            prefix: "urs_3f9a",
            createdAt: now - 3 * day,
            lastUsedAt: now - 12 * MIN,
            expiresAt: now + 27 * day,
            current: false,
          },
          {
            signInId: "gym-signin-2",
            name: "harbor-build-01",
            prefix: "urs_77c1",
            createdAt: now - 18 * day,
            lastUsedAt: now - 2 * day,
            expiresAt: now + 12 * day,
            current: false,
          },
          {
            signInId: "gym-signin-3",
            name: "rosa-thinkpad",
            prefix: "urs_b20e",
            createdAt: now - 40 * MIN,
            expiresAt: now + 30 * day - 40 * MIN,
            current: false,
          },
        ];
      }
      case "people:me":
        return { personId: "gym-person-rosa", name: this.me, teams: [] };
      default:
        return undefined;
    }
  }

  /** The Pair functions' answers, as the room gives them; undefined for anything else. */
  mutate(udfPath: string, args: Json): unknown {
    switch (udfPath) {
      case "pairs:code":
        return { code: GYM_PAIR_CODE, pairId: args["pairId"], expiresAt: Date.now() + 10 * MIN };
      case "pairs:create": {
        const pair = {
          pairId: GYM_PAIRS.fresh,
          createdAt: Date.now(),
          seq: 0,
          unread: 0,
          people: [{ id: "gym-pp-rosa", name: this.me, you: true }],
          runs: [],
          agents: [],
        };
        this.pairs = [pair, ...this.pairs.filter((p) => p["pairId"] !== GYM_PAIRS.fresh)];
        this.changed();
        return pair;
      }
      case "pairs:join":
        if (String(args["code"]) === GYM_PAIR_CODE) return this.pairs[0] ?? null;
        return {
          refused: {
            code: "not_found",
            message: "That pair code is wrong, was used already, or is more than 10 minutes old.",
          },
        };
      // A Pair's files come through short-lived links; the gym's is its sample picture.
      case "pairs:attachmentLink":
        return { url: harborPng, expiresAt: Date.now() + 10 * MIN, pairId: GYM_PAIRS.pepe };
      case "pairs:post": {
        const pairId = args["pairId"] as string;
        const files = (args["attachments"] as { name: string }[] | undefined) ?? [];
        const list = this.messages.get(pairId) ?? [];
        const seq = list.length + 1;
        this.messages.set(pairId, [
          ...list,
          {
            messageId: `${pairId}-m${seq}`,
            seq,
            at: Date.now(),
            body: args["text"],
            ...(files.length
              ? {
                  attachments: files.map((f, index) => ({
                    index,
                    name: f.name,
                    kind: /\.(png|jpe?g|gif|webp)$/i.test(f.name) ? "image" : "file",
                    contentType: "application/octet-stream",
                    size: 0,
                    restricted: true,
                    url: null,
                    downloadUrl: null,
                  })),
                }
              : {}),
            from: {
              kind: "person",
              id: "gym-pp-rosa",
              name: this.me,
              person: { id: "gym-pp-rosa", name: this.me },
            },
          },
        ]);
        this.pairs = this.pairs.map((p) =>
          p["pairId"] === pairId ? { ...p, seq, lastMessageAt: Date.now() } : p,
        );
        this.changed();
        return { messageId: `${pairId}-m${seq}`, seq, pairId };
      }
      case "pairs:markRead":
        return { pairId: args["pairId"], readSeq: 0 };
      case "pairs:end":
        this.pairs = this.pairs.map((p) =>
          p["pairId"] === args["pairId"]
            ? { ...p, endedAt: Date.now(), endReason: "ended", runs: [], agents: [] }
            : p,
        );
        this.changed();
        return null;
      case "pairs:leave":
        this.pairs = this.pairs.filter((p) => p["pairId"] !== args["pairId"]);
        this.changed();
        return null;
      case "people:revokeSignIn":
        return null;
      default:
        return undefined;
    }
  }
}
