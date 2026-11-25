import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { BridgeMessage, RoomMessage, RunAttachTarget, RunRef, RunSaid, RunSay } from "@uplink-room/protocol";
import type { RunMessageClaim, RunMessageClaimRequest } from "@uplink-room/protocol/runMessages";
import { acceptingRefusals } from "@uplink-room/protocol/refusals";
import type { RoomLink } from "./bridge.ts";
const pairRef = makeFunctionReference<
  "mutation",
  { code: string; hostname: string; os: string },
  {
    token: string;
    machineId: string;
    teamId: string;
    /** The member the machine belongs to, or null for a team machine. */
    belongsTo: string | null;
    linkedBy: string;
  }
>("bridge:pair");
/** A room from before ADR 0021 returns null; a later one names the bridge messages it takes. */
const sendRef = makeFunctionReference<
  "mutation",
  { token: string; messages: BridgeMessage[] },
  { features?: string[] } | null
>("bridge:send");
const inboxRef = makeFunctionReference<
  "query",
  { token: string; afterSeq: number },
  { messages: { seq: number; message: RoomMessage }[] }
>("bridge:inbox");
const ackRef = makeFunctionReference<"mutation", { token: string; upToSeq: number }, null>(
  "bridge:ack",
);
const heartbeatRef = makeFunctionReference<"mutation", { token: string }, null>("bridge:heartbeat");
/** A session's hook claims the messages waiting for its run (ADR 0026). */
const claimRunMessagesRef = makeFunctionReference<"mutation", { token: string } & RunMessageClaimRequest, RunMessageClaim>("bridge:claimRunMessages");
/** The bridge still moves a claim's files, so the room keeps it claimed (ADR 0043). */
const holdRunMessagesRef = makeFunctionReference<"mutation", { token: string; claimId: string; deliveryIds: string[] }, { held: boolean }>(
  "bridge:holdRunMessages",
);
/** A run in one of this bridge's terminals posts as itself (ADR 0026). */
const runSayRef = makeFunctionReference<"mutation", { token: string } & RunSay, RunSaid>("bridge:runSay");
/** Where to upload one file a run sends with its next message (ADR 0047). */
const runAttachUrlRef = makeFunctionReference<"mutation", { token: string } & RunRef, RunAttachTarget>("bridge:runAttachUrl");
/** The room shows a machine offline after 90 s of silence, so an idle bridge says hello this often. */
const HEARTBEAT_MS = 30_000;
/** How long closing waits for the command being handled to finish. */
const CLOSE_WAIT_MS = 2000;
export class ConvexLink implements RoomLink {
  private client: ConvexClient;
  /** The client's calls, taking refusals answered (ADR 0046): a refusal still arrives as its ConvexError. */
  private room: ReturnType<typeof acceptingRefusals>;
  private token: string;
  private afterSeq: number;
  private unsubscribe?: () => void;
  private heartbeat?: ReturnType<typeof setInterval>;
  private handler?: (message: RoomMessage) => void | Promise<void>;
  private work = Promise.resolve();
  private closed = false;
  private halted = false;
  private options: {
    afterSeq?: number;
    onCursor?: (seq: number) => Promise<void>;
    onError?: (error: unknown) => void;
  };
  constructor(
    url: string,
    token: string,
    options: {
      afterSeq?: number;
      onCursor?: (seq: number) => Promise<void>;
      onError?: (error: unknown) => void;
    } = {},
  ) {
    this.client = new ConvexClient(url);
    this.room = acceptingRefusals(this.client);
    this.token = token;
    this.afterSeq = options.afterSeq ?? 0;
    this.options = options;
  }
  static async pair(url: string, args: { code: string; hostname: string; os: string }) {
    const client = new ConvexClient(url);
    try {
      return await acceptingRefusals(client).mutation(pairRef, args);
    } finally {
      await client.close();
    }
  }
  async send(message: BridgeMessage) {
    if (this.closed) throw new Error("Room link is closed");
    return await this.room.mutation(sendRef, {
      token: this.token,
      messages: [JSON.parse(JSON.stringify(message))],
    });
  }
  async claimRunMessages(request: RunMessageClaimRequest) {
    if (this.closed) throw new Error("Room link is closed");
    return await this.room.mutation(claimRunMessagesRef, { token: this.token, ...request });
  }
  async holdRunMessages(request: { claimId: string; deliveryIds: string[] }) {
    if (this.closed) throw new Error("Room link is closed");
    return await this.room.mutation(holdRunMessagesRef, { token: this.token, ...request });
  }
  async say(request: RunSay) {
    if (this.closed) throw new Error("Room link is closed");
    return await this.room.mutation(runSayRef, { token: this.token, ...request });
  }
  async attachUrl(ref: RunRef) {
    if (this.closed) throw new Error("Room link is closed");
    return await this.room.mutation(runAttachUrlRef, { token: this.token, ...ref });
  }
  onMessage(handler: (message: RoomMessage) => void | Promise<void>) {
    this.handler = handler;
    this.subscribe();
    this.heartbeat ??= setInterval(() => {
      if (this.closed || this.halted) return;
      this.room.mutation(heartbeatRef, { token: this.token }).catch((error: unknown) => {
        // A missed heartbeat is harmless; only a token the room rejected stops the bridge.
        const code = (error as { data?: { code?: string } }).data?.code;
        if (code !== "unauthenticated" && code !== "forbidden") return;
        this.halted = true;
        this.unsubscribe?.();
        this.options.onError?.(error);
      });
    }, HEARTBEAT_MS);
  }
  private subscribe() {
    this.unsubscribe?.();
    if (this.closed || this.halted) return;
    this.unsubscribe = this.room.onUpdate(
      inboxRef,
      { token: this.token, afterSeq: this.afterSeq },
      (inbox) => {
        this.work = this.work
          .then(async () => {
            if (this.closed || this.halted) return;
            let advanced = false;
            for (const item of [...inbox.messages].sort((a, b) => a.seq - b.seq)) {
              if (this.closed || this.halted || item.seq <= this.afterSeq) continue;
              await this.handler!(item.message);
              this.afterSeq = item.seq;
              advanced = true;
              await this.options.onCursor?.(this.afterSeq);
            }
            if (advanced) {
              await this.room.mutation(ackRef, { token: this.token, upToSeq: this.afterSeq });
              this.subscribe();
            }
          })
          .catch((error) => {
            this.halted = true;
            this.unsubscribe?.();
            this.options.onError?.(error);
          });
      },
      (error) => {
        this.halted = true;
        this.unsubscribe?.();
        this.options.onError?.(error);
      },
    );
  }
  async close() {
    this.closed = true;
    clearInterval(this.heartbeat);
    this.unsubscribe?.();
    await this.client.close();
    // Closing the client doesn't settle a mutation still in flight, so a command stuck on one
    // would hold shutdown forever. Wait for it only briefly.
    await Promise.race([this.work, new Promise((resolve) => setTimeout(resolve, CLOSE_WAIT_MS).unref())]);
  }
}
