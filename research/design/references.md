# Design references

Collected 2026-11-01 for the Uplink Room design round, after three brand directions were rejected as "AI slop". This file records real screens from shipped products and the decisions behind them. It does not propose a design.

The screenshots this file describes are third-party images and are not kept in the repo. Each section links to the page it came from.

How to read the sourcing:

- **Seen**: I opened the image or read the page text myself in this session.
- **Snippet**: I saw only a search-result excerpt, not the full page.
- **Extracted**: the value came from Firecrawl's automatic branding extraction (fonts, colors). It reads the page CSS, but I did not confirm it by hand.

## 1. What Mobbin allowed and blocked

Mobbin is partly open. Single screens are public at full resolution. Browsing, searching, and per-app screen lists need an account.

| Page | Result |
|---|---|
| `mobbin.com/` (homepage) | Reachable. Marketing only. Says 621,500 screens; the Mobbin MCP server is "Available on Pro & Team plans". |
| `mobbin.com/explore/screens/<id>` (one screen) | Reachable. Title, one-line description, tags, and the full image. The image URL in `og:image` downloads directly from `bytescale.mobbin.com` at 1920 px and 2880 px wide without a login. |
| `mobbin.com/explore/flows/<id>` (one flow) | Reachable. Search results listed every screen in the flow (for example 25 screens of Linear onboarding). |
| `mobbin.com/explore/web/screens/<category>` (for example `dark-mode`) | Reachable. The HTML held 57 screen images for dark mode. |
| `mobbin.com/explore/web`, `/explore/sections/<id>` | Reachable. |
| `mobbin.com/discover`, `/discover/apps/web/latest` | Gated. Redirects to `/?redirect_to=...`. |
| `mobbin.com/search/apps/web?q=linear` | Gated. Same redirect. |
| An app's full screen list | Not reachable. App logos link to `/signup/modal`; a guessed `/apps/linear-web` URL returned 404. |
| Save and Copy buttons | Gated (`/signup/modal`). |

So the way in without an account is web search (`site:mobbin.com <app> <pattern>`), then the single-screen page, then the image.

What turned up through search: Linear web (both the older layout and the newer one), Superhuman Mail web, Discord web and iOS, Slack huddles (web, iOS, Android), Cursor web (only the usage dashboard), GitHub Android notifications, Notion inbox, Claude web, Granola iOS, Raycast iOS. Searches did not surface Height, Around, Devin, Factory, the Arc browser app (the Arc result was a section of Arc's marketing site), Notion Calendar desktop, Things, or the Vercel dashboard. They may still be in the gated library.

Mobbin's captures use demo accounts ("John Mobbin", "jane.smith.mobbin"), so the content is sparse. Several of the Linear captures appear to predate Linear's March 2024 redesign; compare `mobbin-linear-web-dark-mode.png` with `linear-redesign-after.png`.

## 2. References

### Inbox and triage

**Linear: Inbox after the 2024 redesign**
- URL: https://linear.app/now/how-we-redesigned-the-linear-ui
- Files: `linear-redesign-after.png`, `linear-redesign-new-ui-b.png`, `linear-redesign-new-ui-a.png`
- Pattern: a notification list beside the open issue. Each row has the actor's face with a small badge for the notification type, the issue title, one line of reason ("julian reacted to a comment", "Marked as completed by romain"), a status icon on the right, and an age ("23h", "2d", "1w"). The issue header holds Delete notification, Snooze, and Unsubscribe. (Seen)
- Why it is good: the post says they "redesigned notifications to be more centered around the notification type and emphasized the faces of your teammates", and the result reads in one scan because every row has the same four slots and the right edge carries state and time.
- For Uplink Room: use the same row anatomy for Needs you, Working, and Done (who, what, why it is here, run state, age), and put settle and snooze in the detail header instead of on every row.

**Linear: Inbox display options and context menu (Mobbin)**
- URLs: https://mobbin.com/explore/screens/f17551a8-b397-401d-990b-d1771d2cbedf, https://mobbin.com/explore/screens/040a46c9-be46-48c9-bfdd-77287da75a06, https://mobbin.com/explore/screens/db497da7-0b3c-4f6b-bf78-f355b2147dec
- Files: `mobbin-linear-web-inbox-snoozed-toggle.png`, `mobbin-linear-web-inbox-context-menu.png`, `mobbin-linear-web-inbox-empty.png` (light theme, older layout)
- Pattern: a small popover with "Show snoozed" and "Show read" switches; a right-click menu where every action shows its single-key shortcut on the right (Mark as unread U, Snooze H, Status S, Assignee A); an empty state that says only "No unread notifications". (Seen)
- Why it is good: snoozed and read items are hidden by default but one toggle away, and the menu teaches the keyboard without a tutorial.
- For Uplink Room: snoozed runs leave Needs you but stay findable through a "Show snoozed" switch; list the shortcut next to Settle and Snooze in menus.

**Superhuman: Split Inbox and Mark Done**
- URLs: https://help.superhuman.com/hc/en-us/articles/46005636204941-Custom-Split-Inbox, https://help.superhuman.com/hc/en-us/articles/46005842694541-Swipe-Your-Way-to-Inbox-Zero
- File: `superhuman-split-inbox-help.png`
- Pattern: the inbox is split into named sections shown as a tab row with counts ("Important 104 · Calendar 7 · Outreach 17 · Other 37"). Tab and Shift+Tab move between them. A section's count disappears when it reaches zero. Superhuman recommends no more than seven splits. Marking a conversation Done moves it out, and it returns if someone replies. (Split Inbox page seen in full; the Mark Done page was a snippet.)
- Why it is good: the count is the to-do number, and hiding it at zero makes "done" visible without a banner.
- For Uplink Room: show counts on Needs you and Done and drop the count at zero. A settled run should come back to Needs you if its run changes state again, the same way a reply brings mail back.

**Superhuman: dark inbox, keyboard tutorial, Inbox Zero reward (Mobbin)**
- URLs: https://mobbin.com/explore/screens/be7d24eb-3e20-4e58-9ef0-7b0d8d6752d0, https://mobbin.com/explore/screens/f6bbf16f-d06d-4594-899d-e893b7466b29, https://mobbin.com/explore/screens/1f6dbde4-2225-4518-b452-c4e1c90c315f
- Files: `mobbin-superhuman-dark-inbox.png`, `mobbin-superhuman-keyboard-tutorial.png`, `mobbin-superhuman-achievement-modal.png`
- Pattern: one-line rows (sender, bold subject, gray snippet, right-aligned time) on a flat dark gray; a contact panel on the right; a small wordmark "SUPERHUMAN" in wide letter-spaced caps at the bottom. The onboarding teaches one key at a time ("Hit K to move up" with two keycaps and a progress bar). Reaching Inbox Zero replaces the list with a full-bleed landscape photo and "You've hit Inbox Zero!". (Seen)
- Why it is good: the list has almost no chrome, just type weight and gray levels, and the empty state is a reward rather than an apology.
- For Uplink Room: give Inbox zero its own calm screen. Teach Settle and Snooze keys in context the first time they apply.

**GitHub: notifications with reason lines (Mobbin, Android)**
- URL: https://mobbin.com/explore/screens/22bc555a-17c8-4ba8-b10c-bc86823fd362
- File: `mobbin-github-android-filtered-notifications.png`
- Pattern: each row is "repo / #number", the title, then a reason line with a face ("@bnjmnt4n requested your review", "Merged #583 into dev."). Filter chips sit on top (Inbox, Unread, a repo). (Seen)
- Why it is good: the reason line answers "why is this in my inbox" before you open it.
- For Uplink Room: every Needs you row should say why in plain words ("Hermes is waiting for you to approve a migration").

### Agent runs and run states

**Linear: coding session card with live progress**
- URL: https://linear.app/changelog/2026-06-11-coding-sessions
- Files: `linear-agent-coding-session-diff.png`, `linear-agent-coding-session-activity-completed.png`
- Pattern: the diff sits on the left; the agent session is a panel on the right with a header ("Linear · Opus 4.8"), who started it ("Conor started this session"), a collapsible "Worked for 32s", the result as short bullets with inline code, a teammate's reply nested in the thread, and a live block "Working 00:12" with dim step lines ("Preparing session...", "Setting up environment...", "Getting ready..."). The composer says "Tell Linear what to do next...". In the issue activity feed, a finished session is one bordered card ("Changed 5 files · Done. Cleaned up the rider ETA feature flag and opened draft PR #77421" with a PR chip) among plain one-line events, and automated actions carry an "Automation" tag. (Seen)
- Why it is good: a run is described with elapsed time, concrete verbs, and a file count, never a spinner and "Thinking...".
- For Uplink Room: show Working with a timer and the current step in dim text, show Done as "Worked for 4m · changed 5 files · PR #123", and tag agent-made events so people can tell them apart in a channel.

**Linear: agent delegation in the activity feed**
- URL: https://linear.app/changelog/2025-10-28-github-copilot-agent
- File: `linear-agent-session-copilot-delegation.png`
- Pattern: a card headed "GitHub Copilot · agent connected" with an Activity button; inside, a person's @mention and the agent's reply "Copilot has completed the issue. See the pull request" with PR and session chips. (Seen)
- Why it is good: the agent's work is a contained card inside the human conversation, so the issue stays readable.
- Also seen as search snippets only: Linear's docs say issues delegated to an agent still appear in the delegator's My issues; the developer docs show agent plans as steps with `inProgress` and `pending` statuses. Both match Uplink Room's rule that the owner stays a person.
- For Uplink Room: render a run inside its task or channel as one card with its own header and state, not as a stream of bot messages.

**Linear: agent as an assignee chip (Mobbin, newer layout)**
- URL: https://mobbin.com/explore/screens/46088879-314c-405c-88b5-eb7820c05efb
- File: `mobbin-linear-web-goal-task.png`
- Pattern: in an issue list grouped by In Progress, Todo, and Backlog, some rows carry an "AI UX Research Assistant" chip in the same slot and style as labels and projects. (Seen, light theme)
- Why it is good: the agent gets no special color or mascot; it is one more property on the row.
- For Uplink Room: show the agent on a task row as a quiet chip next to the owner's face.

**Cursor 3: Agents Window and tiled layout**
- URLs: https://cursor.com/blog/cursor-3, https://cursor.com/changelog/3-1, https://cursor.com/docs/agent/agents-window
- Files: `cursor3-agents-window-file-view.png`, `cursor3-1-changelog-page.png`
- Pattern: all local and cloud agents appear in one sidebar, including ones started from mobile, web, Slack, GitHub, and Linear. Cloud agents attach demos and screenshots of their work. Version 3.1 added a tiled layout to "compare outputs across agents without jumping between tabs". The saved image shows an agent's report on the left (embedded demo video, a Summary, and a Testing list where each line starts with a pass or warning mark), a "Create PR" button, a model picker "Composer 2 · Fast", and a mic for voice; the right side is the file with a breadcrumb and an "LSP" chip. Cursor's `theme-color` metadata is `#f7f7f4` light and `#14120b` dark, a warm off-white and a warm near-black. (Seen; the tiled-layout image on the changelog is blurred in the capture.)
- Why it is good: the agent's report leads with evidence (a demo, test results with pass and warn marks) instead of prose.
- For Uplink Room: the side-by-side view of several runs on one task can follow the tiled layout, and each run's Done state should lead with its evidence.

**Vercel Geist: Status Dot**
- URL: https://vercel.com/geist/status-dot
- File: `vercel-geist-status-dot.png` (light theme)
- Pattern: five deployment states, Queued, Building, Error, Ready, Canceled, each a small dot with a sentence-case label. The guidance: the dot animates only while Building or Queued and is static once terminal; do not add a spinner beside it; do not flash through states on each poll; pair it with a relative time ("Building · 12s ago"); do not write "Status: Ready"; color is never the only signal. (Seen)
- Why it is good: a fixed state vocabulary with written rules for motion and copy, which is exactly what our five run states need.
- For Uplink Room: map Working, Waiting, Done, Failed, Stopped onto a dot and label; animate only Working; give Waiting the one strong color because it needs the driver.

**Cursor web: usage table (Mobbin)**
- URL: https://mobbin.com/explore/screens/1886dfa3-a068-4dc4-84ce-9f33b4ad76cc
- File: `mobbin-cursor-web-screen.png`
- Pattern: a dark table of raw events with small uppercase column headers and monospaced dates, models, and token counts. (Seen)
- Why it is good: monospace for numbers and IDs keeps columns aligned and separates data from labels.
- For Uplink Room: use the mono face for run IDs, timers, token counts, and terminal output, and the sans face for everything people wrote.

### Chat, voice, and presence

**Discord: 2025 desktop refresh**
- URL: https://discord.com/blog/player-release-q12025
- Files: `discord-2025-desktop-themes-density.png`, `discord-2025-call-controls-glow.png`, `discord-2025-refreshed-colors.png`
- Pattern: four base themes (Light, Ash, Dark, Onyx) and three density options (Compact, Default, Spacious); a resizable channel list; call controls "collected into a single bar"; "stronger red glow when your mic is muted and a new green glow when your camera is active". The stated goal is to "reduce the feeling of being overwhelmed by visual noise". In the sidebar, the people in a voice channel are listed under it, with mute and camera icons per person. (Post read in full; images seen.) A support-center snippet says Onyx uses a true black background (snippet).
- Why it is good: dark is a range, not one hex value, and mic and camera state get a color that is impossible to miss.
- For Uplink Room: offer at least two dark levels and a density setting; list who is in a call under the channel; use one unmistakable treatment for "your mic is live".

**Discord web: voice channel (Mobbin)**
- URLs: https://mobbin.com/explore/screens/986e8905-d85a-4b87-afc6-27b34f7e36cf, https://mobbin.com/explore/screens/3e4079f5-cfb4-41b9-9507-be16844f1b9d
- Files: `mobbin-discord-web-voice-channel-two-users.png`, `mobbin-discord-web-voice-channel-lounge.png`
- Pattern: a "Voice Connected" block in green above the user panel, naming the channel and server, with Video and Screen buttons; members nested under the voice channel; one video tile has a thin green outline. (Seen. That the green outline marks the active speaker is my reading, not confirmed on the page.)
- For Uplink Room: keep a persistent "in call: #channel" block at the bottom of the sidebar so you can leave the call view and still see you are connected.

**Slack: huddles (Mobbin)**
- URLs: https://mobbin.com/explore/screens/317bf581-917e-4177-8712-29de16986338, https://mobbin.com/explore/screens/9406be76-e116-4753-a4d3-8fc65ae3033c
- Files: `mobbin-slack-web-huddle-started.png`, `mobbin-slack-web-huddle-in-progress.png`
- Pattern: a small docked huddle window in the bottom-left with participant thumbnails and a row of round controls (mic, video, screen, emoji, invite, more) plus a red Leave; when alone it says "You're the only one in this huddle. Enjoy the tranquility." with optional waiting music. A Huddles page lists past huddles with duration, reply count, and faces ("8 days ago · 25 minutes · 2 replies"). (Seen, light theme with Slack's purple frame)
- Why it is good: the call stays alive and controllable while you work elsewhere, and past calls become browsable records with their threads.
- For Uplink Room: a call in a channel docks as a small panel; past calls list duration, attendees, and the tasks made from them.

**Tuple: named cursors and control modes**
- URLs: https://tuple.app/, https://docs.tuple.app/changelog
- File: `tuple-home.png`
- Pattern: on a shared screen each participant's cursor carries a colored name pill (Paul, Sarah, Mike). A toolbar switches cursor mode (pointer, control, draw, text). The site says "It just takes one click to switch who's sharing". (Homepage seen.) The changelog snippet says control and annotation modes "are used by the participant who currently have control over the mouse" and "Other users cursors are always visible" (snippet).
- Why it is good: presence is shown where the action is, by name, not in a separate roster.
- For Uplink Room: show the driver of a shared terminal or thread as a name pill at the cursor or prompt, and make passing the wheel a single action.

### Desktop chrome, color, and type

**Linear: how the 2024 UI was built**
- URL: https://linear.app/now/how-we-redesigned-the-linear-ui
- Files: `linear-redesign-lch-vs-hsl.png`, `linear-redesign-contrast-30-vs-100.png`, `linear-redesign-light-dark-themes.png`, `linear-redesign-sidebar-alignment.png`
- Pattern and decisions (post read in full): themes are generated in LCH instead of HSL, so colors with the same lightness look equally light; each theme comes from three inputs (base color, accent color, contrast) instead of 98 hand-set variables, and the contrast input yields high-contrast themes for accessibility. They limited "how much chrome (blue in our case) was used in the calculations" to get "a more neutral and timeless appearance", made text lighter in dark mode, and use Inter Display for headings with Inter for the rest. The app is Electron; they tested on macOS, Windows, and the browser and "often relied on Apple standards". They spent time aligning sidebar labels, icons, and buttons, "something that you'll feel after a few minutes".
- Why it is good: the restraint is a system (three inputs, one accent kept out of the neutrals), not a mood board.
- For Uplink Room: we are also Electron. Generate surfaces from base, accent, and contrast in OKLCH or LCH, keep the accent out of the grays, and pick a display cut for headings.

**Raycast 2.0: launcher and native behavior**
- URLs: https://www.raycast.com/blog/a-technical-deep-dive-into-the-new-raycast, https://www.raycast.com/
- Files: `raycast-2-mac-launcher.png`, `raycast-2-overview.png`, `raycast-home-dark.png`
- Pattern: list rows with icon, white title, gray subtitle, alias and hotkey keycaps, and a right-aligned type ("Command", "Application"); small section headers ("Favourites", "Suggestions"); a footer with the primary action and its key (↵) and "Actions ⌘K". The post lists their desktop rules: no `cursor: pointer` on controls, no hover highlights on most controls, settings in a separate native window, popovers and tooltips as native windows, no flicker when views appear. (Seen.) Extracted from the homepage: background `#07080A`, Inter for text, Geist Mono for monospace, accent `#FF6363`.
- Why it is good: every row exposes its keyboard path, and the app avoids the small web habits that make a desktop app feel like a website.
- For Uplink Room: adopt the footer pattern (primary action + key, "Actions ⌘K") for selected runs, and adopt the no-pointer, no-hover rules in Electron.

**Vercel Geist: color scales by role**
- URL: https://vercel.com/geist/colors
- File: `vercel-geist-colors.png` (light theme)
- Pattern: 10 scales (gray, gray-alpha, blue, red, amber, green, teal, purple, pink, plus backgrounds). Within a scale, steps 1 to 3 are component backgrounds (default, hover, active), 4 to 6 are borders (default, hover, active), 7 and 8 are high-contrast backgrounds, 9 and 10 are secondary and primary text. Use solid gray by default and gray-alpha only where the background must show through; "draw each border once". (Seen)
- Why it is good: a color is chosen by job, so two designers pick the same step for the same element.
- For Uplink Room: define our tokens by role (surface, border, text, each with hover and active) before picking hues.

**Granola: a real typeface pairing for an AI product**
- URL: https://www.granola.ai/
- File: `granola-home.png` (light)
- Pattern: a large serif headline, an off-white notes window, an olive-green download button, small status lines in the product ("Transcribing", "Enhancing notes", "Generate notes"). Extracted: Quadrant for headings, Melange for body, primary `#B65B43`, accent `#E0C976`. (Page seen; font names extracted, not confirmed by hand.)
- Why it is good: the identity comes from type and a muted palette, with no gradients or glowing orbs.
- For Uplink Room: this is the strongest evidence that an AI tool can look distinct through a typeface choice alone. It is light-first, so take the method, not the colors.

## 3. Taste traits these products share

The three rejected brand directions are not in this repo, so the comparison below is against the current concept page, `concept/uplink-room.html`. That page uses the system font stack (`ui-sans-serif, system-ui, ...` and `ui-monospace, "SF Mono", ...`), about nine bright accent hues that match Tailwind's 400 shades (`#fbbf24`, `#f87171`, `#f472b6`, `#c084fc`, `#a3e635`, `#60a5fa`, `#4ade80`, `#38bdf8`), and no CSS transitions or animations.

1. **A chosen typeface, with roles.** Linear uses Inter Display for headings and Inter for text; Raycast pairs Inter with Geist Mono; Granola pairs Quadrant and Melange. The concept page uses whatever font the operating system supplies.
2. **Neutrals built from a system, with the accent kept out of them.** Linear derives every surface from base, accent, and contrast and deliberately limits how much blue leaks into the grays; Geist assigns each step a job. The concept page spreads eight saturated hues across the UI.
3. **Color means state, and state has a fixed vocabulary.** Geist's status dot has five named states, sentence-case labels, and rules against extra prose. Linear puts one status icon in the same place on every row. Our five run states need this treatment, with one loud color reserved for Waiting.
4. **Motion only for work in progress.** Geist animates the dot only while Building or Queued and forbids flashing through states; Linear shows "Working 00:12" with a ticking timer and dim step lines instead of a spinner. The concept page has no motion at all, so it cannot tell a running agent from a finished one at a glance.
5. **Dense rows with a fixed anatomy and a right edge for state and time.** Linear's inbox, Superhuman's list, and Raycast's launcher all use one-line rows where the far right holds age, state, or type, and read items dim. Discord ships Compact, Default, and Spacious so density is a setting.
6. **People and agents shown by face and name at the point of action.** Linear's inbox leads with teammates' faces plus a type badge; Tuple puts a name pill on each cursor; Discord nests call members under the voice channel; Linear shows an agent as an ordinary assignee chip, not a mascot.
7. **Keyboard paths printed in the interface.** Linear's context menu lists a key for each action, Superhuman teaches "Hit K to move up", and Raycast's footer shows the primary action's key and "Actions ⌘K".
8. **Plain, specific copy, including for agents and empty states.** "Worked for 32s", "Changed 5 files", "No unread notifications", "You're the only one in this huddle." Raycast adds desktop manners to the same idea: no pointer cursor, no hover highlights, no flicker.

## 4. File index

Mobbin (single-screen pages, images from `bytescale.mobbin.com`):
`mobbin-linear-web-inbox-snoozed-toggle.png`, `mobbin-linear-web-inbox-context-menu.png`, `mobbin-linear-web-inbox-empty.png`, `mobbin-linear-web-dark-mode.png`, `mobbin-linear-web-goal-task.png`, `mobbin-superhuman-dark-inbox.png`, `mobbin-superhuman-keyboard-tutorial.png`, `mobbin-superhuman-achievement-modal.png`, `mobbin-discord-web-voice-channel-two-users.png`, `mobbin-discord-web-voice-channel-lounge.png`, `mobbin-slack-web-huddle-started.png`, `mobbin-slack-web-huddle-in-progress.png`, `mobbin-cursor-web-screen.png`, `mobbin-github-android-filtered-notifications.png`

Product sites, blogs, changelogs, and docs:
`linear-redesign-new-ui-a.png`, `linear-redesign-new-ui-b.png`, `linear-redesign-after.png`, `linear-redesign-lch-vs-hsl.png`, `linear-redesign-contrast-30-vs-100.png`, `linear-redesign-light-dark-themes.png`, `linear-redesign-sidebar-alignment.png`, `linear-agent-coding-session-diff.png`, `linear-agent-coding-session-activity-completed.png`, `linear-agent-session-copilot-delegation.png`, `superhuman-split-inbox-help.png`, `cursor3-agents-window-file-view.png`, `cursor3-1-changelog-page.png`, `vercel-geist-status-dot.png`, `vercel-geist-colors.png`, `discord-2025-desktop-themes-density.png`, `discord-2025-call-controls-glow.png`, `discord-2025-refreshed-colors.png`, `raycast-2-mac-launcher.png`, `raycast-2-overview.png`, `raycast-home-dark.png`, `tuple-home.png`, `granola-home.png`

## 4. Agents as teammates (added after Julio named Grok Bot, Instinct, Muse and iMessage agents)

Read in full on 2026-11-01 unless marked otherwise.

**Grok Bot: Designing Grok Bot for a world of persistent agents** (xAI, Sep 3, 2026)
- URL: https://x.ai/news/designing-grok-bot
- Files: `grokbot-design-avatars.png`, `grokbot-design-avatar-motion.png`, `grokbot-design-steps.png`, `grokbot-design-computer-levels.png`, `grokbot-design-transcript.png`, `grokbot-avatar-*.png` (single avatar studies). The page screenshots were taken from the live article.
- Five primitives only: Bots, Chats, Prompts (once, saved as Skills, or run as Routines), Tools, Artifacts. Everything else stays beneath the interface.
- The sidebar is a roster of Bots, not a chat history. Each row: avatar, name, time, latest line ("Need your yes on the Friday all-hands deck").
- Avatars: one character system (simple shapes, expressive eyes, controlled variations and accessories), chosen after testing initials, emoji, pixel art, watercolor, clay, line art, silhouettes and identicons.
- State lives on the avatar as motion: idle, thinking, working, waiting, blocked, done. Hover shows the current action, because a one-line description made people want the whole log.
- The Bot's computer has three levels: status (title-bar icon lights while active), preview (pinned side panel), takeover (full screen, take control, hand back). More visible computers made people supervise instead of delegate.
- Transcript mixes prose, system events ("Created Routine Morning Briefing"), inline cards and widgets.
- Coordination: a "Chief of Staff" Bot routes work; they rejected dashboards, assignment boards and explicit handoff controls as more work for the user. Limits: about 50 Bots per account, six per group chat.
- For Uplink Room: state on the avatar plus our dot and label in dense lists; the three computer levels map onto Watch, preview and passing the wheel; inline approval cards in threads.

**Muse: How We Designed Muse** (Meta, Sep 2026)
- URL: https://introducing.muse.ai/
- Files: `muse-status.png`, `muse-goals.png`, `muse-checkout.png`, `muse-artifacts.png`, `muse-veda.png`
- One long main conversation plus side chats; you can send several tasks without waiting. Chat bubbles because proactive messages arrive out of turn and bubbles mark where one thought ends.
- Proactive messages with a high bar: only when meaningfully new or needing input.
- Each person creates, names and styles their own agent's avatar (the author's is "Veda").
- Under the avatar, a snippet of what it's doing; tapping shows the full activity log and approved permissions.
- Deterministic UI where conversation isn't enough: structured approval cards with accept and reject, secure credential storage. Defaults stop only for hard-to-undo actions, to avoid approval blindness.
- For Uplink Room: approval cards as fixed controls; a high bar for agent-initiated pings into the Inbox.

**Instinct and agents in your text messages**
- Instinct is an invite-only personal agent you text on iMessage or WhatsApp, or call; no app to install. (Snippet only: eesel.ai review, Eigent and Vellum write-ups, a YouTube interview. No first-party design write-up found.)
- TechCrunch, Oct 24, 2026: https://techcrunch.com/2026/10/24/all-the-ai-agents-that-can-live-in-your-text-messages/ lists Caddy, Iris (built on Hermes Agent), Miso, Tab and others. (Snippet only.)
- For Uplink Room: a later channel for answering the Inbox by text.
