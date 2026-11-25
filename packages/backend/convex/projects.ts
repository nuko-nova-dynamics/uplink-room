import { v } from "convex/values";
import { roomError } from "./lib/errors";
import { audit, inTeam } from "./lib/members";
import { normalizeRepo } from "./lib/repos";
import { linkProjectRepos, MAX_PROJECT_REPOS } from "./github";

/** A project's repos, one spelling each, and at most MAX_PROJECT_REPOS of them. */
function projectRepos(repos: string[]): string[] {
  const list = [...new Set(repos.map(normalizeRepo))];
  if (list.length > MAX_PROJECT_REPOS) {
    throw roomError("invalid", `A project lists at most ${MAX_PROJECT_REPOS} repos; this would list ${list.length}.`);
  }
  return list;
}
import { roomMutation, roomQuery } from "./lib/room";

function channelName(projectName: string): string {
  return projectName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
}

export const { person: create, agent: createAgent } = roomMutation({
  name: "projects.create",
  description: "Create a project with its own channel. List the repos its work touches, up to 200.",
  scope: "work.manage",
  args: { name: v.string(), repos: v.optional(v.array(v.string())) },
  handler: async (ctx, actor, args) => {
    const name = args.name.trim();
    if (!name) throw roomError("invalid", "A project needs a name.");
    const channelId = await ctx.db.insert("channels", { teamId: actor.teamId, name: channelName(name) });
    const repos = projectRepos(args.repos ?? []);
    const projectId = await ctx.db.insert("projects", { teamId: actor.teamId, name, repos, channelId });
    await linkProjectRepos(ctx, actor.teamId, projectId, repos);
    await ctx.db.patch(channelId, { projectId });
    await audit(ctx, actor, "project.created", projectId, { name });
    return projectId;
  },
});

export const { person: list, agent: listAgent } = roomQuery({
  name: "projects.list",
  description: "List the team's projects that aren't archived.",
  scope: "room.read",
  args: { includeArchived: v.optional(v.boolean()) },
  handler: async (ctx, actor, args) => {
    const projects = await ctx.db
      .query("projects")
      .withIndex("by_team", (q) => q.eq("teamId", actor.teamId))
      .collect();
    return projects
      .filter((p) => args.includeArchived || p.archivedAt === undefined)
      // An agent key limited to some channels (ADR 0049) sees only their projects.
      .filter((p) => !actor.channelIds || actor.channelIds.has(p.channelId))
      .map((p) => ({
        projectId: p._id,
        name: p.name,
        repos: p.repos,
        channelId: p.channelId,
        archivedAt: p.archivedAt,
      }));
  },
});

export const { person: rename, agent: renameAgent } = roomMutation({
  name: "projects.rename",
  description: "Rename a project. Its channel and history stay.",
  scope: "work.manage",
  args: { projectId: v.id("projects"), name: v.string() },
  handler: async (ctx, actor, args) => {
    const project = await inTeam(ctx, actor, args.projectId);
    const name = args.name.trim();
    if (!name) throw roomError("invalid", "A project needs a name.");
    await ctx.db.patch(project._id, { name });
    await ctx.db.patch(project.channelId, { name: channelName(name) });
    return null;
  },
});

export const { person: setRepos, agent: setReposAgent } = roomMutation({
  name: "projects.setRepos",
  description:
    "Set the repos a project touches, up to 200. New runs offer them, and unfiled runs in them are suggested for this project. A repo a connected GitHub account gives the team (github.repos) is followed by GitHub's id, so a rename on GitHub renames it here.",
  scope: "work.manage",
  args: { projectId: v.id("projects"), repos: v.array(v.string()) },
  handler: async (ctx, actor, args) => {
    const project = await inTeam(ctx, actor, args.projectId);
    const repos = projectRepos(args.repos);
    await ctx.db.patch(project._id, { repos });
    await linkProjectRepos(ctx, actor.teamId, project._id, repos);
    return null;
  },
});

export const { person: archive, agent: archiveAgent } = roomMutation({
  name: "projects.archive",
  description: "Archive a project and its channel. Their history stays readable.",
  scope: "work.manage",
  args: { projectId: v.id("projects") },
  handler: async (ctx, actor, args) => {
    const project = await inTeam(ctx, actor, args.projectId);
    const now = Date.now();
    await ctx.db.patch(project._id, { archivedAt: now });
    await ctx.db.patch(project.channelId, { archivedAt: now });
    await audit(ctx, actor, "project.archived", project._id);
    return null;
  },
});
