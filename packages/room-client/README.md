# @uplink-room/room-client

Three ways to reach the Room API from outside the app: a TypeScript client, an MCP server (`uplink-mcp`) and a command-line tool (`uplink`). All three call the two HTTP endpoints the backend serves, so they offer every Room API function, including ones added later, with no change here.

You need two things:

- `UPLINK_URL`: the Convex deployment's site URL. For the local dev deployment that is `http://127.0.0.1:3211`.
- A credential, one of:
  - `UPLINK_AGENT_KEY`: an agent key. A person who added the agent creates it with `agents.createKey`, which returns the secret once. The key's scopes limit what the agent can do.
  - A CLI sign-in: you run `uplink login` and sign in with Clerk in the browser, and the tools act as you, in any of your teams or in none (ADR 0030). See [Signing in as yourself](#signing-in-as-yourself).

Both programs are TypeScript files that run directly on Node 24 or later. Below, `ROOM_CLIENT` is the path to this package, such as `~/Projects/uplink-room/packages/room-client`.

## From the Uplink Room app

The desktop app carries both programs, so a computer with only the app installed needs nothing else (ADR 0042). Its build bundles `src/cli.ts` and `src/mcp.ts` into the app (`out/main/uplink.js`, `uplink-mcp.js`), and launchers beside `uplink-bridge` in its `resources/bin` run them on the app's own Electron as Node (`ELECTRON_RUN_AS_NODE=1`). **Settings, Command line, Add to PATH** (or Settings, Setup, which is the same step) puts `uplink-bridge`, `uplink` and `uplink-mcp` on PATH together: links in `/usr/local/bin` on macOS, with one administrator prompt when that folder needs one; the bin folder first in the user's PATH on Windows. The .deb links all three in `/usr/bin` when it installs.

```sh
uplink login                       # no --url: the app's copy knows its room
uplink skills install              # the uplink skill, for Claude Code (~/.claude/skills) and Codex (~/.agents/skills)
uplink skills install --claude     # only one of them: --claude or --codex
uplink mcp install claude          # claude mcp add --scope user uplink -- <the app's uplink-mcp>
uplink mcp install codex           # codex mcp add uplink -- <the app's uplink-mcp>
uplink mcp install hermes          # hermes mcp add uplink --command <the app's uplink-mcp>
```

- **Which room.** A release build of the app (test-channel builds included, since they are built the same way and talk to the same deployment) defaults to the production deployment's site URL; a development build to the deployment its `.env.local` names. `--url`, `UPLINK_URL` and a saved sign-in still come first. Run from source, there is no default.
- **The skill** (`skills/uplink/SKILL.md`, shipped in the app's `resources/skills`) teaches an agent to check the sign-in, join, pair, hear messages, answer with `uplink reply` and `uplink say`, and leave. `skills install` replaces an earlier copy whole. Settings, Command line shows whether each copy is there and current, with Install or Update.
- **The MCP server.** `mcp install` removes an earlier server named `uplink`, then runs the harness's own `mcp add` with the app's `uplink-mcp` launcher (on Windows through `cmd /c`, since it's a `.cmd`). `--channel` adds `uplink-mcp --channel`. Settings, Command line has the same action for Claude Code, Codex and Hermes, and runs it on the PATH a new terminal has.
- **Hooks and the keeper.** The launchers set `UPLINK_BIN_DIR`, and `uplink join` then writes hooks that run the launcher itself (exec form; on Windows a command for Claude Code's Git Bash with the launcher's forward-slashed path), since a hook's environment has no `ELECTRON_RUN_AS_NODE`. The keeper runs the bundled script on the app's Electron with that variable set; the commands themselves take it out of their own environment, so nothing they start inherits it.

## Start here

An agent is a team member (ADR 0003). Its first call should be `members.me`: it returns the agent's `memberId` (what `<@memberId>` mentions and the `driver`, `author` and `owner` fields use), its `agentId`, the person accountable for it (`addedBy`), and the key's scopes and the ones it lacks. A call that needs a missing scope fails with `forbidden`, and the message names the key and who can add the scope: only the person who added the agent can change its keys, in the app under Settings, Agents, or with `agents.setKeyScopes`.

Give a key the scopes for the jobs it does, and no more:

| Job | Scopes |
| --- | --- |
| Read channels, direct messages, tasks, runs, machines and terminals | `room.read` (every key needs it) |
| Post and reply, open direct messages, react | `messages.post` |
| Create and change tasks, file runs, close a task (`tasks.keepRun`) | `work.manage` |
| Open and stop terminals and runs (`runs.start`, `runs.stop`) | `runs.start` |
| Type in a terminal, or run a command in one | `terminals.drive` (with `runs.start` to open the terminal) |
| Join and leave calls | `calls.join` |
| Write a call's transcript and notes, and propose tasks from it (a notetaker) | `calls.notes` |
| Answer a run's approval | `approvals.answer` |
| Start, join and drive shared browsers | `browsers.use` |
| Drive Spaces: take Space actions, suggest, take or pass the wheel | `spaces.drive` |
| Invite people and connect agents' A2A endpoints | `people.invite` |
| Join Pairs with a pair code, and read and write in them, with people outside the team | `pairs.join` |
| Change machine settings, link or unlink machines, share Spaces | `machines.manage` |
| Change team settings and make admins | `team.admin` |

`uplink functions` (or the MCP tool list) shows every function with the scope it needs. Over MCP, a tool whose scope the key lacks says so at the end of its description, with who can add it; in the CLI, module help marks those functions `[your key lacks <scope>]`. The room checks every call either way.

## MCP server

`uplink-mcp` speaks MCP over stdio. It lists one tool per Room API function, with the function's description and input schema, and each argument's description says what it is and where its ids come from. Dots in a function name become underscores, so `tasks.create` is the tool `tasks_create`. A Room API error comes back as a tool error that starts with its code, such as `forbidden: ...`; a function that returns nothing answers `ok`.

The server's MCP `instructions` give the agent a short orientation (`INSTRUCTIONS` in `src/mcp.ts`): start with `members_me`, how chat, tasks, terminals, calls and the Inbox fit together, and what each error code means. Three tools aren't Room API functions: `upload_attachment` uploads a local file for a message (see Chat below), `run_in_terminal` runs a command in a terminal and returns what it printed, and `wait_for_terminal` waits for a terminal to end and returns its output and exit code (see Work below).

From the app, `uplink mcp install claude|codex|hermes` does this for you ([above](#from-the-uplink-room-app)). From source, Claude Code:

```sh
claude mcp add uplink -e UPLINK_URL=http://127.0.0.1:3211 -e UPLINK_AGENT_KEY=<agent key> -- node ROOM_CLIENT/src/mcp.ts
```

Codex:

```sh
codex mcp add uplink --env UPLINK_URL=http://127.0.0.1:3211 --env UPLINK_AGENT_KEY=<agent key> -- node ROOM_CLIENT/src/mcp.ts
```

Hermes:

```sh
hermes mcp add uplink --command node --env UPLINK_URL=http://127.0.0.1:3211 UPLINK_AGENT_KEY=<agent key> --args ROOM_CLIENT/src/mcp.ts
```

Any other MCP client works the same way: run `node ROOM_CLIENT/src/mcp.ts` as a stdio server with the two environment variables set.

Without `UPLINK_AGENT_KEY`, the server uses what `uplink login` saved, so after you sign in as yourself it needs no environment at all: `claude mcp add uplink -- node ROOM_CLIENT/src/mcp.ts`. It then acts as you, its instructions say so and start with `people_me`, and tools whose description ends with "(account: for the signed-in person, in no team)" work with no team.

The server lists one tool per Room API function (`uplink functions` lists them). To list fewer, set `UPLINK_MCP_TOOLS` to modules or functions, comma-separated: `UPLINK_MCP_TOOLS=members,channels,messages,tasks,runs,terminals,machines,calls,inbox` covers the work the instructions describe. The client-side tools are always listed. Whether a shorter list lowers an agent's cost per turn is untested.

## Command-line tool

```sh
node ROOM_CLIENT/src/cli.ts login --url http://127.0.0.1:3211 --key <agent key>
```

`login` saves the address and key to `~/.uplink-room/cli.json` with mode 0600. Set `UPLINK_HOME` to use another directory. `UPLINK_URL` and `UPLINK_AGENT_KEY` override the saved values, which is what a CI job should use instead of `login`. A saved key or sign-in goes only to the deployment it was saved for: with `UPLINK_URL` set to another one and no `UPLINK_AGENT_KEY`, the tool and `uplink-mcp` refuse and say how to sign in there. The address must be `https://`, or plain `http://` to 127.0.0.1, ::1 or localhost, since a key sent over plain HTTP can be read on the network.

### Signing in as yourself

```sh
uplink login --url https://<deployment>.convex.site   # opens your browser; sign in with Clerk
uplink whoami                                           # who you are, and your teams with their teamIds
uplink people signIns                                   # the computers where you're signed in
uplink logout                                           # revoke this computer's sign-in and forget it
uplink logout --pending                                 # revoke sign-ins a login replaced but couldn't revoke then
```

`login` without `--key` opens Clerk's sign-in in your browser and waits for it on `127.0.0.1`, on a port the system picks (OAuth's authorization code flow with PKCE, RFC 8252). Clerk asks you to allow "Uplink Room command line". The room then gives this computer a CLI sign-in, and `login` saves only that token (`urs_…`) in `cli.json`, mode 0600; it never prints it, and it revokes Clerk's own tokens. A CLI sign-in lasts 30 days. Signing in again, or `login --key`, revokes the sign-in it replaces. If the room can't be reached to revoke it, `login` says so and keeps that sign-in in `cli.json` until `uplink logout --pending` (or `uplink logout`) revokes it.

- `--device`: for a computer with no browser, such as one you reach over SSH. `login` prints a link and a code; open the link on any device, enter the code and approve (RFC 8628). Only approve a code you got from your own terminal.
- `--no-browser`: print the link instead of opening it. Open it in a browser on this computer, since the sign-in comes back to this computer's `127.0.0.1`.
- `--name <name>`: what to call this computer's sign-in in `people.signIns` (default: its host name).

Signed in as yourself, you act as you: team functions run as your member in the team, with your rights, and take `teamId`, which you can leave out when you're in exactly one team (`uplink whoami` lists them). Account functions (`uplink people me`, `people signIns`, `people revokeSignIn`) work with no team. A deployment that takes CLI sign-ins needs `CLERK_CLI_CLIENT_ID` (ADR 0030); without it `login` says so, and agent keys still work.

With the package's bin linked, the examples below start with `uplink`.

An agent that uses the command-line tool gets no MCP instructions, so tell it to run `uplink guide` first, or put that text in its prompt. To pass text with backticks or `$`, such as a Markdown message body, use `--stdin <argument>` with a quoted heredoc, so your shell never expands it: `uplink messages post channelId=<id> --stdin body <<'EOF'`. The guide (also at the end of `uplink --help`) lists the functions most work needs and how they fit together, in the same order as the MCP server's instructions.

```sh
uplink functions                                   # name, kind, scope, description
uplink tasks create --title "Fix login"            # one subcommand per function
uplink messages post --channel-id <id> --body "Deployed 0.4.2"
uplink call tasks.create title="Fix login"         # any function by name
uplink call tasks.create --args '{"title": "Fix login"}'
uplink tasks create --help                         # the function's flags
```

- Subcommands and their flags are built at run time from the function list. `camelCase` arguments become `--kebab-case` flags. A flag's value is converted using the function's schema: numbers become numbers, and arrays and objects are read as JSON.
- A subcommand also takes `key=value` pairs, as `call` does: `uplink messages list channelId=<id>` is `uplink messages list --channel-id <id>`. A pair is converted the same way as a flag. `title=2024` stays the string `"2024"` when the function takes a string. With `call` and a function it does not know, a value that parses as JSON is used as JSON.
- An argument that takes one of a few values lists them in `--help`, such as `--harness` for `runs start`. A module's help (`uplink inbox --help`) shows each function's required arguments and those choices on its line, such as `get [view=mine|person|team]`. An unknown function prints its module's list.
- `--args '<json>'` gives all arguments at once. Flags and `key=value` pairs override it.
- `teamId` is optional with an agent key: the key's team is used. With a CLI sign-in it's optional when you're in exactly one team. The built-in commands take it as `--team-id`: `upload` needs it when you're in several teams, and `run-in-terminal` and `wait-for-terminal` find the terminal's team themselves.
- Output is readable by default. `--json` prints the raw result as one line of JSON, and prints errors as `{"ok":false,"error":{"code","message"}}` on stderr.
- On an error the tool exits with 1 and prints `<code>: <message>` on stderr.

### Joining a session to a team

Signed in as yourself, any Claude Code or Codex session, even one not started through Uplink Room, can join one of your teams as a live run of yours (ADR 0027, ADR 0032). Have the agent run, in its session:

```sh
uplink join --team "Nuko Nova" --title "payments migration"   # the session becomes "Claude Code (Pepe)"
uplink inbox                                                   # its new messages, delivered once printed
uplink reply <messageId> "migrated 40 of 52 tables"            # answer one, in its place and thread
uplink say --in "#payments" "done"                             # post in a place
uplink say --in "#payments" --file out/chart.png "the chart"   # send files with it, --file for each (ADR 0047)
uplink leave                                                   # end the run, take out the hooks
```

- The run starts closed: only you and your agents see it in `runs.live` (`via: "joined"`) and can message it, and for the rest of the team it isn't there. `uplink join --open`, or `uplink open` later, opens it so anyone in the team can message it with `<@run:RUNID>`; `uplink close` hides it again (ADR 0044). It shows Unknown, never in anyone's Needs you. It ends with `uplink leave`, when the session ends, when someone stops it with `runs.stop`, when your sign-in is revoked or expires, or two minutes after its heartbeat stops.
- `join` uses your sign-in once and gets the run its own token (`urj_…`), kept in `$UPLINK_HOME/joined/` with mode 0600. `inbox`, `say`, `reply`, `leave` and the hooks use only that token, which can do nothing but act as the run. `join` finds the session by `CLAUDE_CODE_SESSION_ID` or `CODEX_THREAD_ID`; for another agent pass `--harness <name>`, and it reads its messages with `uplink inbox`.
- **Only the session acts as itself.** `join` records the session's harness process (Claude Code's or Codex's own process, found in the system's process list: `ps` on macOS and Linux, `Get-CimInstance Win32_Process` on Windows). `inbox`, `say`, `reply`, `leave`, the hooks and the channel then act as the session only from a process whose parents include that one, so another program of yours can't act as a session by setting its session id. Any program the session's harness starts still can, such as a command the agent runs.
- `join` starts a small keeper process for the session: it sends the run's heartbeat every 30 seconds and ends the run when the harness process exits. If `join` found no harness process, the keeper ends the run 12 hours after the join, and `join` says so.
- **Claude Code** hears through hooks that `join` adds to the project's `.claude/settings.local.json`, where Claude Code reads it: at the repository root in a git repository, the main checkout's for a worktree, and otherwise (or on Windows) in the folder Claude Code started in. A file `join` makes is kept out of git through the repository's `info/exclude`. The hooks hand the session its messages after each tool call during a turn (`PostToolUse`), and while the session is idle a waiter with `asyncRewake` started by `Stop`, `StopFailure` (a turn that ended in an API error) or `SessionStart` wakes it. A subagent's hooks take nothing. Claude Code picks the hooks up without a restart. A session started with `--setting-sources` that leaves out `local` gets them in `.claude/settings.json` in the folder it started in, where Claude Code reads that file, and `join` says so. `--no-hooks` adds none; joining again with `--no-hooks` or `--channel` takes out the hooks the earlier join added, and another joined session's hooks in the same file stay. Joins and leaves in one project take turns with the file (a lock beside it, `<file>.uplink-lock`). In auto mode, Claude Code may ask before `uplink reply` and `uplink say`, which write to the room; a permission rule such as `Bash(uplink reply:*)` allows them.
- **Claude Code with a channel**: run the MCP server as `uplink-mcp --channel` (or `UPLINK_MCP_CHANNEL=1`) and start Claude Code with `--dangerously-load-development-channels server:<its name>`, the name your MCP config gives it. `join` uses the channel, and adds only a `SessionEnd` hook, when that flag names this server; a flag that names only other servers leaves the session on hooks. `--channel` forces it.
- **Codex** hears through its app server: a running turn gets the message with `turn/steer`, an idle session with `codex queue --resume`. A Codex started with `--no-daemon` has no app server, so it reads `uplink inbox`.
- **A message is delivered once the session has it.** `joined.take` claims messages, and `joined.ack` delivers them once they are in front of the session: a hook's output written, the waiter's wake text written, `uplink inbox` printed, a channel notification sent, Codex's steer or queue done. A channel or Codex delivery that fails puts them back (`joined.release`). A claim nobody answers within two minutes, such as one taken by a hook Claude Code stopped reading, comes once more, then fails as `unsure` in `runs.inbox`. Codex and channel delivery go on until nothing waits, and retry a failure after a pause of 1 to 30 seconds.
- Without `--team` the session joins in no team (ADR 0029 D13): it isn't a run in any team and can only pair, below.

### Pairing with runs in other teams

Two people's sessions, in different teams or in none, talk in a Pair (ADR 0027, ADR 0034): a private conversation of 2 to 10 runs and agents, plus their people. Everyone in it is signed in.

```sh
uplink pair                          # in Julio's session: prints a pair code, such as RIVER-4821-MAPLE-0937
uplink pair RIVER-4821-MAPLE-0937    # in Pepe's session, once Julio passed the code on
uplink say --in pair "which schema are you on?"   # post in the Pair; uplink reply <messageId> answers in it
uplink pair --resume                 # a new session of Pepe's rejoins, after his last one ended
uplink pair --end                    # either person ends it, for everyone
```

- `uplink pair` joins the session first, in no team, if it hasn't joined; then the session hears the Pair's messages the way it hears any (hooks, a channel, Codex's app server, or `uplink inbox`), each labelled with who sent it and the person accountable for it.
- **A pair code is a bearer secret for 10 minutes.** It is two of 256 words, each followed by four random digits (about 42.6 bits). The room keeps only its SHA-256, and it works once: Convex runs each join as one transaction, so two joins with one code can't both use it. A wrong, used or expired code counts against the person trying it (an agent's: its person), and after 10 in an hour no code works for them until the hour is over. Pass it on however you like, but only to the person whose run or agent should join.
- **Each side sees only the Pair**: people's names and pictures, runs' labels, agents' names, under ids that exist only in the Pair. Never an email, a team, or anything in one. A run token from a Pair reaches only the `joined.*` run functions, as any run token does; a session in no team posts only in its Pairs.
- **A Pair belongs to its people.** A run that ends leaves it; the Pair lasts until one of its people ends it (`uplink pair --end`, `pairs.end`). The people read and write it with their sign-in or in the app: `uplink pairs list`, `uplink pairs messages --pair-id <id>`, `uplink pairs post`.
- **A Pair message carries files** (ADR 0048): `uplink say --in pair --file crash.png "the crash"` sends them, from a run in a team or in none. A run that hears a Pair message with files is told to save them with `uplink download <messageId>`, which puts them in a new folder only you can open in the system's temp folder (or `--dir`, never overwriting what's there) and prints each path. The people send them from the app's Pair box, and an agent or a sign-in with `pairs.attachUrl` and `pairs.post`; each look at one goes through a 10-minute link from `pairs.attachmentLink`, which stops working once whoever asked has left the Pair.
- **An agent joins with a code its person passes on** (ADR 0029 D11), with its agent key and the `pairs.join` scope, which no key has by default: `pairs.join {code}`, then `pairs.messages`, `pairs.post`, `pairs.markRead` and `pairs.leave`. Every message in the Pair is for it: `pairs.list` counts what it hasn't read. Its key still reaches nothing outside its own team.

### In CI

```sh
export UPLINK_URL=https://<deployment>.convex.site
export UPLINK_AGENT_KEY=...        # from the CI system's secret store
node ROOM_CLIENT/src/cli.ts messages post --channel-id "$CHANNEL_ID" --body "Deployed $GITHUB_SHA"
```

Give the CI key only the scopes it needs, such as `messages.post`.

## HTTP

Without this package, call the endpoints directly:

```sh
curl -s "$UPLINK_URL/api/v1/functions"             # every function, with its JSON Schema

curl -s "$UPLINK_URL/api/v1/call" \
  -H "Authorization: Bearer $UPLINK_AGENT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"fn": "messages.post", "args": {"channelId": "<id>", "body": "Deployed 0.4.2"}}'
```

A call returns `{"ok": true, "result": ...}`, or `{"ok": false, "error": {"code", "message"}}` with a 4xx status. Codes: `unauthenticated` (401), `forbidden` (403), `not_found` (404), `invalid` (400), `conflict` and `no_free_slot` (409).

The bearer can also be a CLI sign-in's token (`urs_…`), which acts as its person. Each function in `/api/v1/functions` has a `realm`: `team` functions take `teamId`; `account` functions take none, have the scope `account`, and refuse agent keys with `forbidden`; `pair` functions (`pairs.*`, ADR 0034) take no `teamId` and work for a CLI sign-in or for an agent key with the `pairs.join` scope; `run` functions (`joined.*`) take only a joined run's token (`urj_…`), which every other function refuses with `forbidden`. `uplink login` makes the sign-in with two calls that take no credential: `POST /api/v1/cli-sign-in` returns Clerk's issuer, the client ID, the scopes and a nonce, and after the person signs in, `POST /api/v1/cli-sign-in/token` with `{ "idToken", "name" }` returns `{ token, signInId, expiresAt, person }`, the token once. Both answer `not_configured` (503) on a deployment without `CLERK_CLI_CLIENT_ID`.

### Files

Docs and HTML pages are text: read them with `files.get` and change them with `files.edit`, passing the `version` you read so you never overwrite someone's edits (a stale save returns `conflict`). PDFs and images take three steps, since their bytes don't go through a function call:

```sh
call() { curl -s "$UPLINK_URL/api/v1/call" -H "Authorization: Bearer $UPLINK_AGENT_KEY" \
  -H "Content-Type: application/json" -d "$1"; }
up=$(call '{"fn": "files.uploadUrl", "args": {}}')
url=$(echo "$up" | jq -r .result.uploadUrl); upload=$(echo "$up" | jq -r .result.uploadId)
id=$(curl -s "$url" -H "Content-Type: application/pdf" --data-binary @report.pdf | jq -r .storageId)
call "{\"fn\": \"files.addUpload\", \"args\": {\"projectId\": \"<id>\", \"name\": \"report.pdf\", \"uploadId\": \"$upload\", \"storageId\": \"$id\"}}"
```

The `uploadId` ties the bytes to your team and to you: `files.addUpload` takes them only from the member who asked for that upload URL, only if they were stored after it was issued, and only once. `files.get` on a PDF or image returns a download `url`. Pin comments with `comments.add`; its description lists each kind of pin.

### Chat

Agents use the same chat functions as people (spec #63). `uplink functions` prints each one with its full description.

- Post with `messages.post`. Mention a person or an agent with `<@memberId>` in the body (member ids come from `teams.members`), or list them in `mentionedMembers`. `mentionedAgents` is the older name for the same list and still works. Agent keys can't use `@everyone`.
- Change your own messages with `messages.edit` and `messages.delete`. React with `messages.react` and `messages.unreact` (one emoji each), and pin with `messages.pin`, `messages.unpin` and `channels.pins`.
- Page back through a channel with `messages.list`: pass `cursor: null`, then each page's `continueCursor`, until `isDone`. Without a cursor it returns the older form, the last messages oldest first. `messages.around` opens at one message.
- Find earlier messages with `messages.search` (the channels and direct messages your agent can see), and watch what is asked of your agent with `messages.addressed`.
- Talk privately with `channels.openDirect`. Your agent reads and posts only in the direct messages it is in.
- Private channels (ADR 0016) are channels only their members see. Create one with `channels.createPrivate`, list who is in it with `channels.members`, add people or agents with `channels.addMembers`, and take someone out with `channels.removeMember` (its creator, or an admin in it) or yourself with `channels.leave`. Your agent sees a private channel only while it is a member: an agent key with `room.read` gets `not_found` for one it isn't in, and search never returns its messages. Creating one and adding members need `work.manage`; leaving needs only `messages.post`. Attachments in direct messages and private channels have no lasting `url` or `downloadUrl`: call `messages.attachmentLink {messageId, attachmentIndex}` for a link that works for ten minutes, and only while your agent is still in the channel. On the command line: `uplink channels createPrivate --name release-notes --member-ids '["<memberId>"]'`.

To attach a file, upload it first. The command-line tool and the MCP server do it in one step:

```sh
uplink upload build.log                            # prints { uploadId, storageId, name }
uplink messages post --channel-id <id> --body "Nightly build" --attachments '[<that object>]'
```

Over MCP, the `upload_attachment` tool takes a file's path on the agent's machine (and `teamId`, as team functions do) and returns the same object; pass it in `messages_post`'s `attachments`. Over HTTP, call `messages.attachUrl` and POST the bytes as for project files above. Images (PNG, JPEG, GIF, WebP) up to 20 MB and PDFs up to 50 MB show in the app, and their content type must match the extension. Other files up to 50 MB are offered only as downloads, and SVG is refused.

### Agents you talk to over A2A

An agent the team reaches over A2A (Hermes, OpenClaw, any A2A 1.0 or 0.3 gateway; `a2a.connect`) is talked to in chat, as a person talks to a bot (ADR 0024). For an agent built against the room, and for Room API callers watching it:

- Each place is one conversation with an agent: a channel's top level, a thread, or a direct message. A run on a task, or one started with `runs.start`, has its own. The room keeps the agent's A2A `contextId` for the conversation: while the agent's task is open, the next message goes to that task's `taskId`; once it finished, the next message starts a new task in the same `contextId`, with `referenceTaskIds` naming the last task. Each task is a run.
- What reaches the agent: in a direct message, every message; at a channel's top level, messages that mention it; in a thread, replies that mention it, and every reply in a thread that hangs off the agent's message or that it opened.
- Every message the room sends carries what was said in its place since the agent last heard from it: a second text part headed "Earlier in …", and the same lines in the metadata as `uplinkRoom.history` (`{ author, text, at }`, oldest first, at most 20 messages and 4,000 characters). Until the agent has answered in a context the room sent, it gets the place's recent messages, its own included.
- The agent's answer goes where it was called, as a message from its member: its last status message and its artifacts' text (each once), the artifacts' links, and file parts with bytes as attachments. A question (input required) is its message too, and the person answers in chat. Progress is a status message with text, at most 10 per run. A failure, a rejection or a message the agent refused shows as a centered line (`system: { kind: "run", runId, text, tone }`). The agent's messages name their run in `a2a.runId`; the message that started a run lists it in `a2aRuns` as well as `mentionedRuns`. While the agent works, `channels.whoIsTyping` lists it with `working: true`. An unfiled run whose answer was posted in chat settles itself (`inbox.get` leaves it out of Done); a failed run or a question stays.
- To propose a thread of its own, the agent sends a data part `{ "kind": "uplink.room/propose-thread", "title": "Q3 migration" }`, or the message metadata key `uplink.room/propose-thread` (`{ "title": … }`), or, if it answers only text, the first line `uplink.room/propose-thread: Q3 migration`. Every message that starts a task in a channel or direct message lists `"propose-thread"` in its metadata under `uplink.room/capabilities`. People answer with Yes or No (`messages.answerProposal {messageId, open}`; an agent key needs `runs.start` for it, since the answer goes to the agent), and nobody answering within 30 seconds counts as Yes. A proposal whose run was stopped, or which was deleted, or whose message to open under was deleted, ends `canceled` with a `reason`, and no thread opens. The agent is told as the conversation's next message, with `uplink.room/thread-decision: { open, byTimeout }` in its metadata; after a Yes its answers go in the thread under the message that started the work.
- `runs.reply` sends to the run's open task, or after it finished, continues the conversation as a new run: it returns `{ runId }`, the run the reply went to. On a run from chat, the reply is posted there as your message.

### Work: tasks, runs and terminals

A task is a piece of work a person owns. `tasks.board` lists the open ones oldest first; each card has its `owner`, `createdBy` (who made or assigned it), `createdAt`, its runs, and a `state` and `column` that come from its runs: `not_started` until its first run. Work on a task happens in a run: one terminal, T3 Code thread or Space on a machine, or work sent to an A2A agent.

To run something on a machine, open a terminal with `runs.start` and drive it. Over MCP:

1. `machines_list`: pick an `online` machine, and note its `machineId`. A terminal an agent starts always uses one of the machine's `slots`. A personal machine that belongs to someone other than your person takes runs only while its `mostOpenAccess` is `drive` or `open`: at `watch` or `suggest`, only the person it belongs to and their agents can start runs there, and `runs_start` is refused with `forbidden`. A team machine takes runs from anyone on the team.
2. `runs_start {taskId, machineId, harness: "shell", cwd: "/path/to/repo"}` returns `{runId, terminalId}`. `cwd` is a folder on that machine; a leading `~` is that machine's home. Without `taskId` the run is unfiled (`runs.unfiled`), and `runs.file` can put it under a task later; pass `title` so it has a name in the Inbox. If the machine has no free slot, the `no_free_slot` error names the terminals of yours there that you can end. Other harnesses (`claude-code`, `codex`, `grok-build`, `opencode`, `cursor`, `hermes-agent`) start that program in the terminal instead of a shell; any other CLI agent runs in a shell, where you type its command.
3. `run_in_terminal {terminalId, command: "npm test"}` types the command and returns what it printed, as plain text, once the terminal ends, the shell shows its prompt again, its output has been quiet for `idleMs` (2 s), or `waitMs` (30 s) passes. `stopped` says which, and `finished` is true for the first two. When it's false the command may still be running: read the rest with `terminals_read {terminalId, afterSeq: cursor}`, as `hint` says. Both helpers read at most 50,000 characters of output per call; past that they stop with `stopped: "limit"`, `truncated: true`, and a `cursor` and `cursorOffset` to read on from (`terminals_read` or `wait_for_terminal` take them as `afterSeq` and `afterOffset`), and `waitMs` holds however fast a command prints. They read the raw output and convert it in one pass, so text split between chunks comes out exactly as printed. The prompt check compares the last line with the prompt shown before the command, so a prompt that changes (a clock, a git status) falls back to the quiet rule. Without the helper, `terminals_input {terminalId, data: "npm test\n"}` types (end a command with `\n`), and `terminals_read` reads: plain text, the last 8,000 characters without `afterSeq`. From a cursor it returns at most `maxChars` and skips nothing: when `more` is true, pass the `cursor` and `cursorOffset` it returned as `afterSeq` and `afterOffset`, since a cursor can point inside a chunk. A cursor never stops inside an escape sequence or a character, and a line that hasn't ended keeps its trailing spaces, so the parts join exactly; a line redrawn across two reads can show in both. The room keeps a terminal's newest output only: `gap: true` says some between the cursor and the read was dropped. `terminals.output` is the raw output with escape codes, for drawing a terminal.
4. End it. `run_in_terminal {terminalId, command: "exit 0"}` ends a shell's run done and returns once the terminal has ended, with the run's state. A bare `exit` passes on the last command's exit code, so after a failing `npm test` the run ends failed; type `exit 0` when the work you were asked to do is finished, and say what failed in your report. `runs_stop {runId}` ends it stopped and returns `{runId, state, terminalId}`. A live terminal holds its slot until it ends.
5. Report, and close the task: post the result where the task asks, with `mentionedTasks: [taskId]` (and `mentionedRuns: [runId]`) so the app shows a chip that opens the task, and `tasks_keepRun {taskId, runId}` closes the task with the run that did it. Closing is final, since nothing reopens a task, so keep a run only once the task's work is done. While the task is open, more work on it, a re-run included, takes its `taskId`; once it's closed, a re-run starts without `taskId` (unfiled).

To run one command line and finish, pass it to `runs.start` as `command` (with `harness: "shell"`): the terminal runs it and ends when it exits, and `terminals.read` returns its output and `exitCode`. On macOS and Linux the bridge runs it in the person's own shell as a login and interactive one (`$SHELL -l -i -c`), so it finds the same programs and versions (fnm, nvm, asdf) as their own terminal; on Windows it runs in the machine's shell (PowerShell or cmd). It runs with `NO_COLOR=1`, because removing a test runner's colors from an inline diff merges its two values; every shell terminal an agent opens does too, interactive or not. The run's state is the exit code's, so a failing test suite makes it failed. `wait_for_terminal {terminalId}` (`uplink wait-for-terminal <terminalId>`) waits for the terminal to end and returns all its output and its `exitCode`; `terminals_read` right after `runs_start` may catch it half done. Running a command needs `terminals.drive` as well as `runs.start`, the same as typing one.

A plain shell's run shows `unknown` while it runs, because the room can't tell what a shell is doing (bridge README, Adapters). Harnesses with an adapter, such as Claude Code with the bridge's hooks, report Working, Waiting and Done themselves.

On the command line, the same steps:

```sh
uplink machines list
uplink runs start --task-id <taskId> --machine-id <machineId> --harness shell --cwd '~/src/billing'   # quoted: ~ is that machine's home
uplink run-in-terminal <terminalId> npm test       # prints the output, then how it stopped
uplink run-in-terminal <terminalId> node --version # the command's own flags pass through
uplink run-in-terminal <terminalId> node -e "console.log('hello world')"   # several arguments: each stays whole (POSIX shells)
uplink run-in-terminal <terminalId> 'ls *.js | wc -l'                     # one argument: the machine's shell reads it as typed
uplink run-in-terminal <terminalId> -- jq --json . # -- first when it uses --json, --wait-ms, --idle-ms or --team-id

Several arguments are each quoted for a POSIX shell (sh, bash, zsh, fish on macOS and Linux), every word, so each reaches the command exactly as typed: the machine's shell expands none of them (no globs, `~` or zsh's `=word`). One argument is sent as typed, for the machine's shell to read: use that for globs, pipes and variables on the machine, and on a Windows machine, whose shells read that quoting differently.
uplink run-in-terminal <terminalId> exit 0         # ends the shell; its run is done
uplink messages post channelId=<channelId> mentionedTasks='["<taskId>"]' mentionedRuns='["<runId>"]' --stdin body <<'EOF'
Billing tests on Ana's MacBook: 1 passed, 1 failed (`formatInvoiceDate`).
EOF
uplink tasks keepRun --task-id <taskId> --run-id <runId>

# Or one command line that ends on its own:
uplink runs start taskId=<taskId> machineId=<machineId> harness=shell cwd='~/src/billing' command='npm test'
uplink wait-for-terminal <terminalId>              # its output, then its exit code
```

`tasks.board`'s `column` is `not_started`, `needs_someone` (a run is waiting or failed: for anyone to look at, not necessarily you), `working` or `done` (GLOSSARY, Board column). `inbox.get` shows work by section (`needsYou`, `working`, `done`). Its default view, `mine`, is the caller's own: for an agent, the runs it drives, and then `personView` points to its person's. `{view: "person"}` is the Inbox of the person who added the agent, which is what an agent should read when its person asks about "my Inbox". Its own view is what to read when asked what it's working on. `for` names whose Inbox came back.

### Calls

`calls.live` lists live calls with who is in each. `calls.join {channelId, callId}` puts the agent in one at once: people see it right away in `calls.live` and in the app, which follows that live, until `calls.leave`, or until it misses `calls.heartbeat` for 60 seconds (send one every 20). The result's LiveKit `url` and `token` are only for hearing or speaking; an agent that just needs to be present can ignore them, and should never post the token. Pass `callId` when answering an invite (`calls.invitations`), so a call that has ended isn't started again. Joining needs the `calls.join` scope.

## TypeScript

```ts
import { RoomClient, RoomApiError } from "@uplink-room/room-client";

const room = new RoomClient({ url: process.env.UPLINK_URL!, key: process.env.UPLINK_AGENT_KEY! });
const { functions } = await room.functions();
try {
  await room.call("tasks.create", { title: "Fix login" });
} catch (error) {
  if (error instanceof RoomApiError) console.error(error.code, error.status, error.message);
}
// Attach a file: upload it, then pass what comes back in `attachments`.
const shot = await room.upload(new Uint8Array(await readFile("shot.png")), "shot.png");
await room.call("messages.post", { channelId, body: "The new screen", attachments: [shot] });
// Signed in as a person in several teams, name the team, as every team function takes it.
// runInTerminal and waitForTerminal find a terminal's team themselves; teamId still overrides.
const forSide = await room.upload(bytes, "shot.png", undefined, { teamId });
```

## Tests

`pnpm --filter @uplink-room/room-client test` runs one smoke test per layer (client, MCP server, command-line tool) against the real backend functions and HTTP router in convex-test. Each shows the layer reaching the same function as the app and returning the same result.
