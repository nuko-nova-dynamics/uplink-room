import "../../components/agentWork.css";
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@ui-sdk/react/button";
import { Checkbox } from "@ui-sdk/react/checkbox";
import { Field, FieldError, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { Listbox, ListboxItem } from "@ui-sdk/react/listbox";
import { PickOne, PickOneItem } from "../../components/PickOne";
import { SegmentedControl, SegmentedControlItem } from "@ui-sdk/react/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs";
import { api, type Access, type Id, type MachineRow } from "../../lib/api";
import {
  ACCESS_LEVELS,
  ACCESS_META,
  accessRank,
  ago,
  DAY,
  days,
  harnessLabel,
  timeLeft,
} from "../../lib/format";
import { useAct, useRoomQuery, useSession, useToast } from "../../lib/session";
import { MemberFace } from "../../components/Faces";
import { Empty } from "../../components/Empty";
import { Icon } from "../../components/Icon";
import { Dialog } from "../../components/Dialog";
import { Tip } from "../../components/Tip";
import { CopyButton } from "../../components/Copy";
import type { Nav } from "../../Shell";
import { MachineSpaces } from "./MachineSpaces";
import { MachineRexTabs } from "./MachineRexTabs";
import { MachineT3Threads } from "./MachineT3Threads";
import {
  CloudMachineDialog,
  CloudMachineSection,
  cloudListState,
  StuckDeletes,
} from "./CloudMachine";
import { track } from "../../lib/analytics";
import { firstName } from "../../lib/machinePick";
import { desktop } from "../../lib/desktop";
import { useBridgeCli } from "../../lib/bridgeCli";
import { usePairing } from "../../lib/pairing";
import { BridgeCliRow } from "../../components/BridgeCli";
import {
  bridgeProgram,
  installCommand,
  LINUX_BUILD_TOOLS,
  osOf,
  pairCommand,
  pathLine,
  usableRelease,
  type MachineOs,
} from "../../lib/bridgeInstall";
import { t3PairingText } from "../../lib/work";
import { ModeOptions } from "../../components/RunMode";
import { T3PairingNote } from "../../components/T3PairingNote";
import { useNow } from "../../components/useNow";

const ACCESS_ICON = { watch: "eye", suggest: "suggest", drive: "wheel", open: "open" } as const;
const PROFILE_CHOICES = [
  { ms: 0, label: "No profiles" },
  { ms: DAY, label: "1 day" },
  { ms: 7 * DAY, label: "7 days" },
  { ms: 30 * DAY, label: "30 days" },
];

export function Machines({ nav }: { nav: Nav }) {
  const session = useSession();
  const machines = useRoomQuery(api.machines.list, {});
  const [scope, setScope] = useState<"mine" | "team">("mine");
  const [selected, setSelected] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [addingCloud, setAddingCloud] = useState(false);

  const isMine = (m: MachineRow) =>
    m.belongsTo.kind === "person" && m.belongsTo.member.memberId === session.me.memberId;
  const shown = (machines ?? []).filter((m) =>
    scope === "team" ? m.belongsTo.kind === "team" : m.belongsTo.kind === "person",
  );
  const machine = shown.find((m) => m.machineId === selected) ?? shown[0];

  return (
    <Tabs
      className="machines-view work-ui"
      value={scope}
      onValueChange={(value) => {
        if (value === "mine" || value === "team") setScope(value);
      }}
    >
      <div className="pane-title">
        <h2>Machines</h2>
        <TabsList className="tabs" aria-label="Whose machines">
          <TabsTab value="mine">
            <span className="control-label">Personal</span>
          </TabsTab>
          <TabsTab value="team">
            <span className="control-label">Team</span>
          </TabsTab>
        </TabsList>
        {scope === "team" && session.isAdmin ? (
          <button className="btn" type="button" onClick={() => setAddingCloud(true)}>
            <Icon name="plus" />
            <span className="control-label"> Add a cloud machine</span>
          </button>
        ) : null}
        <button className="btn primary" type="button" onClick={() => setPairing(true)}>
          <Icon name="plus" />
          <span className="control-label"> Link a machine</span>
        </button>
      </div>

      {scope === "team" ? <StuckDeletes /> : null}

      {machines !== undefined && shown.length === 0 ? (
        <div className="panel">
          <Empty>
            {scope === "team"
              ? session.isAdmin
                ? "No team machines yet. Link one, or add a cloud machine, and the whole team can run work on it."
                : "No team machines yet. An admin can link one or add a cloud machine."
              : "No personal machines yet. Link this computer to share its terminals with your team."}
          </Empty>
        </div>
      ) : (
        <div className="machine-grid">
          <Listbox
            className="machine-list"
            aria-label="Machines"
            value={machine?.machineId ?? null}
            onValueChange={(value) => {
              if (typeof value === "string") setSelected(value);
            }}
          >
            {shown.map((m) => {
              const listState = m.cloud ? cloudListState(m.cloud) : null;
              const up = listState ? listState.up && m.online : m.online;
              return (
                <ListboxItem
                  key={m.machineId}
                  value={m.machineId}
                  label={m.name}
                  className={`option ${machine?.machineId === m.machineId ? "selected" : ""}`}
                  style={{ gridTemplateColumns: "auto minmax(0,1fr)" }}
                >
                  <Icon name={up ? "check" : "offline"} size={14} />
                  <span className="mono truncate">{m.name}</span>
                  <span className="sub" style={{ gridColumn: 2 }}>
                    {listState ? listState.label : m.online ? "Online" : "Offline"}
                    {m.belongsTo.kind === "person"
                      ? `, ${isMine(m) ? "yours" : m.belongsTo.member.name}`
                      : ""}
                    {m.liveTerminals > 0 ? `, ${m.liveTerminals} live` : ""}
                    {m.t3?.state === "needs_pairing" ? ", T3 Code needs pairing again" : ""}
                  </span>
                </ListboxItem>
              );
            })}
          </Listbox>
          {machine ? (
            <MachinePanel
              key={machine.machineId}
              machine={machine}
              mine={isMine(machine)}
              nav={nav}
            />
          ) : (
            <div />
          )}
        </div>
      )}

      {pairing ? <PairingDialog onClose={() => setPairing(false)} /> : null}
      {addingCloud ? <CloudMachineDialog onClose={() => setAddingCloud(false)} /> : null}
    </Tabs>
  );
}

function MachinePanel({ machine, mine, nav }: { machine: MachineRow; mine: boolean; nav: Nav }) {
  const session = useSession();
  const terminals = useRoomQuery(api.terminals.list, { machineId: machine.machineId });
  const profiles = useRoomQuery(api.profiles.onMachine, { machineId: machine.machineId });
  const update = useAct(api.machines.updateSettings);
  const stop = useAct(api.machines.stopSharing, { success: "Sharing stopped on this machine" });
  const resume = useAct(api.machines.resumeSharing, { success: "Sharing resumed" });
  const unlink = useAct(api.machines.unlink, { success: "Machine unlinked" });
  const [confirm, setConfirm] = useState<"stop" | "unlink" | null>(null);

  const canChange = machine.belongsTo.kind === "team" ? session.isAdmin : mine;
  const why = canChange
    ? null
    : machine.belongsTo.kind === "team"
      ? "Only admins can change a team machine."
      : `This machine belongs to ${machine.belongsTo.kind === "person" ? machine.belongsTo.member.name : "someone else"}; only they can change it.`;

  // A personal machine at Watch or Suggest takes runs only from its person (ADR 0025).
  const person = machine.belongsTo.kind === "person" ? machine.belongsTo.member : undefined;
  const first = person ? firstName(person.name) : "";
  const ownerOnly = Boolean(person) && accessRank(machine.mostOpenAccess) < accessRank("drive");
  const levelLine = levelLines(person ? (mine ? "you share" : `${first} shares`) : undefined);
  // Live terminals here that someone other than its person (or an agent of theirs) drives: lowering
  // the machine to Watch or Suggest hands them to its person.
  const othersDrive = person
    ? (terminals ?? []).filter(
        (t) =>
          t.driver &&
          t.driver.memberId !== person.memberId &&
          t.driver.addedBy?.memberId !== person.memberId,
      )
    : [];
  const [lowering, setLowering] = useState<Access | null>(null);
  const setLevel = (level: Access) => {
    if (person && accessRank(level) < accessRank("drive") && othersDrive.length > 0)
      setLowering(level);
    else void update({ machineId: machine.machineId, mostOpenAccess: level });
  };
  const accessLabelId = useId();

  const limit = machine.limits;
  const customProfile = !PROFILE_CHOICES.some((c) => c.ms === machine.longestProfileMs);
  const profileValue = customProfile ? "custom" : String(machine.longestProfileMs);
  const profileItems = [
    ...(customProfile ? [{ value: "custom", label: days(machine.longestProfileMs) }] : []),
    ...PROFILE_CHOICES.filter((c) => !limit || c.ms <= limit.longestProfileMs).map((c) => ({
      value: String(c.ms),
      label: c.label,
    })),
  ];
  const now = useNow(60_000);
  const t3 = t3PairingText(machine.t3, now);
  const [slots, setSlots] = useState(machine.slots);
  useEffect(() => setSlots(machine.slots), [machine.slots]);
  const maxSlots = limit?.slots ?? 16;
  const used = machine.slotsInUse;
  const barLength = Math.max(machine.slots, used, 1);

  return (
    <div className="panel machine-panel work-ui">
      <div className="panel-section">
        <div className="row-flex" style={{ flexWrap: "wrap" }}>
          <h3 className="mono" style={{ fontSize: "var(--font-13)", lineHeight: "var(--line-13)" }}>
            {machine.name}
          </h3>
          <span className="chip">
            {machine.cloud
              ? "Cloud team machine"
              : machine.belongsTo.kind === "team"
                ? "Team machine"
                : "Personal machine"}
          </span>
          <span className="chip">
            <Icon name={machine.online ? "check" : "offline"} size={14} />
            <span className="control-label">
              {machine.online
                ? "Bridge online"
                : `Bridge offline${machine.lastSeenAt ? `, seen ${ago(machine.lastSeenAt)} ago` : ""}`}
            </span>
          </span>
          {machine.sharingStopped ? <span className="chip amber">Sharing stopped</span> : null}
          {t3 ? <span className={t3.needsYou ? "chip amber" : "chip"}>{t3.chip}</span> : null}
        </div>
        <div className="machine-facts muted">
          <span className="machine-owner">
            <span className="nowrap">Belongs to</span>
            {machine.belongsTo.kind === "person" ? (
              <>
                <MemberFace member={machine.belongsTo.member} members={session.members} size={18} />
                <span className="truncate" title={machine.belongsTo.member.name}>
                  {machine.belongsTo.member.name}
                </span>
              </>
            ) : (
              <span>the team</span>
            )}
          </span>
          {machine.hostname ? <span className="mono">{machine.hostname}</span> : null}
          {machine.os ? <span>{machine.os}</span> : null}
          {machine.tools.length > 0 ? <span>Tools: {machine.tools.join(", ")}</span> : null}
        </div>
        {why ? <div className="note">{why}</div> : null}
        <T3PairingNote t3={machine.t3} machineName={machine.name} now={now} plain />
      </div>

      {machine.cloud ? <CloudMachineSection machine={machine} cloud={machine.cloud} /> : null}

      <div className="panel-section">
        <span className="label" id={accessLabelId}>
          Most open access allowed
        </span>
        {/* The room holds the level: it changes when the update lands, or after the handover is confirmed. */}
        <PickOne<Access>
          className="option-list"
          orientation="vertical"
          aria-labelledby={accessLabelId}
          value={machine.mostOpenAccess}
          onPick={setLevel}
        >
          {ACCESS_LEVELS.map((level) => {
            const overLimit = limit ? accessRank(level) > accessRank(limit.mostOpenAccess) : false;
            return (
              <Tip
                key={level}
                label={
                  overLimit
                    ? `The machine itself allows at most ${ACCESS_META[limit!.mostOpenAccess].label}.`
                    : ""
                }
              >
                <PickOneItem
                  value={level}
                  className={`option level-option ${canChange ? "" : "locked"}`}
                  disabled={!canChange || overLimit}
                >
                  <Icon name={ACCESS_ICON[level]} />
                  <span>{ACCESS_META[level].label}</span>
                  {machine.mostOpenAccess === level ? <Icon name="check" size={14} /> : <span />}
                  <span className="sub">{levelLine[level]}</span>
                </PickOneItem>
              </Tip>
            );
          })}
        </PickOne>
        <span className="hint">
          {person
            ? `Lowering it takes effect at once: terminals, Spaces and T3 Code threads here above the new level drop to it, marked in amber. At View or Suggest, ${mine ? "you take" : `${first} takes`} control of every terminal and T3 Code thread a teammate controls here, and that work keeps running. The bridge enforces this on the machine too.`
            : "Anyone on the team can start runs on a team machine, in a free slot. Lowering this drops running terminals, Spaces and T3 Code threads above the new level right away, marked in amber. The bridge enforces it on the machine too."}
        </span>
      </div>

      <div className="panel-section">
        <ModeOptions
          label="Most an agent may do on its own here"
          value={machine.mostPermissiveMode ?? "approval-required"}
          locked={!canChange}
          onPick={(mostPermissiveMode) =>
            void update({ machineId: machine.machineId, mostPermissiveMode })
          }
        />
        <span className="hint">
          {`The most permissive mode a run on ${mine ? "your" : "this"} machine may start in or switch to, for T3 Code threads and Claude Code and Codex terminals. Every machine starts at Ask before acting. Lowering it lowers T3 Code threads here above it at once, marked in amber; terminals keep the mode they started with until they end.`}
        </span>
      </div>

      <div className="panel-section">
        <span className="label">Slots</span>
        <div className="row-flex" style={{ gap: 14, flexWrap: "wrap" }}>
          <div className="stepper">
            <button
              type="button"
              aria-label="Fewer slots"
              disabled={!canChange || slots <= 0}
              onClick={() => {
                setSlots(slots - 1);
                void update({ machineId: machine.machineId, slots: slots - 1 });
              }}
            >
              <span className="control-label">−</span>
            </button>
            <span className="v" aria-live="polite">
              {slots}
            </span>
            <button
              type="button"
              aria-label="More slots"
              disabled={!canChange || slots >= maxSlots}
              onClick={() => {
                setSlots(slots + 1);
                void update({ machineId: machine.machineId, slots: slots + 1 });
              }}
            >
              <span className="control-label">+</span>
            </button>
          </div>
          <span className="muted">
            {used} of {machine.slots} in use
          </span>
        </div>
        <div
          className="slots-bar"
          role="img"
          aria-label={`${used} of ${machine.slots} slots in use`}
        >
          {Array.from({ length: barLength }, (_, i) => (
            <i
              key={i}
              className={i < used ? "use" : ""}
              style={i >= machine.slots ? { opacity: 0.4 } : undefined}
            />
          ))}
        </div>
        <span className="hint">
          {!person
            ? "Terminals anyone on the team may run here at once, agents included."
            : ownerOnly
              ? `Set to ${ACCESS_META[machine.mostOpenAccess].label}, so teammates can't start new runs here and only ${mine ? "your" : `${first}'s`} agents take these slots. At Ask for control or Take control, teammates can start terminals in them. ${mine ? "Your" : `${first}'s`} own terminals never use a slot.`
              : `Terminals teammates may start on this machine. They need Ask for control or Take control. ${mine ? "Your own terminals never use a slot; your agents' terminals do." : `${first}'s own terminals never use a slot; agents' terminals do.`}`}
        </span>
      </div>

      <div className="panel-section">
        <span className="label">Profiles: longest kept</span>
        <div className="row-flex">
          <Select
            disabled={!canChange}
            items={profileItems}
            value={profileValue}
            onValueChange={(value) => {
              if (!value || value === "custom" || value === profileValue) return;
              void update({ machineId: machine.machineId, longestProfileMs: Number(value) });
            }}
          >
            <SelectTrigger
              className="select"
              style={{ width: 220 }}
              aria-label="Longest a profile may be kept"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="pop">
              {profileItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                  <SelectItemIndicator>
                    <Icon name="check" size={14} />
                  </SelectItemIndicator>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {(profiles?.length ?? 0) > 0 ? (
          <div className="field" style={{ marginTop: 4 }}>
            <span className="hint">Profiles kept here</span>
            {profiles!.map((p) => (
              <div key={p.profileId} className="row-flex">
                <MemberFace member={p.person} members={session.members} size={18} />
                <span>
                  {p.person.name}: {p.name}
                </span>
                <span className="faint">{timeLeft(p.expiresAt)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="panel-section">
        <span className="label">Live terminals</span>
        {terminals && terminals.length === 0 ? (
          <span className="faint">No live terminals.</span>
        ) : null}
        {(terminals ?? []).map((t) => (
          <button
            key={t.terminalId}
            type="button"
            className="term-row"
            onClick={() => nav.openTerminal(t.terminalId)}
          >
            <span className="truncate">{t.title}</span>
            <span className="sub">
              <span>{harnessLabel(t.tool)}</span>
              {t.driver ? <span>controlled by {t.driver.name}</span> : null}
              <span>started by {t.startedBy.name}</span>
              {t.usesSlot ? <span>uses a slot</span> : null}
            </span>
            <span className={`chip access ${t.loweredFrom ? "amber" : ""}`}>
              <Icon name={ACCESS_ICON[t.access]} size={14} />
              {t.loweredFrom
                ? `${ACCESS_META[t.access].label}, was ${ACCESS_META[t.loweredFrom].label}`
                : ACCESS_META[t.access].label}
            </span>
          </button>
        ))}
      </div>

      <MachineSpaces machine={machine} canChange={canChange} nav={nav} />
      {/* Unshared tabs' names and folders are theirs, so only whoever can change the machine sees them. */}
      {machine.rex?.available && canChange ? <MachineRexTabs machine={machine} nav={nav} /> : null}
      {/* This computer's own machine only: its T3 Code threads are read from its bridge, never from the room. */}
      <MachineT3Threads machineId={machine.machineId} />

      <div className="panel-section">
        <span className="label">Sharing</span>
        <div className="row-flex" style={{ flexWrap: "wrap" }}>
          {machine.sharingStopped ? (
            <button
              className="btn"
              type="button"
              disabled={!canChange}
              onClick={() => void resume({ machineId: machine.machineId })}
            >
              <span className="control-label">Resume sharing</span>
            </button>
          ) : (
            <button
              className="btn shell-danger"
              type="button"
              disabled={!canChange}
              onClick={() => setConfirm("stop")}
            >
              <span className="control-label">Stop sharing everything</span>
            </button>
          )}
          {machine.cloud ? null : (
            <button
              className="btn shell-danger"
              type="button"
              disabled={!canChange}
              onClick={() => setConfirm("unlink")}
            >
              <span className="control-label">Unlink this machine</span>
            </button>
          )}
        </div>
        <span className="hint">
          {machine.cloud
            ? "Stopping sharing ends every shared terminal at once; the machine keeps running until it goes idle. To remove a cloud machine, delete it above."
            : "Stopping ends every shared terminal at once. Unlinking cuts the room's access to the machine at once."}
        </span>
      </div>

      {lowering ? (
        <Dialog
          title={`Set ${machine.name} to ${ACCESS_META[lowering].label}?`}
          onClose={() => setLowering(null)}
          footer={
            <>
              <button className="btn" type="button" onClick={() => setLowering(null)}>
                <span className="control-label">Cancel</span>
              </button>
              <Button
                className="btn primary"
                onClick={async () => {
                  await update({ machineId: machine.machineId, mostOpenAccess: lowering });
                  setLowering(null);
                }}
              >
                <span className="control-label">Set to {ACCESS_META[lowering].label}</span>
              </Button>
            </>
          }
        >
          <p>
            {othersDrive.length === 1
              ? `You take control of this terminal. Its work keeps running, and ${othersDrive[0]!.driver!.name} can ${lowering === "watch" ? "watch it" : "suggest commands in it"} from now on.`
              : `You take control of these ${othersDrive.length} terminals. Their work keeps running, and whoever had control can ${lowering === "watch" ? "watch them" : "suggest commands in them"} from now on.`}
          </p>
          <ul className="handover-list">
            {othersDrive.map((t) => (
              <li key={t.terminalId}>
                <span className="truncate">{t.title}</span>
                <span className="sub">
                  {harnessLabel(t.tool)}, controlled by {t.driver!.name}
                </span>
              </li>
            ))}
          </ul>
          <p>
            Teammates can't start runs here until it's set to Ask for control or Take control. Any
            T3 Code thread a teammate started here keeps running, and its approvals come to you.
          </p>
        </Dialog>
      ) : null}

      {confirm ? (
        <Dialog
          title={confirm === "stop" ? "Stop sharing everything?" : "Unlink this machine?"}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn" type="button" onClick={() => setConfirm(null)}>
                <span className="control-label">Cancel</span>
              </button>
              <Button
                className="btn shell-danger solid"
                onClick={async () => {
                  await (confirm === "stop"
                    ? stop({ machineId: machine.machineId })
                    : unlink({ machineId: machine.machineId }));
                  setConfirm(null);
                }}
              >
                <span className="control-label">
                  {confirm === "stop" ? "Stop sharing" : "Unlink"}
                </span>
              </Button>
            </>
          }
        >
          <p>
            {confirm === "stop"
              ? `Every shared terminal on ${machine.name} ends now. You can resume sharing later.`
              : `The room loses all access to ${machine.name} now. To use it again, pair its bridge again with a new code.`}
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}

/**
 * What teammates can do on a machine at each level, one line each (ADR 0025). On a personal machine
 * the level also decides whether teammates can start runs there; `shares` names whose terminals they
 * see ("you share", "Axel shares"). On a team machine anyone on the team starts runs, so each line
 * says only what others can do in a terminal.
 */
function levelLines(shares: string | undefined): Record<Access, string> {
  if (!shares) {
    return {
      watch: ACCESS_META.watch.description,
      suggest: ACCESS_META.suggest.description,
      drive: ACCESS_META.drive.description,
      open: ACCESS_META.open.description,
    };
  }
  return {
    watch: `Teammates can watch the terminals and threads ${shares}. They can't start runs here.`,
    suggest: `Teammates can suggest what to send in the terminals and threads ${shares}. They can't start runs here.`,
    drive:
      "Teammates can start runs here in a free slot, and ask whoever is in control for control.",
    open: "Teammates can start runs here in a free slot, and take control without asking.",
  };
}

/** The Convex deployment this app talks to: `pair` needs it on every machine. */
const CONVEX_URL = import.meta.env["VITE_CONVEX_URL"] as string | undefined;

const OS_LABEL: Record<MachineOs, string> = { macos: "macOS", linux: "Linux", windows: "Windows" };

/** A command to copy, beside its Copy button. */
function Command({ text, label }: { text: string; label: string }) {
  return (
    <div className="cmd-row machine-command work-ui">
      <code className="cmd-box" aria-label={label}>
        {text}
      </code>
      <CopyButton text={text} />
    </div>
  );
}

/**
 * Link a machine. This computer links in one click: the app makes the code and pairs its own
 * bridge, so there's no code or command to copy. Only another machine gets a code and the commands
 * to run there.
 */
function PairingDialog({ onClose }: { onClose: () => void }) {
  const session = useSession();
  const create = useAct(api.machines.createPairingCode);
  const machines = useRoomQuery(api.machines.list, {});
  const toast = useToast();
  const [team, setTeam] = useState(false);
  const [result, setResult] = useState<{ code: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  // The installed app carries the bridge, so this computer can be linked from here. That's known
  // without probing PATH.
  const cli = useBridgeCli();
  const thisComputer = Boolean(cli.bundled) && Boolean(desktop.pairThisComputer);
  const [where, setWhere] = useState<"this" | "other">("this");
  const shown = thisComputer ? where : "other";
  const defaultName = `${firstName(session.me.name)}'s ${desktop.platform === "darwin" ? "Mac" : "computer"}`;
  const [name, setName] = useState("");
  // This computer's name is filled in once the app knows it can link it (useBridgeCli answers late).
  useEffect(() => {
    if (thisComputer) setName((current) => current || defaultName);
  }, [thisComputer, defaultName]);
  const makeCode = useCallback(
    async (machineName: string) =>
      ((await create({ name: machineName })) as { code: string } | undefined)?.code,
    [create],
  );
  const { pairing, pair } = usePairing({
    read: thisComputer ? desktop.bridgePairing : undefined,
    makeCode,
    link: desktop.pairThisComputer,
  });
  const linkedAs =
    pairing?.status === "paired"
      ? (machines?.find((m) => m.machineId === pairing.machineId)?.name ?? "a machine in this room")
      : null;
  const pick = (next: "this" | "other") => {
    setWhere(next);
    if (next === "this" && !name.trim()) setName(defaultName);
  };

  const linkThis = async () => {
    setBusy(true);
    try {
      await pair(name.trim(), { replace: false });
      toast.show("This computer is linked. Its bridge is running.", true);
      onClose();
    } catch (error) {
      toast.show(error instanceof Error ? error.message : "Linking failed");
    } finally {
      setBusy(false);
    }
  };
  const makeOther = async () => {
    setBusy(true);
    const made = (await create({ name, ...(team ? { belongsToTeam: true } : {}) })) as
      | { code: string; expiresAt: number }
      | undefined;
    setBusy(false);
    if (made) {
      track("pairing_code_created", { belongs_to: team ? "team" : "person" });
      setResult(made);
    }
  };

  const nameField = (
    <Field className="field" invalid={Boolean(nameError)}>
      <FieldLabel className="label">Name for the machine</FieldLabel>
      <Input
        id="machine-name"
        className="input mono"
        disabled={busy}
        onBlur={() => setNameError(name.trim() ? null : "Enter a name for this machine.")}
        placeholder="julio-mbp"
        value={name}
        onValueChange={(value) => {
          setName(value);
          setNameError(null);
        }}
      />
      {nameError ? (
        <FieldError match id="machine-name-error" className="machine-name-error" role="alert">
          <Icon name="alert" />
          <span className="control-label">{nameError}</span>
        </FieldError>
      ) : null}
    </Field>
  );
  const thisPanel = (
    <>
      {pairing === undefined ? (
        <p className="hint">Checking whether this computer is linked…</p>
      ) : linkedAs !== null ? (
        <p className="note" role="status">
          This computer is already linked as <span className="mono">{linkedAs}</span>. Its bridge
          runs while the app is open, and pairs with T3 Code on its own.
        </p>
      ) : pairing.status === "unknown" ? (
        <p className="note">
          Couldn't check whether this computer is already linked ({pairing.error}), so it can't be
          linked from here. Check again from Settings, Setup.
        </p>
      ) : (
        <>
          {nameField}
          <span className="hint">
            The app links this computer and runs its bridge while it is open. Pairing is automatic.
          </span>
        </>
      )}
      <BridgeCliRow cli={cli} />
    </>
  );
  const otherPanel = (
    <>
      {nameField}
      {session.isAdmin ? (
        <label className="row-flex" style={{ cursor: "pointer" }}>
          <Checkbox checked={team} onCheckedChange={(checked) => setTeam(checked === true)} />
          <span>This is a team machine, such as a cloud box. Only admins can change it.</span>
        </label>
      ) : (
        <span className="hint">The machine will belong to you. Only admins can link team machines.</span>
      )}
      <span className="hint">You'll get a code and the commands to run on that machine.</span>
    </>
  );
  const footer =
    shown === "this" ? (
      linkedAs !== null ? (
        <button className="btn primary" type="button" onClick={onClose}>
          <span className="control-label">Done</span>
        </button>
      ) : (
        <>
          <button className="btn" type="button" onClick={onClose}>
            <span className="control-label">Cancel</span>
          </button>
          <Button
            className="btn primary"
            disabled={!name.trim() || pairing === undefined || pairing.status === "unknown"}
            pendingAnnouncement="Linking"
            onClick={linkThis}
          >
            <span className="control-label">{busy ? "Linking" : "Link this computer"}</span>
          </Button>
        </>
      )
    ) : result ? (
      <button className="btn primary" type="button" onClick={onClose}>
        <span className="control-label">Done</span>
      </button>
    ) : (
      <>
        <button className="btn" type="button" onClick={onClose}>
          <span className="control-label">Cancel</span>
        </button>
        <Button className="btn primary" disabled={!name.trim()} onClick={makeOther}>
          <span className="control-label">Get a pairing code</span>
        </Button>
      </>
    );

  return (
    <Dialog
      title="Link a machine"
      onClose={onClose}
      wide={shown === "other" && result !== null}
      footer={footer}
    >
      {thisComputer && !result ? (
        <Tabs
          value={shown}
          onValueChange={(value) => {
            if (value === "this" || value === "other") pick(value);
          }}
        >
          <TabsList className="tabs link-tabs" aria-label="Which machine">
            <TabsTab value="this" id="link-tab-this">
              <span className="control-label">This computer</span>
            </TabsTab>
            <TabsTab value="other" id="link-tab-other">
              <span className="control-label">Another machine</span>
            </TabsTab>
          </TabsList>
          <TabsPanel
            value="this"
            id="link-panel-this"
            className="link-panel work-ui"
            aria-busy={busy}
          >
            {thisPanel}
          </TabsPanel>
          <TabsPanel value="other" id="link-panel-other" className="link-panel work-ui">
            {otherPanel}
          </TabsPanel>
        </Tabs>
      ) : result ? (
        <>
          <p className="link-code">
            Pairing code <span>{result.code}</span>. Valid for{" "}
            {timeLeft(result.expiresAt).replace(" left", "")}. It works once.
          </p>
          <AnotherMachine code={result.code} />
        </>
      ) : (
        <div className="link-panel work-ui">{otherPanel}</div>
      )}
    </Dialog>
  );
}

/**
 * Another machine: Node, the bridge release cloud machines run (checked against the sha256 the
 * room recorded before npm installs it), then the pair command. Or the app, installed there.
 */
function AnotherMachine({ code }: { code: string }) {
  const answer = useRoomQuery(api.machines.bridgeRelease, {});
  // Checked again here: only plain text goes into a command (lib/bridgeInstall.ts).
  const release = answer ? usableRelease(answer) : answer;
  const [os, setOs] = useState<MachineOs>(osOf(desktop.platform));
  const program = bridgeProgram(os);
  const pair = pairCommand(program, code, CONVEX_URL);
  const path = pathLine(os);
  return (
    <div className="link-panel work-ui" id="link-panel-other">
      <SegmentedControl
        className="seg link-os"
        aria-label="The machine's system"
        value={os}
        onValueChange={(value) => {
          if (value) setOs(value as MachineOs);
        }}
      >
        {(Object.keys(OS_LABEL) as MachineOs[]).map((key) => (
          <SegmentedControlItem key={key} value={key}>
            <span className="control-label">{OS_LABEL[key]}</span>
          </SegmentedControlItem>
        ))}
      </SegmentedControl>
      {release === undefined ? (
        <p className="hint">Checking this room's bridge release…</p>
      ) : release === null ? (
        <>
          <p className="note">
            This room has no bridge release to install from yet. Install the Uplink Room app on that
            machine and choose Link this computer there. A machine that already has the bridge pairs
            with:
          </p>
          <Command text={pair} label="Pairing command" />
        </>
      ) : (
        <>
          <ol className="link-steps">
            <li>
              <b>Install Node.js 24 or newer</b>
              <span className="muted">
                {os === "linux"
                  ? "From nodejs.org or your package manager, with the tools npm builds node-pty with (Debian and Ubuntu):"
                  : "From nodejs.org, or with a version manager such as fnm."}
              </span>
              {os === "linux" ? <Command text={LINUX_BUILD_TOOLS} label="Build tools" /> : null}
            </li>
            <li>
              <b>Install the bridge</b>
              <span className="muted">
                {os === "windows"
                  ? `In PowerShell. It downloads bridge ${release.version ?? "release"}, checks it against the sha256 this room recorded, and only then installs it with npm, into %APPDATA%\\npm, which Node's installer puts on your PATH.`
                  : `It downloads bridge ${release.version ?? "release"}, checks it against the sha256 this room recorded, and only then installs it with npm into ~/.uplink-room/npm, a folder of yours, so it needs no sudo.`}
              </span>
              <Command text={installCommand(os, release)!} label="Install command" />
            </li>
            {path ? (
              <li>
                <b>Put it on PATH</b>
                <span className="muted">
                  {os === "macos" ? "For zsh, macOS's shell." : "For bash."} Then open a new
                  terminal.
                </span>
                <Command text={path} label="PATH command" />
              </li>
            ) : null}
            <li>
              <b>Pair it</b>
              <span className="muted">
                {os === "linux" ? (
                  <>
                    Then run <span className="mono">{program} service install</span>, which keeps
                    the bridge running with systemd after you log out, also on a server with no
                    display. Or start it with <span className="mono">{program} run</span> and keep
                    that running.
                  </>
                ) : (
                  <>
                    Then start it with <span className="mono">{program} run</span> and keep it
                    running.
                  </>
                )}
              </span>
              <Command text={pair} label="Pairing command" />
            </li>
          </ol>
          <p className="hint">
            Or install the Uplink Room app there and choose Link this computer.
          </p>
        </>
      )}
    </div>
  );
}

export type { Id };
