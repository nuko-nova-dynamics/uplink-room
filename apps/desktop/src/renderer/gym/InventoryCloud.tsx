import {
  CloudMachineDialogView,
  CloudMachineView,
  StuckDeletesView,
  type CloudSettings,
  type CloudState,
} from "../views/settings/CloudMachine";

const now = Date.now();
const MINUTE = 60_000;

const base: CloudState = {
  state: "running",
  provider: "vercel",
  region: "iad1",
  vcpus: 2,
  idleMinutes: 15,
  resourceName: "uplink-k179b1tg",
  stateChangedAt: now - 20 * MINUTE,
  wakeReason: "work",
  stopReason: undefined,
  lastError: undefined,
  runningSince: now - 20 * MINUTE,
  stoppedAt: undefined,
  stopsIdleAt: now + 11 * MINUTE,
  sessionEndsAt: now + 40 * MINUTE,
  startsAfterStop: false,
  stopFailed: false,
};

const STOP_ERROR =
  "Couldn't stop the box at the provider after 6 tries, so it may still cost money. The room keeps trying every 5 minutes. Vercel answered 503: unavailable";

const states: { name: string; liveTerminals: number; cloud: CloudState }[] = [
  { name: "team-linux", liveTerminals: 0, cloud: base },
  {
    name: "team-linux",
    liveTerminals: 0,
    cloud: {
      ...base,
      state: "stopped",
      stopReason: "idle",
      stoppedAt: now - 2 * 60 * MINUTE,
      stopsIdleAt: undefined,
      runningSince: undefined,
    },
  },
  {
    name: "team-linux",
    liveTerminals: 1,
    cloud: { ...base, state: "starting", stopsIdleAt: undefined },
  },
  {
    name: "team-linux",
    liveTerminals: 0,
    cloud: {
      ...base,
      state: "failed",
      stopReason: "bridge_missing",
      stopsIdleAt: undefined,
      lastError:
        "The cloud machine started, but its bridge didn't come back within 5 minutes. Its boot log is ~/.uplink-room/boot.log on the machine.",
    },
  },
  {
    name: "team-linux",
    liveTerminals: 0,
    cloud: {
      ...base,
      state: "failed",
      stopReason: "idle",
      stopFailed: true,
      stopsIdleAt: undefined,
      lastError: STOP_ERROR,
    },
  },
];

const settings: CloudSettings = {
  deleting: [],
  notStopped: [],
  configured: false,
  missing: ["VERCEL_TOKEN", "VERCEL_PROJECT_ID"],
  envVars: ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID", "UPLINK_BRIDGE_TARBALL_URL"],
  provider: "vercel",
  region: "iad1",
  os: "linux",
  vcpus: 2,
  vcpuChoices: [1, 2, 4, 8],
  idleMinutes: 15,
};

const noop = async () => {};

export function InventoryCloud({ scene }: { scene: string }) {
  if (scene === "add") {
    return (
      <div className="app" style={{ padding: 24 }}>
        <CloudMachineDialogView settings={settings} create={noop} onClose={() => {}} />
      </div>
    );
  }
  return (
    <div
      className="app"
      style={{
        padding: 24,
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 16,
        alignContent: "start",
        overflow: "auto",
      }}
    >
      <div style={{ gridColumn: "1 / -1" }}>
        <StuckDeletesView
          settings={{
            deleting: [],
            notStopped: [
              {
                machineId: "k179b1tg" as never,
                name: "team-linux",
                since: now - 7 * MINUTE,
                lastError: STOP_ERROR,
              },
            ],
          }}
          now={now}
          retry={noop}
          stopNow={noop}
        />
      </div>
      {states.map((s, i) => (
        <div className="panel" key={i}>
          <CloudMachineView
            machine={{ name: s.name, liveTerminals: s.liveTerminals }}
            cloud={s.cloud}
            isAdmin
            now={now}
            actions={{ start: noop, stop: noop, remove: noop }}
          />
        </div>
      ))}
    </div>
  );
}
