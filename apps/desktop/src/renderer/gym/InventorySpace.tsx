import type { TableNames } from "@uplink-room/backend/dataModel";
import type { Id, MemberRow } from "../lib/api";
import { SpaceScreen, type SpaceScreenProps, type Stage } from "../views/SpaceView";

export function InventorySpace({ scene }: { scene: string }) {
  const id = <T extends TableNames>(value: string) => value as Id<T>;
  const julio = { memberId: id<"members">("m_julio"), name: "Rosa Vega", kind: "person" as const };
  const ana = { memberId: id<"members">("m_ana"), name: "Ana", kind: "person" as const };
  const codex = {
    memberId: id<"members">("m_codex"),
    name: "Playtester",
    kind: "agent" as const,
    addedBy: { memberId: julio.memberId, name: "Rosa Vega" },
  };
  const members = [
    { ...julio, role: "admin" },
    { ...ana, role: "member" },
    { ...codex, role: "member", character: { body: "round", color: "#9db0d8" } },
  ] as unknown as MemberRow[];

  const who = scene === "watcher" ? "ana" : "julio";
  const me = who === "julio" ? julio.memberId : ana.memberId;
  const driver = julio;
  const access = "drive" as SpaceScreenProps["space"]["access"];
  const now = Date.parse("2026-11-02T19:24:00Z");

  const space: SpaceScreenProps["space"] = {
    spaceId: id<"spaces">("s_studio"),
    spaceRef: "local:playtest",
    name: "Playtest",
    os: "linux",
    kind: "container",
    status: scene === "ended" ? "ended" : "live",
    failReason: undefined,
    power: scene === "stopped" ? "stopped" : "running",
    access,
    loweredFrom: false ? "open" : undefined,
    machine: { machineId: id<"machines">("mc_box"), name: "studio-mac", mostOpenAccess: "drive" },
    sharedBy: julio,
    driver,
    watching: [julio, ana],
    runId: undefined,
    endedAt: undefined,
  };

  const frameUrl = "data:text/html,%3Ch1%3ESample%20Space%3C/h1%3E";
  const stages: Record<string, Stage> = {
    failed: { kind: "failed", reason: "Sample connection ended." },
    ready: { kind: "ready", frameUrl, interactive: driver.memberId === me },
    watcher: { kind: "ready", frameUrl, interactive: false },
    opening: { kind: "opening", note: "Control moved. Reopening the Space…" },
    unreachable: { kind: "unreachable", machine: "studio-mac" },
    ended: { kind: "ended" },
    stopped: { kind: "stopped", power: "stopped", machine: "studio-mac" },
  };

  const props: SpaceScreenProps = {
    space,
    me,
    members,
    ownsMachine: who === "julio",
    stage: stages[scene ?? "ready"] ?? stages["ready"]!,
    wheelRequests:
      who === "julio" ? [{ requestId: id<"spaceWheelRequests">("w1"), from: ana }] : [],
    suggestions: [
      {
        suggestionId: id<"spaceSuggestions">("g1"),
        text: "Open the game from the dock, then try the second level",
        from: ana,
      },
    ],
    actions: [
      {
        actionId: id<"spaceActions">("a4"),
        action: { kind: "key", keys: ["ctrl", "s"] },
        status: "done",
        error: undefined,
        by: codex,
        at: now - 20_000,
      },
      {
        actionId: id<"spaceActions">("a3"),
        action: { kind: "type", text: "level-2" },
        status: "done",
        error: undefined,
        by: codex,
        at: now - 40_000,
      },
      {
        actionId: id<"spaceActions">("a2"),
        action: { kind: "click", x: 412, y: 180, screenshotId: "shot-1" },
        status: "failed",
        error: "not_driver",
        by: codex,
        at: now - 60_000,
      },
      {
        actionId: id<"spaceActions">("a1"),
        action: { kind: "screenshot" },
        status: "done",
        error: undefined,
        by: codex,
        at: now - 80_000,
      },
    ],
    on: {
      back() {},
      retry() {},
      setAccess(level) {
        void level;
      },
      takeWheel() {},
      requestWheel() {},
      passWheel() {},
      answerWheel() {},
      suggest: async () => true,
      answerSuggestion() {},
      stopSharing() {},
    },
  };

  return (
    <main className="main" style={{ height: "100vh" }}>
      <SpaceScreen {...props} />
    </main>
  );
}
