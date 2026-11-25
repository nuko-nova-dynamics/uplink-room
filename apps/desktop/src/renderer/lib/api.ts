import type { FunctionReturnType } from "convex/server";
import { api } from "@uplink-room/backend/api";

export { api };
export type { Id } from "@uplink-room/backend/dataModel";

export type InboxData = FunctionReturnType<typeof api.inbox.get>;
export type InboxRow = InboxData["needsYou"][number];
export type RunView = InboxRow["runs"][number];
/** A task proposed from a call, waiting in the Inbox for a yes or a no. */
export type InboxProposal = InboxData["proposals"][number];
export type TaskCard = FunctionReturnType<typeof api.tasks.board>[number];
export type MemberRow = FunctionReturnType<typeof api.teams.members>[number];
export type MachineRow = FunctionReturnType<typeof api.machines.list>[number];
export type TerminalRow = FunctionReturnType<typeof api.terminals.list>[number];
export type ProjectRow = FunctionReturnType<typeof api.projects.list>[number];
export type ChannelRow = FunctionReturnType<typeof api.channels.list>[number];
export type MessageRow = FunctionReturnType<typeof api.messages.replies>[number];
export type AddressedRow = FunctionReturnType<typeof api.messages.addressed>[number];
export type SearchResult = FunctionReturnType<typeof api.messages.search>["results"][number];
export type UnfiledRow = FunctionReturnType<typeof api.runs.unfiled>[number];
export type RosterRow = FunctionReturnType<typeof api.teams.roster>[number];
export type FileRow = FunctionReturnType<typeof api.files.list>[number];
export type FileView = FunctionReturnType<typeof api.files.get>;
export type CommentThread = FunctionReturnType<typeof api.comments.list>[number];
export type MyTeam = FunctionReturnType<typeof api.teams.mine>[number];
export type Access = "watch" | "suggest" | "drive" | "open";
export type RunState = RunView["state"];
export type Character = NonNullable<MemberRow["character"]>;
