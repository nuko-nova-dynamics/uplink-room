/**
 * Spaces on this machine (spec #6, ADR 0009): which are shared, who drives each, and the views
 * open on them. The rules mirror the terminals' and are enforced here whatever the room asks:
 *  - only Spaces Cua knows on this machine are shared, at most at the machine's own limit;
 *  - only the driver the bridge knows gets an interactive view or has a Space action run;
 *  - below Drive the wheel only goes back to whoever shared the Space;
 *  - when the wheel moves, every interactive view but the new driver's is cut.
 *
 * Taking access away never waits for Cua. Messages are handled in order, but whatever needs Cua
 * (connecting a Space, minting a viewer ticket, running a Space action) runs on its own, so a
 * slow Cua can't hold back a `space_driver_changed`, `unshare_space` or `stop_sharing` behind
 * it. Each piece of Cua work checks again, when it finishes, that it's still allowed.
 */
import {
  accessRank,
  minAccess,
  type Access,
  type ActorRef,
  type BridgeMessage,
  type FoundSpace,
  type MachineLimits,
  type RoomMessageOf,
  type SpacePower,
} from "@uplink-room/protocol";
import type { SpaceGateway } from "./gateway.ts";
import { SpaceError, type SpaceEndpoint, type SpaceHost } from "./host.ts";

export type SpaceRoomMessage = RoomMessageOf<
  | "share_space"
  | "unshare_space"
  | "change_space_access"
  | "space_driver_changed"
  | "open_space_view"
  | "close_space_view"
  | "space_action"
>;

const SPACE_ROOM_MESSAGES = new Set<string>([
  "share_space",
  "unshare_space",
  "change_space_access",
  "space_driver_changed",
  "open_space_view",
  "close_space_view",
  "space_action",
]);

export function isSpaceMessage(message: { type: string }): message is SpaceRoomMessage {
  return SPACE_ROOM_MESSAGES.has(message.type);
}

/** How long a viewer ticket may still be used to attach, and how long before that it's renewed. */
const TICKET_TTL_SECONDS = 300;
const RENEW_BEFORE_MS = 60_000;
const DISCOVERY_MS = 30_000;

interface View {
  key: string;
  memberId: string;
  name: string;
  interactive: boolean;
  /** Renews the view's ticket before it expires. */
  renewal?: ReturnType<typeof setTimeout>;
}

interface Shared {
  spaceId: string;
  spaceRef: string;
  /** Set once connected; replaced when the Space runs again after a stop. */
  endpoint?: SpaceEndpoint;
  /** Settles once the latest connect finished (or failed). Never rejects. */
  ready: Promise<void>;
  /** Whether `space_shared` went out. */
  announced: boolean;
  /** The power state the room was told: running only once the Space was reached at its latest start. */
  power: SpacePower;
  /** What Cua last said about it, which can run ahead of `power` while a reconnect is pending. */
  observed: SpacePower;
  /** Bumped on every stop or start Cua is seen to make; a reconnect commits only for the latest. */
  generation: number;
  access: Access;
  sharedBy: ActorRef;
  driver?: ActorRef;
  views: Map<string, View>;
  /** Space actions run one after another, in the order the room sent them. */
  actions: Promise<void>;
  /** A reconnect after the Space ran again, while it's in flight. */
  resuming?: Promise<void>;
}

export interface SpaceSharingOptions {
  host: SpaceHost;
  gateway: SpaceGateway;
  emit: (message: BridgeMessage) => Promise<void> | void;
  limits: () => MachineLimits;
  /** How often to look for Spaces. 0 looks only when asked. */
  pollMs?: number;
  /** A viewer ticket's lifetime (300 s), and how long before it ends it's renewed (60 s). */
  ticketTtlSeconds?: number;
  renewBeforeMs?: number;
  onError?: (error: unknown) => void;
}

export class SpaceSharing {
  private shared = new Map<string, Shared>();
  private found: FoundSpace[] = [];
  private reported = "";
  private timer?: ReturnType<typeof setInterval>;
  private options: SpaceSharingOptions;
  private started = false;
  private discovering?: Promise<void>;
  constructor(options: SpaceSharingOptions) {
    this.options = options;
  }
  async start() {
    if (this.started) return;
    this.started = true;
    await this.options.gateway.start();
    await this.discover();
    const every = this.options.pollMs ?? DISCOVERY_MS;
    if (every > 0) {
      this.timer = setInterval(() => void this.discover().catch((error) => this.options.onError?.(error)), every);
      this.timer.unref();
    }
  }
  /** Runs Cua work outside the message queue; its errors are logged, never thrown at the queue. */
  private detach(work: Promise<unknown>) {
    void work.catch((error) => this.options.onError?.(error));
  }
  /** Lists Cua's Spaces, reports them when they changed, and follows shared ones that stopped, started or went away. */
  discover(): Promise<void> {
    // One listing at a time: a share and the timer asking together see the same answer.
    this.discovering ??= this.list().finally(() => {
      this.discovering = undefined;
    });
    return this.discovering;
  }
  private async list() {
    let spaces: FoundSpace[];
    try {
      spaces = (await this.options.host.list()).map((s) => ({
        spaceRef: s.spaceRef,
        name: s.name,
        ...(s.os ? { os: s.os } : {}),
        ...(s.kind ? { kind: s.kind } : {}),
        state: s.state,
      }));
    } catch {
      // Cua isn't installed or didn't answer: keep the last list rather than end every Space.
      return;
    }
    this.found = spaces;
    const report = JSON.stringify(spaces);
    if (report !== this.reported) {
      this.reported = report;
      await this.options.emit({ v: 1, type: "spaces_found", spaces });
    }
    for (const space of this.shared.values()) {
      if (!space.announced) continue;
      const now = spaces.find((s) => s.spaceRef === space.spaceRef);
      if (!now) {
        await this.end(space, "gone");
        continue;
      }
      const state = now.state ?? "running";
      if (state !== space.observed) await this.observe(space, state);
      // Running in Cua but not reached yet (an earlier reconnect failed): try again.
      else if (state === "running" && space.power !== "running") this.reconnect(space);
    }
  }
  /** Cua stopped, suspended or started a shared Space. */
  private async observe(space: Shared, state: SpacePower) {
    space.observed = state;
    space.generation++;
    if (state === "running") return this.reconnect(space);
    // A reconnect in flight sees the new generation and gives up: a stop wins. The room hears of
    // a stop only when its state changes, so a stop during a reconnect isn't said twice.
    if (space.power === state) return;
    space.power = state;
    // Its cua-spacesd is gone; nobody stays attached to it.
    this.closeViews(space, () => true);
    await this.options.emit({ v: 1, type: "space_power", spaceId: space.spaceId, state });
  }
  /**
   * Reaches a Space that runs again (a restarted Space can come back on another address), and
   * only then says it runs. One reconnect at a time: a start seen while one is in flight is
   * picked up by it when its lookup settles, since that lookup belongs to an older generation and
   * is thrown away. A failed reconnect is tried again on the next look. So "running" is said
   * once per start that was reached, and views and actions use the latest address.
   */
  private reconnect(space: Shared) {
    if (space.resuming) return;
    const attempt = (async () => {
      while (this.shared.get(space.spaceId) === space && space.observed === "running" && space.power !== "running") {
        const generation = space.generation;
        const endpoint = await this.connect(space);
        if (this.shared.get(space.spaceId) !== space) return;
        // Cua stopped or started it again while this looked it up: try the latest, if it runs.
        if (space.generation !== generation) continue;
        if (!endpoint) return;
        space.endpoint = endpoint;
        space.power = "running";
        await this.options.emit({ v: 1, type: "space_power", spaceId: space.spaceId, state: "running" });
        return;
      }
    })().finally(() => {
      space.resuming = undefined;
    });
    space.resuming = attempt;
    space.ready = attempt;
    this.detach(attempt);
  }
  private clamp(access: Access) {
    return minAccess(access, this.options.limits().mostOpenAccess);
  }
  private closeViews(space: Shared, which: (view: View) => boolean) {
    for (const [viewId, view] of space.views) {
      if (!which(view)) continue;
      clearTimeout(view.renewal);
      this.options.gateway.close(view.key);
      space.views.delete(viewId);
    }
  }
  /**
   * Renews a view's viewer ticket a while before it expires, for as long as the view is open. A
   * ticket only has to be valid when the video socket attaches, but a viewer that loses its socket
   * after five minutes must be able to attach again without leaving the Space. The route keeps
   * its key and path and only its ticket changes, so the open socket isn't touched.
   */
  private scheduleRenewal(space: Shared, viewId: string, view: View, expiresAt: number) {
    clearTimeout(view.renewal);
    const before = this.options.renewBeforeMs ?? RENEW_BEFORE_MS;
    view.renewal = setTimeout(
      () => this.detach(this.renew(space, viewId, view)),
      Math.max(1000, Math.min(2147483647, expiresAt - before - Date.now())),
    );
    view.renewal.unref();
  }
  private async renew(space: Shared, viewId: string, view: View) {
    const current = () => this.shared.get(space.spaceId) === space && space.views.get(viewId) === view;
    // An interactive view of someone who no longer drives is cut when the wheel moves; never renew one.
    if (!current() || this.refusal(space) || (view.interactive && space.driver?.memberId !== view.memberId)) return;
    try {
      const ticket = await this.options.host.viewerTicket(space.endpoint!, {
        interactive: view.interactive,
        principal: { id: view.memberId, name: view.name, kind: "human" },
        ttlSeconds: this.options.ticketTtlSeconds ?? TICKET_TTL_SECONDS,
      });
      if (!current() || this.refusal(space) || (view.interactive && space.driver?.memberId !== view.memberId)) return;
      this.options.gateway.renew(view.key, ticket.ticket);
      this.scheduleRenewal(space, viewId, view, ticket.expiresAt);
      await this.options.emit({ v: 1, type: "space_view_renewed", spaceId: space.spaceId, viewId, expiresAt: ticket.expiresAt });
    } catch (error) {
      // Try once more shortly; the current ticket may still have a minute left.
      if (current()) this.scheduleRenewal(space, viewId, view, Date.now() + (this.options.renewBeforeMs ?? RENEW_BEFORE_MS) + 5000);
      this.options.onError?.(error);
    }
  }
  /**
   * Handles one room message. Anything that takes access away is done before this returns;
   * anything that needs Cua is started and left to finish on its own.
   */
  async receive(message: SpaceRoomMessage, sharing: boolean) {
    if (message.type === "share_space") {
      if (!sharing) return this.options.emit({ v: 1, type: "space_share_failed", spaceId: message.spaceId, reason: "sharing_stopped" });
      return this.share(message);
    }
    const space = this.shared.get(message.spaceId);
    if (message.type === "open_space_view") {
      if (space && sharing) return this.detach(this.openView(space, message));
      return this.options.emit({
        v: 1,
        type: "space_view_failed",
        spaceId: message.spaceId,
        viewId: message.viewId,
        reason: sharing ? "space_not_shared" : "sharing_stopped",
      });
    }
    if (message.type === "space_action") {
      if (space && sharing) {
        space.actions = space.actions.then(() => this.act(space, message)).catch((error) => this.options.onError?.(error));
        return;
      }
      return this.actionResult(message, false, { error: "space_not_shared" });
    }
    if (!space) return;
    switch (message.type) {
      case "unshare_space":
        return this.end(space, "stopped");
      case "change_space_access": {
        if (!["watch", "suggest", "drive", "open"].includes(message.access)) throw new Error("Invalid access");
        space.access = this.clamp(message.access);
        if (space.access !== message.access) {
          await this.options.emit({ v: 1, type: "space_access", spaceId: space.spaceId, access: space.access });
        }
        return;
      }
      case "space_driver_changed":
        return this.changeDriver(space, message.driver);
      case "close_space_view": {
        this.closeViews(space, (view) => view === space.views.get(message.viewId));
        return;
      }
    }
  }
  /**
   * Looks up how to reach a shared Space; the caller decides whether the answer is still current.
   * Undefined when it can't be reached (before the share was announced, the share is then over).
   */
  private async connect(space: Shared): Promise<SpaceEndpoint | undefined> {
    try {
      const endpoint = await this.options.host.connect(space.spaceRef);
      return this.shared.get(space.spaceId) === space ? endpoint : undefined;
    } catch (error) {
      if (this.shared.get(space.spaceId) !== space) return undefined;
      if (!space.announced) {
        this.shared.delete(space.spaceId);
        await this.options.emit({
          v: 1,
          type: "space_share_failed",
          spaceId: space.spaceId,
          reason: error instanceof SpaceError ? error.reason : "cua_failed",
        });
      }
      return undefined;
    }
  }
  private share(message: RoomMessageOf<"share_space">) {
    if (this.shared.has(message.spaceId)) return;
    if (!["watch", "suggest", "drive", "open"].includes(message.access)) throw new Error("Invalid access");
    // Registered now, so a view, action or unshare that follows finds it; connected on its own.
    const space: Shared = {
      spaceId: message.spaceId,
      spaceRef: message.spaceRef,
      ready: Promise.resolve(),
      announced: false,
      power: "running",
      observed: "running",
      generation: 0,
      access: this.clamp(message.access),
      sharedBy: message.sharedBy,
      driver: message.sharedBy,
      views: new Map(),
      actions: Promise.resolve(),
    };
    this.shared.set(space.spaceId, space);
    space.ready = (async () => {
      // Only a Space Cua knows on this machine, whatever id the room sends.
      await this.discover();
      if (this.shared.get(space.spaceId) !== space) return;
      const known = this.found.find((s) => s.spaceRef === space.spaceRef);
      if (!known) {
        this.shared.delete(space.spaceId);
        await this.options.emit({ v: 1, type: "space_share_failed", spaceId: space.spaceId, reason: "unknown_space" });
        return;
      }
      const endpoint = await this.connect(space);
      if (!endpoint) return;
      space.endpoint = endpoint;
      space.announced = true;
      await this.options.emit({
        v: 1,
        type: "space_shared",
        spaceId: space.spaceId,
        access: space.access,
        gateway: this.options.gateway.baseUrls(),
      });
      // The room keeps its own level on the acknowledgement (it may have been raised since), so
      // the bridge's clamp to the machine's limit is said on its own.
      const clamped = this.clamp(message.access);
      if (clamped !== message.access) await this.options.emit({ v: 1, type: "space_access", spaceId: space.spaceId, access: clamped });
      const power = known.state ?? "running";
      if (power !== "running") {
        space.power = power;
        space.observed = power;
        await this.options.emit({ v: 1, type: "space_power", spaceId: space.spaceId, state: power });
      }
    })();
    this.detach(space.ready);
  }
  private async changeDriver(space: Shared, next: ActorRef | undefined) {
    // Below Drive (after the local clamp) the wheel only goes back to whoever shared the Space.
    if (next && accessRank(space.access) < accessRank("drive") && next.memberId !== space.sharedBy.memberId) {
      await this.options.emit({
        v: 1,
        type: "space_rejected",
        spaceId: space.spaceId,
        memberId: next.memberId,
        reason: "driver_change_rejected",
      });
      return;
    }
    space.driver = next;
    // Input goes only to the driver: cut every interactive view that isn't theirs, now.
    this.closeViews(space, (view) => view.interactive && view.memberId !== next?.memberId);
  }
  /** Whether a view or action can go ahead on this Space now, or why not. */
  private refusal(space: Shared): string | undefined {
    if (this.shared.get(space.spaceId) !== space) return "space_not_shared";
    if (space.power !== "running") return "space_stopped";
    if (!space.endpoint) return "unreachable";
    return undefined;
  }
  private async openView(space: Shared, message: RoomMessageOf<"open_space_view">) {
    const failed = (reason: string) =>
      this.options.emit({ v: 1, type: "space_view_failed", spaceId: space.spaceId, viewId: message.viewId, reason });
    await space.ready;
    const before = this.refusal(space);
    if (before) return failed(before);
    const interactive = message.interactive && space.driver?.memberId === message.viewer.memberId;
    try {
      const ticket = await this.options.host.viewerTicket(space.endpoint!, {
        interactive,
        principal: { id: message.viewer.memberId, name: message.viewer.name, kind: "human" },
        ttlSeconds: this.options.ticketTtlSeconds ?? TICKET_TTL_SECONDS,
      });
      // The Space may have ended or stopped, or the wheel moved, while the ticket was minted.
      const after = this.refusal(space);
      if (after) return failed(after);
      if (interactive && space.driver?.memberId !== message.viewer.memberId) return failed("wheel_moved");
      this.closeViews(space, (view) => view === space.views.get(message.viewId));
      // The route works only with this ticket, so no older ticket gets more than this view.
      const key = this.options.gateway.open(space.endpoint!.url, ticket.ticket);
      const view: View = { key, memberId: message.viewer.memberId, name: message.viewer.name, interactive };
      space.views.set(message.viewId, view);
      this.scheduleRenewal(space, message.viewId, view, ticket.expiresAt);
      await this.options.emit({
        v: 1,
        type: "space_view_ready",
        spaceId: space.spaceId,
        viewId: message.viewId,
        path: `/v/${key}${ticket.viewerPath.startsWith("/") ? "" : "/"}${ticket.viewerPath}`,
        ticket: ticket.ticket,
        expiresAt: ticket.expiresAt,
        interactive,
      });
    } catch (error) {
      await failed(error instanceof SpaceError ? error.reason : "cua_failed");
    }
  }
  private actionResult(
    message: RoomMessageOf<"space_action">,
    ok: boolean,
    extra: { error?: string; screenshot?: Extract<BridgeMessage, { type: "space_action_result" }>["screenshot"] } = {},
  ) {
    return this.options.emit({ v: 1, type: "space_action_result", spaceId: message.spaceId, actionId: message.actionId, ok, ...extra });
  }
  private async act(space: Shared, message: RoomMessageOf<"space_action">) {
    await space.ready;
    // Checked when the action's turn comes, not when it arrived: the wheel may have moved since.
    const refused = this.refusal(space) ?? (space.driver?.memberId !== message.from.memberId ? "not_driver" : undefined);
    if (refused) return this.actionResult(message, false, { error: refused });
    try {
      const { screenshot } = await this.options.host.act(space.endpoint!, message.action);
      return this.actionResult(message, true, screenshot ? { screenshot } : {});
    } catch (error) {
      const text = error instanceof SpaceError && error.reason === "invalid_action" ? "invalid_action" : (error as Error).message;
      return this.actionResult(message, false, { error: text.slice(0, 500) });
    }
  }
  private async end(space: Shared, reason: "stopped" | "gone" | "bridge_stopped") {
    this.closeViews(space, () => true);
    this.shared.delete(space.spaceId);
    await this.options.emit({ v: 1, type: "space_ended", spaceId: space.spaceId, reason });
  }
  /** The machine's own limit changed: lower every shared Space above it. */
  async setLimits(limits: MachineLimits) {
    for (const space of this.shared.values()) {
      const access = minAccess(space.access, limits.mostOpenAccess);
      if (access !== space.access) {
        space.access = access;
        await this.options.emit({ v: 1, type: "space_access", spaceId: space.spaceId, access });
      }
    }
  }
  /** Ends every shared Space and cuts every view, before anything can yield. */
  stopAll(reason: "stopped" | "bridge_stopped") {
    const ended = [...this.shared.values()];
    for (const space of ended) this.closeViews(space, () => true);
    this.shared.clear();
    return Promise.all(ended.map((space) => this.options.emit({ v: 1, type: "space_ended", spaceId: space.spaceId, reason })));
  }
  async close() {
    clearInterval(this.timer);
    await this.options.gateway.stop();
  }
}
