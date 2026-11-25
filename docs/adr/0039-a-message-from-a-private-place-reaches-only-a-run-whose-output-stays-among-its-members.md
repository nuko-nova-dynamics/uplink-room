---
status: accepted
---

# A message from a private place reaches only a run whose output stays among its members

ADR 0026 lets anyone who can see a run message it, in any place, and ADR 0029 D4 lets a run join a direct message. But whatever a run hears shows in its output. A thread's view in the room shows a delivery as the user's message (ADR 0022), and Claude Code shows what its hooks hand it on the terminal's screen, which everyone who can watch the terminal sees (#144). The room checked who could see the run, not who could see the place a message came from. So a message from a direct message or private channel, sent to a run more people can see, became readable by all of them. The Codex review of #155 found this on 2026-11-05, and the lead decided the rule for v1 the same day: a message can't be both private and readable by a run whose output people outside the place can see.

## Decisions

- **A message from a direct message or private channel reaches a run only when everyone who can see the run's output, now and later, is a member of that place.** The room works out who can see a run's output from the rules that already decide who sees its texts (ADR 0015, ADR 0016). A run started from a direct message or private channel (`directChannelId`) is that place's alone, so it hears what is said there. A run from a direct message whose members are all in the place also hears it, since a direct message's members never grow. A team run is visible to the whole team, including whoever joins later, so it never hears a private place. Neither does a run from another private channel, because its members can add anyone. A message in a team channel reaches any run, since the whole team can read it anyway.
- **The same check covers every kind of run**, because it lives where the room routes a message (`lib/router.ts`) and where it hands one over (`lib/runDelivery.ts` for terminal and thread runs, `lib/joinedRuns.ts` for joined runs). A joined run (ADR 0032) is a team run: its session runs in the person's own terminal, which they may share.
- **A message the rule stops is failed at once, and the place says why.** It is in the run's inbox as `visible_outside`, and the place gets a line from the room: "Claude Code (Julio) is visible to people outside #launch, so it can't hear messages from here." The app shows the run's driver "this run is visible to people outside #launch, so it can't hear messages from there."
- **It is checked again at hand-over.** A message that waited can stop qualifying when someone leaves the place, and messages that waited from before this rule are checked the same way.

## Amendment, 2026-11-05: a direct message opened with a run delivers, and warns first

The rule above left a direct message opened with a team run (ADR 0029 D4) hearing nothing, which broke the app's "Message this run" and the choice that live runs can be members of direct messages. Julio decided the same day: deliver, but warn first.

- **A direct message opened with a run reaches that run**, even when people outside it can see the run's output: the whole team, for a team run. The sender picked that run to message, and the direct message tells them before they write. The room checks this where it routes and where it hands over (`hearsIn` in `lib/runLabels.ts`), for terminal, thread and joined runs alike.
- **It says so before anything is sent.** When the direct message opens, its first line is the warning, "Claude Code (Ana)'s output is visible to the whole team, so what you send here won't stay private." (for a run from another private place, "visible to people outside this direct message", so that place's name stays out of it). `channels.openDirect` returns each such run's `warning`, and `channels.list` gives it too. The app shows it in the direct message's header and as a standing note above its message box and above a thread's reply box, not as a dialog on each send; a reply box opened before the direct message's details load waits to send. "Message this run" and the new direct message picker show it for a team run (`runs.live` says `visibleToTeam`) before the direct message opens.
- **A sender who hasn't seen it is refused once.** An agent over HTTP or MCP can post without reading the history, and a key with only `messages.post` can't read `channels.list` or `messages.list`. So each sender's first `messages.post` in such a direct message fails with `warning_required`, whose message is the warning and says to post again with `acknowledgeWarning: true`; nothing reaches the run. Once a sender has acknowledged it there, their posts go without it. The app acknowledges it when it sends from under the note. A run posting as itself isn't asked, since what it posts is its output. Returning the warning with a post that went through was the other option, but by then the message has reached the run.
- **A direct message from before this gets the line once.** One opened with a team run before the warning existed has no warning line, and may show the old refusal. When it is opened again or posted in, the room adds the line, once (`channelRuns.warnedAt`), before the next message reaches the run.
- **Every other private place keeps the strict rule.** A private channel that mentions a team run still doesn't reach it and still gets the line saying why, and so does a direct message that addresses a run it wasn't opened with.

## Considered options

- **Checking only the run's own access**, as before. That is what leaked.
- **For a direct message opened with a team run: a dialog on each send**, instead of a standing note. It would ask the same question every message and train people to click through it.
- **Treating any private place that names a run as chosen**, as with a direct message opened with it. A mention in a private channel is easy to write without thinking of who watches the run, and the channel's own members never agreed to it.
- **Hiding a delivery's text from the thread view and the terminal.** The room can drop an item from a thread's view, but not text from a terminal's screen, and the agent may quote the message in its answer anyway.
- **Comparing members only at the moment of delivery**, so a run from a private channel whose members are all in the place would hear it. Someone added to that channel later would see the run's output, and with it a message from a place they aren't in.

## Consequences

- This amends ADR 0026 (anyone who can see a run can message it). As first decided it also amended ADR 0029 D4, so a team run in a direct message opened with it heard none of it; the amendment of 2026-11-05 restores D4, with the warning in its place.
- `driver_changed` mostly no longer happens for a private place, since a run that hears one is that place's own or a direct message's, and its wheel stays among their members (ADR 0016). The check stays as a second guard.
- Pairs (ADR 0034) are outside this rule: a pair's messages reach only its joined runs, whose sessions belong to the pair's people.
