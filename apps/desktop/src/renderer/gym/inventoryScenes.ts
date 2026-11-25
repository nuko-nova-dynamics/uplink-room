import harborPng from "./harbor.png?url&no-inline";
import harborPdf from "./harbor.pdf?url&no-inline";
import type { GymState } from "./states";
import type { World } from "./world";

/** Long labels retain ids and relationships, so the same screen remains reachable. */
function longLabels(w: World) {
  const extend = (v: unknown, key = ""): unknown => {
    if (Array.isArray(v)) return v.map((x) => extend(x));
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, extend(x, k)]));
    return typeof v === "string" && /^(name|title|text|summary|description|body|reason)$/.test(key)
      ? `${v} at the north harbor observation station with an unusually long descriptive name 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ`
      : v;
  };
  for (const [key, value] of w.table) w.table.set(key, extend(value));
}

function manyItems(w: World) {
  const people = w.addPeople(Array.from({ length: 35 }, (_, i) => `Harbor observer ${i + 1}`));
  w.addChannels(
    Array.from({ length: 35 }, (_, i) => `station-${i + 1}`),
    people,
  );
  for (const query of [
    "tasks:board",
    "activity:list",
    "invites:list",
    "projects:list",
    "profiles:mine",
    "files:list",
    "comments:list",
    "runs:unfiled",
  ]) {
    w.each(query, (value) => {
      if (!Array.isArray(value) || !value.length) return value;
      return [
        ...value,
        ...Array.from({ length: 30 }, (_, i) => ({
          ...value[i % value.length],
          ...Object.fromEntries(
            Object.entries(value[i % value.length])
              .filter(([k]) => k.endsWith("Id") && k !== "teamId")
              .map(([k, v]) => [k, `${v}-inventory-${i}`]),
          ),
        })),
      ];
    });
  }
  w.each("inbox:get", (value) =>
    Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, rows]) => [
        key,
        Array.isArray(rows) && rows.length
          ? Array.from({ length: 30 }, (_, i) => ({
              ...rows[i % rows.length],
              taskId: `${rows[i % rows.length].taskId}-inventory-${i}`,
            }))
          : rows,
      ]),
    ),
  );
}

/** A project with real file viewers and comments, using in-memory text and image bytes. */
function files(w: World) {
  const author = { memberId: w.me["memberId"], name: "Rosa Vega", kind: "person" };
  const rows = ["markdown", "html", "image", "pdf", "canvas"].map((format, i) => ({
    fileId: `inventory-file-${i}`,
    projectId: w.projectId,
    name: `Station notes.${["md", "html", "png", "pdf", "excalidraw"][i]}`,
    format,
    version: 1,
    size: 2048,
    openComments: 1,
    updatedAt: Date.now() - 120000,
    updatedBy: author,
    ...(format === "markdown"
      ? {
          content:
            "# Harbor stations\n\nReadings taken at **Bayview**.\n\n- North pier\n- South pier",
        }
      : {}),
    ...(format === "html"
      ? { content: "<h1>Harbor stations</h1><p>Readings taken at Bayview.</p>" }
      : {}),
    ...(format === "image"
      ? {
          contentType: "image/png",
          url: harborPng,
        }
      : {}),
    ...(format === "pdf"
      ? {
          contentType: "application/pdf",
          url: harborPdf,
        }
      : {}),
  }));
  // Keep recovery visible in both themes, independent of which scene ran first.
  const doc = rows[0]!;
  localStorage.setItem(
    `uplink.doc-draft.${doc.fileId}`,
    JSON.stringify({
      content: `${doc.content}\n\nCheck the tide gauge.`,
      base: doc.version,
      rev: "gym-doc-draft",
    }),
  );
  w.set("files:list", { projectId: w.projectId }, rows);
  for (const row of rows) {
    w.set("files:get", { fileId: row.fileId }, row);
    const comments = [
      {
        commentId: `inventory-comment-${row.fileId}`,
        body: "Check this station reading.",
        author,
        at: Date.now() - 60000,
        createdAt: Date.now() - 60000,
        replies: [],
        pin:
          row.format === "image"
            ? { kind: "spot", x: 0.4, y: 0.4 }
            : row.format === "markdown"
              ? { kind: "text", quote: "Bayview", prefix: "at ", suffix: "." }
              : row.format === "pdf"
                ? { kind: "page", page: 1, x: 0.4, y: 0.4 }
                : { kind: "point", x: 40, y: 40 },
        n: 1,
      },
    ];
    w.set("comments:list", { fileId: row.fileId }, comments);
    w.set("comments:list", { fileId: row.fileId, status: "open" }, comments);
    w.set("comments:list", { fileId: row.fileId, status: "resolved" }, []);
    w.set("canvas:scene", { fileId: row.fileId }, { elements: [], files: {} });
  }
}

/** A completed call with one proposal and transcript, using the normal channel renderer. */
function callNotes(w: World) {
  w.each("calls:list", (value) =>
    (value as Record<string, unknown>[]).map((call, index) => {
      if (index !== 0) return call;
      w.set(
        "calls:transcript",
        { callId: call.callId },
        {
          deleted: false,
          keptUntil: Date.now() + 7 * 86400000,
          lines: [
            {
              at: Number(call.startedAt),
              speaker: { memberId: w.me.memberId, name: w.me.name, kind: "person" },
              text: "Review the harbor readings before Thursday.",
            },
          ],
        },
      );
      return {
        ...call,
        hasTranscript: true,
        proposals: [
          {
            proposalId: "inventory-call-proposal",
            title: "Review the harbor readings",
            description: "Compare the new readings with the published table.",
            owner: { memberId: w.me.memberId, name: w.me.name, kind: "person" },
            status: "pending",
          },
        ],
      };
    }),
  );
}

export function inventoryScenes(base: readonly GymState[]): GymState[] {
  const scenes: GymState[] = [
    ...(["html-message", "update-ready"] as const).map((specimen) => ({
      id: `inventory-${specimen}`,
      title: `Inventory: ${specimen}`,
      isolation: "default" as const,
      specimen,
    })),
    ...(["default", "empty", "many"] as const).map((variant) => ({
      id: `inventory-machine-spaces-${variant}`,
      title: `Machine Spaces: ${variant}`,
      route: () => ({ name: "settings" as const, section: "machines" as const }),
      world: (w: World) => {
        // Keep the machine present: an empty machine list unmounts MachineSpaces.
        const machine = w.get<Record<string, unknown>[]>("machines:list")[0]!;
        const args = { machineId: machine.machineId };
        const found = w.get<Record<string, unknown>[]>("spaces:found", args)[0]!;
        const shared = w.get<Record<string, unknown>[]>("spaces:list", args)[0]!;
        const rows = Array.from(
          { length: variant === "empty" ? 0 : variant === "many" ? 12 : 1 },
          (_, i) => ({
            ...found,
            name: i === 0 ? found.name : `Harbor desktop ${i + 1}`,
            spaceId: `${found.spaceId}-${i}`,
            spaceRef: `${found.spaceRef}-${i}`,
          }),
        );
        w.set("spaces:found", args, rows);
        w.set(
          "spaces:list",
          args,
          rows.map((row) => ({ ...shared, ...row })),
        );
      },
    })),
    ...(["loading", "error"] as const).map((inviteOutcome) => ({
      id: `inventory-members-${inviteOutcome}`,
      title: `Members: invite request ${inviteOutcome}`,
      route: () => ({ name: "settings" as const, section: "members" as const }),
      inviteOutcome,
    })),
    {
      id: "inventory-members-reminders-off",
      title: "Members: reminders off",
      route: () => ({ name: "settings", section: "members" }),
      world: (w) =>
        w.each("teams:settings", (value) => ({ ...(value as object), inviteReminders: "off" })),
    },
    {
      id: "inventory-notifications-on",
      title: "Notifications: sounds and banners on",
      route: () => ({ name: "settings", section: "notifications" }),
      notificationsOn: true,
    },
    {
      id: "inventory-notifications-blocked",
      title: "Notifications: banners blocked by the operating system",
      route: () => ({ name: "settings", section: "notifications" }),
      notificationsOn: true,
      permissions: {
        microphone: "granted",
        camera: "granted",
        screen: "granted",
        notifications: "denied",
      },
    },
    ...(["on", "off"] as const).map((joined) => ({
      id: `inventory-notifications-email-${joined}`,
      title: `Notifications: email ${joined}`,
      route: () => ({ name: "settings" as const, section: "notifications" as const }),
      world: (w: World) =>
        w.set("members:emailNotifications", {}, { email: "rosa@example.test", joined }),
    })),
    {
      ...base.find((s) => s.id === "agent-dm-working")!,
      id: "inventory-run-mention",
      title: "Inventory: a run mentioned in a message",
      agent: "dm-mention",
    },
    {
      ...base.find((s) => s.id === "terminal-watcher")!,
      id: "inventory-terminal-ask",
      title: "Inventory: asking for terminal control",
      world: (w) => {
        const ana = w.member("Ana Ruiz");
        w.terminalSeen({
          driver: ana,
          startedBy: ana,
          access: "drive",
          watching: [ana, w.member("Rosa Vega")],
        });
      },
    },
    {
      ...base.find((s) => s.id === "task")!,
      id: "inventory-run-output",
      title: "Inventory: terminal output in a task",
      world: (w) =>
        w.set(
          "terminals:output",
          { terminalId: w.terminalId, afterSeq: 0, limit: 8 },
          w.get("terminals:output", { terminalId: w.terminalId, afterSeq: 0 }),
        ),
    },
    {
      ...base.find((s) => s.id === "thread-question")!,
      id: "inventory-thread-unanswered",
      title: "Inventory: a question waiting for two answers",
      world: (w) => {
        w.threadScene("question");
        const run = w.get<{ prompt: { questions: Record<string, unknown>[] } }>("runs:get", {
          runId: w.threadRunId,
        });
        w.set(
          "runs:get",
          { runId: w.threadRunId },
          {
            ...run,
            prompt: {
              ...run.prompt,
              questions: [
                ...run.prompt.questions,
                {
                  ...run.prompt.questions[0],
                  id: "next_step",
                  header: "Next step",
                  question: "Which station should run next?",
                },
              ],
            },
          },
        );
      },
    },
    {
      id: "inventory-agent-owned",
      title: "Inventory: an agent added by the current member",
      route: () => ({ name: "settings", section: "agents" }),
      world: (w) => {
        w.a2aAgent();
        w.set("agents:keys", { agentId: "gym-agents-icarus" }, [
          {
            keyId: "inventory-agent-key",
            name: "Sample workstation",
            prefix: "sample",
            createdAt: Date.now() - 60000,
            scopes: ["room.read"],
          },
        ]);
        w.each("teams:members", (value) =>
          (value as Record<string, unknown>[]).map((member) =>
            member.agentId === "gym-agents-icarus"
              ? { ...member, addedBy: { memberId: w.me.memberId, name: w.me.name } }
              : member,
          ),
        );
      },
    },
    {
      ...base.find((s) => s.id === "agent-dm-working")!,
      id: "inventory-agent-failed-line",
      title: "Inventory: failed agent run line",
      agent: "dm-failed-line",
    },
    {
      id: "inventory-call-notes",
      title: "Inventory: call proposals and transcript",
      route: (w) => ({ name: "channel", channelId: w.general as never }),
      world: callNotes,
    },
    {
      id: "inventory-pairs-many",
      title: "Inventory: many Pairs",
      route: () => ({ name: "pairs" }),
      pairs: "many",
    },
    ...["ready", "watcher", "opening", "unreachable", "failed", "ended", "stopped"].map(
      (inventoryVariant) => ({
        id: `inventory-space-${inventoryVariant}`,
        title: `Inventory Space: ${inventoryVariant}`,
        inventoryPage: "space" as const,
        inventoryVariant,
      }),
    ),
    ...[
      "default",
      "loading",
      "invalid",
      "expired",
      "used",
      "revoked",
      "member",
      "other",
      "overflow",
      "error",
    ].map((inventoryVariant) => ({
      id: `inventory-invite-${inventoryVariant}`,
      title: `Inventory invite: ${inventoryVariant}`,
      inventoryPage: "invite" as const,
      inventoryVariant,
    })),
    ...[
      "driver",
      "watcher",
      "watcher-asked",
      "start",
      "unset",
      "starting",
      "error",
      "many",
      "overflow",
    ].map((inventoryVariant) => ({
      id: `inventory-browser-${inventoryVariant}`,
      title: `Inventory browser: ${inventoryVariant}`,
      inventoryPage: "browser" as const,
      inventoryVariant,
    })),
    ...["default", "add"].map((inventoryVariant) => ({
      id: `inventory-cloud-${inventoryVariant}`,
      title: `Inventory cloud: ${inventoryVariant}`,
      inventoryPage: "cloud" as const,
      inventoryVariant,
    })),
    ...(["default", "disabled", "loading", "error", "empty", "overflow", "many"] as const).map(
      (isolation) => ({
        id: `inventory-controls-${isolation}`,
        title: `Inventory controls: ${isolation}`,
        isolation,
      }),
    ),
    {
      id: "inventory-files",
      title: "Inventory: project files and comments",
      route: (w) => ({ name: "project", projectId: w.projectId as never }),
      world: files,
    },
    {
      id: "inventory-unfiled",
      title: "Inventory: unfiled runs",
      world: (w) => {
        const task = w.get<{ runs: Record<string, unknown>[] }>("tasks:get", { taskId: w.taskId });
        const run = task.runs[0]!;
        w.set("runs:unfiled", {}, [
          {
            ...run,
            runId: "inventory-unfiled-run",
            title: "Review the harbor readings",
            suggestedProjects: [],
          },
        ]);
      },
      route: () => ({ name: "unfiled" }),
    },
  ];
  // Only data-bearing routes need larger sample worlds. Dialogs remain real interactions.
  const routes = [
    "inbox",
    "task",
    "project",
    "settings",
    "settings-members",
    "settings-profiles",
    "settings-agents",
    "settings-activity",
    "private",
    "terminal",
    "search",
    "inventory-files",
    "inventory-unfiled",
  ];
  for (const id of routes) {
    const original = [...base, ...scenes].find((s) => s.id === id)!;
    for (const variant of ["overflow", "many", "empty"] as const) {
      scenes.push({
        ...original,
        id: `inventory-${id.replace(/^inventory-/, "")}-${variant}`,
        title: `${original.title}: ${variant}`,
        world: (w) => {
          original.world?.(w);
          if (id === "settings-agents" && variant !== "empty") w.a2aAgent();
          if (id === "settings-profiles" && variant !== "empty") {
            const machine = w.get<Record<string, unknown>[]>("machines:list")[0]!;
            w.set("profiles:mine", {}, [
              {
                profileId: "gym-profile-harbor",
                name: "Harbor research login",
                machine: { machineId: machine.machineId, name: machine.name },
                status: "ready",
                expiresAt: Date.now() + 7 * 86_400_000,
              },
            ]);
          }
          if (variant === "overflow") longLabels(w);
          else if (variant === "many") manyItems(w);
          else {
            const projects = w.get("projects:list", {});
            const terminals = id === "terminal" ? w.get("terminals:list", {}) : undefined;
            const privateChannels =
              id === "private" ? w.channels.filter((c) => c.kind === "private") : undefined;
            w.empty();
            if (terminals) w.set("terminals:list", {}, terminals);
            if (privateChannels) w.set("channels:list", {}, [...w.channels, ...privateChannels]);
            if (id === "inventory-files" || id === "project") w.set("projects:list", {}, projects);
          }
        },
      });
    }
  }
  return scenes;
}
