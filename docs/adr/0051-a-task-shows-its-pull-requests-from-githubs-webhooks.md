---
status: accepted
---

# A task shows its pull requests from GitHub's webhooks

Vercel Board's GitHub sync (2026-11-18, [Sync](https://vercel.com/docs/board/concepts/sync)) puts a pull request's state on its thread as labels, such as `state=merged` and `review=approved`, so an agent can wait for an approval without asking GitHub. Uplink Room's GitHub App only listed repos (ADR 0020). A person looking at a task couldn't see whether its pull request merged or its checks passed, and an agent had to call GitHub itself.

## Decisions

- **A task links pull requests** (`tasks.linkPullRequest`, up to 10 per task, a `taskPullRequests` row) by `owner/name#123` or URL, only in a repo the team connected. The row keeps GitHub's id for the repo, which survives renames, and the installation the team reaches it through. Once the team disconnects that account, or the repo leaves it, nothing reaches the row any more.
- **Linking reads the pull request once** (`githubSync.readPullRequest`, with an installation token): its state, title, head commit, each reviewer's reviews and the head commit's check suites. The read is folded in field by field, as webhooks are, so a webhook that landed while it was asking GitHub keeps what it said. The room reads it again when its head commit changes (a suite may have finished first, and a fork's names no pull request) and when two deliveries carry the same `updated_at` but say different things.
- **Late deliveries change nothing.** GitHub doesn't promise webhook order, so each change carries GitHub's own time: a pull request's `updated_at`, a review's `submitted_at` and id, a check suite's `updated_at`. A dismissed review stays marked dismissed, so its own submission delivered late doesn't bring the approval back. Check suites are kept per suite (GitHub Actions runs one per workflow) and per commit, and the task shows those on its head. A fork's suite names no pull request; it is matched by its commit.
- **Webhooks keep it current:** `pull_request` (open, draft, merged or closed, title, head commit), `pull_request_review` (approved or changes requested replace a reviewer's earlier decision, a dismissal removes it, a comment changes nothing) and `check_suite` (status and conclusion per app and commit). Only deliveries from the row's own installation change it, so another account's repo with the same name changes nothing.
- **The task shows each one** (`pullRequests` on the task card): state, `review` (changes_requested, approved or none), `checks` (failing, pending, passing or none), with the details, in the API and the app's task panel.
- **The App asks for Pull requests (read) and Checks (read)** and subscribes to those three events (`scripts/github-app.ts`). GitHub's docs: each of `pull_request` and `pull_request_review` needs "at least read-level access for the "Pull requests" repository permission", and `check_suite` needs "at least read-level access for the "Checks" permission", which receives the `completed` action ([Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)).

## Considered options

- **Board's full two-way sync with GitHub, Slack and Linear.** Board's docs spend a section on the data spills it causes ("A synced channel is as readable as the platform channel it syncs with"). Reading state in is the part a task needs.
- **Linking pull requests by a task id in the branch name or description.** It guesses, and a wrong guess shows another task's work.

## Consequences

- An App registered before this change has neither permission: its owner accepts the new permissions on GitHub (Settings, GitHub Apps), and until then a link shows the error from GitHub's refusal.
- Commit statuses (the older Statuses API) aren't read: checks show only check suites.
