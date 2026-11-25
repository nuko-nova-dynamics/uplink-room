/**
 * What the Room API looks like as MCP tools, shared by the two MCP servers: `uplink-mcp` over
 * stdio (packages/room-client/src/mcp.ts) and the remote connector at `/mcp` (ADR 0028, ADR
 * 0031). Both list one tool per Room API function, named and described the same way, and orient
 * the agent with the same instructions, so a function reads the same wherever an agent meets it.
 *
 * Plain data and strings only: no MCP SDK types, since the two servers run different SDKs
 * (`uplink-mcp` on Node, the connector in Convex's runtime).
 */

/** A Room API function as `GET /api/v1/functions` lists it (and as the backend's catalog holds it). */
export type RoomFunctionInfo = {
  name: string;
  kind: "query" | "mutation";
  /** `run` functions (`joined.*`) take only a joined run's token (ADR 0032); neither server lists them. */
  realm?: "team" | "account" | "pair" | "run";
  description: string;
  scope: string;
  inputSchema: Record<string, unknown>;
};

/** One MCP tool definition, as both servers send it in `tools/list`. */
export type RoomTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean };
};

/** MCP tool names can't safely contain dots: `tasks.create` is the tool `tasks_create`. */
export function toolName(fn: string): string {
  return fn.replaceAll(".", "_");
}

/**
 * The tool for one Room API function. A team function's description ends with the scope an agent
 * key needs; `lacking` (from the key's scopes) adds that the key lacks it and who can add it, so
 * an agent knows before it calls. The room still checks every call.
 */
export function roomTool(fn: RoomFunctionInfo, lacking?: { addedBy?: string }): RoomTool {
  const lacks = lacking ? `; your key lacks it${lacking.addedBy ? `, and ${lacking.addedBy}, who added you, can add it` : ""}` : "";
  return {
    name: toolName(fn.name),
    description:
      fn.realm === "account"
        ? `${fn.description} (account: for the signed-in person, in no team)`
        : fn.realm === "pair"
          ? `${fn.description} (pair: in no team; an agent key needs the ${fn.scope} scope${lacks})`
          : `${fn.description} (scope: ${fn.scope}${lacks})`,
    inputSchema: fn.inputSchema,
    annotations: { readOnlyHint: fn.kind === "query" },
  };
}

/** A tool of `uplink-mcp` that isn't a Room API function: it uploads a local file for an attachment. */
export const UPLOAD_TOOL = "upload_attachment";
/** A tool of `uplink-mcp` that isn't a Room API function: it types a command into a terminal and waits for its output. */
export const RUN_TOOL = "run_in_terminal";
/** A tool of `uplink-mcp` that isn't a Room API function: it waits for a terminal to end and returns its output. */
export const WAIT_TOOL = "wait_for_terminal";
/** A tool of `uplink-mcp` that isn't a Room API function: it calls runs.changes until a run you follow changes state. */
export const RUNS_WAIT_TOOL = "wait_for_runs";

/** Parts of the orientation that read the same for an agent and for a person's own agent. */
const CHAT = `- Chat: channels_list lists team channels, private channels you're in and your direct messages, with unread counts. messages_list {channelId} returns its last 100 messages, oldest first, without replies (pass cursor: null to page back from the newest); messages_replies {messageId} reads a thread (replyCount says which messages have one); messages_addressed lists what's addressed to you. Post with messages_post, and mention someone with <@memberId> in the body (memberIds from teams_members). channels_openDirect {memberIds} opens a direct message and returns its channelId, with warnings for each run in it whose output the whole team can see: show them to whoever is writing, since your first post there is refused with warning_required until you send it with acknowledgeWarning: true.`;

const TASKS = `- Tasks: tasks_board lists open tasks oldest first, each with its owner, createdBy (who made or assigned it), createdAt and state (not_started until its first run). You work on a task through a run. A task can wait for others (needs): tasks_createMany makes a plan of tasks that wait for each other, and tasks_queue starts a task on a machine by itself once everything it needs is closed. tasks_linkPullRequest shows a GitHub pull request's state, reviews and checks on the task. runs_changes returns the runs you drive or started whose state changed since a cursor, and runs_remind has a live run sent a message later, such as to check CI in 5 minutes.`;

const FINISHING = `- Finishing: post the result where the task or the person asked, with mentionedTasks [taskId] and mentionedRuns [runId] so it links to them; then tasks_keepRun {taskId, runId} closes the task with the run that did it, once the task's work is done: closing is final (nothing reopens a task), so if the result means more work on it, ask its owner first. While the task is open, more work on it, a re-run included, takes its taskId; only after tasks_keepRun is a re-run unfiled.`;

const CALLS = `- Calls: calls_live lists live calls; calls_join {channelId, callId} puts you in one at once, and people see you there right away (you needn't connect to LiveKit's media); calls_heartbeat every 20 s keeps you there; calls_leave.`;

const AGENT_START = `Uplink Room is your team's shared workspace, and you are a member of the team. Each tool is one Room API function (tasks_board is tasks.board); its description ends with the scope your agent key needs.

Start with members_me: your memberId, the person who added you (you can do at most what they can), and your key's scopes.`;

/** The terminals paragraph for an agent whose server has `run_in_terminal` and `wait_for_terminal` (uplink-mcp). */
const AGENT_TERMINALS_LOCAL = `- Terminals: a task's files are on one of the team's machines (machines_list), not where you run, and you work there through a terminal; your key's runs.start and terminals.drive scopes are your person's permission to work there. runs_start {machineId, harness: "shell", cwd, taskId} opens a terminal you drive (a leading ~ in cwd is that machine's home). Without taskId the run is unfiled: pass title so it has a name in the Inbox and runs_unfiled. ${RUN_TOOL} types a command and returns what it printed (finished says whether it's done); terminals_read reads more. Or pass command to runs_start to run one command line that ends on its own, in the person's own shell setup, then ${WAIT_TOOL} {terminalId} returns its output and exitCode once it ends. ${RUNS_WAIT_TOOL} waits until any run you follow changes state, so wait on several runs at once with it. Finish an interactive shell with ${RUN_TOOL} {terminalId, command: "exit 0"}: it returns once the terminal ends, with the run's state (done; a bare exit passes on the last command's code, so after a failing test it ends failed). runs_stop ends it stopped. Shells you open run with NO_COLOR=1, so test diffs read correctly as text. A live terminal holds one of the machine's slots, so end it when you're done. A personal machine that isn't your person's takes runs only at mostOpenAccess drive or open; at watch or suggest, runs_start there is refused with forbidden, so pick another machine.`;

/** The terminals paragraph for an agent on the remote connector, which has only Room API functions. */
const AGENT_TERMINALS_REMOTE = `- Terminals: a task's files are on one of the team's machines (machines_list), not where you run, and you work there through a terminal; your key's runs.start and terminals.drive scopes are your person's permission to work there, and a connector's key starts without them. runs_start {machineId, harness: "shell", cwd, taskId} opens a terminal you drive (a leading ~ in cwd is that machine's home); without taskId pass title. terminals_input types into it and terminals_read reads what it printed. A live terminal holds one of the machine's slots, so end it when you're done (runs_stop).`;

const AGENT_INBOX_AND_ERRORS = `- Inbox: inbox_get {view: "person"} is the Inbox of the person who added you: use it for "my Inbox". inbox_get {} is your own: the runs you drive or that were given to you, working and done but not settled. Read it when asked what you're working on; don't answer from memory. A run given to you on a task starts unknown until you report: runs_report {runId, state} with working, waiting (message is your question), done or failed, and a message for its status line; runs_get {runId} reads the run and any replies.

Errors start with a code: forbidden (your key lacks a scope, and the message says who can add it, or you lack the right; a tool whose scope your key lacks says so in its description), not_found, invalid (the message says what to pass), conflict (it changed since you read it: read it again), no_free_slot (every slot on the machine is in use: end a terminal you started, which the message names, or ask whoever the machine belongs to), warning_required (the direct message's run shows what it hears to people outside it, as the message says: tell whoever is writing, then post again with acknowledgeWarning: true), unauthenticated (the key is wrong or revoked: ask the person who added you for a new one).`;

/**
 * What an agent reads before its first call (MCP `instructions`) in `uplink-mcp`: how the room's
 * pieces fit, in the order an agent usually needs them. Tool names here are Room API contracts (ADR 0003).
 */
export const INSTRUCTIONS = `${AGENT_START}

${CHAT}
${TASKS}
${AGENT_TERMINALS_LOCAL}
${FINISHING}
${CALLS}
${AGENT_INBOX_AND_ERRORS}`;

/**
 * The same orientation for an agent on the remote connector (ADR 0028): a hosted assistant whose
 * person approved it in the app. It has the Room API's functions and none of `uplink-mcp`'s local tools.
 */
export const CONNECTOR_INSTRUCTIONS = `${AGENT_START}

${CHAT}
${TASKS}
${AGENT_TERMINALS_REMOTE}
${FINISHING}
${CALLS}
${AGENT_INBOX_AND_ERRORS}`;

/**
 * The same orientation for a person's own agent, when `uplink-mcp` runs with their CLI sign-in
 * (ADR 0030): every call is the person's, in any of their teams, with no scopes.
 */
export const PERSON_INSTRUCTIONS = `Uplink Room is a shared workspace. You act as the person signed in on this computer with \`uplink login\`: every call is theirs, with their rights in each of their teams. Each tool is one Room API function (tasks_board is tasks.board).

Start with people_me: who they are, and their teams, each with its teamId. A tool whose description ends with "(account: ...)" or "(pair: ...)" works in no team (pairs_* are the person's Pairs with people outside their teams); every other tool acts in one team: pass teamId, which can be left out when they're in exactly one. members_me {teamId} is their memberId and role in that team.

${CHAT}
${TASKS}
- Terminals: a task's files are on one of the team's machines (machines_list), not where you run, and you work there through a terminal. runs_start {machineId, harness: "shell", cwd, taskId} opens a terminal you drive (a leading ~ in cwd is that machine's home); without taskId pass title. ${RUN_TOOL} types a command and returns what it printed (finished says whether it's done); terminals_read reads more. Or pass command to runs_start to run one command line that ends on its own, then ${WAIT_TOOL} {terminalId} returns its output and exitCode. ${RUNS_WAIT_TOOL} waits until any run you follow changes state. Those find the terminal's or run's team themselves; ${UPLOAD_TOOL} takes teamId as the team tools do. Finish an interactive shell with ${RUN_TOOL} {terminalId, command: "exit 0"}. A live terminal holds one of the machine's slots, so end it when you're done. Someone else's personal machine takes runs only at mostOpenAccess drive or open.
${FINISHING}
${CALLS}
- Inbox: inbox_get {} is the person's Inbox: their tasks' runs that need them, are working, or are done. Read it when asked what they're working on; don't answer from memory.

Errors start with a code: forbidden (they can't do that in this team, or aren't in it), not_found, invalid (the message says what to pass, such as teamId), conflict (it changed since you read it: read it again), no_free_slot (every slot on the machine is in use), warning_required (the direct message's run shows what it hears to people outside it, as the message says: tell the person, then post again with acknowledgeWarning: true), unauthenticated (the sign-in expired or was revoked: the person runs \`uplink login\` again).`;
