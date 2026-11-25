import "./github.css";
import { useState, type ReactNode } from "react";
import { useMutation } from "convex/react";
import { Button } from "@ui-sdk/react/button";
import { errorMessage } from "../../lib/errors";
import type { FunctionReturnType } from "convex/server";
import { api, type Id } from "../../lib/api";
import { agoText } from "../../lib/format";
import { useAct, useRoomQuery, useSession, useToast } from "../../lib/session";
import { Dialog } from "../../components/Dialog";
import { Empty } from "../../components/Empty";
import { Icon } from "../../components/Icon";
import { useNow } from "../../components/useNow";

type Accounts = FunctionReturnType<typeof api.github.accounts>;
type Account = Accounts["accounts"][number];
type Connects = FunctionReturnType<typeof api.github.connects>;
type Connect = Connects[number];
type Offered = Connect["accounts"][number];

/**
 * Settings, GitHub (ADR 0020): the GitHub accounts connected to the team, grouped by whose they
 * are. Your own personal account is yours to sync, change and disconnect. Organizations are the
 * team's, and admins manage them. Admins also see other people's personal accounts, which they can
 * only disconnect. Each row offers only what the backend says you may do (`canSync`,
 * `canChangeRepos`, `canDisconnect`). Connect opens GitHub's install page in the browser. Once
 * GitHub sends you back, your connect waits here under Finish connecting, naming who signed in to
 * GitHub, and nothing is connected until you choose Connect on one of its accounts.
 */
export function GitHub() {
  const data = useRoomQuery(api.github.accounts, {});
  const connects = useRoomQuery(api.github.connects, {});
  const session = useSession();
  const connect = useAct(api.github.connect);
  const [waiting, setWaiting] = useState(false);
  if (!data) return null;
  return (
    <GitHubView
      data={data}
      connects={connects ?? []}
      me={session.me.memberId}
      waiting={waiting}
      onConnect={async () => {
        const result = await connect({});
        if (!result || typeof result !== "object") return;
        window.open(result.url);
        setWaiting(true);
      }}
    />
  );
}

export function GitHubView({
  data,
  connects = [],
  me,
  waiting,
  onConnect,
}: {
  data: Accounts;
  connects?: Connects;
  me?: string;
  waiting: boolean;
  onConnect: () => void;
}) {
  const [leaving, setLeaving] = useState<Account | null>(null);
  const now = useNow(15_000);
  // An expired connect can't be confirmed; it stops showing without waiting for the backend.
  const live = connects.filter((c) => c.expiresAt > now);
  const { accounts, configured, canConnect, canConnectOrganizations: admin } = data;
  const mine = accounts.filter((a) => a.mine);
  const orgs = accounts.filter((a) => a.type === "Organization");
  // Other people's personal accounts are listed for admins, who can disconnect them. A member sees
  // their own account and the team's organizations; the repo pickers still offer every account's repos.
  const others = admin ? accounts.filter((a) => a.type === "User" && !a.mine) : [];
  const connectLabel = admin
    ? "Connect a GitHub account or organization"
    : mine.length > 0
      ? "Connect another GitHub account"
      : "Connect your GitHub account";
  const rows = (list: Account[]) =>
    list.map((account) => (
      <AccountRow
        key={account.accountId}
        account={account}
        me={me}
        onDisconnect={() => setLeaving(account)}
      />
    ));
  const nothing = accounts.length === 0;

  return (
    <div className="github-view">
      <div className="pane-title">
        <h2>GitHub</h2>
        {canConnect && configured ? (
          // Once a member's own account is connected, another one is the rare case: a plain button. So
          // is it while a connect waits under Finish connecting, whose Connect is the next step.
          <button
            className={(!admin && mine.length > 0) || live.length > 0 ? "btn" : "btn primary"}
            type="button"
            onClick={onConnect}
          >
            <Icon name="plus" /> {connectLabel}
          </button>
        ) : null}
      </div>
      <p className="muted" style={{ maxWidth: 520 }}>
        {admin
          ? "Connect GitHub organizations and personal accounts, and the repos they give Uplink Room show in everyone's repo pickers, for new projects, a project's repos and runs. Everyone in the team sees their names."
          : "Connect your personal GitHub account, and the repos you give Uplink Room show in everyone's repo pickers, for new projects, a project's repos and runs. Everyone in the team sees their names."}
      </p>

      {!configured ? (
        <div className="note warn">
          GitHub isn't set up on this deployment yet. An admin registers the App with{" "}
          <code className="mono">packages/backend/scripts/github-app.ts</code>, which puts its
          settings in the Convex environment.
        </div>
      ) : null}
      {waiting && live.length === 0 ? (
        <div className="note" role="status">
          Finish in your browser: pick the account and its repos on GitHub. GitHub then sends you
          back here to confirm, and nothing is connected until you do.
        </div>
      ) : null}
      {configured
        ? live.map((flow) => <FinishConnecting key={flow.connectId} flow={flow} now={now} />)
        : null}

      {!configured || (nothing && live.length > 0) ? null : nothing ? (
        // As Settings shows every empty list (#112): a panel with Link and one line.
        <div className="panel">
          <Empty>
            {admin
              ? "No GitHub accounts connected yet. Connect your organization or your personal account to pick its repos when you make a project."
              : "No GitHub accounts connected yet. Connect your personal account to pick its repos when you make a project. An admin connects the team's organizations."}
          </Empty>
        </div>
      ) : (
        <>
          <Group id="gh-yours" label="Your account" hint={yoursHint(mine.length > 0)}>
            {mine.length > 0 ? (
              rows(mine)
            ) : (
              <p className="gh-none">You haven't connected your GitHub account.</p>
            )}
          </Group>
          {orgs.length > 0 ? (
            <Group
              id="gh-orgs"
              label="Organizations"
              hint={
                admin
                  ? "Admins connect organizations they own on GitHub, and sync and disconnect them. Change which repos opens GitHub, where the organization's owners pick them."
                  : "Admins connect organizations they own on GitHub, and sync, change and disconnect them."
              }
            >
              {rows(orgs)}
            </Group>
          ) : null}
          {others.length > 0 ? (
            <Group
              id="gh-others"
              label="Other people's accounts"
              hint="Each belongs to the person who connected it: only they sync it and change its repos. You can disconnect one to take its repos away from the team."
            >
              {rows(others)}
            </Group>
          ) : null}
        </>
      )}
      {leaving ? <DisconnectDialog account={leaving} onClose={() => setLeaving(null)} /> : null}
    </div>
  );
}

function yoursHint(connected: boolean): string {
  const leave =
    "If you leave the team, it's disconnected. The App stays installed on your GitHub account until you uninstall it there.";
  return connected
    ? `Yours to sync, change and disconnect. An admin can disconnect it too. ${leave}`
    : `Once you connect it, it's yours to sync, change and disconnect. ${leave}`;
}

/** One group of accounts: its label, a panel of rows, and what the group's rules are. */
function Group({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="field gh-group" aria-labelledby={id}>
      <h3 className="label" id={id}>
        {label}
      </h3>
      <div className="panel gh-accounts">{children}</div>
      {hint ? <p className="hint">{hint}</p> : null}
    </section>
  );
}

const REFUSED: Record<NonNullable<Offered["refusal"]>, string> = {
  owner: "Owners only",
  admin: "Team admins only",
  self: "Not your account",
  limit: "Not checked",
};

function expiresText(expiresAt: number, now: number): string {
  const minutes = Math.ceil((expiresAt - now) / 60_000);
  return minutes <= 1 ? "Expires in under a minute" : `Expires in ${minutes} minutes`;
}

/**
 * A connect of yours that GitHub sent back (github.connects). The first row says who signed in to
 * GitHub, since a Connect link can be finished by whoever it reaches; then each account GitHub listed,
 * with Connect on those you may connect. Nothing is linked until you choose one.
 */
function FinishConnecting({ flow, now }: { flow: Connect; now: number }) {
  const confirm = useAct(api.github.confirmConnect);
  const end = useAct(api.github.endConnect);
  const connectId = flow.connectId as Id<"githubConnects">;
  const id = `gh-finish-${flow.connectId}`;
  const close = (label: string) => (
    <div className="gh-actions">
      <button className="btn" type="button" onClick={() => void end({ connectId })}>
        {label}
      </button>
    </div>
  );
  if (flow.status === "connected" || flow.status === "cancelled") {
    return (
      <Group id={id} label="Finish connecting">
        <div className="gh-account gh-finish" role="status">
          <div className="gh-who">
            {flow.status === "connected" ? (
              <>
                <p>
                  Connected <b>{flow.connectedLogin}</b> to {flow.teamName}.
                </p>
                <p className="sub">Its repos show in the repo pickers as they sync.</p>
              </>
            ) : (
              <p>{flow.cancelled}</p>
            )}
          </div>
          {close(flow.status === "connected" ? "Done" : "Dismiss")}
        </div>
      </Group>
    );
  }
  // A check that stopped answering has died; Connect can be chosen again.
  const checking =
    flow.status === "checking" && flow.checkStaleAt !== undefined && now < flow.checkStaleAt;
  const connectable = flow.accounts.filter((a) => a.canConnect).length;
  return (
    <Group
      id={id}
      label="Finish connecting"
      hint={`Everyone in ${flow.teamName} will see the names of the repos the account you connect gives Uplink Room, and can pick them for projects and runs. If ${flow.githubLogin} isn't your GitHub account, someone else finished this on GitHub: choose Cancel.`}
    >
      <div className="gh-account gh-finish">
        <div className="gh-who">
          <p>
            GitHub signed in as <b>{flow.githubLogin}</b>.
          </p>
          <p className="sub">{expiresText(flow.expiresAt, now)}</p>
        </div>
        {close("Cancel")}
      </div>
      {flow.accounts.map((account) => (
        <OfferedRow
          key={account.installationId}
          account={account}
          checking={checking}
          // The account the person installed the App on is the likely one, so it alone is primary; if
          // GitHub didn't name one, the only account they can connect is.
          primary={account.claimed || (connectable === 1 && account.canConnect)}
          onConnect={() => void confirm({ connectId, installationId: account.installationId })}
        />
      ))}
    </Group>
  );
}

/** One account GitHub listed for a connect: Connect when you may, else why not. */
function OfferedRow({
  account,
  checking,
  primary,
  onConnect,
}: {
  account: Offered;
  checking: boolean;
  primary: boolean;
  onConnect: () => void;
}) {
  const repos = account.suspended
    ? "Suspended on GitHub"
    : account.repositorySelection === "all"
      ? "All repos"
      : "Selected repos";
  return (
    <div className="gh-account">
      <GitHubAvatar login={account.login} type={account.type} avatarUrl={account.avatarUrl} />
      <div className="gh-who">
        <div className="gh-name">
          <b className="truncate">{account.login}</b>
          <span className="muted">
            {account.type === "Organization" ? "Organization" : "Personal account"}
          </span>
        </div>
        <div className="sub">
          <span>{repos}</span>
        </div>
        {account.refused ? (
          <div className="sub gh-why">{account.refused}</div>
        ) : !account.canConnect && !account.connected && account.why ? (
          <div className="sub gh-why">{account.why}</div>
        ) : null}
      </div>
      <div className="gh-actions">
        {account.connected ? (
          <span className="gh-state">Connected</span>
        ) : account.canConnect ? (
          <button
            className={primary ? "btn primary" : "btn"}
            type="button"
            disabled={checking}
            aria-disabled={checking || undefined}
            aria-busy={checking && account.checking}
            onClick={() => {
              if (!checking) onConnect();
            }}
          >
            {checking && account.checking ? "Connecting…" : "Connect"}
          </button>
        ) : (
          <span className="gh-state">
            {REFUSED[account.refusal ?? (account.type === "Organization" ? "owner" : "self")]}
          </span>
        )}
      </div>
    </div>
  );
}

export function GitHubAvatar({
  login,
  type,
  avatarUrl,
  size = 32,
}: {
  login: string;
  type: Account["type"];
  avatarUrl?: string | undefined;
  size?: number;
}) {
  const shape = type === "Organization" ? "org" : "user";
  // GitHub serves these images at the requested pixel size. Keep the 2x source
  // an integer multiple of the CSS box, including its painted inset border.
  let source = avatarUrl;
  if (source?.startsWith("https://avatars.githubusercontent.com/")) {
    const url = new URL(source);
    url.searchParams.set("s", String(size * 2));
    source = url.toString();
  }
  // Block-only SVG avatars need crisp cell edges at any CSS size. Photos keep
  // normal resampling; their source above is requested at twice the drawn size.
  if (source?.startsWith("data:image/svg+xml,")) {
    try {
      const svg = decodeURIComponent(source.slice("data:image/svg+xml,".length));
      if (svg.includes("<rect") && !/<(?:path|circle|ellipse|polygon|polyline)\b/.test(svg)) {
        source = `data:image/svg+xml,${encodeURIComponent(svg.replace("<svg ", '<svg shape-rendering="crispEdges" '))}`;
      }
    } catch {
      // A malformed data URL still follows the image element's normal fallback.
    }
  }
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const ready = Boolean(source && loaded === source);
  return (
    <span
      className={`gh-avatar ${shape}`}
      aria-hidden="true"
      style={{ width: size, height: size }}
      data-image-state={ready ? "loaded" : source && failed !== source ? "loading" : "fallback"}
    >
      {ready ? null : login.slice(0, 1).toUpperCase()}
      {source && failed !== source ? (
        <img
          src={source}
          alt=""
          className={ready ? "loaded" : undefined}
          onLoad={() => setLoaded(source)}
          onError={() => setFailed(source)}
        />
      ) : null}
    </span>
  );
}

/** "All repos (9)" or "Selected repos (2)": what the account gives the team, and how many have synced. */
function repoLine(account: Account): string {
  return `${account.repositorySelection === "all" ? "All repos" : "Selected repos"} (${account.repoCount})`;
}

/** A sync that has said "syncing" past its stale time didn't finish (its action died): Sync now starts it again. */
export function syncStalled(
  account: Pick<Account, "syncState" | "syncStaleAt">,
  now: number,
): boolean {
  return (
    account.syncState === "syncing" &&
    account.syncStaleAt !== undefined &&
    now >= account.syncStaleAt
  );
}

function AccountRow({
  account,
  me,
  onDisconnect,
}: {
  account: Account;
  me: string | undefined;
  onDisconnect: () => void;
}) {
  const sync = useAct(api.github.sync);
  const now = useNow(30_000);
  const stalled = syncStalled(account, now);
  const syncing = account.syncState === "syncing" && !stalled;
  const actions = account.canChangeRepos || account.canSync || account.canDisconnect;
  return (
    <div className="gh-account">
      <GitHubAvatar login={account.login} type={account.type} avatarUrl={account.avatarUrl} />
      <div className="gh-who">
        <div className="gh-name">
          <b className="truncate">{account.login}</b>
          <span className="muted">
            {account.type === "Organization" ? "Organization" : "Personal account"}
          </span>
        </div>
        <div className="sub">
          <span>{repoLine(account)}</span>
          <SyncStatus account={account} stalled={stalled} />
          {account.mine ? null : (
            <span>connected by {account.connectedById === me ? "you" : account.connectedBy}</span>
          )}
        </div>
        {account.suspended ? (
          <div className="sub gh-error">
            Suspended on GitHub. Its repos stay listed until it's unsuspended or uninstalled there.
          </div>
        ) : stalled ? (
          <div className="sub gh-error">
            {account.canSync
              ? "Sync didn't finish. Sync now starts it again."
              : "Sync didn't finish. The daily sync starts it again."}
          </div>
        ) : account.syncState === "failed" ? (
          <div className="sub gh-error">
            Last sync failed: {account.syncError ?? "no reason given"}
          </div>
        ) : null}
      </div>
      {actions ? (
        <div className="gh-actions">
          {account.canChangeRepos && account.settingsUrl ? (
            <button className="btn" type="button" onClick={() => window.open(account.settingsUrl)}>
              Change which repos
            </button>
          ) : null}
          {account.canSync ? (
            <button
              className="btn"
              type="button"
              disabled={syncing || account.suspended}
              aria-busy={syncing}
              onClick={() => void sync({ accountId: account.accountId as Id<"githubAccounts"> })}
            >
              {syncing ? "Syncing…" : "Sync now"}
            </button>
          ) : null}
          {account.canDisconnect ? (
            <button className="btn" type="button" onClick={onDisconnect}>
              Disconnect
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SyncStatus({ account, stalled }: { account: Account; stalled: boolean }) {
  if (account.suspended) return null;
  if (account.syncState === "syncing" && !stalled) return <span>syncing now</span>;
  if (account.syncState === "failed")
    return (
      <span>
        sync failed{account.lastSyncedAt ? `, last synced ${agoText(account.lastSyncedAt)}` : ""}
      </span>
    );
  if (account.lastSyncedAt) return <span>synced {agoText(account.lastSyncedAt)}</span>;
  return <span>not synced yet</span>;
}

/** What stays on GitHub after a disconnect, and whose it is to uninstall. */
function staysOnGitHub(account: Account): string {
  if (account.mine)
    return "The App stays installed on your GitHub account until you uninstall it there.";
  if (account.type === "Organization")
    return `The App stays installed on ${account.login} until one of its owners uninstalls it on GitHub.`;
  return `The App stays installed on ${account.login} until ${account.connectedBy} uninstalls it there, and ${account.connectedBy} can connect it again.`;
}

function DisconnectDialog({ account, onClose }: { account: Account; onClose: () => void }) {
  const disconnect = useMutation(api.github.disconnect);
  const { teamId } = useSession();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    try {
      await disconnect({ teamId, accountId: account.accountId as Id<"githubAccounts"> });
      toast.show(`Disconnected ${account.login}`, true);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  return (
    <Dialog
      title={`Disconnect ${account.login}?`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <Button className="btn primary" pendingAnnouncement="Disconnecting" onClick={submit}>
            {(state) => (state.pending ? "Disconnecting…" : "Disconnect")}
          </Button>
        </>
      }
    >
      <p className="github-disconnect">
        Its repos leave the repo pickers. Projects keep the repos they list, which then show as not
        connected. {staysOnGitHub(account)}
      </p>
      {error ? (
        <p className="gh-disconnect-error" role="alert">
          <Icon name="alert" /> {error}
        </p>
      ) : null}
    </Dialog>
  );
}
