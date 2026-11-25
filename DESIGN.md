# Uplink Room design

The design system for the Uplink Room desktop app. It was first settled over eight decision rounds on 2026-11-01 and 2026-11-02 (`design/rounds/`), then rebuilt on 2026-11-17 after Julio judged the app too close to Slack and Discord: Uplink is now a calm manager's desk for many agents, with Grok Bot's look and T3 Code's thread list as references. Where this file and an older round page disagree, this file wins. Product vocabulary comes from `GLOSSARY.md`; the hard-to-reverse choices are in `docs/adr/`.

## Principles

- **Take as little attention as possible.** As agents get better, one person runs many at once. Every screen is judged by how fast someone can see what needs them, decide it in place, and get back to zero. Only what needs a person is loud; everything else is gray or folded.
- **Decide where you read.** A decision (an approval, a question, finished work to settle) carries its answers with it, so it can be made without opening anything.
- **Inbox zero.** The app opens to your Inbox: what needs you, what is working, what is done. You settle finished work and get back to zero. Projects are optional groups, not the tree you navigate (ADR 0004).
- **Grok Bot's calm.** Neutral surfaces, soft fills instead of edges, pill controls, agents as characters; no Slack-style channel sprawl and no kanban.
- **The interface should ask less.** From Grok Bot's design write-up: show state on the agent itself, fold detail until someone wants it, and only interrupt for what needs a person.
- **Only live things move.** Motion means something is happening right now.

## Platforms

- Desktop app first (Electron, macOS and Windows), dark first.
- The Inbox card works at phone width, so a phone app can reuse it later.
- Answering the Inbox by text (iMessage, WhatsApp) comes later.

## Color

Neutral grays sampled from Grok Bot's own screens, in both themes, with no tinted surfaces. The primary action is a text-colored pill (white in dark, near-black in light); where you are is a soft gray fill with no edge; links are the one blue. Amber is the only loud state color and always means "needs you". Focus rings and the terminal cursor use the primary text color.

| Token | Dark | Light | Use |
|---|---|---|---|
| `ground` | `#121212` | `#FCFCFC` | Window background |
| `sidebar` | `#0E0E0E` | `#F5F5F5` | Sidebar |
| `raised` | `#1F1F1F` | `#FFFFFF` | Cards, pills, the composer, menus |
| `hover` | `#262626` | `#EFEFEF` | Row hover |
| `current` | `#212121` | `#E8E8E8` | Where you are, a chosen segment or option |
| `chip` | `#262626` | `#F0F0F0` | Secondary buttons, selects, filters |
| `line` | `#2C2C2C` | `#E6E6E6` | Hairlines |
| `text` | `#ECECEC` | `#1A1A1A` | Primary text |
| `muted` | `#A1A1A1` | `#666666` | Secondary text, read conversations |
| `faint` | `#8C8C8C` | `#707070` | Placeholders and step lines, at least 4.5:1 on every surface |
| `accent` | `#ECECEC` | `#1F1F1F` | The primary pill; `on-accent` is the ground on it |
| `accent-text` | `#6CB2FF` | `#1A6FD6` | Links |
| `bubble-own` | `#3B3B3B` | `#222222` | Your own messages (`on-bubble-own` text on it) |
| `amber` | `#F0A73A` | `#F0A73A` (`#9A5B00` as text) | Needs you |
| `hang-up` | `#E5484D` | `#E5484D` | Leave a call |
| `speaking` | `#3ECF8E` | `#1F9D63` | Who's speaking in a call |

`look.css` holds the tokens and rules of this look; it loads after every other stylesheet.

Characters keep their own outlines and colors on either ground. A terminal, and a Space's screen once it's showing, are dark in both themes: they're the machine's own screen. A Rex tab keeps the size Rex gives it, so when that is larger than the pane its screen scrolls both ways instead of shrinking. A Space with no screen yet (opening, unreachable, stopped) shows its message on the theme's own surface.

Scrollbars show only while the pointer is over the area they scroll, as macOS draws them.

Run state colors in the dark theme (each state also has its own icon, so color is never the only signal):

| State | Hex | Motion |
|---|---|---|
| Working | `#9DB0D8` | Live (timer ticks, avatar works) |
| Waiting | `#F0A73A` | The strongest treatment: count, ring, sound |
| Done | `#5FC38F` | Still |
| Failed | `#EF6F6C` | Still |
| Stopped | `#7C8088` | Still |

## Type

- **The system face** for everything people read, as Grok Bot uses: SF Pro on a Mac, Segoe UI on Windows, and Inter on Linux, which has no system face of that kind. 13 px for interface text and 15 px for messages, weights 400, 500 and 600. Titles are medium weight, never a heavy display weight.
- **Atkinson Hyperlegible Mono** only for timers, machine names, commands, run IDs, terminal output, and the codes, tokens and endpoint URLs people copy or paste.
- Both are on Google Fonts.

## Scales

Every size in the app comes from these scales. `styles.css` names them as tokens, `docs/ui-lint.md` keeps new code on them, and the UI gym measures the rendered app against them (issue #173).

- **Type**: 11 px for tags, badges and counts; 12 px for meta (timestamps, hints, field labels, small buttons, the sidebar's section headings); 13 px for interface text, the default; 15 px for messages and other reading text; 20 px for the title of an empty or intro view. Mono is 12 px inline and in chips, 13 px in terminals and code blocks. The initials in a face scale with the face.
- **Icons**: 12 px inside `.btn.small` and chips; 14 px in every other control, row and title, the default; 16 px for the composer's own controls; 20 px in an empty state. Chevrons, the ellipsis and the call's handset are compact glyphs: the family's stroke on a smaller ink box. A character's face is a drawing, not an icon.
- **Controls**: `.btn` and `.btn.icon` are 28 px, `.btn.small` 24 px, and a bare icon control (`.icon-btn`: row actions, the message toolbar, the composer) is a 24 px square. The call bar is one step larger, 36 px (Calls). Whatever the drawn size, the clickable area is at least 24 × 24 px.
- **Radii**: a full pill on every button, select, filter, chip, badge, title pill and the composer; 10 px on rows (the sidebar's, a menu's, an option's); 14 px on cards and grouped option lists; 18 px on message bubbles; 12 px on dialogs; 4 px on inline tags and key hints.

## Density and rows

- Compact rows by default; Default and Spacious in settings (as Discord offers).
- An Inbox row: the agent's face (its character, or the harness's), the task as a quiet line, and the reason or question in reading size; working and done rows add their state and age on the right edge.
- Keys work on the focused row and are named in each button's tooltip, with no strip of key hints: `A` Allow, `S` Settle, `Z` Snooze, `H` Hand off, `↵` Open.

## Inbox

- Sections: **Needs you**, **Working**, **Done**, with counts that disappear at zero. In the Team tab the first section is **Needs someone**, since its runs wait on whoever is in control of them. Work whose runs are all on a machine whose bridge is offline gathers under **Machine offline**, after Working: nobody can answer it or know it's working until the bridge is back, so it isn't amber.
- Rows are tasks; a run with no task gets its own row marked Unfiled.
- **Mine** by default (tasks you own, runs you are in control of), or **Team** for everyone's, and all projects or one: both in one quiet menu at the header's right ("Mine ⌄"), so the header holds only the Inbox pill and that menu.
- Finished work leaves by **settling**: by hand, by rule (pull request merged, idle days), or by **snooze**. Settled work comes back if one of its runs changes state again.
- **The Inbox is Link's conversation with you**, laid out as a chat with a Bot in Grok Bot: its title is a centered "Inbox" pill with Link's face; Link speaks first in a gray bubble ("3 things need you.", one size at any count; "You're all caught up." at zero; "Let's get you set up." over a new team's first steps); what needs you hangs under that bubble as cards; and a message box at the bottom sends on Enter with no dialog. With a Link (ADR 0049), the agent from the roster you picked, the box says "Message Grok Bot" and the Inbox opens on your conversation with it, above Link's line, as one timeline: your messages in the `bubble-own` pill on the right, its replies on the left with its face. A run it starts shows as a centered gray line ("Started a thread: Bump the tide model") and a card under it that follows the run (harness and machine, the title, its state, Open thread). A reply that starts nothing offers a quiet "Make it a task" under it. A "Send to" chip left of the send button, as T3 Code's model picker, sends to your Link by default, or as a New thread with no question asked, or to another agent as a task; the same menu picks or clears your Link. Under your latest message, until your Link answers, one quiet `muted` line says where it stands when it isn't simply on its way: a send to its routine webhook that failed and why, a wait for an agent that checks in, an A2A message it didn't take or a run it lost contact with, or that the room can't reach it. None of it is amber: a failed send doesn't need you. When the room can't reach your Link at all, a standing `muted` line above the box says so, the box starts a thread until it can, and the Send to menu shows the Link as unavailable. Without a Link the box reads "Tell an agent what to do" and starts a thread: the message becomes a task (its first line the title, in the project the Inbox shows) and a Claude Code thread starts on it in T3 Code with the message as its prompt, on your own machine first, then opens. With no machine whose T3 Code is connected, the task is kept and opens to start its run from there. The + beside the box still opens the New task form. It sits at the bottom of the view, above that box, as a chat does.
- **Decision cards.** Each row that needs you is a card that leads with the question in reading size, with who asks as a quiet gray line above it and its task in the tooltip. An approval has Allow and Deny on the card; a question with set choices shows them as lettered rows (A, B, C), one tap to answer; an agent's open question has an answer box on the card (runs.reply). Tasks proposed from a call wait there too, under one quiet line per call ("2 tasks from the call in #general", with Open): yours as suggested owner, or every one from a call you were in when nobody is suggested. Each has Accept (asking which project when the channel has none), Edit and Dismiss, and leaves once answered, here or in the channel. Nothing else in the Inbox is a card.
- **Folded by default.** Working and Done are quiet centered lines, as Grok Bot's system events: "3 working · Claude Code, Icarus and 1 more" with the agents' faces, and "2 done" with the titles and **Settle all**, whose one toast undoes them all. Either opens on click.
- **Inbox zero** is one quiet line ("Nothing needs you.") with Link beside it, happy. A new team (no projects, nothing working) gets **Get started** under it: Link a machine, Add an agent, Invite a teammate, Make a task, each a row that opens where it's done and is ticked once it is, with the next step marked and a progress bar.
- A working run shows a timer and its current step in dim text ("Working 04:12", "Running pnpm test"), never a progress bar.

## Window chrome

One system for every title row and every control in it, so the window reads as one surface.

- **Title rows.** The sidebar's top row, every view's header, side panels' headers and the task and run drawers are 52 px, with everything in them centered on one line 26 px down. On macOS the traffic lights sit on that line (`trafficLightPosition` x 16, y 19, `main/menuSpec.ts`), 16 px from the window's left edge.
- **Insets.** The last control in a header ends 16 px from the window's right edge, matching the traffic lights. A view's title starts on the 18 px content gutter the views below it use. In the sidebar, row boxes (the team switcher, search, rows) start 8 px from its edge and their icons at 16 px, on the same column as the traffic lights; the team switcher starts 10 px after the lights.
- **The glyph before a title** (`#`, the lock, the pushpin, the browser, search, the machine) is inside the heading, 14 px in `muted`, its ink on the text's baseline.
- **One control.** Every button is a pill 28 px tall with a 14 px icon and a 13 px medium label. In a title row a secondary button is `raised` with a `line` hairline (Grok Bot's Share); elsewhere it is a `chip` fill with no edge. The primary action is the text-colored pill, and nothing else is. An icon-only control is a bare circle that takes the `chip` fill on hover. A segmented control is a `current` track with the chosen segment lifted on `raised`. Status (a tool or machine chip, the driver pill) isn't a control and keeps a hairline pill.
- **No rule under a title row.** It shares the ground with what's under it.
- **A title pill.** A conversation's name, a thread's agent and task, and the Inbox's name sit in a centered pill (`raised`, hairline, soft shadow) between even spaces that give way first in a narrow column. The agent mode chip in a thread shows only when the mode isn't the default (Ask before acting).
- **Order and spacing.** 8 px between everything in a row. Text controls first, icon-only controls last, so the icons line up at the window's edge.
- **Names.** Every icon-only control has a tooltip and an accessible name, the same words ("Pinned messages", "Notifications for this channel", "Settings").
- **The Browser lamp** shows only while a shared browser is live: a `working` dot on the icon's corner, still, so the button keeps its width.
- **Drawers** (a task, a run) open over the view with a scrim that dims it; a click on the scrim closes them. A task drawer's Start a run is the primary action only while none of its runs is live; with one live, opening that run (terminal, thread, Space) is.
- **A thread's header** is one row: the title, Take control or Ask for control when that's yours to do, then who's in control as a pill that opens a menu (Hand off to, what teammates may do, who's watching, where it runs, Open in T3 Code), then the side panel's button.
- **A terminal or Space shows its screen first**, as Grok Bot's view of an agent's computer: one bar for what teammates may do (what each level means is its tooltip), and the side panel folded until a suggestion or a request for control waits there. "No one else is watching" isn't said. Stop sharing sits in the title row while the panel is folded.
- **Narrow columns.** When a channel's column is under 600 px (a small window, or the browser panel beside it), its header's text controls fold to icon controls with the same names; a terminal's or Space's chips give their room to the title.
- **Loading.** Until a view has its data, its title row says "Loading…" in `muted` (no glyph, no controls) and the view shows Link; the sidebar says "Loading…" once instead of empty sections.
- **Settings** lists its sections under four headings: Machines (Machines, Profiles, Setup), Team (Agents, Members, GitHub, Shared browsers), You (Chat, Calls, Appearance, Notifications, Privacy, Command line) and App (Updates, Diagnostics, Activity). Someone in no team sees only Command line and Appearance. Selects draw the app's own chevron.
- **Settings** is the gear (a six-tooth gear, never the sun, which is Appearance) at the right of the sidebar's footer, and **Settings…** (⌘,) in the macOS app menu, right after About, opening the same place. It opens as a dialog over the view you were on, as Grok Bot's does; Escape, the scrim or its close button put you back there.

## Sidebar

From top: the team switcher with search and a new task as icons at its right (Grok Bot's search and +), the **Inbox**, the **Roster**, **Voice**, **Conversations**, and **Projects**. Section headings are small, gray and bare; their + and other controls show while you point at the section.

Rows are roomy, as Grok Bot lists its Bots (`research/design/grok-bot-videos.md`): an agent's row is its 36 px character and its name, with a second line only while it waits on you ("Waiting for you:" in amber, then what it's on), since anything more repeats what the Inbox and the view already say; what it's on is always in its tooltip. While the Inbox is open its cards say what each agent waits on, so the sidebar drops that line there. A conversation's row is as roomy as an agent's, with a 36 px face (a channel, its glyph on a round tile). Marks are Grok Bot's three and nothing else: that amber line for an agent blocked on you, a small green dot on a running agent's face, and nothing for an idle one. The Inbox has the same amber dot, never a count; how many is the Inbox's first line.

**Voice** lists every channel as a room to talk in, as Discord lists its voice channels, whether anyone is there or not. One click joins the room's call and opens the channel; with nobody there yet, that click starts the call, so nothing in the app says "start a call". A row is the volume glyph on its round tile and the channel's name; a black Join pill shows on hover and focus; a room with people in it leads the list, shows how many, and lists them under it; the room you're in has the current fill and says Connected (or Joining, Reconnecting). A direct message joins the list while someone talks in it. Five rooms show, then "All voice rooms (N)"; a live room and the open channel always show. The list is a UI SDK listbox: arrow keys move through it and typing jumps to a room.

**Conversations** is one list for direct messages, channels and Pairs. Folded (the default) it shows only what's live: the one open, a mention of you, or something unread in a conversation you hear from, and an "All conversations (N)" row opens the rest. Read conversations are gray; unread ones are in the text color; a mention of you is the only count.

**Projects** fold to their heading, still showing the project you're in. They are filters for the Inbox first; a project's page holds its task list and files.

Clicking an agent's row in the roster opens a Give it a task menu of the team's open tasks; picking one opens the start-run dialog with that agent picked (ADR 0044). A harness's row doesn't.

The footer is a 52 px row: your avatar on the sidebar's 16 px icon column, your name in the primary text color, and the Settings gear. The call dock above it is one box 8 px in from the sidebar's edges: where you are and the call's time, then your media controls (mute, camera, share) as 28 px icon controls on `ground`, and Leave alone at the far end. A call-settings control (devices) joins the media group after Share.

A **private channel** (ADR 0016) sits in the Channels list with the others and shows a lock where a team channel shows `#`; it is a channel with a lock, not a separate place. The Channels heading's + opens the new channel popover: a name, Everyone or Private, and for a private one the people to add.

The Inbox row's count is the amber Needs you count alone; working runs show in the Inbox, not as a count.

A channel or direct message with unread messages shows its name in bold and a count. When some of them are addressed to you (a mention, @everyone, a reply to you), the count is a mention badge, `@2`, in the strong neutral (the primary text color with the ground color on it). Amber stays for "needs you": a message for you is worth a look, but nothing is waiting on you to go on.

## Conversations

- Every conversation reads as Grok Bot's, in one centered reading column (720 px, the Inbox's too) with the composer under it: everyone else's messages in soft gray bubbles on the left, your own in the solid `bubble-own` pill on the right with no face or name. A channel names who's speaking above a run of their messages; a direct conversation doesn't. A thread is one agent's, so neither its replies nor your own messages carry a name; only a teammate's message, or a suggested one, says who it's from. Your own message's time shows beside its bubble on hover; the day separator gives the rest. A channel opens on its messages, with no "start of #channel" intro; a direct conversation opens on who it's with.
- The composer is one pill: + to attach, the box, and a round send button that fills once there's something to send. In a thread, the hint goes in the placeholder ("Queue a message for Codex" while a turn runs) and the working state is one small line above the pill, with Stop beside it. The Pinned panel keeps every message on the left. A direct conversation opens on who it's with, large and centered. A conversation sits at the bottom, just above the composer, however short.
- A harness's work folds into one line ("Worked 2m, edited 1 file, ran 2 commands") that opens on click.
- An agent's message over A2A shows its run while it's live: "Working" and its timer; "Failed" and why; or, waiting on you, an answer card under the question with the amber edge: the choices the question names ("the CSV export one, or the DST fix?") as buttons that send on a click; anything else goes in the message box, so there is one box to write in. The answer goes to the run (runs.reply), which posts it where the run came from. A finished run leaves nothing under the message; Run details is in its hover bar. The Agent tag says only "Agent"; who added it is in its tooltip. An agent's direct conversation shows its state and what it's on beside its name in the header.
- A thread's message box takes images and files for its driver as the channel composer does: Attach beside the hint, paste and drop. A sent image shows from the room's copy under the message, up to 360 × 240; other files are chips. A thread's header shows what its agent may do as a chip beside the control pill ("Full access"), with who set it in the tooltip; its driver changes it in the pill's menu, under Teammates can (ADR 0043). Neither is amber, except a mode the machine's limit lowered.
- Approvals are fixed cards with Allow and Deny, never prose. A thread's question is a raised card with the amber edge: one question with one answer shows its options as buttons that send on a click; more questions pick options and send together. While it waits, the message box folds to "Write Codex a message instead". Once answered, the card folds into one line in the transcript ("Julio allowed `pnpm add -D tiled-map`").
- System events (a test run, a handoff, a pin) are centered one-line events between bubbles.
- A direct message opened with a team run says the whole team sees the run's output (ADR 0039): the room's first line, a few words with the eye beside the name in the header (the eye alone in a narrow column, the whole warning in its tooltip), and the same sentence as a standing `muted` line above the message box and above a thread's reply box. "Message this run" and the new direct message picker say it before it opens. None of it is amber: nothing waits on you.
- On hover, a message shows its actions in a small bar at its top right: react, reply, pin, and for your own messages edit and delete. Editing happens in place; an edited message says "(edited)". A deleted message with replies leaves a "Message deleted" line.
- Reactions are chips under the bubble, one per emoji with its count; yours is pressed (outlined in the primary text color), and hovering names who reacted.
- Mentions read as bold `@Name` on a soft neutral. One that names you, or @everyone, is inverted (ground color on the primary text color), and the whole message row carries a steady neutral tint. No edge stripe marks it: the tint and the mark say it.
- A "New" divider, a thin line in the primary text color with "New" in sentence case, sits above the first message you hadn't read when you opened the channel. When more is unread than has loaded, older pages load first, and a note says unread messages go on above. Older messages load as you scroll up, back to the first one.
- Attachments: images inline (up to 360 × 240), opening full size; PDFs as a chip opening the sandboxed PDF viewer; other files as a chip that downloads. Link previews are cards under the bubble with one even hairline edge and an 8 px radius: site, title, description, and the image the room copied.
- Message pins use the pushpin icon; the pin icon stays with pinned comments on files.
- Secondary text in chat (times, sizes, "Pinned by") is `muted`, not `faint`: `faint` is the quieter of the two, for step lines and placeholders, and still reads at 4.5:1 or more.
- Floating chat controls (the hover action bar, the emoji picker, the mention list, the new direct message picker, the new channel popover, a private channel's members) are popovers with the app's popover edge and shadow. A dialog is kept for what needs protected focus: confirming a delete, and viewing an image or PDF full size.
- **People** sits beside a channel, as Discord's member list, whenever no other panel (replies, pins, search, the browser) is open; the people button in the header shows or hides it, and the choice is kept on this computer. It lists everyone the channel reaches (the whole team in a team channel, its members otherwise) in three groups, Online, Agents and Offline, each with a count. A row is the face with its presence dot, the name, and one line on what they're doing: the call they're in ("In a call in #general"), their custom status, an agent's run state and what it's on, or Away and "Last seen 5 min ago"; nothing for someone active, since the dot says it. You lead Online, with "Set a status" until you set one. Choosing a row opens that person's card, a popover with their face, role, presence, status and call, then Join their call and Message; your own card sets your status (80 characters, one line) with Save, Clear and Cancel. The list is a UI SDK listbox, and every card is one UI SDK popover the list shares.
- A private channel's header shows its lock and a members button: up to three faces and the count. Its popover lists who is in it ("Created it" beside its creator), adds people or agents, removes them (only for its creator and admins in it), and leaves. Leaving asks once more in the same popover, because only someone still in it can add you back. Someone removed while the channel is open sees "You aren't in this channel any more." in place of it.

## Pairs

A Pair (ADR 0034, ADR 0036) is outside every team, so it looks the same in every team's window and for someone in none.

- It reads like a direct conversation: bubbles, your own on the right, and it opens on who it's with, large and centered, with its live runs under the names and one line on what each side sees. A run's message names the run and who answers for it, as in chat. Its title row says how many runs are live; an ended Pair says Ended, keeps its messages, and puts one `muted` line where the message box was. Older messages load as you scroll up, as a channel's do, and its start shows once the first is loaded. Opening it marks read only what it loaded: with more unread than it loads on its own, it says unread messages go on above, with Load them.
- A message a run didn't get, because its inbox was full, names that run under the box, `muted` with the alert icon, since the message was posted; the next message sent clears it.
- **Make a code** in the title row opens a popover with the code in mono, Copy, its time left ticking in mono, and how the other side uses it. The code shows only there: closing it forgets it, and a new one can be made any time.
- The people button (faces and a count, as a private channel's) lists its people, its live runs and its agents, then Leave and End. Each asks once more in the same popover.
- Joining with a code is a short form in the start popover. A refused code says why under the box in the failed color with the alert icon, in the app's words, and typing again clears it.
- Someone signed in with no team opens on their Pairs: what a Pair is, Start or join a Pair, the list, and under it Create a team and Join with an invite token.

A run whose session joined by itself (`uplink join`, ADR 0032) reads Live in the roster and in its run drawer, with "Joined by itself" where a harness's line or machine would be, and its drawer says once that it has chat only, in place of a terminal or thread.

## A project's tasks

- A project's Tasks tab is one list in the reading column, in sections that come from run states, most urgent first: **Needs someone** (a run is Waiting or Failed), **Working**, **Not started**, **Done**. An empty section isn't shown; its rule is its heading's tooltip. There is no kanban (T3 Code's thread list is the reference).
- A row shows the task, its owner's face, and each run: an agent as its character, a harness as its mark, each with its state. An open task shows Give to an agent on hover and focus (ADR 0044).
- A closed task (a run was kept) stays in Done; a settled task whose runs have all finished sits in Done and says Settled.
- A task whose live runs are all on machines whose bridge is offline sits at the foot of its section under a quiet Machine offline divider.
- In the task panel, each run card shows its machine and repository on one quiet line ("Controlled by" only when it's someone else), the last lines its terminal printed and, when it failed, why. Nothing on a running card is loud: Open terminal is a plain button. A project's header has one labeled button, New task; its channel and repositories are icons. The runs of one agent conversation are one chat across the panel's width (ADR 0041).

## People, agents and harnesses

- **People** have round avatars.
- **Agents** (team members a person added, such as Hermes or the Notetaker) are characters from the cast below. In chat an agent's name is set in its character's color, and its bubble (in a channel's rows, a card) is tinted in that color, so agent output reads apart from people's. What an agent made (its A2A artifacts) shows as cards under its message: the name, its first lines in mono, its links. In the roster an agent's face wears its state as a ring: amber waiting, red failed, blue working. Hovering one shows who added it and that it can do at most what that person can.
- **Harnesses** (Claude Code, Codex, Grok Build) are tools, not members. Each is drawn from the same character system as agents, its own body and color (Claude Code a gold blob, Codex a sand pill, Grok Build a blue tall body), so the roster, the Inbox and a thread read as one cast, and its character shows its run's state. A plain shell, Rex and a Space keep their marks. Their messages carry no tag.
- **Control**: whoever is in control has one marker, in the member list, the thread header pill and the composer, never on past messages. The pill reads "You're in control" or "Ana is in control". Handing off animates the pill from one person to the other.

## An agent's computer

Three levels, from Grok Bot's design:

1. **Status**: a lit lamp on the machine button in the thread header while the machine is in use.
2. **Preview**: a pinned side panel showing the machine's terminal or Space, without leaving the thread.
3. **Take control**: full screen; the harness pauses while you are in control; **Hand back** returns control.

## Machine settings

Set by whoever the machine belongs to, except the T3 Code threads to share, which anyone using that computer's own app picks (ADR 0045):

- **Most open access allowed**: View, Suggest, Ask for control or Take control, each with one line on what teammates can do at it. On a personal machine it also decides who starts runs there: at View or Suggest only the person it belongs to and their agents, at Ask for control or Take control teammates too, in a free slot (ADR 0025). Personal machines start at Suggest, team machines at Ask for control. Lowering it drops running terminals, Spaces and threads above the new limit right away, marked in amber ("Ask for control, was Take control"). Lowering a personal machine to View or Suggest also puts its person in control of what teammates control there; when that takes a terminal from someone, a confirmation lists those terminals first. The bridge enforces the limit on the machine.
- **Most an agent may do on its own here**: Ask before acting, Edit files without asking, Approve safe steps itself or Full access, each with one line on what the agent does at it (ADR 0043). Every machine starts at Ask before acting. Lowering it lowers T3 Code threads above it at once, marked in amber; terminals keep the mode they started with.
- **Slots**: how many terminals teammates may start without asking (on a personal machine, only at Ask for control or Take control), with a bar showing how many are in use. At View or Suggest the line under it says that only its person's agents take them.
- **Profiles**: whether people may keep their own logins on the machine, and for how long.
- **Live terminals**: each with its driver, the harness or tool running in it, and its access level.
- **Rex tabs** (only whoever the machine belongs to sees them): the tabs opened through Uplink Room, each shared (it opens) or with an access level and Share; how many other Rex tabs there are, which can't be shared; or that Rex isn't running there (ADR 0019).
- **T3 Code threads on this computer** (only in this computer's own machine settings, read from its bridge and never sent to the room): every thread T3 Code lists, searchable by title or repo, each private until it's checked and saved. Threads started from the room are always shared and locked on. Saving shares or stops at once; a thread T3 Code no longer lists stays shared, marked as such, until it's unchecked (ADR 0045).

Start a run lists a teammate's personal machine at View or Suggest as off, tagged with its level ("Set to Suggest"), and its line says why: "Axel's machine is set to Suggest: teammates can't start runs there." When no machine can take the run, those machines show at once instead of folding into one line.

## Adding an agent

- Settings, Agents with no agents starts from roles (Notetaker, Deploy bot, Release-notes writer), each opening Add an agent with its name and character set.
- Settings, Agents also lists the coding tools working now (Claude Code, Codex), with one line on why they aren't agents to add: they run on linked machines and show in the Roster while they work. With no agents, its empty state holds Add an agent.

- The person adding the agent names it, picks how it connects (A2A, MCP or HTTP), and builds its character from the system: one of six bodies, one of eight colors, one tool (or none). The preview cycles its states so the tool shows.
- It starts with the smallest set of scopes: post messages and read projects. Starting runs, answering approvals, inviting people and changing machine settings are each granted explicitly.
- The form states who added it and that it can do at most what that person can.
- An agent with the Answer approvals scope can answer any approval; the record names the agent and its accountable person (ADR 0005).

## Calls

- A call belongs to its channel. The call dock sits at the bottom of the sidebar with mute, camera, screen share and leave.
- People in the call are listed under its room in Voice, five of them and then "and N more"; the speaking ring is green.
- An agent joins like anyone else: its character joins the call bar's faces and the list under the room, and the join sound plays, with no banner.
- Tasks made from a call go to that channel's project.
- A call error (calls not set up, a failed join) shows in that channel under its title row, in words people use, until dismissed; anywhere else it's a toast.
- The call bar: a channel with a call shows one pill under its title, floating with a soft shadow (Grok Bot's Watching and Take control). It holds up to three faces, the ones talking first with the green ring, then "+N", and the call's time. Clicking the faces lists everyone in the call with their mute, camera, screen and notes icons. Outside the call the pill ends in a black Join; in it, Mute, Share, a menu, and Leave in red. The menu holds the camera (turning it on previews it first), microphone, speaker and camera, Voice quality, and the agents you can ask to join. While the channel is on screen the sidebar's dock steps aside, so the controls show once. In a narrow channel column (the shared browser beside it, a small window) the controls, "Joining" or "Reconnecting", and the notes icon never give way: the words "Taking notes", then the time, drop out whole, and when that isn't enough the controls move together to a second line under the faces. While nobody is talking in a channel, its header has a labeled Join call button with the volume glyph, which never folds to a bare icon; joining starts the call.
- Voice takes no tiles. The stage under the call bar shows only shared screens, largest, and a tile for each camera that's on, soft gray with no edge, the one speaking with an inset green line. A call with no camera and no screen has no stage, so the conversation stays in view. More than six cameras make the tiles compact, up to twelve and then one "+N" tile.
- People outside the call see who's in it under its room in Voice and in its call bar, with mute, camera and screen icons, but no speaking ring.
- While an agent with the `calls.notes` scope is in the call, the call bar says "Taking notes" in dim text, and the dock says "Notetaker is taking notes".
- Call quality (ADR 0017). While you're in a channel's call, the call bar's menu has Voice quality, which lists Standard, High and Music, each with what it does and its bitrate; the chosen one has a tick. Admins choose in a team channel, anyone in a private channel or direct message. The share picker's Quality sits above the screens: Sharp, Balanced, Smooth, Smooth HD and Source, with Source's frame rate (30 or 60 fps) beside it, one line saying what the choice sends, and what 60 fps costs. A shared screen's tile has a small toolbar at its top right on the same plate as its name: for a viewer, Stream quality Auto or Low; for the sharer, the share's quality as a menu; and Expand, which lets the screen fill the channel. Settings, Calls holds the camera quality and, for admins, the highest call quality allowed, which also caps the camera (720p under Standard). A choice above the team's limit stays visible, unavailable, with one line saying why and who can change it. Nothing about quality is amber: a limit doesn't need you.
- Devices (docs/devices.md). The dock's fifth button, or "Microphone, speaker and camera" in the call bar's menu, opens call settings beside it: the microphone with a one-line level bar in the speaking green, the speaker with "Play test sound", the camera and its quality, and one line on Krisp noise cancellation (on, or why it's off). Turning the camera on opens the same popover as a preview first: your picture mirrored, the camera and quality, then Cancel or "Turn on camera". While your camera is on, the dock shows it, mirrored, above its controls. Settings, Calls has the same three pickers, with "Test microphone" and "Preview camera" so nothing opens a device until asked. The level bar moves only with the sound it hears.
- Joining is one click on a room in Voice, Join call in a quiet channel's header, Join in a live call's bar, or Join their call on a person's card in People. A conversation row in the sidebar only opens the conversation.
- A call's start and end are centered one-line events in the channel ("Call ended · 25 min · Julio, Ana, Notetaker"). A call with nothing said during it is one line ("Julio started a call · 25 min with Ana"), and short calls back to back with no notes fold into one ("Rosa Vega started 2 calls · under a minute each"). The call notes come after it as the agent's message, with the proposed tasks under them as rows with Accept and Dismiss, never auto-created. The same proposals wait in the Inbox of whoever they need (Inbox, Decision cards).

## Characters

All characters are built in code with one SVG rig (`design/link-rig.js`), like the Grok Bot icon Benji Taylor described: every state, shape and expression morphs into the next. Nothing is a raster image.

- **Body**: a superellipse from four numbers (width, height, roundness, top taper), so bodies morph into each other.
- **Face**: two parametric eyes (size, upper and lower lid curve, tilt, look direction), brows, a mouth (width, curve, open), cheeks. Springs carry every number to its target.
- **Cel shading**: flat base color, a hard-edged shadow band, one sharp highlight, and an ink outline in a darker tone of the character's own color. The light is fixed in the scene, so the shadow slides as the character tilts or hops.
- **States** follow run states: an agent shows its most urgent run (Waiting, then Failed with the blocked look, then Working, then Done) and is idle when it has none. Motion is lively:
  - Idle: breathing, blinking, looking around.
  - Working: focused eyes scanning, a quick bob.
  - Waiting: wide eyes, a double hop, the antenna glows (Link).
  - Blocked: worried brows, a droop and a shiver.
  - Done: happy closed eyes, an open smile, one hop.
- **Accessories**: each agent has one, drawn in the same cel style, and takes it out only while active (working, waiting, blocked):

| Agent | Body | Accessory |
|---|---|---|
| Notetaker | Sage squircle | Headphones |
| Deploy bot | Blue pill | Wrench |
| Hermes | Coral rounded triangle | Round glasses |
| Scribe | Lilac circle | Pencil |
| Chief of staff | Sand tall rectangle | Clipboard |
| Night watch | Gold blob | Lantern |

- Whoever adds an agent builds its character from this system (body, color, accessory).

### Link

Uplink Room's house mascot: a cream squircle with an antenna ending in an amber dot. The dot glows when something needs you. Link appears on the app icon, next to the Inbox zero line, in onboarding and empty states, and reacts to every sound cue.

## Sound

Soft wood palette: short, warm, marimba-like. Cues and when they play:

| Cue | Plays |
|---|---|
| Needs you | Yes |
| You have control | Yes |
| Someone joins or leaves a call (people and agents alike) | Yes |
| Settled | Yes |
| Inbox zero | Yes |
| A message for you (outside the channel you're looking at) | Yes |
| Allowed | No |

The round 6 page synthesizes placeholder versions of every cue; final sound design is still to do.

## Brand

- **Name**: Uplink Room. The JPL origin stays in the name only; no space imagery.
- **Wordmark**: Link as the logomark beside lowercase "uplink room" in Atkinson Hyperlegible Next Bold, with the dot on the i in amber (Link's antenna dot, the "needs you" signal).
- **App icon**: Link's face close up on a graphite tile in the macOS icon shape, so it reads at 24 px. The antenna dot glows in the Dock when something needs you.
- **Menu bar**: a one-color glyph (Link's outline, antenna and eyes), as macOS expects.

## Onboarding

The first-run setup, shown once on each computer the first time a team opens, and again from Settings, Setup. Link speaks in the first person beside each step; each step past the welcome can be skipped.

1. **Welcome**: "Hi Ana, I'm Link.", the team you're in, and what the next steps set up.
2. **Devices**: the microphone, speaker and camera calls use on this computer, picked with the shared device pickers (`components/Devices.tsx`). The microphone's level meter and the camera's picture start only when you press Test or Preview, because opening a device is what makes macOS ask for it.
3. **Permissions** (macOS only): only what the app uses, each with one line on what it's for and its live state (Allowed, Off, Not asked yet), read again when the app comes back to the front. Microphone and camera ask with macOS's own prompt; after a denial the button opens their pane, where the app only needs switching on. Screen Recording opens its pane and offers the app as a tile to drag into the list, as System Settings lists it (icon and name). Notifications send a test banner, which is when macOS asks. No Accessibility: nothing in the app types or clicks on this computer. See `research/onboarding-permissions.md`.
4. **Link this computer**: name it and link its bridge (the installed app carries it). Under it, one row in the permissions' anatomy says what `uplink-bridge` runs in a new terminal and offers Add to PATH (Settings, Setup shows the same row). Unlike a permission's line, its line wraps: it names paths. Add to PATH there also links `uplink` and `uplink-mcp`. Settings, Command line opens with the same rows for this computer: `uplink` and `uplink-mcp` in a terminal, the `uplink` skill in Claude Code and in Codex (Install or Update), and `uplink-mcp` in an agent (a harness picker and Add), above the signed-in computers.
5. **Done**: what's set and what isn't, and the three things that work differently here (the Inbox, the roster, who is in control), one line each. It ends on "Open my Inbox".

The dialog keeps one height on every step, so its buttons stay put, and Link stays calm (its antenna glows only when something needs you), looking blocked only when linking fails. Each permission row keeps one line: after you open System Settings, its line says what to do there.


## Notifications

- System notifications for **needs you**, **you have control**, and **a message for you**: a direct message, a mention of you or @everyone, or a reply to your message, plus every message in a channel you set to all (spec #63, ADR 0015). Sounds cover more events; a banner interrupts more, so fewer events get one.
- No banner or message sound for the channel you're looking at. Each channel's bell sets what it tells you about: all messages, mentions and replies (the default for channels), or nothing; direct messages default to all.
- The banner icon is Link, waiting.
- You can answer from the banner only when the action can be undone. Hard-to-undo actions, such as a deploy, show **Open** only.
- The same Inbox card works at phone width for a future phone app.

## Updates

- A downloaded update shows as one quiet row at the bottom of the sidebar, where the call dock sits during a call: "Version 0.2.1 is ready" and **Restart to update**. It's neutral, never amber (an update doesn't need you), and never a dialog, toast or system banner.
- It isn't shown during a call, and the app never restarts on its own. Signed out, the same row sits at the bottom of the sign-in screen. Settings, Updates shows the version and **Check for updates**.

## Website

uplinkroom.com (`apps/site`) uses the app's tokens and follows the visitor's light or dark setting, with screenshots in the matching theme.

- Type: Atkinson Hyperlegible Next for everything, at 15 px (captions, meta), 17 px (body), 19 px (lead), 24 to 30 px (section headings) and 36 to 68 px (page headings). Mono only for file names and commands.
- The primary button is the app's: a text-colored fill. Amber appears only in the wordmark's dot and where the screenshots show something that needs you.
- The product shows itself: real screenshots with sample data, near their real size, cropped to what a section is about. No feature-card grids, no mockups.

## Open items

- Real harness marks (Claude Code, Codex, Grok Build) in place of the terminal mark.
- Final sound design for the soft wood cues.
- Production artwork for the wordmark and app icon at every size (the round 7 page shows them live).
- `design/scenes/` holds the stageshow sources for the films in `design/films/`; they import the stageshow kit (`kit/index.ts`) and run in its preview.
