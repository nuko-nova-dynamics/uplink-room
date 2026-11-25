/**
 * The gym's GitHub (ADR 0020): the sample team's connected accounts and synced repos, answered
 * per query so the repo picker's search works as it does against the backend. The accounts are
 * sample data: Harbor Labs' organization and Rosa's and Ana's personal accounts, with identicons,
 * the pictures GitHub gives accounts that never uploaded one. The confirm scenes add a connect of
 * Rosa's that GitHub sent back, waiting for her under Finish connecting (github.connects).
 */
type Json = Record<string, unknown>;

/**
 * Admin scenes show Rosa, an admin, with Harbor Labs' organization, her own personal account and Ana's.
 * The member scenes show Rosa as a member: her own account and the organization, the organization
 * alone, or nothing yet. Ana's personal account is in the data of the first two, and a member's view
 * leaves it out.
 */
export type GitHubScene =
  | "none"
  | "unconfigured"
  | "accounts"
  | "avatar-error"
  | "disconnect-busy"
  | "disconnect-error"
  | "suspended"
  | "syncing"
  | "stalled"
  | "error"
  | "member-own"
  | "member-org"
  | "member-none"
  | "confirm"
  | "confirm-checking"
  | "confirm-refused"
  | "confirm-connected"
  | "confirm-member";

/** A 5×5 identicon, mirrored like GitHub's, as an SVG data URI. */
function identicon(login: string, color: string): string {
  let hash = 2166136261;
  for (const c of login) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0;
  const cells: string[] = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if ((hash >>> (y * 3 + x)) & 1) {
        for (const cx of x === 2 ? [2] : [x, 4 - x])
          cells.push(`<rect x="${cx + 0.5}" y="${y + 0.5}" width="1" height="1"/>`);
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 6 6"><rect width="6" height="6" fill="#f0f0f0"/><g fill="${color}">${cells.join("")}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const MINUTE = 60_000;

const REPOS: [number, string, boolean, boolean][] = [
  [101, "harbor-labs/tide-tables", true, false],
  [102, "harbor-labs/tide-tables-export", false, false],
  [103, "harbor-labs/forecast-api", true, false],
  [104, "harbor-labs/harbor-site", false, false],
  [105, "harbor-labs/station-firmware", true, true],
  [106, "harbor-labs/buoy-ingest", true, false],
  [107, "harbor-labs/design-system", false, false],
  [108, "harbor-labs/ops-runbooks", true, false],
  [109, "harbor-labs/charts", false, false],
  [201, "rosa-vega/tide-notebook", false, false],
  [202, "rosa-vega/dotfiles", false, false],
  [301, "ana-ruiz/buoy-notes", false, false],
];

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export class GitHubWorld {
  readonly scene: GitHubScene;
  /** The sample team's member ids: you (Rosa Vega) and Ana Ruiz. */
  readonly ids: { me: string; ana: string };
  constructor(
    scene: GitHubScene,
    ids: { me: string; ana: string } = { me: "gym-rosa", ana: "gym-ana" },
  ) {
    this.scene = scene;
    this.ids = ids;
  }

  get member(): boolean {
    return this.scene.startsWith("member-") || this.scene === "confirm-member";
  }

  accounts(): Json {
    const now = Date.now();
    const admin = !this.member;
    // What the backend lets each viewer do (github.accounts): admins manage the organization; a
    // personal account is its person's, and an admin can only disconnect someone else's.
    const org = {
      accountId: "gym-github-org",
      login: "harbor-labs",
      type: "Organization",
      avatarUrl: identicon("harbor-labs", "#4f8fb0"),
      repositorySelection: "all",
      repoCount: 9,
      suspended: this.scene === "suspended",
      syncState:
        this.scene === "syncing" || this.scene === "stalled"
          ? "syncing"
          : this.scene === "error"
            ? "failed"
            : "synced",
      // Syncing: started 2 minutes ago. Stalled: started 19 minutes ago, past the 15 after which a sync didn't finish.
      ...(this.scene === "syncing"
        ? { syncStaleAt: now + 13 * MINUTE }
        : this.scene === "stalled"
          ? { syncStaleAt: now - 4 * MINUTE }
          : {}),
      ...(this.scene === "error"
        ? {
            syncError:
              "GitHub refused an installation token (401): A JSON web token could not be decoded.",
          }
        : {}),
      // A failed or stalled sync: the last one that finished was yesterday's.
      lastSyncedAt:
        now - (this.scene === "error" || this.scene === "stalled" ? 26 * 60 * MINUTE : 3 * MINUTE),
      connectedAt: now - 9 * 24 * 60 * MINUTE,
      // In the member scenes Ana is the team's admin, and she connected the organization.
      connectedBy: admin ? "Rosa Vega" : "Ana Ruiz",
      connectedById: admin ? this.ids.me : this.ids.ana,
      mine: false,
      canSync: admin,
      canChangeRepos: admin,
      canDisconnect: admin,
      ...(admin
        ? { settingsUrl: "https://github.com/organizations/harbor-labs/settings/installations/1" }
        : {}),
    };
    const personal = {
      accountId: "gym-github-personal",
      login: "rosa-vega",
      type: "User",
      avatarUrl:
        this.scene === "avatar-error"
          ? "data:image/png;base64,broken"
          : identicon("rosa-vega", "#b0644f"),
      repositorySelection: "selected",
      repoCount: 2,
      suspended: false,
      syncState:
        this.scene === "syncing" ? "syncing" : this.scene === "error" ? "failed" : "synced",
      ...(this.scene === "syncing" ? { syncStaleAt: now + 13 * MINUTE } : {}),
      ...(this.scene === "error"
        ? { syncError: "GitHub couldn't complete the sync. Try Sync now again." }
        : {}),
      lastSyncedAt: now - 64 * MINUTE,
      connectedAt: now - 2 * 24 * 60 * MINUTE,
      connectedBy: "Rosa Vega",
      connectedById: this.ids.me,
      mine: true,
      canSync: true,
      canChangeRepos: true,
      canDisconnect: true,
      settingsUrl: "https://github.com/settings/installations/2",
    };
    const anas = {
      accountId: "gym-github-ana",
      login: "ana-ruiz",
      type: "User",
      avatarUrl: identicon("ana-ruiz", "#6f8f4f"),
      repositorySelection: "selected",
      repoCount: 1,
      suspended: false,
      syncState: "synced",
      lastSyncedAt: now - 5 * 60 * MINUTE,
      connectedAt: now - 24 * 60 * MINUTE,
      connectedBy: "Ana Ruiz",
      connectedById: this.ids.ana,
      mine: false,
      canSync: false,
      canChangeRepos: false,
      canDisconnect: admin,
    };
    // Just connected from Finish connecting: its first sync started a moment ago.
    const fresh = {
      ...Object.fromEntries(Object.entries(org).filter(([key]) => key !== "lastSyncedAt")),
      syncState: "syncing",
      syncStaleAt: now + 15 * MINUTE,
      connectedAt: now - MINUTE,
    };
    const accounts =
      this.scene === "none" ||
      this.scene === "unconfigured" ||
      this.scene === "member-none" ||
      this.scene === "confirm" ||
      this.scene === "confirm-checking" ||
      this.scene === "confirm-refused"
        ? []
        : this.scene === "member-org" || this.scene === "confirm-member"
          ? [org, anas]
          : this.scene === "confirm-connected"
            ? [fresh]
            : [anas, org, personal];
    return {
      configured: this.scene !== "unconfigured",
      canConnect: true,
      canConnectOrganizations: admin,
      accounts,
    };
  }

  /** A connect of Rosa's that GitHub sent back, waiting for her to confirm in the app. */
  connects(): Json[] {
    if (!this.scene.startsWith("confirm")) return [];
    const now = Date.now();
    const base = {
      connectId: "gym-connect",
      teamName: "Harbor Labs",
      githubLogin: "rosa-vega",
      expiresAt: now + 24 * MINUTE + 20_000,
    };
    if (this.scene === "confirm-connected")
      return [{ ...base, status: "connected", connectedLogin: "harbor-labs", accounts: [] }];
    const offered = (
      installationId: number,
      login: string,
      type: "Organization" | "User",
      color: string,
      more: Json,
    ) => ({
      installationId,
      login,
      type,
      avatarUrl: identicon(login, color),
      repositorySelection: "all",
      suspended: false,
      claimed: false,
      connected: false,
      checking: false,
      canConnect: false,
      ...more,
    });
    const org = offered(1, "harbor-labs", "Organization", "#4f8fb0", {
      claimed: true,
      canConnect: true,
    });
    const personal = offered(2, "rosa-vega", "User", "#b0644f", {
      repositorySelection: "selected",
      canConnect: true,
    });
    // An organization where Rosa reads repos but isn't an owner, in the words the backend gives (githubHttp.ts, authority).
    const tide = offered(3, "tide-collective", "Organization", "#8a7a3a", {
      refusal: "owner",
      why: "Only an owner of tide-collective can connect it. It gives Uplink Room every repo the organization picked for the App, including private repos you may not be able to see. GitHub doesn't list rosa-vega as an owner.",
    });
    if (this.scene === "confirm-member") {
      // As a member: her own account, and organizations only an admin connects.
      const adminsOnly = {
        canConnect: false,
        refusal: "admin",
        why: "Only an admin of Harbor Labs can connect an organization.",
      };
      return [
        {
          ...base,
          status: "waiting",
          accounts: [
            { ...personal, claimed: true },
            { ...org, ...adminsOnly, claimed: false, connected: true },
            { ...tide, ...adminsOnly },
          ],
        },
      ];
    }
    if (this.scene === "confirm-checking") {
      return [
        {
          ...base,
          status: "checking",
          checkStaleAt: now + MINUTE,
          accounts: [{ ...org, checking: true }, personal, tide],
        },
      ];
    }
    if (this.scene === "confirm-refused") {
      return [
        {
          ...base,
          status: "waiting",
          accounts: [
            {
              ...org,
              refused:
                "Only an owner of harbor-labs can connect it, and GitHub no longer lists rosa-vega as one.",
            },
            personal,
            tide,
          ],
        },
      ];
    }
    return [{ ...base, status: "waiting", accounts: [org, personal, tide] }];
  }

  repos(): Json[] {
    // The repos of the accounts this scene has connected.
    const owners = new Set(
      ((this.accounts()["accounts"] as Json[]) ?? []).map((a) => String(a["login"])),
    );
    return REPOS.filter(([, name]) => owners.has(name.split("/")[0]!)).map(
      ([githubId, fullName, isPrivate, archived]) => ({
        githubId,
        fullName,
        repo: `github.com/${fullName}`,
        private: isPrivate,
        archived,
        defaultBranch: "main",
        account: fullName.split("/")[0],
      }),
    );
  }

  answer(udfPath: string, args: Json): unknown {
    if (udfPath === "github:accounts") return this.accounts();
    if (udfPath === "github:connects") return this.connects();
    if (udfPath === "github:repos") {
      const query = words(String(args["search"] ?? ""));
      const limit = Number(args["limit"] ?? 20);
      const all = this.repos();
      const found = query.length
        ? all
            .filter((r) =>
              query.every((q) => words(String(r["fullName"])).some((w) => w.startsWith(q))),
            )
            .sort((a, b) => String(a["fullName"]).length - String(b["fullName"]).length)
        : [...all].sort((a, b) => String(a["fullName"]).localeCompare(String(b["fullName"])));
      return found.slice(0, limit);
    }
    if (udfPath === "github:repoStatus") {
      const all = this.repos();
      const key = (r: string) => {
        const k = r
          .toLowerCase()
          .replace(/^https?:\/\//, "")
          .replace(/\.git$/, "");
        return k.split("/").length === 2 ? `github.com/${k}` : k;
      };
      return ((args["repos"] as string[]) ?? []).map((repo) => ({
        repo,
        synced: all.find((r) => key(String(r["repo"])) === key(repo)) ?? null,
      }));
    }
    return undefined;
  }
}
