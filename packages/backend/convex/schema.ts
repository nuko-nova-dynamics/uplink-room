import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  vAccess,
  vRuntimeMode,
  vPrompt,
  vRunHearing,
  vSpaceAction,
  vSpacePower,
  vSpaceScreenshot,
  vT3PairingState,
  vThreadItem,
} from "@uplink-room/protocol";
import { vFileFormat, vPin } from "./lib/files";
import { vKeep } from "./lib/savedLogins";
import { vArtifactRef } from "./lib/a2a/observe";
import { vCallQuality, vCallQualityLimit } from "./lib/callQuality";

export const vRole = v.union(v.literal("admin"), v.literal("member"));

/** Run states (GLOSSARY.md), plus `unknown` for a tool with no adapter. */
export const vRunState = v.union(
  v.literal("working"),
  v.literal("waiting"),
  v.literal("done"),
  v.literal("failed"),
  v.literal("stopped"),
  v.literal("unknown"),
);

export const vBelongsTo = v.union(
  v.object({ kind: v.literal("person"), memberId: v.id("members") }),
  v.object({ kind: v.literal("team") }),
);

/** Who may send an A2A agent work (ADR 0012): anyone in the team, or only the person accountable for it. */
export const vSendWork = v.union(v.literal("team"), v.literal("accountable"));

/** What the room learned about an optional A2A feature the Agent Card doesn't declare. */
export const vLearned = v.union(
  v.literal("unknown"),
  v.literal("supported"),
  v.literal("unsupported"),
);

/** The A2A version the room speaks to an agent over JSON-RPC (ADR 0018). */
export const vDialect = v.union(v.literal("1.0"), v.literal("0.3"));

export const vCharacter = v.object({
  body: v.string(),
  color: v.string(),
  accessory: v.optional(v.string()),
});

export default defineSchema({
  people: defineTable({
    /** Clerk's `subject` for this person. People sign in with Clerk; only agents hold agent keys. */
    subject: v.string(),
    name: v.string(),
    email: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    /**
     * Clerk deleted the account (its `user.deleted` webhook, accounts.ts, ADR 0035). The name is then
     * "A deleted account" and the email and picture are gone. The row stays, keyed by `subject`, so
     * nothing signs in as the person again and what pointed at them still finds a row.
     */
    deletedAt: v.optional(v.number()),
  }).index("by_subject", ["subject"]),

  /** Clerk webhook deliveries already applied, by `svix-id`, so one sent again changes nothing twice. Kept 7 days. */
  clerkDeliveries: defineTable({
    deliveryId: v.string(),
    at: v.number(),
  })
    .index("by_delivery", ["deliveryId"])
    .index("by_at", ["at"]),

  /**
   * A Clerk account that Clerk deleted (ADR 0035), by its user ID, kept for good: no sign-in makes
   * a person for it again, even one the room never saw (`recordPerson`). It also holds how far the
   * steps that take the person out of everything have got (accounts.cleanUp).
   */
  accountDeletions: defineTable({
    subject: v.string(),
    /** The person the room knew for it; absent when it never saw the account. */
    personId: v.optional(v.id("people")),
    deletedAt: v.number(),
    /** When the last cleanup step ran. A deletion not finished whose last step is old is resumed (accounts.resumeStalled). */
    stepAt: v.number(),
    /** The membership whose private channels, direct messages and machines are still being taken away. */
    leaving: v.optional(v.id("members")),
    /**
     * How far the walk through their memberships of teams they had already left got: a page cursor
     * of `members.by_person`, past the memberships finished (accounts.cleanUp).
     */
    formerCursor: v.optional(v.string()),
    /**
     * How far the search for a new admin got, in a team whose only admin was this person: their
     * membership there, and a page cursor of `members.by_team` past the members who can't be one
     * (accounts.cleanUp).
     */
    successor: v.optional(v.object({ memberId: v.id("members"), cursor: v.string() })),
    /** When the cleanup finished: nothing of the person's was left to take away. */
    finishedAt: v.optional(v.number()),
  })
    .index("by_subject", ["subject"])
    .index("by_finished_step", ["finishedAt", "stepAt"]),

  /**
   * A person signed in from one computer's command line with `uplink login` (ADR 0030, GLOSSARY
   * "CLI sign-in"). Its token (`urs_…`) lets the `uplink` tool and `uplink-mcp` act as the person,
   * in any of their teams or in none. Only its SHA-256 is kept; the token is shown once.
   */
  cliSignIns: defineTable({
    personId: v.id("people"),
    hash: v.string(),
    /** The token's first characters, `urs_` and four more, so the person can tell sign-ins apart. */
    prefix: v.string(),
    /** What the person called this computer, by default its host name. */
    name: v.string(),
    createdAt: v.number(),
    /** 30 days after createdAt. The token stops working then. */
    expiresAt: v.number(),
    /**
     * Set by a scheduled function at expiresAt (cliSignIns.expire). The write is what ends cached
     * live queries that checked this sign-in: Convex reruns a query when a document it read
     * changes, not when time passes.
     */
    expired: v.optional(v.boolean()),
    /** When it was last used over HTTP, to the hour. Live watches don't update it. */
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_hash", ["hash"])
    .index("by_person", ["personId"])
    // A deleted account's sign-ins still working, revoked a step at a time (accounts.ts).
    .index("by_person_revoked", ["personId", "revokedAt"])
    .index("by_expires", ["expiresAt"]),

  /**
   * A harness session that joined the room by itself with `uplink join` (ADR 0027, ADR 0032, GLOSSARY
   * "Joined run"): a Claude Code or Codex session, or another agent's, as its signed-in person. Each
   * join has its own run token (`urj_…`, ADR 0029 D8), kept only as its SHA-256, which acts only as
   * this joined run: reads its inbox, posts as it and keeps it alive. The token belongs to the CLI
   * sign-in it was made with and to the harness's session id, and stops working when that sign-in
   * is revoked or expires, or when the run ends. With a team the session is a run there (`runId`).
   * Without one it has no `runs` row and can only pair (D13): it is a run only in its Pairs (`pairRuns`).
   */
  joinedSessions: defineTable({
    personId: v.id("people"),
    signInId: v.id("cliSignIns"),
    hash: v.string(),
    /** The token's first characters, `urj_` and four more. */
    prefix: v.string(),
    /** The harness, as runs name it: `claude-code`, `codex`, or another agent's own name. */
    harness: v.string(),
    /** The harness's own id for the session: Claude Code's session_id, Codex's thread id. */
    sessionRef: v.string(),
    teamId: v.optional(v.id("teams")),
    runId: v.optional(v.id("runs")),
    /** For a session in no team, which has no run to hold it: how it hears messages, as `runs.hearing`. */
    hearing: v.optional(v.union(v.literal("mid_task"), v.literal("between_turns"), v.literal("none"))),
    createdAt: v.number(),
    /** The last heartbeat (or inbox read). Two minutes without one ends the run (joined.expire). */
    lastSeenAt: v.number(),
    endedAt: v.optional(v.number()),
    /**
     * Why it ended: `left` (`uplink leave`), `session_ended` (the harness session ended), `heartbeat`
     * (none for two minutes), `signed_out` (its CLI sign-in was revoked or expired), `stopped`
     * (runs.stop), `replaced` (the session joined again in another team).
     */
    endReason: v.optional(
      v.union(
        v.literal("left"),
        v.literal("session_ended"),
        v.literal("heartbeat"),
        v.literal("signed_out"),
        v.literal("stopped"),
        v.literal("replaced"),
      ),
    ),
  })
    .index("by_hash", ["hash"])
    // A sign-in's joined runs still live end with it, a step at a time (people.revokeSignIn,
    // cliSignIns.expire); pruning a sign-in reads all of them.
    .index("by_sign_in_ended", ["signInId", "endedAt"])
    // The session's join, when it joins again.
    .index("by_person_session", ["personId", "sessionRef"])
    // A deleted account's runs still live, ended a step at a time (accounts.ts).
    .index("by_person_ended", ["personId", "endedAt"])
    .index("by_ended", ["endedAt"]),

  /**
   * A Pair (ADR 0027, ADR 0029 D9 to D13, ADR 0034, GLOSSARY "Pair"): a private conversation of 2 to
   * 10 joined runs and agents, plus their people, who may be in different teams or in none. It lives
   * outside every team, in these `pair*` tables and the `pairs.*` functions, so no team path can
   * reach one. It belongs to its people (`pairPeople`): a run that ends leaves it, and the pair lasts
   * until one of its people ends it, or an account deletion leaves fewer than two people in it.
   */
  pairs: defineTable({
    createdBy: v.id("people"),
    createdAt: v.number(),
    /** The newest message's seq: 0 before the first. */
    seq: v.number(),
    lastMessageAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    /** The person who ended it; absent when the room ended it (`too_few_people`). */
    endedBy: v.optional(v.id("people")),
    /** `ended`: one of its people ended it. `too_few_people`: an account deletion left fewer than two (D10). */
    endReason: v.optional(v.union(v.literal("ended"), v.literal("too_few_people"))),
  })
    // A person's open Pairs and the Pairs they made lately, for the limits on making one (ADR 0036).
    .index("by_creator_ended", ["createdBy", "endedAt"])
    .index("by_creator", ["createdBy", "createdAt"]),

  /**
   * A person a Pair belongs to: someone whose run or agent joined it. They read and write it, make
   * its codes and can end it; their next run can rejoin it (`uplink pair --resume`). Leaving a team
   * changes nothing here (D10); deleting the account sets `removedAt`.
   */
  pairPeople: defineTable({
    pairId: v.id("pairs"),
    personId: v.id("people"),
    joinedAt: v.number(),
    /** The newest message seq they have read. */
    readSeq: v.number(),
    /** They left (`pairs.leave`), or their account was deleted (D10, lib/pairs.ts `forgetPairsStep`). */
    removedAt: v.optional(v.number()),
  })
    // A pair's people, or a person's pairs: removedAt unset for those still in it.
    .index("by_pair_removed", ["pairId", "removedAt"])
    .index("by_person_removed", ["personId", "removedAt"])
    .index("by_pair_person", ["pairId", "personId"]),

  /**
   * A joined run in a Pair (ADR 0032): a session of one of its people. Live until `endedAt`: when the
   * session ends, or the pair does. Its messages wait in `pairInbox` and reach it the way a joined
   * run's do, through `joined.take`.
   */
  pairRuns: defineTable({
    pairId: v.id("pairs"),
    sessionId: v.id("joinedSessions"),
    personId: v.id("people"),
    harness: v.string(),
    joinedAt: v.number(),
    endedAt: v.optional(v.number()),
  })
    // A pair's live runs: endedAt unset.
    .index("by_pair_ended", ["pairId", "endedAt"])
    // A session's live runs in Pairs, without the ones that left: a session that pairs all day
    // leaves hundreds behind.
    .index("by_session_ended", ["sessionId", "endedAt"]),

  /**
   * An agent in a Pair (D11): it joined with a pair code its person passed on, and acts there with its
   * agent key. The pair shows its name and its person's, never its team. `teamId` and `memberId` are
   * the room's own record, never shown to anyone in the pair.
   */
  pairAgents: defineTable({
    pairId: v.id("pairs"),
    agentId: v.id("agents"),
    memberId: v.id("members"),
    teamId: v.id("teams"),
    /** The person accountable for it, one of the pair's people. */
    personId: v.id("people"),
    joinedAt: v.number(),
    /** The newest message seq it has read. */
    readSeq: v.number(),
    leftAt: v.optional(v.number()),
  })
    // A pair's agents still in it, or an agent's pairs it is still in: leftAt unset.
    .index("by_pair_left", ["pairId", "leftAt"])
    .index("by_agent_left", ["agentId", "leftAt"])
    .index("by_person", ["personId"]),

  /**
   * A pair code (GLOSSARY "Pair code"), such as RIVER-4821-MAPLE-0937: a bearer secret for 10 minutes that
   * lets one more run or agent join. Only its SHA-256 is kept, and it works once (`usedAt`).
   */
  pairCodes: defineTable({
    pairId: v.id("pairs"),
    codeHash: v.string(),
    createdBy: v.id("people"),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
  })
    .index("by_code", ["codeHash"])
    .index("by_expires", ["expiresAt"]),

  /**
   * Wrong pair codes one person tried (for an agent, its accountable person), in the current window.
   * Past the limit, no code works for them until the window ends, so codes can't be guessed.
   */
  pairCodeFailures: defineTable({
    personId: v.id("people"),
    windowStart: v.number(),
    failures: v.number(),
  })
    .index("by_person", ["personId"])
    .index("by_window", ["windowStart"]),

  /**
   * A message in a Pair. `personId` is the person accountable for it: the writer, the person whose
   * run posted it, or an agent's person. A run or an agent that posted it is named as it was then.
   * When that person's account is deleted, `personId`, `run` and `agent` go and `deletedAuthor` is
   * set: it shows as "A deleted account" (D10).
   */
  pairMessages: defineTable({
    pairId: v.id("pairs"),
    seq: v.number(),
    body: v.string(),
    at: v.number(),
    personId: v.optional(v.id("people")),
    run: v.optional(v.object({ pairRunId: v.id("pairRuns"), label: v.string() })),
    agent: v.optional(v.object({ pairAgentId: v.id("pairAgents"), name: v.string() })),
    deletedAuthor: v.optional(v.boolean()),
    /** How many files it carries (`pairAttachments`, ADR 0048); absent for none. */
    attachmentCount: v.optional(v.number()),
  })
    .index("by_pair_seq", ["pairId", "seq"])
    .index("by_person", ["personId"]),

  /**
   * An upload URL issued for one file sent in a Pair (ADR 0048): to one of its people for that Pair
   * (`pairs.attachUrl`), to one of its agents, or to a joined run in no team (`joined.attachUrl`). A
   * message keeps it only from the author it was issued to; then this row goes. The hourly sweep
   * (files.sweepUploads) deletes rows never used and bytes nothing keeps. These rows are outside
   * every team, as every Pair table is.
   */
  pairUploads: defineTable({
    personId: v.id("people"),
    by: v.union(
      v.object({ kind: v.literal("person"), pairId: v.id("pairs") }),
      v.object({ kind: v.literal("agent"), pairAgentId: v.id("pairAgents") }),
      v.object({ kind: v.literal("run"), sessionId: v.id("joinedSessions") }),
    ),
  }),

  /**
   * A file sent with a Pair message (ADR 0048), in the kinds and sizes a chat message's are. It has
   * no lasting link: whoever is still in the Pair asks for a short-lived one (`pairs.attachmentLink`,
   * `joined.download`), as a direct message's files are served (ADR 0016).
   */
  pairAttachments: defineTable({
    pairId: v.id("pairs"),
    messageId: v.id("pairMessages"),
    /** Its place in the message's list, from 0. */
    position: v.number(),
    storageId: v.id("_storage"),
    name: v.string(),
    kind: v.union(v.literal("image"), v.literal("pdf"), v.literal("file")),
    contentType: v.string(),
    size: v.number(),
  })
    .index("by_message", ["messageId"])
    .index("by_storage", ["storageId"]),

  /**
   * A short-lived link to one Pair attachment (ADR 0048), for whoever asked: one of the Pair's people,
   * one of its agents, or one of its runs. `/attachments/pair/<token>` serves the bytes only until it
   * expires, and only while that person, agent or run is still in the Pair.
   */
  pairAttachmentGrants: defineTable({
    attachmentId: v.id("pairAttachments"),
    by: v.union(
      v.object({ kind: v.literal("person"), personId: v.id("people") }),
      v.object({
        kind: v.literal("agent"),
        pairAgentId: v.id("pairAgents"),
        /** The key the link was made with: the link works only while it isn't revoked and holds pairs.join. */
        agentKeyId: v.optional(v.id("agentKeys")),
      }),
      v.object({ kind: v.literal("run"), pairRunId: v.id("pairRuns") }),
    ),
    /** SHA-256 of the link's token. */
    tokenHash: v.string(),
    /** Served as a download (`Content-Disposition: attachment`) rather than shown. */
    download: v.boolean(),
    expiresAt: v.number(),
  })
    .index("by_token", ["tokenHash"])
    .index("by_expires", ["expiresAt"]),

  /**
   * A Pair message waiting for one of the pair's live runs, as `runInbox` holds a team's (ADR 0032):
   * taken, acknowledged and released with the same `joined.take`, `joined.ack` and `joined.release`,
   * under the same claims.
   */
  pairInbox: defineTable({
    pairId: v.id("pairs"),
    sessionId: v.id("joinedSessions"),
    messageId: v.id("pairMessages"),
    /** Whether the person accountable for it is this run's own person. */
    fromDriver: v.boolean(),
    status: v.union(v.literal("waiting"), v.literal("claimed"), v.literal("delivered"), v.literal("failed")),
    how: v.optional(v.union(v.literal("mid_task"), v.literal("next_turn"))),
    claim: v.optional(v.object({ id: v.string(), at: v.number(), how: v.union(v.literal("mid_task"), v.literal("next_turn")) })),
    unsure: v.optional(v.number()),
    /** `run_ended`: the run left the pair, or the pair ended, first. `unsure`: a claim lapsed twice. */
    error: v.optional(v.union(v.literal("run_ended"), v.literal("unsure"))),
    at: v.number(),
  })
    .index("by_session_status", ["sessionId", "status"])
    .index("by_message", ["messageId"]),

  /**
   * A command-line sign-in in progress: the nonce the room gave `uplink login`, which Clerk puts
   * in the ID token, so each ID token makes one sign-in on this deployment only (ADR 0030).
   */
  cliSignInRequests: defineTable({
    nonce: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_nonce", ["nonce"])
    .index("by_expires", ["expiresAt"]),

  /**
   * A remote connector (ADR 0028, ADR 0031, GLOSSARY "Connector"): a hosted assistant or other MCP
   * client that a person signed in to the room's MCP endpoint (`/mcp`) with Clerk. One per person
   * and OAuth client. It waits until the person approves it in the app, picking its team, name and
   * scopes; approving adds it as an agent with an agent key whose secret nobody sees, and from then
   * on it acts through that key. It is pending while `agentKeyId` is unset.
   */
  connectors: defineTable({
    /** Clerk's user ID of the person who signed in: the access token's `sub`. */
    subject: v.string(),
    /** The OAuth client the token was issued to: its `client_id`, a registered client's ID or a CIMD URL. */
    clientId: v.string(),
    /** What the client calls itself in MCP's clientInfo, at most 80 characters. Untrusted: the person names the agent. */
    clientName: v.optional(v.string()),
    createdAt: v.number(),
    /** When it last called, to the hour. */
    lastSeenAt: v.number(),
    /** Set when the person approves it. */
    teamId: v.optional(v.id("teams")),
    agentId: v.optional(v.id("agents")),
    agentKeyId: v.optional(v.id("agentKeys")),
    approvedAt: v.optional(v.number()),
  })
    .index("by_subject_client", ["subject", "clientId"])
    .index("by_subject", ["subject"])
    .index("by_key_last_seen", ["agentKeyId", "lastSeenAt"])
    // The connection behind an agent: one that only reads and posts through it checks in on its own schedule.
    .index("by_agent", ["agentId"]),

  teams: defineTable({
    name: v.string(),
    createdAt: v.number(),
    /** Whether the room fetches link previews for messages (spec #63). Absent: on. Admins set it. */
    linkPreviews: v.optional(v.union(v.literal("on"), v.literal("off"))),
    /**
     * The highest call quality the team allows (issue #87): it caps every channel's voice quality
     * and the screen share choices, since LiveKit Cloud bills by bandwidth. Absent: none, so
     * everything is allowed. Admins set it (teams.setCallQualityLimit).
     */
    callQualityLimit: v.optional(vCallQualityLimit),
    /**
     * Whether an invite nobody accepted after 3 days gets its one reminder email (invites.remind).
     * Absent: on. Admins set it (teams.setInviteReminders).
     */
    inviteReminders: v.optional(v.union(v.literal("on"), v.literal("off"))),
  }),

  /** A team member: a person or an agent. */
  members: defineTable({
    teamId: v.id("teams"),
    kind: v.union(v.literal("person"), v.literal("agent")),
    personId: v.optional(v.id("people")),
    agentId: v.optional(v.id("agents")),
    name: v.string(),
    role: vRole,
    removedAt: v.optional(v.number()),
    /**
     * Whether this person gets "<name> joined <team>" when someone they invited joins. Absent: on.
     * Each person sets their own (members.setEmailNotifications).
     */
    joinedEmails: v.optional(v.union(v.literal("on"), v.literal("off"))),
    /**
     * A person's Link (ADR 0049): the roster agent their Inbox talks to, and the direct message with
     * it that the Inbox shows as a conversation. The agent reads each message there, answers, or
     * starts the work itself (tasks.create, runs.start). Absent: the Inbox's box starts a thread.
     * Set with members.setLink.
     */
    link: v.optional(v.object({ memberId: v.id("members"), channelId: v.id("channels") })),
    /**
     * A custom status: a short line the member sets about what they're doing ("Reviewing PRs"),
     * shown beside their name in People. Absent: none. Set with members.setStatus.
     */
    status: v.optional(v.string()),
  })
    .index("by_team", ["teamId"])
    // A team's admins, read without its other members (accounts.ts, when its only admin's account is deleted).
    .index("by_team_role", ["teamId", "role"])
    .index("by_person", ["personId"])
    .index("by_agent", ["agentId"]),

  invites: defineTable({
    teamId: v.id("teams"),
    email: v.string(),
    role: vRole,
    invitedBy: v.id("members"),
    /** SHA-256 of the current token. Regenerating or resending replaces it, so the old token stops working. */
    tokenHash: v.string(),
    acceptedAt: v.optional(v.number()),
    /** Who joined with it. Absent on invites accepted before this was kept. */
    acceptedBy: v.optional(v.id("members")),
    /**
     * Which token this is: 1 for the first, one more each time it's regenerated or resent. Invite
     * emails and the reminder belong to one generation, so a newer token makes them moot. Absent: an
     * invite made before tokens could change, treated as 0.
     */
    generation: v.optional(v.number()),
    /** When the token stops working. Absent: an invite made before invites expired, which never does. */
    expiresAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    /**
     * The current token, sealed with AES-GCM (lib/inviteToken.ts), so the invite email, the reminder
     * and Copy link can give out the same link later. Absent when the deployment has no
     * INVITE_TOKEN_KEYS, and once the invite is accepted or revoked. `keyId` names the key it was
     * sealed with.
     */
    sealedToken: v.optional(v.object({ ciphertext: v.string(), iv: v.string(), keyId: v.optional(v.string()) })),
    /** False when the admin chose to send the link by hand. Absent: emails are on. */
    sendEmail: v.optional(v.boolean()),
    /** The one reminder, scheduled for 3 days after the invite is made (invites.remind). */
    reminderId: v.optional(v.id("_scheduled_functions")),
    remindedAt: v.optional(v.number()),
    /** The latest invite or reminder email and where it stands, for the waiting invites list. */
    lastEmail: v.optional(
      v.object({
        emailId: v.id("emails"),
        kind: v.union(v.literal("invite"), v.literal("reminder")),
        status: v.union(v.literal("sending"), v.literal("sent"), v.literal("failed"), v.literal("skipped")),
        at: v.number(),
        /** Why it failed or was skipped, in words a person can act on. Never a secret. */
        error: v.optional(v.string()),
      }),
    ),
  })
    .index("by_team", ["teamId"])
    .index("by_token", ["tokenHash"]),

  /**
   * Every email the room sends (lib/email.ts), with where it stands. One row is one email: its
   * retries reuse the row and its Resend idempotency key, so a retry never sends it twice. Rows hold
   * what the template needs, never a token: an invite's token is opened from the invite at send time.
   */
  emails: defineTable({
    teamId: v.id("teams"),
    kind: v.union(v.literal("invite"), v.literal("reminder"), v.literal("welcome"), v.literal("joined")),
    to: v.string(),
    inviteId: v.id("invites"),
    /** For invite and reminder emails: the token generation it carries. A newer one makes it moot. */
    generation: v.optional(v.number()),
    /** The Resend Idempotency-Key, the same on every attempt (lib/email.ts, idempotencyKey). */
    idempotencyKey: v.string(),
    /** What the template shows: names, the team, dates and ids that carry no secret. */
    data: v.object({
      teamName: v.string(),
      teamId: v.id("teams"),
      inviterName: v.optional(v.string()),
      inviterEmail: v.optional(v.string()),
      /** Set when an agent sent the invite: its name, beside its accountable person's in inviterName. */
      agentName: v.optional(v.string()),
      inviteeName: v.optional(v.string()),
      inviteeEmail: v.optional(v.string()),
      role: v.optional(vRole),
      expiresAt: v.optional(v.number()),
      invitedAt: v.optional(v.number()),
      /** Welcome emails: the channel "join a call" opens. */
      channelId: v.optional(v.id("channels")),
      channelName: v.optional(v.string()),
    }),
    status: v.union(
      v.literal("queued"),
      v.literal("sending"),
      v.literal("sent"),
      v.literal("failed"),
      v.literal("skipped"),
    ),
    /** Attempts started so far. */
    attempts: v.number(),
    /** The last failure, or why it was skipped. Never a secret. */
    error: v.optional(v.string()),
    /** Resend's id for the email, once Resend accepted it. */
    resendId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    sentAt: v.optional(v.number()),
  })
    .index("by_invite", ["inviteId"])
    .index("by_team", ["teamId"]),

  agents: defineTable({
    teamId: v.id("teams"),
    name: v.string(),
    /** The person accountable for the agent. An agent can do at most what this person can. */
    addedBy: v.id("members"),
    /** "webhook": the room reaches it at a routine webhook (webhooks.set), as Grok Bot (ADR 0028). */
    connection: v.union(v.literal("mcp"), v.literal("http"), v.literal("a2a"), v.literal("cli"), v.literal("webhook")),
    character: v.optional(vCharacter),
  }).index("by_team", ["teamId"]),

  agentKeys: defineTable({
    teamId: v.id("teams"),
    agentId: v.id("agents"),
    name: v.string(),
    /** SHA-256 of the secret. The secret is shown once, when the key is created. */
    hash: v.string(),
    prefix: v.string(),
    scopes: v.array(v.string()),
    /**
     * The only channels this key may read and post in, and the tasks of the projects they belong
     * to (ADR 0049). Absent: every channel its person can see.
     */
    channelIds: v.optional(v.array(v.id("channels"))),
    createdBy: v.id("members"),
    createdAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_hash", ["hash"])
    .index("by_agent", ["agentId"])
    // An agent's keys still valid (no revokedAt), however many it has revoked.
    .index("by_agent_revoked", ["agentId", "revokedAt"]),

  projects: defineTable({
    teamId: v.id("teams"),
    name: v.string(),
    repos: v.array(v.string()),
    channelId: v.id("channels"),
    archivedAt: v.optional(v.number()),
  }).index("by_team", ["teamId"]),

  channels: defineTable({
    teamId: v.id("teams"),
    /** Empty for a direct message: the app shows its members' names instead. */
    name: v.string(),
    projectId: v.optional(v.id("projects")),
    archivedAt: v.optional(v.number()),
    /**
     * Absent or `channel`: a team channel, open to the whole team. `direct`: a direct message
     * (ADR 0015), and `private`: a private channel (ADR 0016), each open only to the members in
     * `channelMembers`. lib/channels.ts decides access. A channel's kind never changes.
     */
    kind: v.optional(v.union(v.literal("channel"), v.literal("direct"), v.literal("private"))),
    /** A direct message's members' ids, sorted and joined by commas, to find it again for the same members. */
    memberKey: v.optional(v.string()),
    /** A private channel's creator: with admins who are members, the only ones who can remove members. */
    createdBy: v.optional(v.id("members")),
    /** The seq of the channel's last message. Unread counts are this minus a member's read seq. Absent: 0. */
    lastSeq: v.optional(v.number()),
    lastMessageAt: v.optional(v.number()),
    /** Unused: replaced by `deletedTotal` and the `deletions` table. */
    deletedSeqs: v.optional(v.array(v.number())),
    /** How many messages with a seq were ever deleted here (one row each in `deletions`). Absent: 0. */
    deletedTotal: v.optional(v.number()),
    /**
     * The voice quality of this channel's calls (issue #87): standard, high or music. Absent:
     * standard. The team's `callQualityLimit` caps it (lib/callQuality.ts). Set with
     * channels.setCallQuality.
     */
    callQuality: v.optional(vCallQuality),
  })
    .index("by_team", ["teamId"])
    .index("by_team_member_key", ["teamId", "memberKey"]),

  /**
   * Who is in a direct message (ADR 0015) or a private channel (ADR 0016). Team channels have no
   * rows here: the whole team is in them.
   */
  channelMembers: defineTable({
    teamId: v.id("teams"),
    channelId: v.id("channels"),
    memberId: v.id("members"),
    addedAt: v.number(),
    /** Who added them to a private channel. Absent for its creator and for direct messages. */
    addedBy: v.optional(v.id("members")),
    /**
     * When they acknowledged the warning of a direct message opened with a run whose output people
     * outside it can see (`acknowledgeWarning` on messages.post, ADR 0039, amended 2026-11-05).
     * Until then their posts there are refused with `warning_required`.
     */
    warningAcknowledgedAt: v.optional(v.number()),
  })
    .index("by_channel_member", ["channelId", "memberId"])
    .index("by_member", ["memberId"]),

  /**
   * The live runs in a direct message (ADR 0026, ADR 0029 D4). A run isn't a member: its person is
   * in `channelMembers` as an ordinary member, so who may see the direct message stays one check.
   */
  channelRuns: defineTable({
    teamId: v.id("teams"),
    channelId: v.id("channels"),
    runId: v.id("runs"),
    addedBy: v.id("members"),
    addedAt: v.number(),
    /**
     * When the room checked whether the direct message's history says whose output this run is, and
     * added that line if it should (ADR 0039, amended 2026-11-05). Absent on rows from before the
     * warning, which get the line once, when the direct message is opened again or posted in.
     */
    warnedAt: v.optional(v.number()),
  })
    .index("by_channel", ["channelId"])
    .index("by_run", ["runId"]),

  /**
   * One member's read state and notification level in one channel or direct message. Absent
   * until it is first needed: until then the member has read what was posted before they joined.
   */
  channelReads: defineTable({
    teamId: v.id("teams"),
    channelId: v.id("channels"),
    memberId: v.id("members"),
    /** Read up to and including the message with this seq. */
    readSeq: v.number(),
    readAt: v.optional(v.number()),
    /** Unused: replaced by the counters below and the `mentions` table. */
    mentionSeqs: v.optional(v.array(v.number())),
    /** How many of the channel's deletions have a seq at or below `readSeq`. Unread = lastSeq − readSeq − (deletedTotal − this). */
    deletedThrough: v.optional(v.number()),
    /**
     * The channel's `deletedTotal` when `deletedThrough` was last brought up to date. A deletion
     * still being swept past (`messageSweeps`) with a higher number may not be in it yet (lib/reads.ts).
     * Absent on rows from before: 0.
     */
    deletionSync: v.optional(v.number()),
    /** The member's live rows in `mentions` for this channel, and how many of them are at or below `readSeq`. */
    mentionTotal: v.optional(v.number()),
    mentionsThrough: v.optional(v.number()),
    /** Absent: the default, `all` in a direct message and `mentions` in a channel. */
    notify: v.optional(v.union(v.literal("all"), v.literal("mentions"), v.literal("none"))),
    /**
     * Counts each time the read point is moved back (channels.markUnread). A partial markRead's
     * scheduled step carries the number it started under and stops if it changed, so it can't undo
     * a Mark unread made meanwhile. Absent: 0.
     */
    readGeneration: v.optional(v.number()),
  })
    .index("by_channel_member", ["channelId", "memberId"])
    .index("by_channel_notify", ["channelId", "notify"])
    .index("by_channel_read", ["channelId", "readSeq"])
    .index("by_member", ["memberId"]),

  /** One deleted message (with a seq), so unread counts stay exact however many are deleted (lib/reads.ts). */
  deletions: defineTable({
    channelId: v.id("channels"),
    seq: v.number(),
  }).index("by_channel_seq", ["channelId", "seq"]),

  /** A message addressed to a member (a mention, @everyone or a reply), for exact mention counts (lib/reads.ts). */
  mentions: defineTable({
    channelId: v.id("channels"),
    memberId: v.id("members"),
    messageId: v.id("messages"),
    seq: v.number(),
  })
    .index("by_member_channel_seq", ["memberId", "channelId", "seq"])
    .index("by_message_member", ["messageId", "memberId"]),

  /**
   * A message being taken out of counts in steps, because it can reach the whole team (#69): it was
   * deleted, or @everyone was edited out of it. While the row exists, lib/reads.ts counts as if the
   * steps had all run; the last step deletes it.
   */
  messageSweeps: defineTable({
    teamId: v.id("teams"),
    channelId: v.id("channels"),
    messageId: v.id("messages"),
    /** deleted: out of every count, its alerts deleted. everyone: out of the counts of whoever it no longer names or answers. */
    kind: v.union(v.literal("deleted"), v.literal("everyone")),
    /** For a deleted message with a seq: its seq, and the channel's `deletedTotal` once it was counted. */
    seq: v.optional(v.number()),
    deletion: v.optional(v.number()),
  })
    .index("by_channel", ["channelId"])
    .index("by_message", ["messageId"])
    // A team's running sweeps, read once per channels.list.
    .index("by_team", ["teamId"]),

  messages: defineTable({
    teamId: v.id("teams"),
    channelId: v.id("channels"),
    authorId: v.id("members"),
    /** Set when an agent posted it: the key it used. */
    agentKeyId: v.optional(v.id("agentKeys")),
    format: v.union(v.literal("markdown"), v.literal("html")),
    body: v.string(),
    replyTo: v.optional(v.id("messages")),
    mentionedTasks: v.array(v.id("tasks")),
    mentionedRuns: v.array(v.id("runs")),
    /** Agents the message names. An A2A agent among them gets the message as a run (ADR 0012). */
    mentionedAgents: v.optional(v.array(v.id("members"))),
    /** People and agents the message names (`<@memberId>` in the body, or passed). Absent on older messages. */
    mentionedMembers: v.optional(v.array(v.id("members"))),
    /** Its place in the channel, from 1, counting replies. Absent on messages from before unread counts. */
    seq: v.optional(v.number()),
    editedAt: v.optional(v.number()),
    /** Deleted while it had replies: kept as a "message deleted" line, with no body, attachments or reactions. */
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.id("members")),
    /** At most 20 distinct emoji, each with who reacted, in order. */
    reactions: v.optional(v.array(v.object({ emoji: v.string(), memberIds: v.array(v.id("members")) }))),
    /** How many rows it has in `attachments`, so most messages skip that read. */
    attachmentCount: v.optional(v.number()),
    /** How many agentDeliveries rows it has: the app reads them only for a message that has some. */
    deliveryCount: v.optional(v.number()),
    /** The last reply's time, for a "new replies" mark. */
    lastReplyAt: v.optional(v.number()),
    /**
     * How many replies it has, kept by every reply posted and deleted, so a thread is never read
     * whole to count it. Absent on messages replied to before it was kept: counted then, bounded.
     */
    replyCount: v.optional(v.number()),
    /** Its newest reply's seq, kept with replyCount: past your read point, the thread has news. */
    lastReplySeq: v.optional(v.number()),
    /**
     * Who replied most lately, up to three, newest first: kept by every reply posted and deleted, so
     * showing a thread's faces never reads its replies. Absent on threads not replied to since.
     */
    repliers: v.optional(v.array(v.id("members"))),
    /**
     * A thread reply also sent to the channel (Also send to #channel): this top-level row shows that
     * reply in the channel's list. It has no body, seq or reactions of its own; the reply has them.
     */
    echoOf: v.optional(v.id("messages")),
    /** On a reply also sent to the channel: the row that shows it there (echoOf), deleted with it. */
    echoId: v.optional(v.id("messages")),
    /**
     * Goes up by one with every reply posted to it or deleted from it, so the reply backfill
     * (messages.backfillReplyMeta) can tell a thread changed while it was counting it.
     */
    replyRevision: v.optional(v.number()),
    /** @everyone: a mention of everyone in the channel, except those who set it to none. */
    mentionsEveryone: v.optional(v.boolean()),
    /** The first 3 links in the body, normalized, whose previews (`linkPreviews`) it shows. */
    previewUrls: v.optional(v.array(v.string())),
    /** Its author removed the previews. */
    previewsHidden: v.optional(v.boolean()),
    pinnedAt: v.optional(v.number()),
    pinnedBy: v.optional(v.id("members")),
    /**
     * A line the room wrote in the channel, such as "Ana pinned a message". It has no seq. `run`: what
     * happened to an agent's run over A2A that the agent didn't say itself, such as a failure or a
     * refused message, with a link to the run (ADR 0024). Its author is the agent.
     */
    system: v.optional(
      v.union(
        v.object({ kind: v.literal("pinned"), messageId: v.id("messages") }),
        v.object({
          kind: v.literal("run"),
          runId: v.id("runs"),
          text: v.string(),
          tone: v.union(v.literal("info"), v.literal("warn")),
        }),
      ),
    ),
    /**
     * The runs this message was sent to over A2A (ADR 0024): started by it, or continued. They are in
     * mentionedRuns too, as before; the app shows their chip on the agent's answer instead.
     */
    a2aRuns: v.optional(v.array(v.id("runs"))),
    /**
     * The live runs the message is addressed to (ADR 0026, ADR 0029): `<@run:runId>` tokens in its
     * body and the runs passed as addressedRuns. Unlike mentionedRuns, which only links a run as a
     * chip, these are runs the message is for. Absent on messages that address none.
     */
    addressedRuns: v.optional(v.array(v.id("runs"))),
    /**
     * Posted by a live run as itself (ADR 0026): the run, and the name it had then, such as
     * "Claude Code (Julio)". `authorId` is the run's driver when it posted, who answers for it.
     */
    asRun: v.optional(v.object({ runId: v.id("runs"), label: v.string() })),
    /**
     * Posted by the room for an agent over A2A (ADR 0024): the run it came from, and when the agent
     * asked to move its work to a thread of its own, that proposal.
     */
    a2a: v.optional(
      v.object({
        runId: v.id("runs"),
        proposal: v.optional(
          v.object({
            title: v.optional(v.string()),
            /**
             * Canceled: no thread opened, with nobody's Yes or No: the run was stopped or isn't
             * followed any more, or the proposal or the message it would open under was deleted.
             */
            status: v.union(v.literal("pending"), v.literal("accepted"), v.literal("declined"), v.literal("canceled")),
            /** Why it was canceled, as the room words it for the chat. */
            reason: v.optional(v.string()),
            /** Without an answer by then, it counts as Yes. */
            expiresAt: v.number(),
            /** The thread opens under this message: the one that started the agent's work. */
            triggerMessageId: v.id("messages"),
            conversationId: v.id("a2aConversations"),
            /** Who answered; absent on a Yes that came from the wait running out. */
            decidedBy: v.optional(v.id("members")),
            decidedAt: v.optional(v.number()),
          }),
        ),
      }),
    ),
  })
    .index("by_channel", ["channelId"])
    .index("by_reply", ["replyTo"])
    .index("by_channel_top", ["channelId", "replyTo"])
    .index("by_channel_pinned", ["channelId", "pinnedAt"])
    // Threads with replies past a read point (messages.unreadThreads); messages without replies sort first.
    .index("by_channel_last_reply", ["channelId", "lastReplySeq"])
    .searchIndex("search_body", { searchField: "body", filterFields: ["teamId", "channelId", "authorId"] }),

  /**
   * What a link shows under a message (spec #63): fetched by the backend, never by the app, and
   * shared by every message with the same link for 24 hours. Fields are plain text from the page's
   * Open Graph, Twitter card and `<title>` tags; the image is a copy in Convex file storage.
   */
  linkPreviews: defineTable({
    /** The normalized URL (lib/linkPreview.ts). */
    url: v.string(),
    status: v.union(v.literal("pending"), v.literal("ready"), v.literal("failed")),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    siteName: v.optional(v.string()),
    imageStorageId: v.optional(v.id("_storage")),
    /** Why there is no preview, for the record. Never shown in the app. */
    error: v.optional(v.string()),
    requestedAt: v.number(),
    fetchedAt: v.optional(v.number()),
    /**
     * While pending: every team whose message is waiting on this fetch, so it goes on for the others
     * when one turns previews off (#70). Cleared when the fetch settles.
     */
    waitingTeams: v.optional(v.array(v.id("teams"))),
  })
    .index("by_url", ["url"])
    .index("by_image", ["imageStorageId"]),

  /**
   * A file attached to a message (spec #63, ADR 0015). Its bytes are in Convex file storage,
   * uploaded the way project files are (files.uploadUrl's `uploads`). A project file saved from
   * it shares the same bytes, which are deleted only when neither uses them any more.
   */
  attachments: defineTable({
    teamId: v.id("teams"),
    channelId: v.id("channels"),
    messageId: v.id("messages"),
    /** Its place in the message's list, from 0. */
    position: v.number(),
    storageId: v.id("_storage"),
    name: v.string(),
    /** `image` and `pdf` show in the app; any other `file` is only ever downloaded. */
    kind: v.union(v.literal("image"), v.literal("pdf"), v.literal("file")),
    contentType: v.string(),
    size: v.number(),
    /** The unguessable part of its download link (`/attachments/<token>`), which serves it as a download. */
    token: v.string(),
  })
    .index("by_message", ["messageId"])
    .index("by_storage", ["storageId"])
    .index("by_token", ["token"]),

  /**
   * A short-lived link to one attachment in a direct message or private channel, for one member
   * (ADR 0016). messages.attachmentLink makes it; `/attachments/grant/<token>` serves the bytes only
   * until it expires, and only while that member can still see the channel.
   */
  attachmentGrants: defineTable({
    attachmentId: v.id("attachments"),
    memberId: v.id("members"),
    /** The agent key the link was made with: it serves only while the key still reaches the channel (ADR 0049). */
    agentKeyId: v.optional(v.id("agentKeys")),
    /** SHA-256 of the link's token. */
    tokenHash: v.string(),
    /** Served as a download (`Content-Disposition: attachment`) rather than shown. */
    download: v.boolean(),
    expiresAt: v.number(),
  })
    .index("by_token", ["tokenHash"])
    .index("by_expires", ["expiresAt"]),

  /**
   * A new message addressed to a member, for desktop banners and agents watching for work: a
   * direct message, a mention, a reply to their message, or any message in a channel they set to
   * `all`. Written when the message reaches the member (at once, or by a later @everyone fan-out
   * step); deleted with it, and after 7 days.
   */
  messageAlerts: defineTable({
    teamId: v.id("teams"),
    memberId: v.id("members"),
    channelId: v.id("channels"),
    messageId: v.id("messages"),
    reason: v.union(
      v.literal("direct"),
      v.literal("mention"),
      v.literal("reply"),
      v.literal("everyone"),
      v.literal("all"),
    ),
    /** When the alert was written: the post, or the fan-out step that reached this member. */
    at: v.number(),
    /**
     * The member's alerts in the order they were written, from `alertSeqs`: exact where times can
     * tie or commit out of order. Missing only on alerts from before it existed (dev data).
     */
    seq: v.optional(v.number()),
  })
    .index("by_member_at", ["memberId", "at"])
    .index("by_member_seq", ["memberId", "seq"])
    .index("by_message_member", ["messageId", "memberId"]),

  /** The last alert seq given to each member (messageAlerts.seq). */
  alertSeqs: defineTable({
    memberId: v.id("members"),
    seq: v.number(),
  }).index("by_member", ["memberId"]),

  /**
   * Who is writing in a channel or thread now ("Ana is typing"): one row per member and channel,
   * refreshed while they type (channels.typing) and taken away when they post or stop.
   */
  typing: defineTable({
    teamId: v.id("teams"),
    channelId: v.id("channels"),
    memberId: v.id("members"),
    /** The thread they're answering, when they write in Replies. */
    replyTo: v.optional(v.id("messages")),
    /** When they last typed: the app shows it for a few seconds after. */
    at: v.number(),
    /**
     * An agent working on a run over A2A here (ADR 0024): shown as writing for as long as the row
     * is there, whatever `at` says. The room takes it away when the run stops working.
     */
    runId: v.optional(v.id("runs")),
  })
    .index("by_channel", ["channelId", "at"])
    .index("by_member_channel", ["memberId", "channelId"])
    .index("by_at", ["at"]),

  /**
   * Whether a person has the app open (members.heartbeat): one row per member, refreshed about once a
   * minute. The app counts someone as away past a couple of minutes without one, by its own clock.
   */
  presence: defineTable({
    teamId: v.id("teams"),
    memberId: v.id("members"),
    lastSeenAt: v.number(),
    /** The app's window was in use lately (focused, or input in the last few minutes). */
    active: v.boolean(),
    /**
     * One app launch (members.heartbeat's sessionId): a member with the app open on two computers
     * has two rows, and is active while either is. Absent: a heartbeat that sent none.
     */
    sessionId: v.optional(v.string()),
    /** When this session stops counting without another beat (lastSeenAt + PRESENCE_LIVE_MS). */
    expiresAt: v.optional(v.number()),
  })
    .index("by_team", ["teamId"])
    .index("by_member", ["memberId"]),

  tasks: defineTable({
    teamId: v.id("teams"),
    projectId: v.optional(v.id("projects")),
    title: v.string(),
    description: v.optional(v.string()),
    /** Always a person. */
    ownerId: v.id("members"),
    createdBy: v.id("members"),
    keptRunId: v.optional(v.id("runs")),
    closedAt: v.optional(v.number()),
    settledAt: v.optional(v.number()),
    snoozedUntil: v.optional(v.number()),
    snoozedAt: v.optional(v.number()),
    /**
     * A task accepted from a call in a direct message or private channel (ADR 0016): only that
     * channel's members see its title and description, or act on it. Named as on `runs`.
     */
    directChannelId: v.optional(v.id("channels")),
    /**
     * The tasks this one waits for (ADR 0050): queued, it starts only once each of them is closed.
     * At most MAX_NEEDS, in the same team, never itself or a task that waits for it.
     */
    needs: v.optional(v.array(v.id("tasks"))),
  })
    .index("by_team", ["teamId"])
    .index("by_project", ["projectId"])
    .index("by_owner", ["ownerId"]),

  runs: defineTable({
    teamId: v.id("teams"),
    /** Absent: an unfiled run. */
    taskId: v.optional(v.id("tasks")),
    /**
     * The harness, "a2a" for a run sent to an agent over A2A, or "agent" for a run given to an agent
     * the room can't follow over A2A (a webhook, a check-in or a key-only agent), which reports it
     * itself with runs.report (ADR 0044).
     */
    harness: v.string(),
    repo: v.optional(v.string()),
    /** Absent for a run sent to an agent over A2A, which runs on the agent's own gateway (ADR 0012). */
    machineId: v.optional(v.id("machines")),
    /**
     * For a run sent over A2A, or given to an agent (harness "agent", ADR 0044): the agent doing it.
     * An A2A run's binding (a2aBindings) holds the A2A side; a given run's is `given`.
     */
    agentId: v.optional(v.id("agents")),
    /**
     * For a run given to an agent (harness "agent", ADR 0044): what was sent to it, the first message
     * and then the replies (runs.reply), keeping the first and the last 19, and the agent's latest
     * line (runs.report). With waiting, the line is also the run's question (`prompt`).
     */
    given: v.optional(
      v.object({
        messages: v.array(
          v.object({
            kind: v.union(v.literal("start"), v.literal("reply")),
            text: v.string(),
            from: v.id("members"),
            at: v.number(),
          }),
        ),
        lastMessage: v.optional(v.object({ text: v.string(), at: v.number() })),
        /** Who stopped it (runs.stop), for the refusal a later report gets. */
        stoppedBy: v.optional(v.id("members")),
      }),
    ),
    /**
     * A run sent from a direct message (ADR 0015) or a private channel (ADR 0016), or on a task
     * from one: only that channel's members see what was sent and what the agent answered, or act
     * on it. Everyone else sees the run, with its texts left out. The name dates from ADR 0015.
     */
    directChannelId: v.optional(v.id("channels")),
    terminalId: v.optional(v.id("terminals")),
    /** For a run through a Space (spec #6). */
    spaceId: v.optional(v.id("spaces")),
    /** For T3 Code threads: the thread's id on that machine. */
    threadRef: v.optional(v.string()),
    /**
     * For a thread run: how much teammates may do in the thread (ADR 0021), up to the machine's
     * `mostOpenAccess`. Absent, as on thread runs from before ADR 0021: Watch.
     */
    threadAccess: v.optional(vAccess),
    /** Set when the machine's limit lowered this thread's access: the level it had before. */
    threadLoweredFrom: v.optional(vAccess),
    /**
     * What the agent may do without asking (ADR 0043), for a thread run and a Claude Code or Codex
     * terminal: T3 Code's runtime mode, or the flags the terminal started with. Absent:
     * `approval-required`, as on every run from before. A thread's comes from its bridge's last
     * `thread_mode` report, so a change made in T3 Code shows too.
     */
    runtimeMode: v.optional(vRuntimeMode),
    /** For a thread run: the modes its T3 Code provider takes, from `thread_mode`. Absent: not reported. */
    runtimeModes: v.optional(v.array(vRuntimeMode)),
    /** Who last set `runtimeMode` from the room (the starter, or the driver who changed it), and when. */
    runtimeModeSetBy: v.optional(v.id("members")),
    runtimeModeSetAt: v.optional(v.number()),
    /** Set when the machine's cap lowered this run's mode: the mode it had before. */
    runtimeModeLoweredFrom: v.optional(vRuntimeMode),
    /**
     * A thread's mode asked for from the room that T3 Code hasn't confirmed yet (ADR 0043): by its
     * driver (`by`), or by the machine's cap (`loweredFrom`). `runtimeMode` stays the mode in effect
     * until the bridge reports this one (`thread_mode`); a refusal (`input_rejected`) drops it.
     */
    runtimeModeRequested: v.optional(
      v.object({ mode: vRuntimeMode, by: v.optional(v.id("members")), at: v.number(), loweredFrom: v.optional(vRuntimeMode) }),
    ),
    /**
     * Set when the room stopped this thread run because T3 Code refused every mode within its
     * machine's lowered cap (ADR 0043): `runtimeMode` is the mode it still had, above the cap.
     */
    runtimeModeOverCap: v.optional(v.literal(true)),
    /** How many of the thread's newest items the room keeps (`threadItems` not from history), ADR 0022. */
    threadItemCount: v.optional(v.number()),
    /** T3 Code holds items older than the oldest the room keeps for this thread. */
    threadOlder: v.optional(v.boolean()),
    /** When the room asked the bridge to follow this thread (`watch_thread`); cleared when nobody watches. */
    threadWatchedAt: v.optional(v.number()),
    /** When the older items someone loaded go (`threadItems` from history), 30 minutes after the last page. */
    threadHistoryExpiresAt: v.optional(v.number()),
    /** The last request for older items: loading, or why it failed. */
    threadHistory: v.optional(
      v.object({ requestId: v.string(), status: v.union(v.literal("loading"), v.literal("failed")), error: v.optional(v.string()), at: v.number() }),
    ),
    title: v.optional(v.string()),
    driverId: v.optional(v.id("members")),
    startedBy: v.optional(v.id("members")),
    state: vRunState,
    /**
     * Who ended a Stopped run. `bridge`: the bridge reported it Stopped (a T3 Code run interrupted
     * or cancelled there), so a later report that the thread works again brings the run back.
     * `room`, or absent (runs stopped before this field): someone stopped it in the room, or the
     * room ended its terminal or machine, so a late report never does. `agent`: an A2A agent
     * canceled its task without the room asking.
     */
    stoppedBy: v.optional(v.union(v.literal("room"), v.literal("bridge"), v.literal("agent"))),
    /**
     * Why a thread run failed to start, from the bridge's `thread_start_failed`. For an A2A run: why
     * it failed, or why its state is Unknown (delivery not confirmed, contact lost, no longer followed).
     */
    failReason: v.optional(v.string()),
    prompt: v.optional(vPrompt),
    /** The last approval answered for this run, for the "Julio allowed …" line. */
    lastAnswer: v.optional(
      v.object({
        by: v.id("members"),
        answer: v.union(v.literal("allow"), v.literal("deny")),
        action: v.optional(v.string()),
        at: v.number(),
      }),
    ),
    /** The last answer sent from the room to a thread's question (ADR 0023): by whom, for which prompt. */
    questionAnswer: v.optional(v.object({ by: v.id("members"), promptId: v.string(), at: v.number() })),
    stateChangedAt: v.number(),
    endedAt: v.optional(v.number()),
    settledAt: v.optional(v.number()),
    snoozedUntil: v.optional(v.number()),
    snoozedAt: v.optional(v.number()),
    /**
     * Who may message this run while it is live (ADR 0026): anyone who can see it (absent, or
     * `anyone`), or only its driver and their agents (`driver`). Set by its driver (runs.setHears).
     * A closed run (`closed`, ADR 0044) hears only its person and their agents, whatever this says.
     */
    hears: v.optional(v.union(v.literal("anyone"), v.literal("driver"))),
    /**
     * For a thread run: T3 Code lists the thread, by its bridge's last report (ADR 0026). Set from a
     * bridge that says when T3 Code archives or deletes a thread (`thread_closed`), and cleared then,
     * when a new bridge process registers (it reports each listed thread again), and when the
     * machine is unlinked. A thread run whose turn is Done or Failed takes messages while it holds.
     */
    threadOpen: v.optional(v.boolean()),
    /**
     * How this run hears messages, as its machine's bridge reported (`run_hearing`, ADR 0026, slice 4
     * of #139): during a turn and at once when idle (`mid_task`), only between turns, or not at all
     * (`none`, a plain shell). Absent until a bridge that delivers run messages reports it; runs.live,
     * runs.inbox and the app read that, or a bridge that no longer takes run messages, as `unknown`,
     * and the messages wait in the run's inbox.
     */
    hearing: v.optional(vRunHearing),
    /**
     * A joined run (ADR 0027, ADR 0032): a session that joined with `uplink join`, with no machine,
     * terminal or thread. It shows Unknown while live, since it reports no state, and is live until
     * it ends (`endedAt`): when it leaves, its session ends, or its heartbeat stops.
     */
    joinedSessionId: v.optional(v.id("joinedSessions")),
    /**
     * A closed run (ADR 0044): only its person (its driver, or the person accountable for an agent
     * driver) and their agents can see it, address it or have it hear them; for everyone else in the
     * team it doesn't exist. A joined run starts closed (`true`) unless it joined with `--open`, and
     * its person opens or closes it (runs.setOpen, joined.setOpen). Absent, as on every run started
     * in the app and on joined runs from before this field, means open.
     */
    closed: v.optional(v.boolean()),
  })
    .index("by_team", ["teamId"])
    // A team's open threads: their runs take messages between turns (runs.live).
    .index("by_team_thread_open", ["teamId", "threadOpen"])
    // A team's runs in one state: thread runs still working, waiting or unknown are live (runs.live).
    .index("by_team_state", ["teamId", "state"])
    .index("by_team_task", ["teamId", "taskId"])
    .index("by_task", ["taskId"])
    .index("by_driver", ["driverId"])
    // runs.changes: the runs a member drives or started whose state changed after a point.
    .index("by_driver_changed", ["driverId", "stateChangedAt"])
    .index("by_starter_changed", ["startedBy", "stateChangedAt"])
    .index("by_terminal", ["terminalId"])
    .index("by_machine_thread", ["machineId", "threadRef"])
    .index("by_agent", ["agentId"])
    // The runs from one direct message or private channel, to stop or hand back their work when
    // someone leaves it (ADR 0016). Runs from anywhere else have no directChannelId.
    .index("by_direct_channel", ["directChannelId"]),

  /**
   * The messages a live run is sent (ADR 0026, ADR 0029): one row per run and message, waiting
   * until the run's bridge delivers it (slice 4 of #139). At most MAX_WAITING wait per run; past
   * that the sender is told the run isn't taking messages.
   */
  runInbox: defineTable({
    teamId: v.id("teams"),
    runId: v.id("runs"),
    messageId: v.id("messages"),
    channelId: v.id("channels"),
    /** Who sent it: the member, and the run it came from when a run posted it as itself. */
    from: v.object({ memberId: v.id("members"), runId: v.optional(v.id("runs")) }),
    /** The person who answers for it: the sender, or the person accountable for an agent sender. */
    accountableId: v.id("members"),
    /** Whether that person is this run's person (its driver, or an agent driver's person). */
    fromDriver: v.boolean(),
    /**
     * `claimed`: a hook of the run's session has it (`bridge:claimRunMessages`, lib/runDelivery.ts), or
     * a joined session took it (`joined.take`, lib/joinedRuns.ts), and hasn't said it wrote it yet.
     */
    status: v.union(v.literal("waiting"), v.literal("claimed"), v.literal("delivered"), v.literal("failed")),
    /** How it reached the run, once delivered: during a turn, or at the next one. */
    how: v.optional(v.union(v.literal("mid_task"), v.literal("next_turn"))),
    /**
     * While claimed: the claim, so only the bridge's answer to it settles the message. `until`: the
     * bridge holds it past CLAIM_MS while it moves the claim's files (`bridge:holdRunMessages`, ADR 0043).
     */
    claim: v.optional(
      v.object({ id: v.string(), at: v.number(), how: v.union(v.literal("mid_task"), v.literal("next_turn")), until: v.optional(v.number()) }),
    ),
    /** How many claims a hook got without saying it wrote them: after a second, it fails as unsure. */
    unsure: v.optional(v.number()),
    /**
     * Why it failed: `run_ended` (its terminal ended first, such as when a new bridge process ended
     * the last one's terminals), `driver_changed` (the run's driver changed to someone who can't read
     * where it was posted), `not_heard` (its driver narrowed who it hears since), `deleted`,
     * `unsure` (a hook got it twice and never said it wrote it), or `visible_outside` (it was said
     * in a direct message or private channel, and people outside it can see the run's output, ADR
     * 0039).
     */
    error: v.optional(
      v.union(
        v.literal("run_ended"),
        v.literal("driver_changed"),
        v.literal("not_heard"),
        v.literal("deleted"),
        v.literal("unsure"),
        v.literal("visible_outside"),
      ),
    ),
    at: v.number(),
  })
    .index("by_run_status", ["runId", "status"])
    .index("by_run", ["runId"])
    .index("by_message", ["messageId"]),

  /**
   * An agent's routine webhook (ADR 0028): where the room POSTs each message that reaches the agent,
   * as Grok Bot's routines take one (docs.x.ai/grok-bot/skills-routines-and-automations). The key is
   * sealed as A2A endpoint tokens are (lib/a2a/secrets.ts), to this row's agent and URL: nobody can
   * read it back, and the app shows its last four characters. Setting it again replaces the row, so a
   * send queued for the old one never goes to the new address.
   */
  webhooks: defineTable({
    teamId: v.id("teams"),
    agentId: v.id("agents"),
    url: v.string(),
    ciphertext: v.string(),
    iv: v.string(),
    /** The key's last four characters, for the app. */
    hint: v.string(),
    setBy: v.id("members"),
    setAt: v.number(),
  }).index("by_agent", ["agentId"]),

  /**
   * One message reaching an agent the room can't follow (decision D17 of ADR 0029): sent to its
   * routine webhook (sending, then sent or failed with the reason), or waiting for an agent that
   * checks in on its own schedule to read the place (waiting, then seen). Not a run: a webhook's 200
   * says only that the agent started a run of its own.
   */
  agentDeliveries: defineTable({
    teamId: v.id("teams"),
    /** The message sent, and where. Absent on a run's delivery (`runId`). */
    messageId: v.optional(v.id("messages")),
    channelId: v.optional(v.id("channels")),
    /** For a run given to the agent (ADR 0044): the run, sent as a task, or a reply on it. */
    runId: v.optional(v.id("runs")),
    /** The thread it is in, if it is a reply. */
    threadRootId: v.optional(v.id("messages")),
    /** The agent's member. */
    memberId: v.id("members"),
    agentId: v.id("agents"),
    via: v.union(v.literal("webhook"), v.literal("check_in")),
    status: v.union(v.literal("sending"), v.literal("sent"), v.literal("failed"), v.literal("waiting"), v.literal("seen")),
    /** Who sent the message, and the person who answers for them. */
    senderId: v.id("members"),
    accountableId: v.id("members"),
    /** For a webhook send: the webhook it goes to. Replaced or removed before the send, it fails. */
    webhookId: v.optional(v.id("webhooks")),
    /** Why it failed, with the key taken out. */
    reason: v.optional(v.string()),
    at: v.number(),
    /**
     * For a webhook send: when the send action took it to POST. Set once; a send taken is never
     * taken again, and one left sending past its deadline is unconfirmed (webhooks.checkSending).
     */
    attemptedAt: v.optional(v.number()),
    settledAt: v.optional(v.number()),
  })
    .index("by_message", ["messageId"])
    // What waits for an agent in one place (a channel's top level, or a thread), so a post marks only there.
    .index("by_member_status_place", ["memberId", "status", "channelId", "threadRootId"])
    // The agent's row on a message, for the messages a read returned.
    .index("by_member_message", ["memberId", "messageId"])
    // A given run's sends (ADR 0044).
    .index("by_run", ["runId"]),

  /**
   * An agent's A2A endpoint (ADR 0012): where the room sends it work. Only the room
   * calls out; nothing comes in this way. Its token is in a2aCredentials.
   */
  a2aPeers: defineTable({
    teamId: v.id("teams"),
    agentId: v.id("agents"),
    connectedBy: v.id("members"),
    /** The Agent Card's URL. The room sends requests only to this origin. */
    cardUrl: v.string(),
    status: v.union(v.literal("checking"), v.literal("ready"), v.literal("failed")),
    /** Why the last card check failed. */
    error: v.optional(v.string()),
    checkedAt: v.optional(v.number()),
    /** Bumped on every check, so an older check's result can't overwrite a newer one. */
    checkGeneration: v.number(),
    /**
     * Bumped whenever the endpoint changes (a new address, or a card naming another interface).
     * A run follows only the generation it started on (ADR 0012).
     */
    endpointGeneration: v.number(),
    /** The JSON-RPC interface the card names, on the registered origin. Kept from the last good check. */
    endpoint: v.optional(v.object({ url: v.string(), tenant: v.optional(v.string()) })),
    card: v.optional(
      v.object({
        name: v.string(),
        description: v.string(),
        version: v.string(),
        streaming: v.boolean(),
        pushNotifications: v.boolean(),
        skills: v.array(v.object({ id: v.string(), name: v.string() })),
        security: v.array(
          v.object({ name: v.string(), kind: v.string(), detail: v.optional(v.string()) }),
        ),
        needsCredential: v.boolean(),
        documentationUrl: v.optional(v.string()),
        /** The A2A version its chosen interface names, such as "1.0" or "0.3.0". Absent: read before 0.3 was accepted, so 1.0. */
        protocolVersion: v.optional(v.string()),
      }),
    ),
    /** A2A cards don't say whether CancelTask or ListTasks work; the room learns it by trying. */
    cancel: vLearned,
    listTasks: vLearned,
    sendWork: vSendWork,
    /**
     * The A2A version the agent was found to answer when it isn't the one its card names (ADR 0018):
     * a send whose method wasn't found, then answered in the other version, or a connection check.
     * Absent: the room speaks the card's version. Cleared when the card names another endpoint or version.
     */
    speaks: v.optional(vDialect),
    /**
     * Bumped whenever what the room learned about the version may no longer hold (another endpoint,
     * a card naming another version, another address), so a send or a check that started before
     * can't bring back what was cleared. Absent: 0.
     */
    dialectGeneration: v.optional(v.number()),
    /** The last connection check (a2a.checkConnection): a harmless authenticated call, and what answered. */
    connection: v.optional(
      v.object({
        status: v.union(v.literal("checking"), v.literal("ok"), v.literal("failed")),
        /**
         * This check's own id: a result for another check, however old, never lands on this one.
         * Optional, so a row without one can't fail a push; a result never matches it.
         */
        checkId: v.optional(v.string()),
        /** Written only by an unreleased build (257cc3a) before checkId; ignored, kept so such a row can't fail a push. */
        generation: v.optional(v.number()),
        at: v.number(),
        by: v.id("members"),
        /** The version that answered. */
        dialect: v.optional(vDialect),
        /** What the check found, in a sentence for the person who ran it. */
        summary: v.optional(v.string()),
      }),
    ),
  })
    .index("by_team", ["teamId"])
    .index("by_agent", ["agentId"]),

  /**
   * One conversation between an agent and a place (ADR 0024): a channel's top level, a thread, a
   * direct message, or a run on a task. It keeps the agent's A2A context, so every message sent to
   * the agent there continues it, and each A2A task the agent opens is a run of its own.
   */
  a2aConversations: defineTable({
    teamId: v.id("teams"),
    agentId: v.id("agents"),
    /** The channel or direct message. Absent for a run's own conversation (a run on a task, or started through the Room API). */
    channelId: v.optional(v.id("channels")),
    /** The thread it is in: the thread's first message. Absent at the channel's top level. */
    threadRootId: v.optional(v.id("messages")),
    /** The thread was opened for the agent (a Yes to its thread proposal): every reply in it goes to the agent. */
    ownThread: v.optional(v.boolean()),
    /** For a run's own conversation: the run it began with. */
    originRunId: v.optional(v.id("runs")),
    /** The agent's A2A context, as the agent returned it, and the endpoint generation it is from. */
    contextId: v.optional(v.string()),
    contextGeneration: v.optional(v.number()),
    /** The agent answered in the context the room sent: it keeps context, so history is only what came since it last heard. */
    contextKept: v.optional(v.boolean()),
    /** The agent answered in another context than the one the room sent: it doesn't keep context, so history carries it all. */
    contextIgnored: v.optional(v.boolean()),
    /** The seq of the newest message in the place the agent was sent, as a message or as history: later history starts after it. */
    heardSeq: v.optional(v.number()),
    /** The run whose A2A task isn't finished: messages go to it. */
    openRunId: v.optional(v.id("runs")),
    /** The agent's last task here, for referenceTaskIds on the next one. */
    lastTaskId: v.optional(v.string()),
    /** The agent's thread proposal waiting for an answer (one at a time). */
    proposalMessageId: v.optional(v.id("messages")),
    updatedAt: v.number(),
  })
    .index("by_place", ["agentId", "channelId", "threadRootId"])
    .index("by_thread", ["channelId", "threadRootId"])
    .index("by_origin_run", ["originRunId"]),

  /** The token the room sends to an agent's gateway, sealed (lib/a2a/secrets.ts). Never returned by any query. */
  a2aCredentials: defineTable({
    teamId: v.id("teams"),
    peerId: v.id("a2aPeers"),
    kind: v.union(v.literal("bearer"), v.literal("header")),
    /** For `header`: the header it goes in. */
    headerName: v.optional(v.string()),
    /** The origin the token was given for. It is sealed to it, and deleted when the address moves. */
    origin: v.string(),
    ciphertext: v.string(),
    iv: v.string(),
    /** The last four characters, for the app. */
    hint: v.string(),
    setBy: v.id("members"),
    setAt: v.number(),
  }).index("by_peer", ["peerId"]),

  /**
   * One run sent to an agent over A2A, and what the room knows of the agent's task (ADR 0012).
   * Only the A2A worker writes its observations, one step at a time (the lease).
   */
  a2aBindings: defineTable({
    teamId: v.id("teams"),
    runId: v.id("runs"),
    peerId: v.id("a2aPeers"),
    agentId: v.id("agents"),
    /** The endpoint generation the run started on. Another one means another gateway: stop following. */
    endpointGeneration: v.number(),
    /** Told to the agent with every message, as metadata. */
    meta: v.object({
      team: v.string(),
      runId: v.string(),
      taskId: v.optional(v.string()),
      task: v.optional(v.string()),
      channelId: v.optional(v.string()),
      channel: v.optional(v.string()),
      messageId: v.optional(v.string()),
    }),
    /** The agent's conversation and task. A task id is set once and never changes. */
    contextId: v.optional(v.string()),
    taskId: v.optional(v.string()),
    /** What the room sends: the first message, then replies. Each keeps its message id, so it is never sent twice. */
    outbox: v.array(
      v.object({
        messageId: v.string(),
        kind: v.union(v.literal("start"), v.literal("reply")),
        text: v.string(),
        from: v.string(),
        by: v.id("members"),
        at: v.number(),
        /**
         * pending: not sent yet. sending: a step is sending it (if that step died, the room asks the
         * agent before sending anything). sent. failed: the agent refused it. unconfirmed: it may or
         * may not have arrived, and the agent couldn't say.
         */
        status: v.union(
          v.literal("pending"),
          v.literal("sending"),
          v.literal("sent"),
          v.literal("failed"),
          v.literal("unconfirmed"),
        ),
        error: v.optional(v.string()),
        /**
         * The A2A version the room last sent it in (ADR 0018), kept apart from what the room
         * learned: a message whose delivery is unclear is looked for in the version it went out in.
         */
        dialect: v.optional(vDialect),
        /**
         * What was said in its place since the agent last heard from it, oldest first (ADR 0024):
         * sent with it as a second text part and in its metadata. Dropped once it went out.
         */
        history: v.optional(v.array(v.object({ author: v.string(), text: v.string(), at: v.number() }))),
        /** The chat message it is, when a person or agent wrote it in a conversation. */
        chatMessageId: v.optional(v.id("messages")),
        /** An answer to the agent's thread proposal (ADR 0024). */
        decision: v.optional(v.object({ open: v.boolean(), byTimeout: v.boolean() })),
      }),
    ),
    /** The conversation this run is part of (ADR 0024). Absent on runs from before conversations. */
    conversationId: v.optional(v.id("a2aConversations")),
    /** The chat message that started this run: a thread the agent proposes opens under it. */
    triggerMessageId: v.optional(v.id("messages")),
    /** The context the first message carried (the conversation's), to see whether the agent kept it. */
    sentContextId: v.optional(v.string()),
    /** The agent's previous task in the conversation, sent as referenceTaskIds (spec 3.4.3). */
    previousTaskId: v.optional(v.string()),
    /** The first message went again in a fresh context once, after the agent refused the old one. */
    contextRetried: v.optional(v.boolean()),
    /** What the room posted in chat for this run, so nothing is posted twice (ADR 0024). */
    chat: v.optional(
      v.object({
        /** Short fingerprints of the texts already posted. */
        said: v.array(v.string()),
        /**
         * Of those, the texts posted as a message of their own, which went where that message goes
         * (ADR 0026). Text shown only by editing the last progress message isn't here. Absent on
         * bindings from before it: every text said was posted as its own message.
         */
        routed: v.optional(v.array(v.string())),
        /** How many progress messages were posted; past the limit, the last one is edited instead. */
        progress: v.number(),
        lastProgressId: v.optional(v.id("messages")),
        /** The answer or the end of the run was posted. */
        ended: v.optional(v.boolean()),
      }),
    ),
    /** Files the agent sent as bytes, kept until its answer is posted with them as attachments. */
    files: v.optional(
      v.array(
        v.object({
          /** Which part it was (artifact or message id, and the part's place), so a task read again isn't stored twice. */
          key: v.string(),
          storageId: v.id("_storage"),
          name: v.string(),
          contentType: v.string(),
          size: v.number(),
          /** The task it came in, so a reply the agent took into a new task of its own takes its files along (ADR 0024). */
          taskId: v.optional(v.string()),
        }),
      ),
    ),
    /** The last A2A state observed, such as TASK_STATE_WORKING, and the agent's own timestamp for it. */
    externalState: v.optional(v.string()),
    statusAt: v.optional(v.number()),
    /** When the room last heard from the agent about this task. */
    observedAt: v.optional(v.number()),
    /** Bumped on every accepted observation. */
    version: v.number(),
    lastMessage: v.optional(v.string()),
    artifacts: v.array(vArtifactRef),
    /** True while the worker still follows the task. */
    following: v.boolean(),
    /** When the next step is due. */
    nextCheckAt: v.number(),
    quietPolls: v.number(),
    failures: v.number(),
    lastError: v.optional(v.string()),
    lastContactAt: v.number(),
    lastChangeAt: v.number(),
    /**
     * Looking for a message whose delivery is unclear: the ListTasks page to read next. Kept between
     * steps, so a step that ran out of time goes on from there instead of from page 1. `taskId`: the
     * task found with the message, still to be read whole; the next step reads it instead of searching.
     */
    reconcile: v.optional(
      v.object({
        messageId: v.string(),
        pageToken: v.string(),
        pages: v.number(),
        taskId: v.optional(v.string()),
      }),
    ),
    /** The agent's stream broke or isn't offered for this task: poll instead. */
    pollOnly: v.optional(v.boolean()),
    /** The worker step that holds this binding now. */
    lease: v.optional(v.object({ token: v.string(), until: v.number() })),
    /** Someone asked for a step while one held the lease: run the next one at once. */
    wakeRequested: v.optional(v.boolean()),
    cancel: v.optional(
      v.object({
        requestedAt: v.number(),
        by: v.id("members"),
        status: v.union(
          v.literal("pending"),
          v.literal("sent"),
          v.literal("canceled"),
          v.literal("unsupported"),
          v.literal("not_cancelable"),
          v.literal("failed"),
        ),
        error: v.optional(v.string()),
      }),
    ),
    detached: v.optional(
      v.object({ at: v.number(), by: v.optional(v.id("members")), reason: v.string() }),
    ),
  })
    .index("by_run", ["runId"])
    .index("by_peer", ["peerId"])
    .index("by_following", ["following", "nextCheckAt"]),

  machines: defineTable({
    teamId: v.id("teams"),
    name: v.string(),
    belongsTo: vBelongsTo,
    /** Who paired the bridge. Drives what is started on the machine itself. */
    linkedBy: v.id("members"),
    /** Last seq queued for the bridge, so acked messages never reuse a seq. */
    outboxSeq: v.optional(v.number()),
    /** Settings, set in the room. Never above `limits`. */
    mostOpenAccess: vAccess,
    /**
     * The most permissive permission mode a run here may use (ADR 0043), set by whoever the machine
     * belongs to. Absent: `approval-required`, so nothing runs here without asking until they allow it.
     */
    mostPermissiveMode: v.optional(vRuntimeMode),
    slots: v.number(),
    longestProfileMs: v.number(),
    /** The machine's own limits, reported by its bridge. */
    limits: v.optional(
      v.object({ mostOpenAccess: vAccess, slots: v.number(), longestProfileMs: v.number() }),
    ),
    bridgeTokenHash: v.optional(v.string()),
    hostname: v.optional(v.string()),
    os: v.optional(v.string()),
    bridgeVersion: v.optional(v.string()),
    tools: v.array(v.string()),
    lastSeenAt: v.optional(v.number()),
    /** Set when the bridge stayed quiet for the online window; cleared when it's heard from. */
    offlineSince: v.optional(v.number()),
    /** The pending check that marks the machine offline (one per machine). */
    onlineCheckId: v.optional(v.id("_scheduled_functions")),
    sharingStoppedAt: v.optional(v.number()),
    unlinkedAt: v.optional(v.number()),
    /**
     * Rex on the machine, from its bridge's last `rex_found` (ADR 0019): whether Rex runs there, and
     * how many Rex tabs it has that weren't opened through Uplink Room (only that count is reported).
     */
    rex: v.optional(v.object({ running: v.boolean(), otherTabs: v.number(), checkedAt: v.number() })),
    /**
     * The room messages the machine's bridge handles beyond the first protocol, from its last
     * `bridge_features` (BRIDGE_FEATURES). Absent: a bridge from before ADR 0021, or not heard yet.
     * Cleared when a bridge registers, so an older bridge started there later isn't sent them.
     */
    bridgeFeatures: v.optional(v.array(v.string())),
    /**
     * The bridge's T3 Code pairing, from its last `t3_status` (GLOSSARY.md, "T3 Code pairing").
     * Absent: the bridge never reported one (not paired, or a bridge from before ADR 0021).
     */
    t3: v.optional(
      v.object({
        state: vT3PairingState,
        expiresAt: v.optional(v.number()),
        reason: v.optional(v.union(v.literal("expired"), v.literal("refused"))),
        environmentId: v.optional(v.string()),
        at: v.number(),
      }),
    ),
  })
    .index("by_team", ["teamId"])
    .index("by_bridge_token", ["bridgeTokenHash"]),

  pairingCodes: defineTable({
    teamId: v.id("teams"),
    codeHash: v.string(),
    createdBy: v.id("members"),
    belongsTo: vBelongsTo,
    name: v.string(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
    /**
     * A cloud machine's boot step pairs with a code for the machine the room already made
     * (#10). Pairing then gives that machine its bridge token instead of making a new one.
     */
    machineId: v.optional(v.id("machines")),
  })
    .index("by_code", ["codeHash"])
    // The unused codes someone made, taken back when their account is deleted (accounts.ts).
    .index("by_created_by_used", ["createdBy", "usedAt"]),

  /**
   * A team machine whose computer the room starts and stops at a provider (#10, ADR 0013).
   * Its `machines` row is an ordinary team machine; this row is only the provider's side.
   */
  cloudMachines: defineTable({
    teamId: v.id("teams"),
    machineId: v.id("machines"),
    /** `vercel`. */
    provider: v.string(),
    /** The provider's name for the box, derived from `machineId`. */
    resourceName: v.string(),
    region: v.string(),
    vcpus: v.number(),
    idleMinutes: v.number(),
    createdBy: v.id("members"),
    /**
     * `creating`: first boot. `starting`: booting, or waiting for the bridge. `running`: the bridge
     * registered. `stopping`/`stopped`: stopped at the provider, disk kept. `failed`: the last start
     * or stop didn't finish (`lastError`). `deleting`/`deleted`: gone, with its retained data.
     */
    state: v.union(
      v.literal("creating"),
      v.literal("starting"),
      v.literal("running"),
      v.literal("stopping"),
      v.literal("stopped"),
      v.literal("failed"),
      v.literal("deleting"),
      v.literal("deleted"),
    ),
    stateChangedAt: v.number(),
    /** Bumped by every start, stop and delete; a provider result for an older one is ignored. */
    generation: v.number(),
    /** Why it was last started: work needed it, someone started it, it was just made, or profile maintenance. */
    wakeReason: v.optional(
      v.union(v.literal("work"), v.literal("start"), v.literal("maintenance"), v.literal("create")),
    ),
    stopReason: v.optional(
      v.union(
        v.literal("idle"),
        v.literal("admin"),
        v.literal("provider"),
        v.literal("bridge_missing"),
        v.literal("start_failed"),
      ),
    ),
    /** A start that came while it was stopping: it starts again once the stop finishes. */
    wakeAfterStop: v.optional(v.boolean()),
    lastError: v.optional(v.string()),
    /** The last time the idle check found live work (or the bridge registered). */
    lastBusyAt: v.optional(v.number()),
    /** When the provider will stop the current session on its own unless the room extends it. */
    sessionEndsAt: v.optional(v.number()),
    lastReconcileAt: v.optional(v.number()),
    /** When the room last asked the provider to extend the session; cleared when it answers. */
    extendRequestedAt: v.optional(v.number()),
    /**
     * A profile expired or was deleted while the box was down, so its disk (and snapshot) may still
     * hold it. Set until a bridge registers after a wake, which deletes it; retried with backoff.
     */
    maintenancePending: v.optional(v.boolean()),
    maintenanceAttempts: v.optional(v.number()),
    /** The pending retry of a failed stop or delete, so a manual retry replaces it instead of adding a second. */
    retryId: v.optional(v.id("_scheduled_functions")),
    /** The generation whose boot the provider confirmed (`providerStarted`). Until then the watchdog owns the box. */
    bootedGeneration: v.optional(v.number()),
    /** The last time a stop or delete in progress made progress; the reconciler restarts one stalled past 10 minutes. */
    lastProgressAt: v.optional(v.number()),
    /** Numbers delete attempts. Only the current attempt's failure schedules the next, so there is one chain. */
    deleteAttempt: v.optional(v.number()),
    /** When the reconciler deleted the snapshots a deleted machine's box left behind. */
    snapshotsSweptAt: v.optional(v.number()),
    /**
     * The box's snapshots, listed just before its delete. The provider deletes them asynchronously,
     * and once the box is gone they can't be listed by its name (seen live, 2026-11-02).
     */
    snapshotIds: v.optional(v.array(v.string())),
    /** Failed provider calls in a row for the current operation, for backoff. */
    attempts: v.optional(v.number()),
    /**
     * The last stop ran out of tries, so the box may still run and bill. The reconciler keeps
     * stopping it every 5 minutes, and settles the machine as an ordinary stop once the box is down.
     */
    stopGaveUp: v.optional(v.boolean()),
    /** The pending idle check, and the pending check that the bridge came back. */
    idleCheckId: v.optional(v.id("_scheduled_functions")),
    bridgeWaitId: v.optional(v.id("_scheduled_functions")),
    runningSince: v.optional(v.number()),
    stoppedAt: v.optional(v.number()),
  })
    .index("by_machine", ["machineId"])
    .index("by_team", ["teamId"]),

  /** The one reconcile run pending soon after a provider action (#10, ADR 0013). The cron runs it every 5 minutes too. */
  cloudReconciler: defineTable({
    key: v.literal("main"),
    pendingId: v.optional(v.id("_scheduled_functions")),
    lastRunAt: v.optional(v.number()),
  }).index("by_key", ["key"]),

  terminals: defineTable({
    teamId: v.id("teams"),
    machineId: v.id("machines"),
    startedBy: v.id("members"),
    access: vAccess,
    driverId: v.optional(v.id("members")),
    runId: v.optional(v.id("runs")),
    profileId: v.optional(v.id("profiles")),
    usesSlot: v.boolean(),
    title: v.string(),
    tool: v.string(),
    command: v.optional(v.string()),
    cwd: v.optional(v.string()),
    repo: v.optional(v.string()),
    localRef: v.optional(v.string()),
    status: v.union(
      v.literal("starting"),
      v.literal("live"),
      v.literal("ended"),
      v.literal("failed"),
    ),
    failReason: v.optional(v.string()),
    /** Set when the machine's limit lowered this terminal: the level it had before. */
    loweredFrom: v.optional(vAccess),
    /** The last stored output chunk's seq (`terminalOutput.seq`). */
    outputSeq: v.number(),
    /**
     * The last `terminal_output` seq from the bridge stored, to drop repeats. The room splits a
     * large message into several chunks, so this differs from `outputSeq`. Absent on terminals
     * from before that split, where the two were equal.
     */
    bridgeOutputSeq: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    /** The exit code its process reported when it exited on its own (`terminal_ended`, reason `exited`). */
    exitCode: v.optional(v.number()),
    /**
     * The one screen whose own replies (focus, cursor and status reports) reach the program: the
     * driver's screen that most recently opened the terminal, got the wheel or got focus
     * (`terminals.claimReplies`). Cleared when the wheel moves; absent: no screen answers.
     */
    responder: v.optional(v.object({ screenId: v.string(), memberId: v.id("members") })),
    /**
     * A terminal in Rex (ADR 0019). `run`: the room started it as a new Rex tab (runs.start via rex),
     * so stopping it ends its program. `tab`: a Rex tab the person opened, shared (rex.share), whose
     * program keeps running when the share ends.
     */
    inRex: v.optional(v.union(v.literal("run"), v.literal("tab"))),
    /** The size the bridge reports for it (`terminal_size`): a Rex tab's is Rex's, not the driver's. */
    size: v.optional(v.object({ cols: v.number(), rows: v.number() })),
  })
    .index("by_machine", ["machineId"])
    // A machine's live terminals, without its ended ones (lib/runDelivery.ts).
    .index("by_machine_status", ["machineId", "status"])
    .index("by_machine_local", ["machineId", "localRef"])
    .index("by_team", ["teamId"])
    // A team's starting and live terminals: their runs are the live runs messages can address (ADR 0026).
    .index("by_team_status", ["teamId", "status"]),

  terminalOutput: defineTable({
    terminalId: v.id("terminals"),
    seq: v.number(),
    data: v.string(),
  }).index("by_terminal_seq", ["terminalId", "seq"]),

  /** Everything sent to a shared terminal, and who sent it. */
  terminalInput: defineTable({
    terminalId: v.id("terminals"),
    memberId: v.id("members"),
    agentKeyId: v.optional(v.id("agentKeys")),
    data: v.string(),
    suggestionId: v.optional(v.id("suggestions")),
    at: v.number(),
    /**
     * "typed", or "reply": the member's screen answering the program on its own. Absent on input
     * recorded before replies were marked, where replies are mixed in with typing.
     */
    kind: v.optional(v.union(v.literal("typed"), v.literal("reply"))),
  }).index("by_terminal", ["terminalId"]),

  watchers: defineTable({
    terminalId: v.id("terminals"),
    memberId: v.id("members"),
    lastSeenAt: v.number(),
    /** The pending check that drops this watcher once they stop watching (one per watcher). */
    checkId: v.optional(v.id("_scheduled_functions")),
  })
    .index("by_terminal", ["terminalId"])
    .index("by_terminal_member", ["terminalId", "memberId"]),

  suggestions: defineTable({
    terminalId: v.id("terminals"),
    fromId: v.id("members"),
    command: v.string(),
    status: v.union(v.literal("pending"), v.literal("sent"), v.literal("dismissed")),
    sentCommand: v.optional(v.string()),
    answeredBy: v.optional(v.id("members")),
  }).index("by_terminal", ["terminalId"]),

  wheelRequests: defineTable({
    terminalId: v.id("terminals"),
    fromId: v.id("members"),
    status: v.union(
      v.literal("pending"),
      v.literal("granted"),
      v.literal("denied"),
      v.literal("cancelled"),
    ),
    answeredBy: v.optional(v.id("members")),
  }).index("by_terminal", ["terminalId"]),

  /**
   * A T3 Code thread's conversation (ADR 0022): its newest items, at most THREAD_ITEMS_KEPT per run,
   * and older ones someone loaded (`history`), which go after HISTORY_KEPT_MS.
   */
  threadItems: defineTable({
    runId: v.id("runs"),
    itemId: v.string(),
    order: v.number(),
    item: vThreadItem,
    /** Loaded with threads.loadOlder; history rows go together (`runs.threadHistoryExpiresAt`). */
    history: v.boolean(),
  })
    .index("by_run_order", ["runId", "order", "itemId"])
    .index("by_run_item", ["runId", "itemId"])
    .index("by_run_history_order", ["runId", "history", "order"]),

  /**
   * What was sent into a T3 Code thread from the room (ADR 0023), and by whom: the room's record of
   * who sent what, since T3 Code records no sender. `_id` is the message id the bridge gives T3 Code.
   */
  threadMessages: defineTable({
    runId: v.id("runs"),
    fromId: v.id("members"),
    agentKeyId: v.optional(v.id("agentKeys")),
    text: v.string(),
    suggestionId: v.optional(v.id("threadSuggestions")),
    /** How many files went with it (`threadAttachments`, ADR 0043). */
    attachmentCount: v.optional(v.number()),
    status: v.union(v.literal("sending"), v.literal("sent"), v.literal("queued"), v.literal("failed")),
    error: v.optional(v.string()),
    at: v.number(),
  })
    .index("by_run", ["runId"])
    /** Messages still on their way, which a restarted bridge is sent again (ADR 0043). */
    .index("by_status_at", ["status", "at"]),

  /**
   * A file sent into a thread with a message from its box (ADR 0043). The bridge gets a link to it
   * with the message and hands it to T3 Code; the room keeps it to show on the message, and frees
   * its bytes like a chat attachment's (`storageInUse`).
   */
  threadAttachments: defineTable({
    runId: v.id("runs"),
    threadMessageId: v.id("threadMessages"),
    position: v.number(),
    storageId: v.id("_storage"),
    name: v.string(),
    kind: v.union(v.literal("image"), v.literal("pdf"), v.literal("file")),
    contentType: v.string(),
    size: v.number(),
  })
    .index("by_message", ["threadMessageId"])
    .index("by_storage", ["storageId"]),

  /** A message a teammate proposed for a Suggest (or more open) thread; its driver sends it or not. */
  threadSuggestions: defineTable({
    runId: v.id("runs"),
    fromId: v.id("members"),
    text: v.string(),
    status: v.union(v.literal("pending"), v.literal("sent"), v.literal("dismissed")),
    sentText: v.optional(v.string()),
    answeredBy: v.optional(v.id("members")),
  }).index("by_run", ["runId"]),

  /** Who has a thread's view open, as `watchers` for terminals. */
  threadWatchers: defineTable({
    runId: v.id("runs"),
    memberId: v.id("members"),
    lastSeenAt: v.number(),
    checkId: v.optional(v.id("_scheduled_functions")),
  })
    .index("by_run", ["runId"])
    .index("by_run_member", ["runId", "memberId"]),

  /** A turn's diff someone asked to see, one per run and turn, kept for a day. */
  threadDiffs: defineTable({
    runId: v.id("runs"),
    turn: v.number(),
    requestId: v.string(),
    requestedBy: v.id("members"),
    status: v.union(v.literal("loading"), v.literal("ready"), v.literal("failed")),
    diff: v.optional(v.string()),
    cut: v.optional(v.boolean()),
    error: v.optional(v.string()),
    at: v.number(),
  })
    .index("by_run_turn", ["runId", "turn"])
    .index("by_request", ["requestId"]),

  /** Requests for a thread run's wheel (ADR 0021), like a terminal's `wheelRequests`. */
  threadWheelRequests: defineTable({
    runId: v.id("runs"),
    fromId: v.id("members"),
    status: v.union(
      v.literal("pending"),
      v.literal("granted"),
      v.literal("denied"),
      v.literal("cancelled"),
    ),
    answeredBy: v.optional(v.id("members")),
  }).index("by_run", ["runId"]),

  profiles: defineTable({
    teamId: v.id("teams"),
    machineId: v.id("machines"),
    personId: v.id("members"),
    name: v.string(),
    expiresAt: v.number(),
    status: v.union(
      v.literal("creating"),
      v.literal("ready"),
      v.literal("expired"),
      v.literal("deleted"),
    ),
  })
    .index("by_machine", ["machineId"])
    .index("by_person", ["personId"]),

  /**
   * Files kept in a project (spec #9, ADR 0010). Docs and HTML pages keep their text here;
   * PDFs and images keep their bytes in Convex file storage; a canvas keeps its shapes in
   * `canvasElements`.
   */
  files: defineTable({
    teamId: v.id("teams"),
    projectId: v.id("projects"),
    name: v.string(),
    format: vFileFormat,
    /** Docs and HTML pages. */
    content: v.optional(v.string()),
    /** Docs and HTML pages: moves on with each save, so a save from an older version is refused. Absent means 1. */
    version: v.optional(v.number()),
    /** PDFs and images. */
    storageId: v.optional(v.id("_storage")),
    contentType: v.optional(v.string()),
    /** Bytes: the text, the stored file, or a canvas's shapes. */
    size: v.optional(v.number()),
    updatedBy: v.id("members"),
    updatedAt: v.number(),
  })
    .index("by_project_name", ["projectId", "name"])
    .index("by_storage", ["storageId"]),

  /**
   * An upload URL handed out by files.uploadUrl: the team and member it was for. files.addUpload
   * accepts bytes only through one of these, then deletes it (spec #9).
   */
  uploads: defineTable({
    teamId: v.id("teams"),
    uploaderId: v.id("members"),
  }),

  /** One shape on a canvas, as Excalidraw's JSON. Saves merge shape by shape (ADR 0010). */
  canvasElements: defineTable({
    fileId: v.id("files"),
    elementId: v.string(),
    version: v.number(),
    versionNonce: v.number(),
    /** Excalidraw keeps deleted shapes so a late edit of one can't bring it back. */
    isDeleted: v.boolean(),
    data: v.string(),
  }).index("by_file_element", ["fileId", "elementId"]),

  /** Pinned comments on files, and their replies (spec #9). */
  comments: defineTable({
    teamId: v.id("teams"),
    fileId: v.id("files"),
    authorId: v.id("members"),
    agentKeyId: v.optional(v.id("agentKeys")),
    body: v.string(),
    /** Comments have a pin; replies have `replyTo` instead. */
    pin: v.optional(vPin),
    replyTo: v.optional(v.id("comments")),
    resolvedAt: v.optional(v.number()),
    resolvedBy: v.optional(v.id("members")),
  })
    .index("by_file", ["fileId"])
    .index("by_reply", ["replyTo"]),

  /** Messages from the room to a machine's bridge, in order. */
  bridgeOutbox: defineTable({
    machineId: v.id("machines"),
    seq: v.number(),
    /**
     * A `RoomMessage`. Not validated against `vRoomMessage` here: a queued message keeps the shape
     * it was written with, and a protocol change that adds a required field would otherwise make
     * Convex refuse to deploy while an older message waits. `sendToBridge` takes a typed
     * `RoomMessage`, so new writes are still checked.
     */
    message: v.any(),
  }).index("by_machine_seq", ["machineId", "seq"]),

  /** A shared browser (spec #7): a cloud browser people in a channel use together. */
  browsers: defineTable({
    teamId: v.id("teams"),
    channelId: v.id("channels"),
    startedBy: v.id("members"),
    driverId: v.id("members"),
    access: vAccess,
    /** Set when the team's limit lowered it, to show "Suggest, was Open". */
    loweredFrom: v.optional(vAccess),
    startUrl: v.optional(v.string()),
    /**
     * Counts the URLs asked for (a deferred start URL, openUrl, opened suggestions), so a navigation
     * runs again until the URL it opened is the latest (#77).
     */
    navigationSeq: v.optional(v.number()),
    /** The latest URL asked for. */
    navigationUrl: v.optional(v.string()),
    /**
     * The navigation allowed to call the provider: its number, and until when it holds the lease
     * (renewed before each call). `until` unset: none runs, and the next one takes `holder + 1`.
     */
    navigationLease: v.optional(v.object({ holder: v.number(), until: v.optional(v.number()) })),
    /** The last URL the room gave up opening after retrying, and why. Cleared when a URL opens. */
    navigationError: v.optional(v.object({ url: v.string(), message: v.string(), at: v.number() })),
    /** The saved logins it loads and saves back to (ADR 0011). Unset: a temporary browser that keeps nothing. */
    savedLoginId: v.optional(v.id("savedLogins")),
    /** Stopping: ended in the room, and still counted until the provider confirms the session is gone. */
    status: v.union(
      v.literal("starting"),
      v.literal("live"),
      v.literal("stopping"),
      v.literal("ended"),
      v.literal("failed"),
    ),
    endReason: v.optional(
      v.union(
        v.literal("ended"),
        v.literal("idle"),
        v.literal("nobody_connected"),
        v.literal("longest_session"),
        /** The provider ended it and no webhook said why; the room found out by asking. */
        v.literal("timed_out"),
        v.literal("failed"),
      ),
    ),
    endedBy: v.optional(v.id("members")),
    failReason: v.optional(v.string()),
    /** The limits it started with, in minutes. */
    idleMinutes: v.number(),
    longestMinutes: v.number(),
    /** Started while the team was at its limit: provisioning claims a slot first. */
    waitsForSlot: v.optional(v.boolean()),
    /** The provider's session. Never returned by a query except the embed URL, through `browsers.join`. */
    session: v.optional(
      v.object({ sessionId: v.string(), embedUrl: v.string(), adminToken: v.string() }),
    ),
    /** SHA-256 of the secret Hyperbeam sends to our webhooks for this browser. */
    webhookSecretHash: v.optional(v.string()),
    startedAt: v.number(),
    liveAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    /** The backstop that ends it at its longest session. */
    endCheckId: v.optional(v.id("_scheduled_functions")),
    /** The next check that the session still runs, and when the room last asked. */
    aliveCheckId: v.optional(v.id("_scheduled_functions")),
    lastAliveCheckAt: v.optional(v.number()),
    /** The pending retry of the provider's DELETE while stopping, and how many failed. */
    stopCheckId: v.optional(v.id("_scheduled_functions")),
    stopAttempts: v.optional(v.number()),
    /** When the next stop try runs (`browsers.stopStep` leases each one), and why the last one failed. */
    stopNextAt: v.optional(v.number()),
    stopError: v.optional(v.string()),
    /**
     * A start with saved logins failed without saying whether a session was made: the room looks for
     * one by the browser's tag, and ends it, until this time (after which its own timeouts have).
     */
    recoverUntil: v.optional(v.number()),
    /** The provisioning job, which `browsers.provisionWatchdog` watches until it reports. */
    provisionJobId: v.optional(v.id("_scheduled_functions")),
    /** The latest URL asked for came from a `navigate` job queued before #77, not a request made since. */
    navigationFromOldJob: v.optional(v.boolean()),
    /** Bumped on every change to who may control it; a sync re-runs until it applied the latest. */
    controlVersion: v.optional(v.number()),
    /** Until when a running control sync holds the lease. */
    controlSyncUntil: v.optional(v.number()),
  })
    .index("by_team", ["teamId"])
    .index("by_channel", ["channelId"])
    .index("by_webhook_secret", ["webhookSecretHash"])
    .index("by_saved_login", ["savedLoginId"]),

  /**
   * Saved logins (ADR 0011): a named Hyperbeam profile that a channel's shared
   * browsers load and save back to, kept for the time someone picked.
   */
  savedLogins: defineTable({
    teamId: v.id("teams"),
    channelId: v.id("channels"),
    name: v.string(),
    savedBy: v.id("members"),
    createdAt: v.number(),
    keep: vKeep,
    /** When the keep choice was last made; `expiresAt` counts from here. */
    keptFrom: v.number(),
    /** When they are forgotten. Unset for "until deleted", and once forgotten. */
    expiresAt: v.optional(v.number()),
    expireCheckId: v.optional(v.id("_scheduled_functions")),
    /**
     * The provider's profile id: for Hyperbeam, the id of the session that first
     * saved it. Only the backend reads it; no query returns it. Unset until a
     * browser with these logins goes live, and dropped when they are forgotten.
     */
    profileId: v.optional(v.string()),
    lastUsedAt: v.optional(v.number()),
    status: v.union(v.literal("kept"), v.literal("forgotten")),
    forgottenAt: v.optional(v.number()),
    /** Expired: their time ran out. Forgotten: someone forgot them. */
    forgetReason: v.optional(v.union(v.literal("expired"), v.literal("forgotten"))),
    forgottenBy: v.optional(v.id("members")),
    /**
     * Erasing the profile once the saved logins are forgotten (#76), with a session that loads
     * nothing and saves an empty profile over it. Waiting: a browser still uses the profile.
     * Pending: the room starts that session, then ends it, trying again with backoff. Then erased,
     * or given up on after about a day. The profile id is kept here only until then.
     */
    erase: v.optional(
      v.object({
        state: v.union(v.literal("waiting"), v.literal("pending"), v.literal("erased"), v.literal("gaveUp")),
        profileId: v.optional(v.string()),
        /** The erase session, once started. Nobody joins it, and its URL and token are never stored. */
        sessionId: v.optional(v.string()),
        tries: v.number(),
        /** When the next try may start; `savedLogins.eraseStep` moves it ahead by the backoff before each try. */
        nextAt: v.number(),
        lastError: v.optional(v.string()),
        erasedAt: v.optional(v.number()),
      }),
    ),
  })
    .index("by_channel", ["channelId"])
    .index("by_team", ["teamId"]),

  /** A team's limits for shared browsers, set by admins. Defaults apply until a row exists. */
  browserSettings: defineTable({
    teamId: v.id("teams"),
    mostOpenAccess: vAccess,
    maxLive: v.number(),
    idleMinutes: v.number(),
    longestMinutes: v.number(),
  }).index("by_team", ["teamId"]),

  /** One-time join tickets. Hyperbeam passes the ticket back to our auth webhook. */
  browserTickets: defineTable({
    browserId: v.id("browsers"),
    memberId: v.id("members"),
    /** For agents: the key that asked, so revoking it refuses the ticket. */
    agentKeyId: v.optional(v.id("agentKeys")),
    ticketHash: v.string(),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
  }).index("by_hash", ["ticketHash"]),

  /** Which provider user each admitted connection is, so control goes to the driver's connections only. */
  browserConnections: defineTable({
    browserId: v.id("browsers"),
    memberId: v.id("members"),
    agentKeyId: v.optional(v.id("agentKeys")),
    providerUserId: v.string(),
    joinedAt: v.number(),
  }).index("by_browser", ["browserId"]),

  browserWatchers: defineTable({
    browserId: v.id("browsers"),
    memberId: v.id("members"),
    lastSeenAt: v.number(),
    checkId: v.optional(v.id("_scheduled_functions")),
  })
    .index("by_browser", ["browserId"])
    .index("by_browser_member", ["browserId", "memberId"]),

  browserSuggestions: defineTable({
    browserId: v.id("browsers"),
    fromId: v.id("members"),
    url: v.string(),
    status: v.union(v.literal("pending"), v.literal("opened"), v.literal("dismissed")),
    answeredBy: v.optional(v.id("members")),
  }).index("by_browser", ["browserId"]),

  browserWheelRequests: defineTable({
    browserId: v.id("browsers"),
    fromId: v.id("members"),
    status: v.union(
      v.literal("pending"),
      v.literal("granted"),
      v.literal("denied"),
      v.literal("cancelled"),
    ),
    answeredBy: v.optional(v.id("members")),
  }).index("by_browser", ["browserId"]),

  // Spaces (spec #6, ADR 0009) ---------------------------------------------

  /** A Cua Space a machine's bridge shares with the room. */
  spaces: defineTable({
    teamId: v.id("teams"),
    machineId: v.id("machines"),
    /** Cua's id for the Space on that machine, such as `local:studio`. */
    spaceRef: v.string(),
    name: v.string(),
    os: v.optional(v.string()),
    kind: v.optional(v.string()),
    /** Whoever shared it: the machine's person, or an admin for a team machine. */
    sharedBy: v.id("members"),
    access: vAccess,
    driverId: v.optional(v.id("members")),
    runId: v.optional(v.id("runs")),
    status: v.union(
      v.literal("starting"),
      v.literal("live"),
      v.literal("ended"),
      v.literal("failed"),
    ),
    failReason: v.optional(v.string()),
    /** Whether Cua has it running on its machine (`space_power`). Absent: running. */
    power: v.optional(vSpacePower),
    /** Set when the machine's limit lowered this Space: the level it had before. */
    loweredFrom: v.optional(vAccess),
    /** Base URLs of the bridge's Space gateway, from `space_shared`. */
    gateway: v.array(v.string()),
    endedAt: v.optional(v.number()),
  })
    .index("by_machine", ["machineId"])
    .index("by_team", ["teamId"]),

  /** The Cua Spaces a machine's bridge last reported finding. */
  foundSpaces: defineTable({
    machineId: v.id("machines"),
    spaceRef: v.string(),
    name: v.string(),
    os: v.optional(v.string()),
    kind: v.optional(v.string()),
    state: v.optional(vSpacePower),
  }).index("by_machine", ["machineId"]),

  /**
   * The Rex tabs a machine's bridge last reported it can share (`rex_found`, ADR 0019): tabs whose
   * program runs through the bridge. Only whoever the machine belongs to reads them (rex.found).
   */
  foundRexTabs: defineTable({
    machineId: v.id("machines"),
    tabRef: v.string(),
    sessionRef: v.string(),
    session: v.string(),
    title: v.string(),
    command: v.string(),
    cwd: v.optional(v.string()),
    /** The terminal sharing it, as the bridge names it: its room id, or its local ref. */
    terminalRef: v.optional(v.string()),
  }).index("by_machine", ["machineId"]),

  /** One person's view of a Space (GLOSSARY.md, "Space view"). */
  spaceViews: defineTable({
    spaceId: v.id("spaces"),
    memberId: v.id("members"),
    /** Whether the room asked for an interactive view (only for the driver). */
    interactive: v.boolean(),
    status: v.union(
      v.literal("requested"),
      v.literal("ready"),
      v.literal("failed"),
      v.literal("closed"),
    ),
    /** From `space_view_ready`. Only the viewer can read these. */
    path: v.optional(v.string()),
    ticket: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    failReason: v.optional(v.string()),
    closedReason: v.optional(v.string()),
    lastSeenAt: v.number(),
    checkId: v.optional(v.id("_scheduled_functions")),
  })
    .index("by_space", ["spaceId"])
    .index("by_space_member", ["spaceId", "memberId"]),

  /** Space actions: who did what on a Space, and what came back. */
  spaceActions: defineTable({
    spaceId: v.id("spaces"),
    memberId: v.id("members"),
    agentKeyId: v.optional(v.id("agentKeys")),
    action: vSpaceAction,
    status: v.union(v.literal("pending"), v.literal("done"), v.literal("failed")),
    error: v.optional(v.string()),
    screenshot: v.optional(vSpaceScreenshot),
    at: v.number(),
  }).index("by_space", ["spaceId"]),

  spaceSuggestions: defineTable({
    spaceId: v.id("spaces"),
    fromId: v.id("members"),
    text: v.string(),
    status: v.union(v.literal("pending"), v.literal("done"), v.literal("dismissed")),
    answeredBy: v.optional(v.id("members")),
  }).index("by_space", ["spaceId"]),

  spaceWheelRequests: defineTable({
    spaceId: v.id("spaces"),
    fromId: v.id("members"),
    status: v.union(
      v.literal("pending"),
      v.literal("granted"),
      v.literal("denied"),
      v.literal("cancelled"),
    ),
    answeredBy: v.optional(v.id("members")),
  }).index("by_space", ["spaceId"]),

  /** A call held in a channel (ADR 0007). A channel has at most one live call (no `endedAt`). */
  calls: defineTable({
    teamId: v.id("teams"),
    channelId: v.id("channels"),
    startedBy: v.id("members"),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    /** The call notes message in the channel, once posted. */
    notesMessageId: v.optional(v.id("messages")),
    /**
     * When tasks were first proposed after the call ended (calls.propose, even
     * with none). With the notes, it marks the call's notes complete, so a
     * Notetaker stopped between the two still finds the call unfinished.
     */
    proposedAt: v.optional(v.number()),
    /** Set when the transcript was deleted, 30 days after the call ended (ADR 0008). */
    transcriptDeletedAt: v.optional(v.number()),
  })
    .index("by_channel", ["channelId"])
    .index("by_team_ended", ["teamId", "endedAt"])
    .index("by_transcript_ended", ["transcriptDeletedAt", "endedAt"]),

  /**
   * One join of a call: one row per `calls.join`, so per device. Leave,
   * heartbeat and media updates act on one participation only, so a stale leave
   * can never remove a newer join. A member is in the call while any of their
   * participations is live (no `leftAt`).
   */
  callParticipations: defineTable({
    callId: v.id("calls"),
    memberId: v.id("members"),
    kind: v.union(v.literal("person"), v.literal("agent")),
    /** An agent whose key holds `calls.notes`: the dock says it's taking notes. */
    takesNotes: v.boolean(),
    joinedAt: v.number(),
    lastSeenAt: v.number(),
    leftAt: v.optional(v.number()),
    muted: v.boolean(),
    camera: v.boolean(),
    screen: v.boolean(),
    /** The pending check that drops it once its heartbeat stops (one per participation). */
    checkId: v.optional(v.id("_scheduled_functions")),
  })
    .index("by_call", ["callId"])
    .index("by_call_member", ["callId", "memberId"])
    // A member's live joins (no leftAt) and the ones that ended lately, to revoke (calls.removeFromCalls).
    .index("by_member_left", ["memberId", "leftAt"]),

  /**
   * A LiveKit identity to disconnect and refuse, after its member left the team (calls.ts,
   * removeFromCalls). Pending until LiveKit confirms it removed the join or that it isn't there;
   * transient failures are tried again with backoff, each time with a fresh revokeTokenTs.
   */
  callRevocations: defineTable({
    memberId: v.id("members"),
    callId: v.id("calls"),
    identity: v.string(),
    state: v.union(v.literal("pending"), v.literal("removed"), v.literal("absent"), v.literal("gaveUp")),
    tries: v.number(),
    /** When the next try may start; the retry step that leased a try sets it ahead by the backoff. */
    nextAt: v.number(),
    lastError: v.optional(v.string()),
  })
    .index("by_identity", ["identity"])
    .index("by_member", ["memberId"])
    // Finished rows by age, to delete them a week on (calls.pruneRevocations, #73).
    .index("by_state", ["state"]),

  /**
   * Which process takes calls for an agent (one at a time), so two copies of
   * the Notetaker never both join and summarize. Renewed while held; it lapses
   * if the holder stops renewing (a crash).
   */
  callLeases: defineTable({
    agentMemberId: v.id("members"),
    holder: v.string(),
    expiresAt: v.number(),
  }).index("by_agent", ["agentMemberId"]),

  callInvites: defineTable({
    callId: v.id("calls"),
    memberId: v.id("members"),
    invitedBy: v.id("members"),
    at: v.number(),
    status: v.union(v.literal("pending"), v.literal("joined"), v.literal("cleared")),
  })
    .index("by_member_status", ["memberId", "status"])
    .index("by_call", ["callId"]),

  /** One line of a call's transcript: who said what. Deleted 30 days after the call ends. */
  transcriptLines: defineTable({
    callId: v.id("calls"),
    speakerId: v.id("members"),
    text: v.string(),
    at: v.number(),
    addedBy: v.id("members"),
    /** The writer's id for the line, so a batch sent again after a timeout isn't added twice. */
    key: v.optional(v.string()),
  })
    .index("by_call_at", ["callId", "at"])
    .index("by_call_key", ["callId", "key"]),

  /** A task suggested from a call. It becomes a task only when a team member accepts it. */
  taskProposals: defineTable({
    teamId: v.id("teams"),
    callId: v.id("calls"),
    channelId: v.id("channels"),
    title: v.string(),
    description: v.optional(v.string()),
    /** The suggested owner, a person. */
    ownerId: v.optional(v.id("members")),
    proposedBy: v.id("members"),
    status: v.union(v.literal("pending"), v.literal("accepted"), v.literal("dismissed")),
    taskId: v.optional(v.id("tasks")),
    answeredBy: v.optional(v.id("members")),
    /** The proposer's id for it, so proposals sent again after a lost answer aren't added twice. */
    key: v.optional(v.string()),
  })
    .index("by_call", ["callId"])
    .index("by_call_key", ["callId", "key"])
    // The Inbox lists a team's pending proposals (inbox.get).
    .index("by_team_status", ["teamId", "status"]),

  /** Who changed access, slots, the driver or machine settings, and when. */
  audit: defineTable({
    teamId: v.id("teams"),
    actorId: v.id("members"),
    agentKeyId: v.optional(v.id("agentKeys")),
    /** For agents: the person accountable for it. */
    accountableId: v.optional(v.id("members")),
    action: v.string(),
    target: v.string(),
    details: v.optional(v.any()),
    at: v.number(),
    /**
     * The channel the entry is about, found when it was written (ADR 0016): activity.list shows it
     * only to someone who can see that channel, even after its message is deleted.
     */
    channelId: v.optional(v.id("channels")),
  }).index("by_team", ["teamId"]),

  /**
   * A connected GitHub account (ADR 0020): a GitHub organization an admin connected, or a person's
   * own personal account, where the room's GitHub App is installed, linked to one team. The same
   * installation may be connected to several teams, each with its own row and its own copy of the
   * synced repos.
   */
  githubAccounts: defineTable({
    teamId: v.id("teams"),
    /** GitHub's id for the installation. */
    installationId: v.number(),
    /** GitHub's id for the organization or user. */
    accountGithubId: v.number(),
    login: v.string(),
    type: v.union(v.literal("Organization"), v.literal("User")),
    avatarUrl: v.optional(v.string()),
    repositorySelection: v.union(v.literal("all"), v.literal("selected")),
    /** When the account suspended the App on GitHub. Its repos stay listed, marked, until it's unsuspended or uninstalled. */
    suspendedAt: v.optional(v.number()),
    /** Who connected it. A personal account is theirs: they sync it, change its repos and disconnect it. */
    connectedBy: v.id("members"),
    connectedAt: v.number(),
    /** How many synced repos it gives the team, kept as repos are added and removed. */
    repoCount: v.number(),
    /** "syncing" while a sync runs, "synced" after one finished, "failed" with `syncError`. */
    syncState: v.union(v.literal("syncing"), v.literal("synced"), v.literal("failed")),
    /** Bumped by each sync; a page or a result from an older sync changes nothing. */
    syncGeneration: v.number(),
    syncStartedAt: v.optional(v.number()),
    lastSyncedAt: v.optional(v.number()),
    syncError: v.optional(v.string()),
    /** Set on disconnect or uninstall. Its repos are then deleted in batches, then this row. */
    removedAt: v.optional(v.number()),
    /** When a webhook last changed its repos. A sync that started before it resyncs instead of finishing as synced. */
    lastWebhookAt: v.optional(v.number()),
  })
    .index("by_team", ["teamId"])
    .index("by_installation", ["installationId"])
    .index("by_removed", ["removedAt"])
    /** A member's connections, disconnected when they leave the team. */
    .index("by_connected_by", ["connectedBy"]),

  /** A repo a connected GitHub account gives the team: a synced repo (ADR 0020). */
  githubRepos: defineTable({
    teamId: v.id("teams"),
    githubAccountId: v.id("githubAccounts"),
    /** GitHub's numeric id for the repo, which survives renames and transfers. */
    githubId: v.number(),
    /** `owner/name` as GitHub writes it. */
    fullName: v.string(),
    /** `repoKey`: `github.com/owner/name` in lower case, to match projects' repo strings. */
    key: v.string(),
    /** The name's words, space-separated (`nuko uplink room`), for the repo search. */
    searchText: v.string(),
    private: v.boolean(),
    archived: v.boolean(),
    defaultBranch: v.string(),
    /** The sync that last saw it. A sync deletes its account's repos that it didn't see. */
    syncGeneration: v.number(),
    /** When a webhook last changed it. A sync page GitHub sent before then doesn't overwrite it. */
    webhookAt: v.optional(v.number()),
  })
    .index("by_account_github", ["githubAccountId", "githubId"])
    .index("by_account_generation", ["githubAccountId", "syncGeneration"])
    .index("by_github", ["githubId"])
    .index("by_team_github", ["teamId", "githubId"])
    .index("by_team_key", ["teamId", "key"])
    .searchIndex("search_name", { searchField: "searchText", filterFields: ["teamId"] }),

  /** A project's repo that is a synced repo, by GitHub's id, so a rename on GitHub renames it in the project. */
  projectRepoLinks: defineTable({
    teamId: v.id("teams"),
    projectId: v.id("projects"),
    githubId: v.number(),
    /** The repo's `repoKey` as the project lists it, kept current by renames. */
    key: v.optional(v.string()),
  })
    .index("by_github", ["githubId"])
    .index("by_project", ["projectId"])
    .index("by_team_github_project", ["teamId", "githubId", "projectId"]),

  /**
   * A repo a webhook removed from an account, and when. A sync page GitHub sent before then doesn't
   * bring it back. Kept a day.
   */
  githubRepoTombstones: defineTable({
    githubAccountId: v.id("githubAccounts"),
    githubId: v.number(),
    at: v.number(),
  })
    .index("by_account_github", ["githubAccountId", "githubId"])
    .index("by_at", ["at"]),

  /**
   * One run of the connect flow (ADR 0020). Its state names the team and the person who started it,
   * expires after 30 minutes and is used once. The PKCE verifier stays here and never leaves the backend.
   * The browser part ends after GitHub's sign-in; the person who started it confirms in the app.
   */
  githubConnects: defineTable({
    teamId: v.id("teams"),
    memberId: v.id("members"),
    nonceHash: v.string(),
    codeVerifier: v.string(),
    expiresAt: v.number(),
    /**
     * The starter's role when they started it. A flow an admin started is cancelled if they stop
     * being one before they confirm. Absent on flows from before Confirm moved into the app: those
     * connect nothing.
     */
    starterRole: v.optional(v.union(v.literal("admin"), v.literal("member"))),
    /** The installation id GitHub's Setup URL named. Only a claim until GitHub confirms the person can access it. */
    claimedInstallationId: v.optional(v.number()),
    /** After the person authorized the App: who they are on GitHub and which installations they can access. */
    githubLogin: v.optional(v.string()),
    /** Their GitHub user id, so Confirm can ask GitHub again whether they still own what they connect. */
    githubUserId: v.optional(v.number()),
    accessible: v.optional(
      v.array(
        v.object({
          installationId: v.number(),
          accountGithubId: v.number(),
          login: v.string(),
          type: v.union(v.literal("Organization"), v.literal("User")),
          avatarUrl: v.optional(v.string()),
          repositorySelection: v.union(v.literal("all"), v.literal("selected")),
          suspended: v.boolean(),
          /**
           * Whether the person may give the team this installation's every repo: an active owner of
           * the organization, or the personal account itself. Absent counts as no.
           */
          canShare: v.optional(v.boolean()),
          /** Why not, in words the app shows. */
          why: v.optional(v.string()),
          /** Why not, in short: not an owner, not a team admin, someone else's account, or not checked. */
          refusal: v.optional(v.union(v.literal("owner"), v.literal("admin"), v.literal("self"), v.literal("limit"))),
        }),
      ),
    ),
    /**
     * When an agent started the flow: the key it used. Agents can't connect accounts now, so a flow
     * an agent started before that is refused; the field stays for those rows.
     */
    agentKeyId: v.optional(v.id("agentKeys")),
    /** The browser confirm page's form token, as a hash, on flows from before Confirm moved into the app. */
    confirmTokenHash: v.optional(v.string()),
    /** The starter chose Connect in the app: which installation, and when. The room is asking GitHub again. */
    confirming: v.optional(v.object({ installationId: v.number(), at: v.number() })),
    /** The last Connect GitHub or the room refused, shown in the app until the next one. */
    refusal: v.optional(v.object({ installationId: v.number(), why: v.string() })),
    /** The account it connected (with `usedAt`), shown in the app until the starter clears it. */
    connectedLogin: v.optional(v.string()),
    /** The starter cancelled it in the app, or cleared it once it was done. */
    /** When its admin starter was made a member. It stays cancelled if they're made an admin again. */
    demotedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    usedAt: v.optional(v.number()),
  })
    .index("by_nonce", ["nonceHash"])
    .index("by_expires", ["expiresAt"])
    .index("by_member", ["memberId", "expiresAt"]),

  /** Webhook deliveries already applied, by `X-GitHub-Delivery`, so a redelivery changes nothing twice. Kept 7 days. */
  githubDeliveries: defineTable({
    deliveryId: v.string(),
    at: v.number(),
  })
    .index("by_delivery", ["deliveryId"])
    .index("by_at", ["at"]),

  /**
   * Writes made with an idempotency key (messages.post, tasks.create, tasks.createMany,
   * runs.report): the same member, function and key within a day get the first write's result back
   * and write nothing again, so a caller that retries after a timeout doesn't post twice. Kept a day.
   */
  idempotentWrites: defineTable({
    teamId: v.id("teams"),
    memberId: v.id("members"),
    /** The Room API function, such as `messages.post`. */
    fn: v.string(),
    key: v.string(),
    /** SHA-256 of the call's other arguments: the same key with different arguments is refused. */
    fingerprint: v.string(),
    result: v.any(),
    at: v.number(),
  })
    .index("by_member_fn_key", ["memberId", "fn", "key"])
    .index("by_at", ["at"]),

  /**
   * A message a run's driver (or their agent) set to reach the run later (runs.remind): at `at`
   * the room posts `text` in the place named, addressed to the run, so it lands in the run's inbox
   * like any message to it.
   */
  runReminders: defineTable({
    teamId: v.id("teams"),
    runId: v.id("runs"),
    /** Who set it: the run's driver, or an agent of theirs. It is posted as them. */
    setBy: v.id("members"),
    /** The key an agent set it with, so the post keeps that key's scopes and channels. */
    agentKeyId: v.optional(v.id("agentKeys")),
    channelId: v.id("channels"),
    replyTo: v.optional(v.id("messages")),
    text: v.string(),
    at: v.number(),
    /** The scheduled post; set right after the row is made. */
    scheduledId: v.optional(v.id("_scheduled_functions")),
    status: v.union(v.literal("pending"), v.literal("sent"), v.literal("canceled"), v.literal("skipped")),
    /** For skipped: why it wasn't posted, such as the run having ended. */
    why: v.optional(v.string()),
    messageId: v.optional(v.id("messages")),
  })
    .index("by_run_status", ["runId", "status"]),

  /**
   * A task waiting for a machine (ADR 0050): once every task it needs is closed, the room starts
   * a run for it there, oldest first, as its machine has room (a free slot for a terminal). Starting
   * deletes the row; so does the task closing. The run starts as whoever queued it, with the rights
   * they have then.
   */
  taskQueue: defineTable({
    teamId: v.id("teams"),
    taskId: v.id("tasks"),
    machineId: v.id("machines"),
    queuedBy: v.id("members"),
    /** The key an agent queued it with: the run starts with that key's scopes and channels. */
    agentKeyId: v.optional(v.id("agentKeys")),
    harness: v.string(),
    via: v.union(v.literal("terminal"), v.literal("thread")),
    cwd: v.optional(v.string()),
    repo: v.optional(v.string()),
    prompt: v.optional(v.string()),
    command: v.optional(v.string()),
    access: v.optional(vAccess),
    runtimeMode: v.optional(vRuntimeMode),
    queuedAt: v.number(),
    /** Why the last try didn't start it, such as a machine set to take runs only from its person. */
    lastRefusal: v.optional(v.string()),
    /** While its start is under way (tasks.startQueued). One still set a minute later failed. */
    startingAt: v.optional(v.number()),
    /** Its start failed: it waits, skipped, until someone queues it again or starts it by hand. */
    stuck: v.optional(v.literal(true)),
  })
    .index("by_task", ["taskId"])
    .index("by_team_queued", ["teamId", "queuedAt"])
    .index("by_machine_queued", ["machineId", "queuedAt"])
    // A start under way on a machine, wherever its row is in the queue: one at a time.
    .index("by_machine_starting", ["machineId", "startingAt"])
    .index("by_queued", ["queuedAt"]),

  /**
   * A GitHub pull request linked to a task (ADR 0051): its state, reviews and checks, kept by the
   * App's webhooks, so people and agents see on the task whether it merged, who approved it and
   * whether CI passes, without asking GitHub.
   */
  taskPullRequests: defineTable({
    teamId: v.id("teams"),
    taskId: v.id("tasks"),
    /** GitHub's id for the repo, which survives renames: webhooks are matched by it. */
    repoGithubId: v.number(),
    /** `owner/name` as GitHub last wrote it. */
    repo: v.string(),
    number: v.number(),
    /** The installation the team reaches the repo through: only its webhooks change this row. */
    installationId: v.number(),
    linkedBy: v.id("members"),
    title: v.optional(v.string()),
    url: v.optional(v.string()),
    state: v.optional(v.union(v.literal("open"), v.literal("draft"), v.literal("merged"), v.literal("closed"))),
    headSha: v.optional(v.string()),
    /** GitHub's `updated_at` for the pull request (ms), so an older delivery arriving late changes nothing. */
    pullUpdatedAt: v.optional(v.number()),
    /** Each reviewer's latest review that counts: approved or changes requested, with the review's id and time. */
    reviews: v.optional(
      v.array(
        v.object({
          login: v.string(),
          /** dismissed: kept so a submission of that review delivered late doesn't bring it back. */
          state: v.union(v.literal("approved"), v.literal("changes_requested"), v.literal("dismissed")),
          reviewId: v.optional(v.number()),
          at: v.optional(v.number()),
        }),
      ),
    ),
    /** Check suites by GitHub's suite id (or app and commit); the task shows those on `headSha`. */
    checks: v.optional(
      v.array(
        v.object({
          app: v.string(),
          suiteId: v.optional(v.number()),
          sha: v.optional(v.string()),
          status: v.string(),
          conclusion: v.optional(v.string()),
          at: v.optional(v.number()),
        }),
      ),
    ),
    /** Why the room couldn't read it from GitHub, such as the App lacking the pull requests permission. */
    error: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_task", ["taskId"])
    .index("by_repo_number", ["repoGithubId", "number"])
    .index("by_repo_head", ["repoGithubId", "headSha"]),
});
