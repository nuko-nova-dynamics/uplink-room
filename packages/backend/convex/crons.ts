import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";
import { providerConfigured } from "./lib/cloudProvider";

const crons = cronJobs();

// Uploads that no file keeps (refused, or never added) are deleted after an hour (spec #9).
crons.hourly("delete uploads no file keeps", { minuteUTC: 17 }, internal.files.sweepUploads, {});

/** Short-lived attachment links (messages.attachmentLink) are deleted once they expire (ADR 0016). */
crons.hourly("delete expired attachment links", { minuteUTC: 41 }, internal.messages.pruneAttachmentGrants, {});

/** Message alerts (messages.addressed) are kept for 7 days (spec #63). */
crons.daily("delete old message alerts", { hourUTC: 7, minuteUTC: 30 }, internal.messages.pruneAlerts, {});

/** Call transcripts are kept for 30 days after the call ends (ADR 0008). */
crons.daily(
  "delete old call transcripts",
  { hourUTC: 7, minuteUTC: 0 },
  internal.calls.pruneTranscripts,
  {},
);

/** LiveKit revocations that finished are kept for 7 days (#73). */
crons.daily(
  "delete finished call revocations",
  { hourUTC: 7, minuteUTC: 15 },
  internal.calls.pruneRevocations,
  {},
);

/**
 * Command-line sign-ins (ADR 0030): requests `uplink login` never finished, after 15 minutes, and
 * sign-ins 30 days after they expired.
 */
crons.hourly("delete ended CLI sign-ins", { minuteUTC: 53 }, internal.cliSignIns.prune, {});

/** Pair codes a day after they expire, and wrong-code counts whose hour is over (ADR 0034). */
crons.hourly("delete expired pair codes", { minuteUTC: 29 }, internal.pairs.prune, {});

/** Queued tasks (ADR 0050): each machine with a queue looks at it, so a freed slot or a machine back online is noticed. */
crons.interval("start queued tasks", { minutes: 1 }, internal.tasks.dispatchAll, {});

/** Idempotency keys are kept for a day (lib/idempotency.ts). */
crons.hourly("delete old idempotency keys", { minuteUTC: 11 }, internal.tasks.pruneIdempotentWrites, {});

/** Clerk webhook deliveries applied more than 7 days ago (ADR 0035). */
crons.daily("delete old Clerk webhook deliveries", { hourUTC: 7, minuteUTC: 45 }, internal.accounts.prune, {});

/** Account deletions whose steps stopped for 10 minutes, started again: Convex doesn't retry a failed one (ADR 0035). */
crons.interval("resume stalled account deletions", { minutes: 10 }, internal.accounts.resumeStalled, {});

/** Remote connectors nobody approved, 30 days after their last call (ADR 0031). */
crons.hourly("delete unapproved connectors", { minuteUTC: 23 }, internal.connectors.prune, {});

/** "Is typing" rows left by drafts nobody posted or cleared (channels.typing). */
crons.interval("delete stale typing", { minutes: 10 }, internal.channels.pruneTyping, {});

/**
 * GitHub (ADR 0020): a full sync of every connected account once a day, since GitHub sends Apps no
 * event when a repo is deleted, and pruning of finished connect flows and old webhook deliveries.
 */
crons.daily("sync GitHub accounts", { hourUTC: 6, minuteUTC: 30 }, internal.github.syncAll, {});
crons.daily("prune GitHub connects and deliveries", { hourUTC: 6, minuteUTC: 45 }, internal.github.prune, {});

/** Restarts A2A runs whose worker step died (ADR 0012). A healthy step schedules the next one itself. */
crons.interval("restart stalled A2A steps", { minutes: 5 }, internal.a2aWorker.sweep, {});

/**
 * Cloud machines (ADR 0013): make the provider's boxes match what the room wants. Only on a
 * deployment with the Vercel settings; Convex reads them here on deploy, so a deployment that gets
 * them later has the cron from its next deploy (#51).
 */
if (providerConfigured()) {
  crons.interval("reconcile cloud machines", { minutes: 5 }, internal.cloudMachineActions.reconcileAll, {});
}

export default crons;
