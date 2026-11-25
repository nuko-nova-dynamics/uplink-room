/**
 * Scopes narrow what an agent key may do (GLOSSARY.md, "Scope").
 * People are never limited by scopes; their role decides.
 */
export const SCOPES = {
  "room.read": "Read the team's projects, tasks, runs, channels and machines",
  "messages.post": "Post messages and replies, and pinned comments on files",
  "work.manage": "Create and change projects, channels, tasks and files, and file runs",
  "runs.start": "Start and stop runs, including the terminals and T3 Code threads they open",
  "terminals.drive": "Drive terminals and T3 Code threads: type, send suggestions, set access, take or pass the wheel",
  "spaces.drive": "Drive Spaces: take Space actions, suggest, take or pass the wheel",
  "approvals.answer": "Answer runs' approvals, only as the person who added the agent could",
  "browsers.use": "Start, join and drive shared browsers, and end the ones it started or drives",
  "calls.join": "Start, join and leave calls, and ask others to join",
  "calls.notes": "Write a call's transcript and notes, and propose tasks from it",
  "people.invite": "Invite people and add agents",
  "pairs.join": "Join Pairs with a pair code, and read and write in them, with people and runs outside the team",
  "machines.manage": "Change machine settings and link or unlink machines",
  "team.admin": "Change team settings and make admins",
} as const;

export type Scope = keyof typeof SCOPES;

export const ALL_SCOPES = Object.keys(SCOPES) as Scope[];

/** New agents start with the smallest set (DESIGN.md, "Adding an agent"). */
export const DEFAULT_AGENT_SCOPES: Scope[] = ["room.read", "messages.post"];

export function isScope(value: string): value is Scope {
  return value in SCOPES;
}
