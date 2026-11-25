import "../../components/agentWork.css";
import { useState } from "react";
import { Button } from "@ui-sdk/react/button";
import { Field, FieldLabel } from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select";
import type { FunctionReturnType } from "convex/server";
import { api, type MachineRow } from "../../lib/api";
import { agoText, timeLeft } from "../../lib/format";
import { useAct, useRoomQuery, useSession } from "../../lib/session";
import { Icon } from "../../components/Icon";
import { Dialog } from "../../components/Dialog";
import { useNow } from "../../components/useNow";
import { track } from "../../lib/analytics";

/** A cloud machine's state at its provider (#10). */
export type CloudState = NonNullable<MachineRow["cloud"]>;

const STATE_LABEL: Record<CloudState["state"], string> = {
  creating: "Setting up",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Didn't start",
  deleting: "Deleting",
  deleted: "Deleted",
};

const STOP_REASON: Record<NonNullable<CloudState["stopReason"]>, string> = {
  idle: "no live work",
  admin: "an admin stopped it",
  provider: "its provider stopped it",
  bridge_missing: "its bridge didn't come back",
  start_failed: "it couldn't start",
};

/** For the machine list: a short state, and whether to show the dot as up. */
export function cloudListState(cloud: CloudState): { label: string; up: boolean } {
  return { label: `Cloud ${stateLabel(cloud).toLowerCase()}`, up: cloud.state === "running" };
}

/** A failed stop isn't a failed start: its box may still run (#51). */
function stateLabel(cloud: CloudState): string {
  return cloud.state === "failed" && cloud.stopFailed ? "Didn't stop" : STATE_LABEL[cloud.state];
}

/**
 * The cloud part of a team machine's settings: its state, Start for anyone,
 * Stop and Delete for admins. Everything else (access, slots, profiles) is the
 * same as on any team machine.
 */
export function CloudMachineSection({
  machine,
  cloud,
}: {
  machine: MachineRow;
  cloud: CloudState;
}) {
  const session = useSession();
  const now = useNow(30_000);
  const start = useAct(api.cloudMachines.start, { success: "Starting the cloud machine" });
  const stop = useAct(api.cloudMachines.stop, { success: "Stopping the cloud machine" });
  const remove = useAct(api.cloudMachines.remove, { success: "Deleting the cloud machine" });
  return (
    <CloudMachineView
      machine={machine}
      cloud={cloud}
      isAdmin={session.isAdmin}
      now={now}
      actions={{
        start: () => start({ machineId: machine.machineId }),
        stop: () => stop({ machineId: machine.machineId }),
        remove: () => remove({ machineId: machine.machineId }),
      }}
    />
  );
}

export type CloudActions = {
  start: () => Promise<unknown>;
  stop: () => Promise<unknown>;
  remove: () => Promise<unknown>;
};

/** The section itself, from data and actions only, so the sample-data page can render it too. */
export function CloudMachineView({
  machine,
  cloud,
  isAdmin,
  now,
  actions,
}: {
  machine: Pick<MachineRow, "name" | "liveTerminals">;
  cloud: CloudState;
  isAdmin: boolean;
  now: number;
  actions: CloudActions;
}) {
  const [confirm, setConfirm] = useState<"stop" | "delete" | null>(null);
  const up = cloud.state === "running" || cloud.state === "starting" || cloud.state === "creating";
  const gone = cloud.state === "deleting" || cloud.state === "deleted";

  let detail: string;
  if (cloud.state === "running" && cloud.stopsIdleAt) {
    detail =
      machine.liveTerminals > 0
        ? `Live work keeps it running. It stops ${cloud.idleMinutes} minutes after the last of it ends.`
        : `Stops by itself in ${timeLeft(cloud.stopsIdleAt, now).replace(" left", "")} unless a terminal or run starts.`;
  } else if (cloud.state === "stopped") {
    detail = `Stopped${cloud.stoppedAt ? ` ${agoText(cloud.stoppedAt, now)}` : ""}${cloud.stopReason ? `: ${STOP_REASON[cloud.stopReason]}` : ""}. Its disk, settings and profiles are kept. Starting a terminal or run here starts it.`;
  } else if (cloud.state === "creating") {
    detail = "Installing and pairing its bridge. This takes a few minutes the first time.";
  } else if (cloud.state === "starting") {
    detail = "Booting from its kept disk. Terminals started now wait until its bridge is back.";
  } else if (cloud.state === "stopping") {
    detail = cloud.startsAfterStop
      ? "Saving its disk. Something asked for it meanwhile, so it starts again right after."
      : "Saving its disk before it stops.";
  } else if (cloud.state === "failed" && cloud.stopFailed) {
    detail =
      "The room couldn't stop its box, so it may still cost money. The room keeps stopping it, or an admin can stop it now.";
  } else if (cloud.state === "failed") {
    detail = "The last start didn't finish. Start it again, or check the error below.";
  } else {
    detail = "Its box and disk are being deleted.";
  }

  return (
    <div className="panel-section cloud-machine-section cloud-machine work-ui">
      <span className="label">Cloud machine</span>
      <div className="row-flex" style={{ flexWrap: "wrap" }}>
        <span className="chip cloud-state">
          <Icon
            name={
              cloud.state === "failed"
                ? "alert"
                : cloud.state === "running"
                  ? "check"
                  : cloud.state === "stopped" || cloud.state === "deleted"
                    ? "stop"
                    : "working"
            }
            size={14}
          />
          {stateLabel(cloud)}
        </span>
        <span className="muted">
          Linux on Vercel Sandbox in {cloud.region}, with {cloud.vcpus} vCPU
          {cloud.vcpus === 1 ? "" : "s"} and {cloud.vcpus * 2} GB of memory.
        </span>
      </div>
      <span className="hint">{detail}</span>
      {cloud.lastError ? (
        <div className="cloud-error" role="alert">
          <Icon name="alert" />
          <span>
            {cloud.lastError.split(/(~\/[^\s]+|\/[^\s]+)/).map((part, i) =>
              part.startsWith("~/") || part.startsWith("/") ? (
                <span className="cloud-path" title={part} key={i}>
                  {part}
                </span>
              ) : (
                part
              ),
            )}
          </span>
        </div>
      ) : null}
      {!gone ? (
        <div className="row-flex" style={{ flexWrap: "wrap" }}>
          {!up && cloud.state !== "stopping" ? (
            <Button className="btn primary" onClick={() => actions.start()}>
              Start
            </Button>
          ) : null}
          {isAdmin && cloud.state !== "stopped" && cloud.state !== "stopping" ? (
            <button className="btn" type="button" onClick={() => setConfirm("stop")}>
              Stop now
            </button>
          ) : null}
          {isAdmin ? (
            <button className="btn" type="button" onClick={() => setConfirm("delete")}>
              Delete this cloud machine
            </button>
          ) : null}
        </div>
      ) : null}
      <span className="hint">
        It starts when a terminal or run needs it and stops after {cloud.idleMinutes} minutes with
        no live work. A stop keeps the disk; runs going when it stops don&apos;t come back.
      </span>

      {confirm ? (
        <Dialog
          title={confirm === "stop" ? "Stop this cloud machine?" : "Delete this cloud machine?"}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <button className="btn" type="button" onClick={() => setConfirm(null)}>
                Cancel
              </button>
              <Button
                className="btn primary"
                onClick={async () => {
                  await (confirm === "stop" ? actions.stop() : actions.remove());
                  setConfirm(null);
                }}
              >
                {confirm === "stop" ? "Stop" : "Delete"}
              </Button>
            </>
          }
        >
          <p>
            <span className="mono">{machine.name}</span>
            {confirm === "stop"
              ? ` stops now. Its ${machine.liveTerminals} live terminal${machine.liveTerminals === 1 ? "" : "s"} end, and its runs stop. Its disk, settings and profiles are kept.`
              : ", its disk and every profile on it are deleted, and the room loses access to it at once. This can't be undone."}
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}

/** Admins add a cloud machine: a name and a size. */
export function CloudMachineDialog({ onClose }: { onClose: () => void }) {
  const settings = useRoomQuery(api.cloudMachines.settings, {});
  const make = useAct(api.cloudMachines.create, { success: "Setting up the cloud machine" });
  const create = async (args: { name: string; vcpus: number }) => {
    const made = await make(args);
    if (made !== undefined) track("cloud_machine_created");
    return made;
  };
  return <CloudMachineDialogView settings={settings} create={create} onClose={onClose} />;
}

export type CloudSettings = FunctionReturnType<typeof api.cloudMachines.settings>;

export function CloudMachineDialogView({
  settings,
  create,
  onClose,
}: {
  settings: CloudSettings | undefined;
  create: (args: { name: string; vcpus: number }) => Promise<unknown>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [vcpus, setVcpus] = useState(2);
  const configured = settings?.configured ?? false;
  const sizes = (settings?.vcpuChoices ?? [1, 2, 4, 8]).map((n) => ({
    value: String(n),
    label: `${n} vCPU${n === 1 ? "" : "s"}, ${n * 2} GB`,
  }));

  return (
    <Dialog
      title="Add a cloud machine"
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <Button
            className="btn primary"
            disabled={!configured || !name.trim()}
            onClick={async () => {
              const made = await create({ name, vcpus });
              if (made) onClose();
            }}
          >
            Add it
          </Button>
        </>
      }
    >
      {settings && !configured ? (
        <div className="note warn">
          Cloud machines aren&apos;t configured yet. Set{" "}
          {settings.missing.map((name, i) => (
            <span key={name}>
              {i > 0 ? ", " : ""}
              <code>{name}</code>
            </span>
          ))}{" "}
          in the Convex environment.
        </div>
      ) : null}
      <Field className="field">
        <FieldLabel className="label">Name for the machine</FieldLabel>
        <Input
          id="cloud-name"
          className="input mono"
          placeholder="team-linux"
          value={name}
          onValueChange={setName}
        />
      </Field>
      <Field className="field">
        <FieldLabel className="label">Size</FieldLabel>
        <Select
          items={sizes}
          value={String(vcpus)}
          onValueChange={(value) => {
            if (value) setVcpus(Number(value));
          }}
        >
          <SelectTrigger id="cloud-size" className="select" style={{ width: 220 }}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="pop">
            {sizes.map((size) => (
              <SelectItem key={size.value} value={size.value}>
                {size.label}
                <SelectItemIndicator>
                  <Icon name="check" size={14} />
                </SelectItemIndicator>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <span className="hint">
        A Linux team machine on Vercel Sandbox in {settings?.region ?? "iad1"} (Washington, D.C.).
        It sets itself up now, then starts whenever a terminal or run needs it and stops after{" "}
        {settings?.idleMinutes ?? 15} minutes with no live work, keeping its disk, settings and
        profiles. It is billed only while it runs, plus its kept disk.
      </span>
    </Dialog>
  );
}

/**
 * Deletes the provider hasn't confirmed yet (#10), and stops that ran out of
 * tries (#51). Until the provider confirms, the box may still bill (and a
 * deleted machine's snapshot still holds its logins), so admins see them, with
 * the last error, and can retry now.
 */
export function StuckDeletes() {
  const session = useSession();
  const settings = useRoomQuery(api.cloudMachines.settings, {});
  const retry = useAct(api.cloudMachines.remove, { success: "Retrying the delete" });
  const stopNow = useAct(api.cloudMachines.stop, { success: "Stopping the cloud machine" });
  const now = useNow(30_000);
  if (!session.isAdmin || !settings) return null;
  return (
    <StuckDeletesView
      settings={settings}
      now={now}
      retry={(machineId) => retry({ machineId })}
      stopNow={(machineId) => stopNow({ machineId })}
    />
  );
}

/** The notes themselves, from data and actions only, so the sample-data page can render them too. */
export function StuckDeletesView({
  settings,
  now,
  retry,
  stopNow,
}: {
  settings: Pick<CloudSettings, "deleting" | "notStopped">;
  now: number;
  retry: (machineId: MachineRow["machineId"]) => Promise<unknown>;
  stopNow: (machineId: MachineRow["machineId"]) => Promise<unknown>;
}) {
  const stuck = settings.deleting.filter((d) => d.attempts > 0 || now - d.since > 5 * 60_000);
  const notStopped = settings.notStopped;
  if (stuck.length + notStopped.length === 0) return null;
  return (
    <>
      {notStopped.map((d) => (
        <div key={d.machineId} className="note warn cloud-stuck">
          <div className="row-flex">
            <span>
              Couldn't stop the cloud machine <span className="mono">{d.name}</span>{" "}
              {agoText(d.since, now)}. It may cost money until its box stops. The room keeps trying.
            </span>
            <Button className="btn" onClick={() => stopNow(d.machineId)}>
              Stop now
            </Button>
          </div>
          {d.lastError ? (
            <div className="hint" style={{ marginTop: 4 }}>
              {d.lastError}
            </div>
          ) : null}
        </div>
      ))}
      {stuck.map((d) => (
        <div key={d.machineId} className="note warn cloud-stuck">
          <div className="row-flex">
            <span>
              Still deleting the cloud machine <span className="mono">{d.name}</span>, started{" "}
              {agoText(d.since, now)}. It may cost money until the provider confirms it's gone. The
              room keeps trying.
            </span>
            <Button className="btn" onClick={() => retry(d.machineId)}>
              Retry now
            </Button>
          </div>
          {d.lastError ? (
            <div className="hint" style={{ marginTop: 4 }}>
              {d.lastError}
            </div>
          ) : null}
        </div>
      ))}
    </>
  );
}
