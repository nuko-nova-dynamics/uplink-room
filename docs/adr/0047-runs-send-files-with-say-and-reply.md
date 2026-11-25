---
status: accepted
---

# Runs send files with `say` and `reply`

Julio asked on 2026-11-13 for agents to send each other attachments and images. Half of it existed: a chat message's files reach a run (ADR 0043), and an agent with a Room API key or a person's CLI sign-in uploads files with `messages.attachUrl` (`uplink upload`, the MCP server's upload tool). But a live run posts with `uplink-bridge say` and `reply` (ADR 0026) or, joined, with `uplink say` and `reply` (ADR 0032), and both took text only. So a Claude Code run could not hand a Codex run a screenshot, a render or a log.

## Decisions

- **`--file PATH` sends a file with the message,** once for each file, up to 10 (`RUN_SAY_FILES_MAX`, what any message keeps). It works on `uplink-bridge say` and `reply`, in a terminal and in a T3 Code thread, and on `uplink say` and `reply`. A message with files may have no text.
- **The files are the run's driver's uploads.** A run posts as its driver (ADR 0029 D2), and `messages.post` keeps only the poster's own uploads, so the URL each file goes to is an upload of the driver's: `bridge:runAttachUrl` for a bridge run, by the bridge's token and the terminal or thread, and `joined.attachUrl` for a joined run, by its run token. Either answers only while the run is live. The message keeps the files through `messages.post`'s checks, so the kinds and limits are the composer's: images (PNG, JPEG, GIF, WebP) up to 20 MB, PDFs and other files up to 50 MB, no SVG.
- **The bridge sends only bytes the command could read.** The bridge, not the command, uploads, so the run never holds an upload URL and the command needs no network, which Codex's sandbox blocks (ADR 0038). The command reads each file and names it by path, size and SHA-256; the bridge reads it again and refuses it if the bytes differ. A process that can reach the bridge's socket could otherwise make it upload a file the process itself can't read. In Codex's sandbox the signed relay request carries the same three fields.
- **All or nothing.** A file that can't be read, changed, or failed to upload fails the message before it is posted. Uploads a message never kept are deleted by the hourly sweep.
- **A bridge sends files only to a room that names `run_say_files`.** A room from before refuses `attachments` in `bridge:runSay`'s argument validator and has no `bridge:runAttachUrl`, so the bridge says the room is too old to take files instead.
- **A Pair message takes text only.** Pair messages have no attachments table, so `joined.say` refuses files in a Pair and `joined.attachUrl` refuses a run in no team. Amended by ADR 0048: a Pair message carries files, and a run sends them there with the same `--file`.
- **Each delivered message's closing hint says how to send files,** on bridge runs and joined runs alike, so an agent learns the flag where it learns `say` and `reply`.

## Considered options

- **The command uploads, the bridge only posts.** It saves the bridge a second read, but the command would need an upload URL over the socket and network access, which a sandboxed Codex command lacks.
- **Sending the bytes over the local socket.** Up to 500 MB through one JSON request, and the Codex relay goes through the tool's printed output, which can't carry it.
- **Bridge reads the path with no check.** Simpler, but it lets anything that reaches the socket send a file it can't read itself.

## Consequences

- A file sent this way reaches another run as ADR 0043 says: a T3 Code thread gets it as an attachment, Codex and Hermes Agent get images as images, and Claude Code in a terminal gets a copy in its workspace.
- The bridge hides run keys in a message's text (ADR 0037) but not inside the files a run sends. A log that quotes the run's own key reaches chat with it. The key posts only as that run and only through that machine's socket, for an hour after its turn.
- A Pair can't carry files until Pair messages get attachments (ADR 0048 adds them).
- An A2A agent still hears only how many files a message had (`lib/a2a/conversations.ts`); sending them as A2A file parts is a separate change.
