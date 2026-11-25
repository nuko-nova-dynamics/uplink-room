# Uplink Room

The team layer above the tools that already run agents. It holds people and agents, channels and calls, tasks and their runs, optional projects, and each person's Inbox.

## Language

### Team and projects

**Team**:
The top level of Uplink Room. It holds the people, agents, channels, projects and machines.
_Avoid_: Workspace, org

**Admin**:
A team member, person or agent, who can change settings that belong to the team, such as channels, invites, and a team machine's slots and access. A team keeps at least one person who is an admin: when its only one deletes their account, the person who has been in it longest becomes one (ADR 0035).
_Avoid_: Owner, moderator

**Project**:
An optional group of tasks inside a team, with exactly one channel of its own. It lists the repos its work touches.
_Avoid_: Board (that is the view), T3 Code project (that is a Repo)

**Channel**:
A place in a team for chat and calls. Each project has one; other channels belong to no project. A team channel is open to the whole team; a private channel only to its members.
_Avoid_: Room, chat

**Private channel**:
A channel outside any project that only its members, people or agents, can see, find, read or join a call in, team admins included (ADR 0016). Whoever creates it is its first member; any member can add teammates or agents, and anyone can leave; its creator and admins who are members can remove members. It stays private, and a team channel can't become one.
_Avoid_: Secret channel, locked channel, group, direct message (that has fixed members and no name)

**Direct message**:
A channel with a fixed set of 2 to 10 members, people, agents or live runs, outside any project, that only they can see, list or join a call in (ADR 0015). It has no name; the app shows its members' names. Starting one with the same members opens the one they have. A run it was opened with hears every message in it; when people outside it can see the run's output, such as the whole team for a team run, it says so before anyone writes (ADR 0039).
_Avoid_: DM in the app's text (fine in code and chat), private channel (that has a name and its members can change), conversation, thread

**Pair**:
A private conversation of 2 to 10 joined runs and agents, plus their people, who may be in different teams or in none, made with pair codes. Each side sees only the conversation: names, pictures and run labels, never an email or the other's team. Everyone in it is signed in to Uplink Room, an agent through its agent key and the person accountable for it, and the people can read and write in it too. It belongs to its people, not its runs: when a run ends, its person's next run can rejoin, and it lasts until one of them ends it. A person can also make one, join one with a code, or leave one in the app; a Pair left with one person ends (ADR 0027, ADR 0029 D9 to D13, ADR 0034, ADR 0036).
_Avoid_: Session, link, connection, cross-team direct message, T3 Code pairing (that is the bridge's sign-in to T3 Code)

**Pair code**:
A short code, such as RIVER-4821-MAPLE-0937, that a run in a pair (or one of its people) makes and its person passes on, so one more run, agent or person can join. It works once and expires after 10 minutes; the room keeps only its hash, and a person who tries 10 wrong ones in an hour can't use any until the hour is over (ADR 0034).
_Avoid_: Invite code, token, number

**Call**:
A voice or video conversation held in a channel. Tasks made from it go to that channel's project.
_Avoid_: Meeting, huddle

**Voice**:
The sidebar's list of channels as rooms to talk in. Joining a room joins its call, and starts it when nobody is in it, so the app never offers "start a call".
_Avoid_: Voice channel (a channel holds both chat and calls), lobby

**Custom status**:
A short line a member sets about what they're doing, such as "Reviewing PRs", shown beside their name in People. Up to 80 characters; the Room API calls it `members.setStatus`.
_Avoid_: Status on its own (that is a run's state), mood, away message

**People**:
The panel beside a channel that lists everyone it reaches, grouped Online, Agents and Offline, with what each is doing.
_Avoid_: Member list, user list

**Call invite**:
Asking a team member, usually an agent such as the Notetaker, to join a call in progress. It clears when they join or the call ends.
_Avoid_: Summon, dispatch, ring

**Voice quality**:
How a channel's calls send voices: Standard (the default, for talking), High, or Music (stereo, with noise suppression off). One setting per channel or direct message, for everyone in its calls (ADR 0017).
_Avoid_: Bitrate (that's one part of it), audio mode

**Share quality**:
The size and frame rate a screen share is sent at, picked when sharing starts: Sharp, Balanced (the default), Smooth, Smooth HD, or Source at 30 or 60 fps (ADR 0017).
_Avoid_: Resolution (that's one part of it), stream preset

**Call quality limit**:
The highest voice and share quality a team allows, set by its admins, since LiveKit Cloud bills calls by bandwidth. The app shows "Highest call quality allowed".
_Avoid_: Ceiling, cap, plan

**Transcript**:
What was said in a call, one line per utterance with who said it. Kept for 30 days after the call ends.
_Avoid_: Recording (no audio is kept), captions

**Call notes**:
A summary of a call, posted in its channel when the call ends.
_Avoid_: Minutes, recap

**Proposed task**:
A task an agent or person suggests from a call. It becomes a task, Not started, in the channel's project only when a team member accepts it.
_Avoid_: Draft task, suggestion (that is a command proposed in a terminal, or a message proposed in a thread), action item

**Agent**:
A team member that is not a person, such as Hermes, OpenClaw, a deploy bot, a notetaker, or an MCP client. Every agent is added by a person, who is accountable for it, and can do at most what that person can.
_Avoid_: Bot, assistant, and using it for Claude Code or Codex (those are Harnesses)

**Agent key**:
The credential an agent uses to act through the Room API. An agent can have several, each with its own scopes.
_Avoid_: Bot token, API key, personal access token

**CLI sign-in**:
A person signed in on one computer's command line with `uplink login`, through Clerk in the browser. It lets the `uplink` tool and `uplink-mcp` on that computer act as the person, in any of their teams or in none. It lasts 30 days, until `uplink logout`, or until the person revokes it; `people.signIns` lists each one (ADR 0030).
_Avoid_: Session (that is a harness's session, as in a joined run), session token, personal access token, agent key (that is an agent's)

**Deleted account**:
A person whose Clerk account was deleted, which Clerk tells the room through its signed `user.deleted` webhook. Nothing acts as them from that moment. They leave every team and Pair they were in, their CLI sign-ins and joined runs end, their personal machines are unlinked, also in teams they had already left, and what they wrote in Pairs and teams shows as "A deleted account" (ADR 0029 D10, ADR 0035). Leaving a team is not this: it changes nothing about a person's Pairs.
_Avoid_: Removed member (someone an admin took out of one team), closed account

**Connector**:
A hosted assistant (Grok Bot, ChatGPT dots, Meta Muse, Claude Duet) or other remote MCP client that a person added in its own settings with the room's MCP address (`/mcp`) and signed in to with Clerk. It waits until that person approves it in the app, choosing its team, name and scopes; then it is an agent the person is accountable for, acting through an agent key nobody sees. `connectors.list` lists a person's connectors (ADR 0028, ADR 0031).
_Avoid_: Integration, plugin, app, remote MCP server (that is the room's side)

**A2A endpoint**:
An agent's own gateway, such as a Hermes or OpenClaw gateway, where the room sends it work over A2A. The person accountable for the agent, or an admin, connects it (ADR 0012).
_Avoid_: Peer, A2A server (the room has none yet), webhook

**Endpoint token**:
The token the room sends an agent's A2A endpoint so the gateway takes its work. It is not an agent key: an agent key lets the agent act in the room, while an endpoint token lets the room send the agent work. Nobody can read it back; the app shows its last four characters.
_Avoid_: Agent key, API key, A2A key

**Routine webhook**:
Where the room reaches Grok Bot: the URL and key of one of its routines, which a person sets on the agent. Each message that reaches the agent is POSTed there, and the message shows a delivery record (sent, or failed with the reason), not a run, since the room can't follow the routine's run. The key is kept like an endpoint token (ADR 0033).
_Avoid_: Hook, callback, A2A endpoint

**Checks in on its own schedule**:
What the app says of an agent that joined through a connector and has no A2A endpoint or routine webhook, such as dots, Muse or Duet: the room can't reach it, so a message to it waits until it reads the place, then shows Seen (ADR 0033).
_Avoid_: Offline, asleep, polling

**Scope**:
A limit on one agent key that narrows what the agent's role allows, such as "post messages" or "invite people".
_Avoid_: Permission (that is what a role grants)

**Channel limit**:
The channels one agent key may read and post in, when its person sets them; it then sees no other channel, and only those channels' projects' tasks (ADR 0049).
_Avoid_: Grant, allowlist, sandbox

**Approval**:
A run's request for a yes before it does something, such as running a command or deploying. A person answers it, or an agent whose key holds the Answer approvals scope.
_Avoid_: Permission request, confirmation, prompt

**Room API**:
The one public set of functions for everything in Uplink Room. The desktop app, agents over MCP and HTTP, and the command-line tool all use it, so no action is app-only. Most functions act in one team; account functions (`people.*`) act for a signed-in person in no team, and agent keys can't call them (ADR 0030).
_Avoid_: Bot API, private endpoint

### Work

**Task**:
A piece of work owned by one person. It may belong to a project, and it can exist before its first run.
_Avoid_: Card (the UI element that shows a task), ticket, issue

**Needs**:
The tasks a task waits for. A queued task starts only once each task it needs is closed (ADR 0050).
_Avoid_: Dependencies, blockers, prerequisites

**Queued task**:
A task waiting in a machine's queue: once every task it needs is closed, the room starts a run for it there, as whoever queued it, when the machine has room (ADR 0050).
_Avoid_: Scheduled task, claimed task, job

**Board column**:
Where a task sits on a project's board, from its runs: Not started (no run yet), Needs someone (a run is Waiting or Failed), Working (a run is Working or Unknown) or Done (every run Done or Stopped, or every run finished and the task settled, until one of its runs changes state again). Needs someone is for anyone to look at; the Inbox's Needs you is only the runs waiting on you.
_Avoid_: Status, lane

**Closed task**:
A task whose owner, or an agent for them, kept one of its runs (`tasks.keepRun`). It leaves the board, shows Done in the Inbox whatever the kept run's state, and gets no new runs: later work on it is an unfiled run.
_Avoid_: Archived, resolved, settled (settling is for the Inbox)

**Run**:
One agent working on one task, or on none yet (an unfiled run), through one thread, terminal, Space, or agent conversation. A task can have several runs side by side. While it is live, a run can be mentioned and post messages as itself, named by its harness and driver, such as Claude Code (Julio); its driver at the time answers for what it says. A run can be given to an agent the room can't follow over A2A (a webhook, check-in or key-only agent), which reports on it itself (ADR 0044).
_Avoid_: Attempt, job, session

**Agent conversation**:
Talking with an A2A agent in one place: a channel's top level, a thread, or a direct message, and a run on a task has its own. The room keeps the agent's A2A context for it, so each message continues it: on the agent's open task, or as a new run in the same context once that task finished. The agent answers in the same place, as its own messages (ADR 0024).
_Avoid_: Session, chat (that is the place), thread (a T3 Code thread, or the replies under a message)

**Thread proposal**:
An A2A agent's ask to move its work to the replies under the message that started it, shown with Yes and No and counting as Yes after 30 seconds. On Yes the agent's conversation goes on there (ADR 0024).
_Avoid_: Thread request, fork

**Stop following**:
For a run sent to an A2A agent whose gateway can't cancel: the room stops watching it without asking the agent to stop. The run shows Unknown, because the agent may still be running it. The Room API calls this `runs.detach`.
_Avoid_: Detach (in the app), abandon, cancel

**Unfiled run**:
A run that no task points at yet, such as a thread someone started straight in T3 Code.
_Avoid_: Orphan, loose run

**Reminder**:
A message a run's driver, or an agent of theirs, sets to reach the run later (runs.remind), such as "check CI in 5 minutes". It is posted where they named, addressed to the run.
_Avoid_: Schedule, follow-up, wake-up

**Joined run**:
A run whose session joined the room by itself, with the `uplink` command-line tool, skill or MCP server, as its signed-in person: no bridge or app needed. It has chat only, with no terminal or thread view, and ends when its session does, when it leaves, or when its heartbeat stops. It acts with its own run token (ADR 0032). One that joined with no team can only pair (ADR 0029 D13). It starts closed: only its person and their agents see it or message it, until its person opens it to the team (ADR 0044).
_Avoid_: Guest run, external run, session, unfiled run (that is a run with no task)

**Run token**:
The token a joined run acts with (`urj_…`), one per join, made with its person's CLI sign-in for one harness session. It only reads that run's messages, posts as the run and keeps it live, and stops working when the run ends or the sign-in does (ADR 0029 D8, ADR 0032).
_Avoid_: Run key (a T3 Code thread run's short-lived key), session token, agent key

**Run key**:
The short-lived key a run in a T3 Code thread posts with (`urt_…`): its bridge puts a new one in the last lines of each delivery of messages into the thread, and `uplink-bridge say` and `reply` give it with `--key`. It posts only as that thread's run, works while the thread's turn runs and for an hour after, 12 hours at most, and never reaches the room (ADR 0029 D7, ADR 0037).
_Avoid_: Run token (a joined run's), terminal secret, agent key

**Owner**:
The person accountable for a task. Always a person, never an agent. Whoever made the task, or assigned it to its owner, is its creator (`createdBy`): "who assigned it" means the creator, not the owner.
_Avoid_: Assignee (giving a task to an agent starts a run for it, and the owner stays), delegate, and using it for machines (a machine "belongs to" someone)

**Driver**:
Whoever is steering a thread, terminal or shared browser right now: a person or an agent. The app shows it as "In control" ("You're in control", "Ana is in control"). Driver stays the internal and API name.
_Avoid_: Delegate, controller, and "driving" or "driven by" in the app's text (say "in control" or "controlled by")

**Passing the wheel**:
Making someone else the driver of a thread, terminal or shared browser. The app shows it as "Hand off" ("Hand off to" a person). Taking it is "Take control", asking is "Ask for control". Passing the wheel stays the internal and API name.
_Avoid_: Takeover, and "the wheel", "Pass the wheel", "Take the wheel" in the app's text

**Inbox**:
One person's view of their work in three sections: Needs you (runs waiting on that person), Working, and Done (finished work not yet settled). A waiting run goes to its driver's Inbox.
_Avoid_: Home, notifications, activity

**Link**:
The agent from the roster that a person picks for their Inbox to talk to. What they write in the Inbox goes to it in a direct message, and it answers or starts the work itself: it makes the task and starts the run. Each person picks their own, or none, and then the Inbox's box starts a thread. Link is also the character that speaks the Inbox's own lines ("3 things need you.").
_Avoid_: Assistant, front desk, router, bot

**Inbox zero**:
An Inbox with nothing in Needs you and nothing left to settle in Done. Runs may still be Working.
_Avoid_: All clear, empty inbox

**Run state**:
Where a run stands: Working, Waiting (it needs its driver), Done, Failed, or Stopped (someone ended it). A run shows Unknown when the room can't tell, such as a plain shell's run while it's live, or a run sent to an A2A agent whose delivery wasn't confirmed or that the room stopped following; Unknown sits with Working. A run in a plain shell or a Space, where no tool reports a state, is labelled Live in the app while its terminal or Space is open. A task shows the most urgent state among its runs, in the order Waiting, Failed, Working, Done, Stopped. A run sent to an A2A agent shows the state the agent reports, and shows Stopped only once the agent confirms it canceled. A run given to an agent that reports on it itself shows Unknown until the agent first reports.
_Avoid_: Status, phase

**Settle**:
To put finished work away so it leaves the Inbox, by hand or by a rule such as a merged pull request or some idle days (auto-settle). Settled work stays findable, and it comes back to the Inbox if one of its runs changes state again.
_Avoid_: Archive, dismiss, close

**Roster**:
The team's agents and running harnesses, listed under the Inbox. Each avatar shows the most urgent state among that agent's runs, or idle when it has none.
_Avoid_: Bot list, agent directory

**Snooze**:
To hide a task or run from the Inbox until a set time or an event, such as its pull request changing.
_Avoid_: Defer, remind me

### Where agents work

**Harness**:
The tool that runs a thread or a terminal run, such as Claude Code, Codex, Grok Build, Cursor, OpenCode, or Hermes Agent. A run in a plain terminal has none; the Room API names that `shell`, and any other CLI agent runs there: start a shell and type its command. Hermes Agent is a harness when its CLI (`hermes`) runs in a terminal, and an agent when the team sends it work over A2A.
_Avoid_: Agent, provider

**Thread**:
A T3 Code agent conversation, run by one harness in one repo.
_Avoid_: Chat, conversation, and using it for a chain of chat messages (those are Replies)

**Thread view**:
One person's view of a thread in the room: its messages, tool calls, plans, requests and diffs, as T3 Code has them, while its bridge follows it (ADR 0022). The room keeps the newest part; older parts come from the machine on request.
_Avoid_: Transcript (that is a call's), conversation, chat

**Reply**:
A chat message that answers another message in a channel.
_Avoid_: Thread

**Repo**:
A code repository that runs work in. T3 Code calls this a project.
_Avoid_: Project

**Connected GitHub account**:
A GitHub organization or personal account where the room's GitHub App is installed and that someone connected to the team: an admin who owns the organization on GitHub, or any person in the team for their own personal account. It gives the team all of the account's repos or the ones picked on GitHub. An organization is the team's; a personal account stays its person's, and is disconnected when they leave the team (ADR 0020).
_Avoid_: Integration, installation (GitHub's word for the App's place on the account), linked account

**GitHub connect**:
One attempt to connect a GitHub account: a person chooses Connect in Settings, installs the App and signs in on GitHub, then confirms in Uplink Room which account GitHub listed to connect. Only the person who started it can confirm it, it expires after 30 minutes, and it's cancelled if they leave the team or, having started it as an admin, stop being one (ADR 0020).
_Avoid_: Connect link (the link is only its browser part), flow, request

**Synced repo**:
A repo a connected GitHub account gives the team. The room keeps its name, default branch, and whether it's private or archived up to date, and the repo pickers offer it. A project can also list repos that aren't synced; they show as not connected.
_Avoid_: Linked repo, imported repo, GitHub project

**Machine**:
Any computer, local or in the cloud, linked to the team through a bridge. It belongs to one person or to the team.
_Avoid_: Computer, host, environment, cloud runner

**Personal machine**:
A machine that belongs to one person. That person decides what teammates may do on it, including whether they may start runs there (ADR 0025).
_Avoid_: My computer, private machine

**Team machine**:
A machine that belongs to the team.
_Avoid_: Shared computer, server

**Cloud machine**:
A team machine whose computer the room rents and starts and stops itself: today a Linux box on Vercel Sandbox in `iad1`. It keeps its disk, settings and profiles while stopped, starts when a terminal or run needs it, and stops after 15 minutes with no live work. Its bridge starts again on every boot.
_Avoid_: Sandbox (Vercel's word for what it runs on), VM, cloud box, cloud runner, server

**Wake**:
Starting a stopped cloud machine because work needs it: a terminal, a run, or a profile to create or delete. The work waits until the machine's bridge is back, then goes on.
_Avoid_: Resume (nothing resumes; only the disk is kept), boot

**Idle stop**:
Stopping a cloud machine once it has had no live work for 15 minutes: no live or starting terminals, no shared Spaces, no thread runs Working or Waiting, and nothing queued for its bridge. Its disk is kept; the runs that were going there don't come back.
_Avoid_: Suspend, hibernate, pause, sleep

**Bridge**:
The Uplink Room program on a machine. It shares that machine's terminals with the room and drives the tools running there.
_Avoid_: Agent, daemon, relay

**T3 Code pairing**:
The bridge's sign-in to T3 Code on its machine, which lets the room follow and drive that machine's threads. It ends after 30 days, or when someone revokes it in T3 Code, and the machine then needs pairing again (ADR 0021).
_Avoid_: T3 token, T3 session (T3 Code's own word for it), linked environment (T3 Code's link between two of its servers)

**Terminal**:
A live shell on a machine that the bridge shares with the room. It may run a harness, a multiplexer such as tmux or herdr, or anything else.
_Avoid_: Session, console

**Rex tab**:
A tab in Rex, the terminal app, whose program runs through the bridge (`uplink-bridge rex-host`), so the room can show it as a terminal while the person keeps using it in Rex. Whoever the machine belongs to shares one, or a run starts in one ("In Rex"). A tab opened in Rex directly isn't one, and can't be shared (ADR 0019).
_Avoid_: Rex window or block (Rex's own words for a tab and a pane), Rex session (a group of tabs)

**Access**:
How much teammates may do in a terminal, thread or shared browser: View (see it), Suggest (propose commands, messages or URLs the driver sends), Ask for control (one person is in control, others ask them for control) or Take control (anyone takes control, one at a time). Teammates can View, Suggest, Ask for control or Take control. The internal and API names are watch, suggest, drive and open. Whoever starts it picks the level, up to the most open level the machine (for a terminal or thread) or the team (for a shared browser) allows (ADR 0021). On a personal machine, that most open level also decides who may start runs there: at View or Suggest only the person it belongs to and their agents, at Ask for control or Take control teammates too (ADR 0025).
_Avoid_: Permissions, sharing mode, and the old level names Watch, Drive and Open in the app's text, T3 Code's access levels (Supervised to Full access decide what the agent may do, not teammates: that is the permission mode)

**Permission mode**:
What the agent in a run may do without asking: Ask before acting, Edit files without asking, Approve safe steps itself or Full access. The internal and API names are T3 Code's runtime modes: approval-required, auto-accept-edits, auto and full-access. Whoever starts a run picks it, a thread's driver can change it, and whoever the machine belongs to caps it (ADR 0043). A run that names none asks before acting.
_Avoid_: Access (that is what teammates may do), sandbox, YOLO mode, and T3 Code's own labels (Supervised for approval-required) in the app's text

**Slot**:
One terminal that a teammate or an agent may start on a machine without asking: on a personal machine only while it allows Ask for control or Take control, and never for the person it belongs to, whose own terminals use none. Whoever the machine belongs to sets how many there are.
_Avoid_: Seat, quota

**Machine setup**:
The logins (or CLI proxy), settings and skills a machine already has. A terminal uses it unless someone picks a profile.
_Avoid_: Default profile, base config

**Profile**:
One person's own logins, settings and skills on a single machine, kept apart from the machine setup for as long as that person chooses, up to the limit set by whoever the machine belongs to.
_Avoid_: Environment, home, workspace

**Space**:
A Cua desktop on a machine (a container, a VM, or the machine's own screen) that the bridge shares with the room. Like a terminal, it has an access level and at most one driver.
_Avoid_: Desktop, session, sandbox (Cua's word for what a Space runs in)

**Space gateway**:
The bridge's door to the Spaces on its machine. Each viewer's connection to a Space goes through it, so the bridge can close that connection at once when the person's access changes.
_Avoid_: Proxy, relay (Cua's relay is something else)

**Space view**:
One person's open view of a Space, at their access: watch-only for everyone except the driver. Opening a Space asks its bridge for one; it closes when the person leaves or the wheel moves.
_Avoid_: Stream, session, viewer ticket (Cua's credential behind a Space view)

**Space action**:
One step an agent takes in a Space through the Room API: a screenshot, a click, a key, typed text or a scroll. Only the Space's driver can take one, and each is recorded with who took it.
_Avoid_: Command, tool call

**Shared browser**:
A cloud browser that people in a channel use together, started on demand and ended when idle. It has an access level and one driver, like a terminal. It is temporary, keeping nothing after it ends, unless whoever starts it keeps its logins as saved logins.
_Avoid_: Cobrowser, Hyperbeam session, and using it for T3 Code's browser tabs (where agents browse on their own)

**Saved logins**:
A named set of a shared browser's cookies, passwords, history and bookmarks, such as "staging admin", that a channel keeps for 1 day, 7 days, 30 days or until someone forgets them. A shared browser started with them is already signed in, and saves new logins back to them when it ends. They are one item, named in the plural: "the saved logins".
_Avoid_: Profile (that is one person's logins on a machine), Hyperbeam profile, session, cookie jar

**Forget**:
To stop shared browsers loading saved logins, by hand or when their time runs out. Once the last browser with them has ended, the room erases them at Hyperbeam by saving an empty browser over them.
_Avoid_: Delete, clear, revoke

### Chat

**Mention**:
Naming a team member or a live run in a message, `@Ana` in the app and `<@memberId>` in the Room API, so it counts for them and can send them a banner. A mentioned run gets the message while it works, as a message from whoever wrote it. **@everyone** mentions everyone in the channel, except those who set it to nothing. Agents can't use @everyone.
_Avoid_: Ping, tag

**Reaction**:
One emoji a member puts on a message, shown with how many reacted and who. A message has at most 20 different emoji.
_Avoid_: Emoji response, like

**Attachment**:
A file sent with a message: an image shown inline, a PDF opened in the PDF viewer, or any other file offered only as a download. It lives with its message and goes when the message is deleted, unless someone saved it into a project, where it becomes a File.
_Avoid_: Upload (that is the step before), file (that is kept in a project)

**Pinned message**:
A message pinned in its channel or direct message, so it is listed in the channel's Pinned panel. At most 50 per channel.
_Avoid_: Pinned comment (that is on a file), bookmark, starred message

**Link preview**:
The title, description and image of a page a message links to, fetched by the room, never by the app.
_Avoid_: Unfurl, embed, card

**Unread**:
The messages in a channel or direct message after the last one a member read. The app counts them, and how many of them are addressed to the member, and marks where they start with a "new" divider.
_Avoid_: New messages (that is the divider's label), notifications

### Files

**File**:
Something kept in a project for people and agents to read and work on together: a doc, a canvas, a PDF, an image, or an HTML page.
_Avoid_: Attachment (that is sent with a message, until someone saves it into a project), asset, upload

**Doc**:
A rich text file kept as Markdown. People edit it in the app; agents read and write the Markdown.
_Avoid_: Note, document, page (a page is part of a PDF, or an HTML page)

**Canvas**:
A file of shapes, arrows and text that several people and agents can draw on at once (Excalidraw).
_Avoid_: Whiteboard, drawing, board (that is a project's view of its tasks)

**Pinned comment**:
A comment fixed to a spot in a file: a position on a PDF page, a spot on an image, a quoted passage in a doc, or a point on a canvas. It can also be about the whole file. People and agents can reply to it and resolve it.
_Avoid_: Annotation, note, review comment

**Resolve**:
To mark a pinned comment as dealt with. It leaves the file's open comments but stays findable, and anyone can reopen it.
_Avoid_: Close, dismiss, settle (settling is for the Inbox)

**Detached comment**:
A pinned comment on a doc whose quoted passage is no longer in the doc. It keeps its quote until someone resolves it.
_Avoid_: Orphaned comment

### The app

**Release channel**:
Which stream of versions an installed app updates from: `latest` for releases everyone gets, `test` for builds checked before a release ships. A version's prerelease tag names it (0.2.1-test.1 is on test). See `docs/releases.md`.
_Avoid_: Channel on its own (that is a place for chat and calls), track, ring

**Test build**:
A version on the test release channel. It keeps its data apart from the released app and updates only to newer test builds.
_Avoid_: Beta, nightly, preview
