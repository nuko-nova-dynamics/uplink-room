/**
 * A scripted T3 Code server for tests: the pairing exchange, socket tickets, and Effect RPC JSON
 * frames over `/ws`, with only the methods the bridge uses. Like T3's server, it sends a stream's
 * next chunk only after the client acks the last one.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

export const PAIRING_TOKEN = "pairing-token";
const TICKET = "socket-ticket";

export interface FakeThread {
  id: string;
  projectId: string;
  title: string;
  status: string;
  activeRunId?: string | null;
  pendingRuntimeRequest?: { id: string; kind: string } | null;
  archivedAt?: string | null;
  deletedAt?: string | null;
  /** The T3 Code provider instance running it; absent, `codex_px`. */
  providerInstanceId?: string;
  /** What its agent may do without asking (ADR 0043); absent, `approval-required`. */
  runtimeMode?: string;
}
export interface FakeProjection {
  /** Set once a thread is archived or deleted; a read of either still returns the thread. */
  thread?: { id: string; archivedAt: string | null; deletedAt: string | null };
  runtimeRequests: { id: string; kind: string; status: string; responseCapability: { type: string }; decision?: string }[];
  turnItems: Record<string, unknown>[];
  runs?: { id: string; status: string; providerThreadId?: string; activeAttemptId?: string }[];
  checkpoints?: { id: string; appRunOrdinal: number | null }[];
  /** The provider's side of a thread (contracts orchestrationV2.ts), whose session says how its turns steer. */
  providerThreads?: { id: string; providerSessionId: string | null }[];
  providerSessions?: { id: string; providerInstanceId: string; updatedAt: string; capabilities: { turns: Record<string, unknown> } }[];
  providerTurns?: { runAttemptId: string; status: string }[];
  /** The bounded snapshot's own rows; absent, every turn item is one. */
  visibleTurnItems?: { visibility: string; item: Record<string, unknown> }[];
}
type Sub = { socket: WebSocket; id: string; queue: unknown[]; waiting: boolean };

export class FakeT3 {
  url = "";
  projects = [
    {
      id: "project-1",
      title: "Billing",
      workspaceRoot: "/work/billing",
      repositoryIdentity: { canonicalKey: "github.com/nuko/billing" },
      defaultModelSelection: null,
    },
  ];
  providers = [
    {
      instanceId: "codex_px",
      driver: "codex",
      enabled: true,
      installed: true,
      status: "ready",
      supportedRuntimeModes: ["approval-required", "full-access"],
      models: [
        { slug: "old-model", isLegacy: true },
        { slug: "gpt-6.1-sol", isDefault: true },
      ],
    },
    { instanceId: "claude", driver: "claudeAgent", enabled: false, installed: true, status: "disabled", models: [{ slug: "opus" }] },
  ];
  threads = new Map<string, FakeThread>();
  projections = new Map<string, FakeProjection>();
  /** Every command the bridge dispatched, and every thread it launched. */
  commands: Record<string, unknown>[] = [];
  launches: Record<string, unknown>[] = [];
  /** Scopes and labels of every pairing exchange. */
  exchanges: URLSearchParams[] = [];
  /** The bearer sessions T3 accepts; each pairing exchange mints one. */
  sessions = new Set<string>();
  /** Every socket ticket asked for, with the bearer it was asked with. */
  tickets: string[] = [];
  environmentId = "env-fake-1";
  /** Thread subscriptions, by thread id. */
  threadSubs: (Sub & { threadId: string })[] = [];
  /** Request ids the client interrupted. */
  interrupts: string[] = [];
  /** What `subscribeThread`'s snapshot says about older history, by thread id. */
  moreHistory = new Map<string, boolean>();
  /** Every turn item the history route can page through, oldest first, by thread id. */
  history = new Map<string, Record<string, unknown>[]>();
  /** The cursors the history route was asked with, decoded. */
  historyCursors: Record<string, unknown>[] = [];
  /** When set, the history route answers only once it settles. */
  historyGate: Promise<unknown> | undefined;
  /** Turn diffs by `threadId:from-to`. */
  diffs = new Map<string, string>();
  /** A recorded `subscribeThread` stream to replay as it came, by thread id (test/recordings). */
  threadStreams = new Map<string, unknown[]>();
  /** Command types `dispatchCommand` refuses, as T3 does while it restarts. */
  failCommands = new Set<string>();
  /**
   * Attachment uploads (ADR 0043), as T3 Code's `attachments.createUploadUrl` and its signed upload
   * route take them: what was asked for, and the bytes once they were posted.
   */
  uploads: { attachmentId: string; token: string; type: string; name: string; mimeType: string; sizeBytes: number; body?: Buffer }[] = [];
  /** Thread ids whose projection read fails. */
  failReads = new Set<string>();
  /** When set, a projection read is answered only once it settles. */
  projectionGate: Promise<unknown> | undefined;
  /** How many projection reads came in, answered or not. */
  projectionReads = 0;
  /** While true, a new shell subscription gets no snapshot until `releaseSnapshot`. */
  holdSnapshot = false;
  private held: { socket: WebSocket; id: string; queue: unknown[]; waiting: boolean }[] = [];
  private shells: { socket: WebSocket; id: string; queue: unknown[]; waiting: boolean }[] = [];
  private server = createServer((req, res) => void this.http(req, res));
  private wss = new WebSocketServer({ noServer: true });

  /** True once a client subscribed to the shell. */
  get subscribed() {
    return this.shells.length + this.held.length > 0;
  }
  async start() {
    this.server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://fake");
      if (url.pathname !== "/ws" || url.searchParams.get("wsTicket") !== TICKET || url.searchParams.get("orchestrationProtocol") !== "2") {
        socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.connected(ws));
    });
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  async close() {
    for (const client of this.wss.clients) client.terminate();
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
  private async http(req: IncomingMessage, res: ServerResponse) {
    let body = "";
    for await (const chunk of req) body += (chunk as Buffer).toString("latin1");
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "POST" && req.url === "/oauth/token") {
      const form = new URLSearchParams(body);
      this.exchanges.push(form);
      if (form.get("subject_token") !== PAIRING_TOKEN) return json(401, { error: "invalid_grant" });
      const bearer = `bearer-${this.exchanges.length}`;
      this.sessions.add(bearer);
      return json(200, {
        access_token: bearer,
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 2592000,
        scope: form.get("scope"),
      });
    }
    const historyRoute = req.method === "GET" ? /^\/api\/orchestration\/threads\/([^/]+)\/history\?cursor=(.+)$/.exec(req.url ?? "") : null;
    if (historyRoute) {
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!this.sessions.has(bearer) || req.headers["x-t3-orchestration-protocol"] !== "2") return json(401, {});
      const threadId = decodeURIComponent(historyRoute[1]!);
      const cursor = JSON.parse(Buffer.from(decodeURIComponent(historyRoute[2]!), "base64url").toString("utf8")) as { si: string };
      this.historyCursors.push(cursor);
      await this.historyGate;
      const all = this.history.get(threadId) ?? [];
      const end = all.findIndex((item) => item.id === cursor.si);
      const before = end < 0 ? [] : all.slice(0, end);
      const page = before.slice(-50);
      return json(200, {
        snapshotSequence: 7,
        items: page.map((item, position) => ({ position, visibility: "local", sourceThreadId: threadId, sourceItemId: item.id, item })),
        nextCursor: null,
        hasMoreHistory: before.length > page.length,
      });
    }
    const upload = req.method === "POST" ? /^\/api\/attachments\/upload\/([^/?]+)$/.exec(req.url ?? "") : null;
    if (upload) {
      // Like T3 Code's route: the signed path is the credential, and Content-Length must match.
      const ticket = this.uploads.find((u) => u.token === upload[1]);
      const bytes = Buffer.from(body, "latin1");
      if (!ticket) return json(404, {});
      if (Number(req.headers["content-length"]) !== ticket.sizeBytes || bytes.byteLength !== ticket.sizeBytes) return json(400, {});
      ticket.body = bytes;
      res.writeHead(204);
      return res.end();
    }
    if (req.method === "POST" && req.url === "/api/auth/websocket-ticket/rpc") {
      const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      this.tickets.push(bearer);
      if (!this.sessions.has(bearer)) return json(401, { error: "unauthorized" });
      return json(200, { ticket: TICKET, expiresAt: new Date(Date.now() + 60000).toISOString() });
    }
    json(404, {});
  }
  private connected(socket: WebSocket) {
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as { _tag: string; id: string; requestId: string; tag: string; payload: any };
      if (message._tag === "Ping") return socket.send(JSON.stringify({ _tag: "Pong" }));
      if (message._tag === "Ack") {
        const shell = [...this.shells, ...this.threadSubs].find((s) => s.socket === socket && s.id === message.requestId);
        if (shell) {
          shell.waiting = false;
          this.flush(shell);
        }
        return;
      }
      if (message._tag === "Interrupt") {
        this.interrupts.push(String(message.requestId));
        this.threadSubs = this.threadSubs.filter((s) => !(s.socket === socket && s.id === String(message.requestId)));
        return;
      }
      if (message._tag === "Request") this.request(socket, message.id, message.tag, message.payload);
    });
    socket.on("close", () => {
      this.shells = this.shells.filter((s) => s.socket !== socket);
      this.threadSubs = this.threadSubs.filter((s) => s.socket !== socket);
      this.held = this.held.filter((s) => s.socket !== socket);
    });
  }
  private request(socket: WebSocket, id: string, tag: string, payload: any) {
    const succeed = (value: unknown) =>
      socket.send(JSON.stringify({ _tag: "Exit", requestId: id, exit: { _tag: "Success", value } }));
    const fail = (error: Record<string, unknown>) =>
      socket.send(JSON.stringify({ _tag: "Exit", requestId: id, exit: { _tag: "Failure", cause: [{ _tag: "Fail", error }] } }));
    switch (tag) {
      case "server.getConfig":
        return succeed({
          providers: this.providers,
          environment: { environmentId: this.environmentId, capabilities: { threadStop: true } },
        });
      case "orchestration.subscribeShell": {
        const shell = { socket, id, queue: [] as unknown[], waiting: false };
        if (this.holdSnapshot) return void this.held.push(shell);
        this.shells.push(shell);
        return this.snapshot(shell);
      }
      case "orchestration.subscribeThread": {
        const sub = { socket, id, queue: [] as unknown[], waiting: false, threadId: payload.threadId as string };
        this.threadSubs.push(sub);
        const recorded = this.threadStreams.get(payload.threadId);
        if (recorded) {
          sub.queue.push(...recorded);
          return this.flush(sub);
        }
        const projection = this.projections.get(payload.threadId) ?? { runtimeRequests: [], turnItems: [] };
        sub.queue.push({
          kind: "snapshot",
          snapshotSequence: 7,
          projection: {
            runs: [],
            checkpoints: [],
            ...projection,
            visibleTurnItems:
              projection.visibleTurnItems ?? projection.turnItems.map((item) => ({ visibility: "local", item })),
          },
          hasMoreHistory: this.moreHistory.get(payload.threadId) ?? false,
        });
        return this.flush(sub);
      }
      case "orchestration.getTurnDiff": {
        const diff = this.diffs.get(`${payload.threadId}:${payload.fromTurnCount}-${payload.toTurnCount}`);
        return diff === undefined
          ? fail({ _tag: "OrchestrationV2CheckpointUnavailableError", message: "No checkpoint for that turn." })
          : succeed({ threadId: payload.threadId, fromTurnCount: payload.fromTurnCount, toTurnCount: payload.toTurnCount, diff });
      }
      case "orchestration.getThreadProjection": {
        this.projectionReads++;
        const answer = () => {
          const projection = this.failReads.has(payload.threadId) ? undefined : this.projections.get(payload.threadId);
          return projection
            ? succeed(projection)
            : fail({ _tag: "OrchestrationV2GetThreadProjectionError", message: "Thread not found." });
        };
        if (this.projectionGate) return void this.projectionGate.then(answer);
        return answer();
      }
      case "attachments.createUploadUrl": {
        const n = this.uploads.length + 1;
        const ticket = { attachmentId: `pending-${n}`, token: `upload-token-${n}`, type: payload.type ?? "image", name: payload.name, mimeType: payload.mimeType, sizeBytes: payload.sizeBytes };
        this.uploads.push(ticket);
        return succeed({ attachmentId: ticket.attachmentId, relativeUrl: `/api/attachments/upload/${ticket.token}`, expiresAt: Date.now() + 600_000 });
      }
      case "orchestration.dispatchCommand": {
        if (this.failCommands.has(payload.type))
          return fail({ _tag: "OrchestrationV2DispatchCommandError", message: "T3 Code is restarting." });
        // T3 Code decodes the command first: message.dispatch needs its creation fields (seen live).
        if (payload.type === "message.dispatch" && (payload.createdBy === undefined || payload.creationSource === undefined))
          return fail({ _tag: "SchemaError", message: "Missing key" });
        this.commands.push(payload);
        if (payload.type === "runtime-request.respond") {
          const request = this.projections.get(payload.threadId)?.runtimeRequests.find((r) => r.id === payload.requestId);
          if (!request || request.status !== "pending")
            return fail({ _tag: "OrchestrationV2DispatchCommandError", message: "Request is not pending." });
          request.status = "resolved";
          this.update({ ...this.threads.get(payload.threadId)!, pendingRuntimeRequest: null });
        }
        if (payload.type === "thread.stop") this.update({ ...this.threads.get(payload.threadId)!, status: "interrupted" });
        if (payload.type === "thread.runtime-mode.set") this.update({ ...this.threads.get(payload.threadId)!, runtimeMode: payload.runtimeMode });
        return succeed({ sequence: this.commands.length });
      }
      case "orchestration.launchThread": {
        this.launches.push(payload);
        const provider = this.providers.find((p) => p.instanceId === payload.modelSelection.instanceId);
        if (!provider?.enabled)
          return fail({ _tag: "ThreadManagementProviderInstanceDisabledError", message: "Provider instance is disabled." });
        this.update({ id: payload.threadId, projectId: payload.projectId, title: payload.title, status: "running", activeRunId: "run-1", runtimeMode: payload.runtimeMode });
        return succeed({ threadId: payload.threadId, projection: {}, resumed: false });
      }
      default:
        return fail({ _tag: "UnknownMethod", message: `No fake for ${tag}` });
    }
  }
  /** Drops every client socket, as when T3 Code restarts. The server keeps listening, so the bridge reconnects. */
  dropConnections() {
    for (const client of this.wss.clients) client.terminate();
  }
  /**
   * Revokes every session, as Settings → Sharing & access does: open sockets close at once and
   * new tickets are refused (research/t3code-capabilities.md, live on 2026-11-04).
   */
  revokeAll() {
    this.sessions.clear();
    this.dropConnections();
  }
  /** Sends the held subscriptions their snapshot. */
  releaseSnapshot() {
    this.holdSnapshot = false;
    for (const shell of this.held.splice(0)) {
      this.shells.push(shell);
      this.snapshot(shell);
    }
  }
  private snapshot(shell: { socket: WebSocket; id: string; queue: unknown[]; waiting: boolean }) {
    shell.queue.push({ kind: "snapshot", snapshot: { projects: this.projects, threads: [...this.threads.values()].map(shellOf) } });
    this.flush(shell);
  }
  /**
   * T3 Code resolved some projects' repositories: it sends a snapshot with only those projects and
   * no threads, marked with the roots it resolved (ShellStream.ts `shellStreamItemFromEnrichmentRefresh`).
   */
  enrich(projects: FakeT3["projects"], roots: string[]) {
    this.push({ kind: "snapshot", snapshot: { projects, threads: [], archivedThreads: [] }, resolvedRepositoryIdentityRoots: roots });
  }
  /** Pushes an event to every subscription of a thread, as T3 Code's thread stream does. */
  pushThread(threadId: string, event: { type: string; payload: unknown }) {
    for (const sub of this.threadSubs.filter((s) => s.threadId === threadId)) {
      sub.queue.push({ kind: "event", sequence: 8, event });
      this.flush(sub);
    }
  }
  private flush(shell: { socket: WebSocket; id: string; queue: unknown[]; waiting: boolean }) {
    if (shell.waiting || !shell.queue.length) return;
    shell.waiting = true;
    shell.socket.send(JSON.stringify({ _tag: "Chunk", requestId: shell.id, values: [shell.queue.shift()] }));
  }
  private push(event: Record<string, unknown>) {
    for (const shell of this.shells) {
      shell.queue.push(event);
      this.flush(shell);
    }
  }
  /** Changes a thread, and pushes the change to every shell subscription. */
  update(thread: FakeThread) {
    this.threads.set(thread.id, thread);
    this.push({ kind: "thread.updated", sequence: 1, location: "active", thread: shellOf(thread) });
  }
  /**
   * T3 Code deletes a thread. The real server (apps/server orchestration-v2 `ThreadDeletion.ts`)
   * keeps the row with `deletedAt` set, and its shell stream (`ShellStream.ts`
   * `shellStreamItemFromThreadShell`) sends only `thread.removed` on the active list.
   */
  remove(id: string) {
    this.retire(id, { deletedAt: new Date().toISOString() });
  }
  /**
   * T3 Code archives a thread. The shell stream sends the same `thread.removed` on the active
   * list as for a delete (`shellStreamItemFromThreadShell` does so when `archivedAt` is set); only
   * a read of the thread, which still works, says it was archived.
   */
  archive(id: string) {
    this.retire(id, { archivedAt: new Date().toISOString() });
  }
  private retire(id: string, dates: { archivedAt?: string; deletedAt?: string }) {
    const projection = this.projections.get(id) ?? { runtimeRequests: [], turnItems: [] };
    this.projections.set(id, { ...projection, thread: { id, archivedAt: null, deletedAt: null, ...dates } });
    this.threads.delete(id);
    this.push({ kind: "thread.removed", sequence: 1, location: "active", threadId: id });
  }
}

function shellOf(thread: FakeThread) {
  return {
    activeRunId: null,
    pendingRuntimeRequest: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: thread.id },
    providerInstanceId: "codex_px",
    archivedAt: null,
    deletedAt: null,
    runtimeMode: "approval-required",
    ...thread,
  };
}
