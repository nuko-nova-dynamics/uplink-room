import { createRoot } from "react-dom/client";
import type { TableNames } from "@uplink-room/backend/dataModel";
import type { Id, MemberRow } from "./lib/api";
import { SpaceScreen, type SpaceScreenProps, type Stage } from "./views/SpaceView";
import "./styles.css";
import "./look.css";

/**
 * The Space view with sample data, for screenshots and e2e/space.spec.ts. Query parameters:
 * `as` (julio: drives and shared it; ana: a teammate watching; ana-driving), `stage` (ready,
 * opening, unreachable, ended), `access` (watch, suggest, drive, open) and `theme` (dark, light).
 * Every name, id and action here is sample data.
 */
const params = new URLSearchParams(location.search);
document.documentElement.dataset["theme"] = params.get("theme") === "light" ? "light" : "dark";
document.documentElement.dataset["density"] = "compact";

const id = <T extends TableNames>(value: string) => value as Id<T>;
const julio = { memberId: id<"members">("m_julio"), name: "Julio", kind: "person" as const };
const ana = { memberId: id<"members">("m_ana"), name: "Ana", kind: "person" as const };
const codex = {
  memberId: id<"members">("m_codex"),
  name: "Playtester",
  kind: "agent" as const,
  addedBy: { memberId: julio.memberId, name: "Julio" },
};
const members = [
  { ...julio, role: "admin" },
  { ...ana, role: "member" },
  { ...codex, role: "member", character: { body: "round", color: "#9db0d8" } },
] as unknown as MemberRow[];

const who = params.get("as") ?? "julio";
const me = who === "julio" ? julio.memberId : ana.memberId;
const driver = who === "ana-driving" ? ana : julio;
const access = (params.get("access") ?? "drive") as SpaceScreenProps["space"]["access"];
const now = Date.parse("2026-11-02T19:24:00Z");

const space: SpaceScreenProps["space"] = {
  spaceId: id<"spaces">("s_studio"),
  spaceRef: "local:playtest",
  name: "Playtest",
  os: "linux",
  kind: "container",
  status: params.get("stage") === "ended" ? "ended" : "live",
  failReason: undefined,
  power: params.get("stage") === "stopped" ? "stopped" : "running",
  access,
  loweredFrom: params.get("lowered") ? "open" : undefined,
  machine: { machineId: id<"machines">("mc_box"), name: "studio-mac", mostOpenAccess: "drive" },
  sharedBy: julio,
  driver,
  watching: [julio, ana],
  runId: undefined,
  endedAt: undefined,
};

const frameUrl = new URL("./space-sample.html", location.href).toString();
const stages: Record<string, Stage> = {
  ready: { kind: "ready", frameUrl, interactive: driver.memberId === me },
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
  stage: stages[params.get("stage") ?? "ready"] ?? stages["ready"]!,
  wheelRequests: who === "julio" ? [{ requestId: id<"spaceWheelRequests">("w1"), from: ana }] : [],
  suggestions: [{ suggestionId: id<"spaceSuggestions">("g1"), text: "Open the game from the dock, then try the second level", from: ana }],
  actions: [
    { actionId: id<"spaceActions">("a4"), action: { kind: "key", keys: ["ctrl", "s"] }, status: "done", error: undefined, by: codex, at: now - 20_000 },
    { actionId: id<"spaceActions">("a3"), action: { kind: "type", text: "level-2" }, status: "done", error: undefined, by: codex, at: now - 40_000 },
    { actionId: id<"spaceActions">("a2"), action: { kind: "click", x: 412, y: 180, screenshotId: "shot-1" }, status: "failed", error: "not_driver", by: codex, at: now - 60_000 },
    { actionId: id<"spaceActions">("a1"), action: { kind: "screenshot" }, status: "done", error: undefined, by: codex, at: now - 80_000 },
  ],
  on: {
    back() {},
    retry() {},
    setAccess(level) {
      document.body.dataset["lastAction"] = `setAccess:${level}`;
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

createRoot(document.getElementById("root")!).render(
  <main className="main" style={{ height: "100vh" }}>
    <SpaceScreen {...props} />
  </main>,
);
