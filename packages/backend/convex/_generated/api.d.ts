/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as a2a from "../a2a.js";
import type * as a2aNode from "../a2aNode.js";
import type * as a2aWorker from "../a2aWorker.js";
import type * as accounts from "../accounts.js";
import type * as activity from "../activity.js";
import type * as agents from "../agents.js";
import type * as bridge from "../bridge.js";
import type * as browsers from "../browsers.js";
import type * as calls from "../calls.js";
import type * as canvas from "../canvas.js";
import type * as channels from "../channels.js";
import type * as cliSignIns from "../cliSignIns.js";
import type * as cloudMachineActions from "../cloudMachineActions.js";
import type * as cloudMachines from "../cloudMachines.js";
import type * as comments from "../comments.js";
import type * as connectors from "../connectors.js";
import type * as crons from "../crons.js";
import type * as emailSend from "../emailSend.js";
import type * as emails from "../emails.js";
import type * as files from "../files.js";
import type * as github from "../github.js";
import type * as githubConfirm from "../githubConfirm.js";
import type * as githubHttp from "../githubHttp.js";
import type * as githubSync from "../githubSync.js";
import type * as http from "../http.js";
import type * as inbox from "../inbox.js";
import type * as invites from "../invites.js";
import type * as joined from "../joined.js";
import type * as lib_a2a_connection from "../lib/a2a/connection.js";
import type * as lib_a2a_conversations from "../lib/a2a/conversations.js";
import type * as lib_a2a_dialect from "../lib/a2a/dialect.js";
import type * as lib_a2a_explain from "../lib/a2a/explain.js";
import type * as lib_a2a_guardedFetch from "../lib/a2a/guardedFetch.js";
import type * as lib_a2a_observe from "../lib/a2a/observe.js";
import type * as lib_a2a_peerUrl from "../lib/a2a/peerUrl.js";
import type * as lib_a2a_protocol from "../lib/a2a/protocol.js";
import type * as lib_a2a_redact from "../lib/a2a/redact.js";
import type * as lib_a2a_runs from "../lib/a2a/runs.js";
import type * as lib_a2a_secrets from "../lib/a2a/secrets.js";
import type * as lib_a2a_timing from "../lib/a2a/timing.js";
import type * as lib_actor from "../lib/actor.js";
import type * as lib_attachments from "../lib/attachments.js";
import type * as lib_bridgeMessages from "../lib/bridgeMessages.js";
import type * as lib_browserProvider from "../lib/browserProvider.js";
import type * as lib_callQuality from "../lib/callQuality.js";
import type * as lib_catalog from "../lib/catalog.js";
import type * as lib_channels from "../lib/channels.js";
import type * as lib_chat from "../lib/chat.js";
import type * as lib_clerkTokens from "../lib/clerkTokens.js";
import type * as lib_clerkWebhook from "../lib/clerkWebhook.js";
import type * as lib_cloudBoot from "../lib/cloudBoot.js";
import type * as lib_cloudMachines from "../lib/cloudMachines.js";
import type * as lib_cloudProvider from "../lib/cloudProvider.js";
import type * as lib_cloudReconcile from "../lib/cloudReconcile.js";
import type * as lib_crypto from "../lib/crypto.js";
import type * as lib_deliveries from "../lib/deliveries.js";
import type * as lib_email from "../lib/email.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_fileAccess from "../lib/fileAccess.js";
import type * as lib_files from "../lib/files.js";
import type * as lib_github_api from "../lib/github/api.js";
import type * as lib_github_config from "../lib/github/config.js";
import type * as lib_github_crypto from "../lib/github/crypto.js";
import type * as lib_github_events from "../lib/github/events.js";
import type * as lib_github_pages from "../lib/github/pages.js";
import type * as lib_github_pulls from "../lib/github/pulls.js";
import type * as lib_givenRuns from "../lib/givenRuns.js";
import type * as lib_harnesses from "../lib/harnesses.js";
import type * as lib_idArgs from "../lib/idArgs.js";
import type * as lib_idempotency from "../lib/idempotency.js";
import type * as lib_inviteToken from "../lib/inviteToken.js";
import type * as lib_joinedRuns from "../lib/joinedRuns.js";
import type * as lib_link from "../lib/link.js";
import type * as lib_linkPreview from "../lib/linkPreview.js";
import type * as lib_livekit from "../lib/livekit.js";
import type * as lib_machines from "../lib/machines.js";
import type * as lib_members from "../lib/members.js";
import type * as lib_messages from "../lib/messages.js";
import type * as lib_outbox from "../lib/outbox.js";
import type * as lib_pairAttachments from "../lib/pairAttachments.js";
import type * as lib_pairs from "../lib/pairs.js";
import type * as lib_people from "../lib/people.js";
import type * as lib_reads from "../lib/reads.js";
import type * as lib_refusals from "../lib/refusals.js";
import type * as lib_remoteMcp from "../lib/remoteMcp.js";
import type * as lib_repos from "../lib/repos.js";
import type * as lib_requestBody from "../lib/requestBody.js";
import type * as lib_rex from "../lib/rex.js";
import type * as lib_room from "../lib/room.js";
import type * as lib_router from "../lib/router.js";
import type * as lib_runDelivery from "../lib/runDelivery.js";
import type * as lib_runLabels from "../lib/runLabels.js";
import type * as lib_runSay from "../lib/runSay.js";
import type * as lib_runWarnings from "../lib/runWarnings.js";
import type * as lib_savedLogins from "../lib/savedLogins.js";
import type * as lib_scopes from "../lib/scopes.js";
import type * as lib_spaces from "../lib/spaces.js";
import type * as lib_states from "../lib/states.js";
import type * as lib_taskQueue from "../lib/taskQueue.js";
import type * as lib_terminals from "../lib/terminals.js";
import type * as lib_threadView from "../lib/threadView.js";
import type * as lib_threads from "../lib/threads.js";
import type * as lib_typing from "../lib/typing.js";
import type * as lib_vercelSandbox from "../lib/vercelSandbox.js";
import type * as lib_webhookTiming from "../lib/webhookTiming.js";
import type * as linkPreviewNode from "../linkPreviewNode.js";
import type * as linkPreviews from "../linkPreviews.js";
import type * as live from "../live.js";
import type * as machines from "../machines.js";
import type * as members from "../members.js";
import type * as messages from "../messages.js";
import type * as pairs from "../pairs.js";
import type * as people from "../people.js";
import type * as profiles from "../profiles.js";
import type * as projects from "../projects.js";
import type * as rex from "../rex.js";
import type * as roomModules from "../roomModules.js";
import type * as runDelivery from "../runDelivery.js";
import type * as runs from "../runs.js";
import type * as savedLogins from "../savedLogins.js";
import type * as spaces from "../spaces.js";
import type * as tasks from "../tasks.js";
import type * as teams from "../teams.js";
import type * as terminals from "../terminals.js";
import type * as threads from "../threads.js";
import type * as webhooks from "../webhooks.js";
import type * as webhooksNode from "../webhooksNode.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  a2a: typeof a2a;
  a2aNode: typeof a2aNode;
  a2aWorker: typeof a2aWorker;
  accounts: typeof accounts;
  activity: typeof activity;
  agents: typeof agents;
  bridge: typeof bridge;
  browsers: typeof browsers;
  calls: typeof calls;
  canvas: typeof canvas;
  channels: typeof channels;
  cliSignIns: typeof cliSignIns;
  cloudMachineActions: typeof cloudMachineActions;
  cloudMachines: typeof cloudMachines;
  comments: typeof comments;
  connectors: typeof connectors;
  crons: typeof crons;
  emailSend: typeof emailSend;
  emails: typeof emails;
  files: typeof files;
  github: typeof github;
  githubConfirm: typeof githubConfirm;
  githubHttp: typeof githubHttp;
  githubSync: typeof githubSync;
  http: typeof http;
  inbox: typeof inbox;
  invites: typeof invites;
  joined: typeof joined;
  "lib/a2a/connection": typeof lib_a2a_connection;
  "lib/a2a/conversations": typeof lib_a2a_conversations;
  "lib/a2a/dialect": typeof lib_a2a_dialect;
  "lib/a2a/explain": typeof lib_a2a_explain;
  "lib/a2a/guardedFetch": typeof lib_a2a_guardedFetch;
  "lib/a2a/observe": typeof lib_a2a_observe;
  "lib/a2a/peerUrl": typeof lib_a2a_peerUrl;
  "lib/a2a/protocol": typeof lib_a2a_protocol;
  "lib/a2a/redact": typeof lib_a2a_redact;
  "lib/a2a/runs": typeof lib_a2a_runs;
  "lib/a2a/secrets": typeof lib_a2a_secrets;
  "lib/a2a/timing": typeof lib_a2a_timing;
  "lib/actor": typeof lib_actor;
  "lib/attachments": typeof lib_attachments;
  "lib/bridgeMessages": typeof lib_bridgeMessages;
  "lib/browserProvider": typeof lib_browserProvider;
  "lib/callQuality": typeof lib_callQuality;
  "lib/catalog": typeof lib_catalog;
  "lib/channels": typeof lib_channels;
  "lib/chat": typeof lib_chat;
  "lib/clerkTokens": typeof lib_clerkTokens;
  "lib/clerkWebhook": typeof lib_clerkWebhook;
  "lib/cloudBoot": typeof lib_cloudBoot;
  "lib/cloudMachines": typeof lib_cloudMachines;
  "lib/cloudProvider": typeof lib_cloudProvider;
  "lib/cloudReconcile": typeof lib_cloudReconcile;
  "lib/crypto": typeof lib_crypto;
  "lib/deliveries": typeof lib_deliveries;
  "lib/email": typeof lib_email;
  "lib/errors": typeof lib_errors;
  "lib/fileAccess": typeof lib_fileAccess;
  "lib/files": typeof lib_files;
  "lib/github/api": typeof lib_github_api;
  "lib/github/config": typeof lib_github_config;
  "lib/github/crypto": typeof lib_github_crypto;
  "lib/github/events": typeof lib_github_events;
  "lib/github/pages": typeof lib_github_pages;
  "lib/github/pulls": typeof lib_github_pulls;
  "lib/givenRuns": typeof lib_givenRuns;
  "lib/harnesses": typeof lib_harnesses;
  "lib/idArgs": typeof lib_idArgs;
  "lib/idempotency": typeof lib_idempotency;
  "lib/inviteToken": typeof lib_inviteToken;
  "lib/joinedRuns": typeof lib_joinedRuns;
  "lib/link": typeof lib_link;
  "lib/linkPreview": typeof lib_linkPreview;
  "lib/livekit": typeof lib_livekit;
  "lib/machines": typeof lib_machines;
  "lib/members": typeof lib_members;
  "lib/messages": typeof lib_messages;
  "lib/outbox": typeof lib_outbox;
  "lib/pairAttachments": typeof lib_pairAttachments;
  "lib/pairs": typeof lib_pairs;
  "lib/people": typeof lib_people;
  "lib/reads": typeof lib_reads;
  "lib/refusals": typeof lib_refusals;
  "lib/remoteMcp": typeof lib_remoteMcp;
  "lib/repos": typeof lib_repos;
  "lib/requestBody": typeof lib_requestBody;
  "lib/rex": typeof lib_rex;
  "lib/room": typeof lib_room;
  "lib/router": typeof lib_router;
  "lib/runDelivery": typeof lib_runDelivery;
  "lib/runLabels": typeof lib_runLabels;
  "lib/runSay": typeof lib_runSay;
  "lib/runWarnings": typeof lib_runWarnings;
  "lib/savedLogins": typeof lib_savedLogins;
  "lib/scopes": typeof lib_scopes;
  "lib/spaces": typeof lib_spaces;
  "lib/states": typeof lib_states;
  "lib/taskQueue": typeof lib_taskQueue;
  "lib/terminals": typeof lib_terminals;
  "lib/threadView": typeof lib_threadView;
  "lib/threads": typeof lib_threads;
  "lib/typing": typeof lib_typing;
  "lib/vercelSandbox": typeof lib_vercelSandbox;
  "lib/webhookTiming": typeof lib_webhookTiming;
  linkPreviewNode: typeof linkPreviewNode;
  linkPreviews: typeof linkPreviews;
  live: typeof live;
  machines: typeof machines;
  members: typeof members;
  messages: typeof messages;
  pairs: typeof pairs;
  people: typeof people;
  profiles: typeof profiles;
  projects: typeof projects;
  rex: typeof rex;
  roomModules: typeof roomModules;
  runDelivery: typeof runDelivery;
  runs: typeof runs;
  savedLogins: typeof savedLogins;
  spaces: typeof spaces;
  tasks: typeof tasks;
  teams: typeof teams;
  terminals: typeof terminals;
  threads: typeof threads;
  webhooks: typeof webhooks;
  webhooksNode: typeof webhooksNode;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
