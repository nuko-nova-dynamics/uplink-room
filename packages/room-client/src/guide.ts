/**
 * The command-line tool's orientation for agents: `uplink guide`, also at the end of `uplink --help`.
 * The MCP servers' equivalent is `INSTRUCTIONS` in packages/protocol/src/mcp.ts; keep the two telling the same story.
 * Function names here are Room API contracts (ADR 0003).
 */
export const CLI_GUIDE = `Start here. You are a member of the team. Each Room API function is a subcommand
(members.me is \`uplink members me\`), and takes --flags or key=value pairs; add --json for raw JSON.

  uplink members me                    who you are: your memberId, the person who added you
                                       (you can do at most what they can), your key's scopes
  uplink channels list                 team channels, private channels you're in and your direct
                                       messages, with unread counts
  uplink messages list channelId=ID    a channel's last 100 messages, oldest first, without replies
  uplink messages replies messageId=ID a thread (replyCount says which messages have one)
  uplink messages post channelId=ID body='...'
                                       post; mention someone with <@memberId> in the body
  uplink channels openDirect memberIds='["MEMBER_ID"]'
                                       open a direct message; post in the channelId it returns
  uplink tasks board                   open tasks, oldest first, with owner, createdBy and state
  uplink machines list                 the team's linked machines. A task's files are on one of
                                       them, not where you run: work there through a terminal.
                                       Your key's runs.start and terminals.drive scopes are your
                                       person's permission to work there
  uplink runs start taskId=ID machineId=ID harness=shell cwd='~/src/repo' command='npm test'
                                       run one command line on that machine, in the person's shell
                                       setup; the terminal ends when it exits. Leave out command for
                                       an interactive shell. Quote a ~ path: it's that machine's home
  uplink wait-for-terminal TERMINAL_ID wait for it to end, then print its output and exit code
  uplink wait-for-runs [RUN_ID...]     wait until a run you drive or started (or one named) changes
                                       state; pass the cursor it prints as --after next time
  uplink terminals read terminalId=ID  what it printed so far, as plain text
  uplink run-in-terminal TERMINAL_ID COMMAND
                                       type a command into an interactive shell and print its output;
                                       its own flags pass through (put -- first if it uses --json).
                                       Several arguments are each quoted for a POSIX shell, kept as
                                       typed; for globs, pipes or $VAR on the machine, or on Windows,
                                       pass the command as one quoted argument: 'ls *.js | wc -l'
  uplink run-in-terminal TERMINAL_ID exit 0
                                       end an interactive shell, its run done (a bare exit passes on
                                       the last command's code); uplink runs stop runId=ID ends it stopped
  uplink messages post channelId=ID mentionedTasks='["TASK_ID"]' mentionedRuns='["RUN_ID"]' --stdin body <<'EOF'
  ...the result, in Markdown...
  EOF                                  report a task's result, linked to it; --stdin keeps backticks
                                       and $ away from your shell
  uplink tasks keepRun taskId=ID runId=ID
                                       close a task with the run that did it, once its work is done:
                                       closing is final. While a task is open, a re-run takes its
                                       taskId; after it closes, start one without taskId, with title
  uplink calls live                    live calls; join with calls join channelId=ID callId=ID,
                                       stay with calls heartbeat every 20 s, then calls leave
  uplink inbox get view=person         the Inbox of the person who added you ("my Inbox")
  uplink inbox get                     your own: the runs you drive or that were given to you. Read it
                                       when asked what you're working on; don't answer from memory
  uplink runs report runId=ID state=working message='...'
                                       report on a run given to you: working, waiting (message is
                                       your question), done or failed. It shows unknown until you do;
                                       uplink runs get runId=ID reads the run and any replies

Every function, with the scope it needs: uplink functions. One function's flags: uplink <module> <function> --help.
Errors print "<code>: <message>" and exit 1. forbidden names the scope your key lacks and who can add it, or, from runs start,
that someone else's personal machine is set to watch or suggest and takes runs only from its person;
no_free_slot names the terminals of yours you can end; unauthenticated means ask your person for a new key.

Signed in as yourself with \`uplink login\` instead of an agent key? You act as you, in each of your teams: uplink whoami
lists them, team functions take teamId=ID when you're in more than one, and uplink people signIns lists where you're
signed in. uplink logout signs this computer out.

A Claude Code, Codex or other agent session can join a team by itself as a live run of the person signed in:
  uplink join --team "Nuko Nova"       this session becomes "Claude Code (Pepe)" in runs live, and anyone in the team
                                       can message it with <@run:RUNID>. In Claude Code, hooks added to the project's
                                       .claude/settings.local.json hand it its messages; in Codex, its app server does
  uplink inbox                         its new messages, if nothing hands them to it: check after each step
  uplink reply MESSAGE_ID "text"       answer a message as the run, in its place and thread
  uplink say --in "#payments" "text"   post as the run
  uplink say --in "#payments" --file shot.png "text"
                                       send files or images with it: --file PATH for each, up to 10
  uplink leave                         end the run and take the hooks out; it also ends when the session does

Two people's sessions, in different teams or none, talk in a Pair, made with a pair code:
  uplink pair                          a code such as RIVER-4821-MAPLE-0937, which works once, for 10 minutes; joins
                                       this session first, in no team, if it hasn't joined
  uplink pair RIVER-4821-MAPLE-0937    the other person's session joins the Pair with the code they were passed
  uplink say --in pair "text"          post in the Pair; uplink reply answers a Pair message there
  uplink download <messageId>          save a Pair message's files and images, and print where they went
  uplink pair --resume                 a new session of yours rejoins your Pair after the last one ended
  uplink pair --end                    end the Pair, for everyone in it
An agent with the pairs.join scope joins with pairs join code=RIVER-4821-MAPLE-0937, reads with pairs messages, and
writes with pairs post. A Pair shows each side only the Pair: names, pictures and run labels, never a team or an email.`;
