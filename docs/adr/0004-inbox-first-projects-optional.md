---
status: accepted
---

# Uplink Room opens to the Inbox, and projects are optional

Uplink Room opens to each person's Inbox: Needs you, Working and Done, across all of their work. Finished work leaves when it is settled by hand, settled by a rule (a merged pull request, some idle days) or snoozed. Projects are optional groups that work as filters and labels, not the tree you navigate, so a task can belong to no project. We chose this over a project-first sidebar (Slack and Discord style) so that each person sees what needs them, what is running and what is done, and can reach Inbox zero. The model follows T3 Code's inbox sidebar.

## Considered options

- A project tree sidebar, one team per window.
- A team rail plus the project tree, as in Discord.
- Opening to the last place you were.

## Consequences

- People who think in projects lose their default view. T3 Code saw the same pushback when it replaced its project sidebar with an inbox, and kept grouping by project as a Labs option ([discussion #7917](https://github.com/pingdotgg/t3code/discussions/7917)). The Inbox therefore keeps a group-by-project toggle and a project filter.
- Settled work has to stay easy to find (in its project, its channel and search), since the Inbox no longer shows it.
- The Inbox shows your own work by default, with a Team tab for everyone's, so it needs to know who owns each task and who drives each run (see Owner and Driver in `GLOSSARY.md`).
