---
status: accepted
---

# A Pair message carries files

Julio asked on 2026-11-14 to send pictures and other files from a Pair's message box in the app. That night Axel's run reported a crash in a Pair, with the crash reports on Axel's machine, and a screenshot or a log was the thing to pass. ADR 0047 left Pairs out: "A Pair message takes text only", because Pair messages had no attachments table, and the team tables can't hold them, since a Pair is outside every team (ADR 0029 D9).

## Decisions

- **A Pair message takes up to 10 files,** in the kinds and sizes a chat message takes: images (PNG, JPEG, GIF, WebP) up to 20 MB, PDFs and other files up to 50 MB, no SVG. With files the text may be empty. The checks are the same code (`checkUploadedBytes` in `lib/attachments.ts`).
- **Pair files have tables of their own,** outside every team: `pairUploads` (an upload URL issued for one file), `pairAttachments` (a kept file) and `pairAttachmentGrants` (a short-lived link to one). `pairMessages` gets `attachmentCount`.
- **One exception to D9: whether stored bytes are kept** (`storageInUse`) also looks in `pairAttachments`, and team functions call it. Without it a team message could keep bytes a Pair keeps, and deleting that message would delete the Pair's file; the hourly sweep needs it too. It answers only "already kept" for a storage id, which only the bytes' own uploader holds, so it tells a team function nothing about a Pair.
- **An upload counts only for the author it was issued to.** `pairs.attachUrl` issues one to one of a Pair's people for that Pair, or to one of its agents. `joined.attachUrl` issues a run in no team one for its session. A run in a team still uploads as its driver in the team (ADR 0047), and its Pair message keeps that upload too, so `uplink say --in pair --file` works from either kind of run without the command knowing where the message goes. A message refuses an upload issued to anyone else, or for another Pair, and the same upload twice.
- **A Pair file has no lasting link.** A Convex storage URL serves its file to anyone who has it until the file is deleted (docs.convex.dev/file-storage/serve-files), and someone who leaves a Pair must stop reading it. So each look goes through a link from `pairs.attachmentLink` (a person or agent) or `joined.download` (a run), which `/attachments/pair/<token>` serves for 10 minutes and only while that person, agent or run is still in the Pair: what ADR 0016 does for a direct message's files. A person still reads an ended Pair's files; its runs and agents left it when it ended.
- **A run saves a Pair message's files with `uplink download <messageId>`.** A joined run hears how many files a message has (ADR 0043 gives the files themselves only to bridge runs), and for a Pair message the delivery says the command. It saves them in a new folder only that user can open (`mkdtemp`, mode 0700) in the system's temp folder, or in `--dir`, and prints each path. Each file is created new (mode 0600, and never over a file or symlink already there; a taken name gets " (2)"), so a folder someone else prepared can't redirect or overwrite anything.
- **The app's Pair box attaches files** with a paperclip, a paste or a drop, as the channel's composer does (`useUploads`, the team-free core of `useFileUploads`), and a Pair message shows its files as a direct message's do.

## Considered options

- **Returning storage URLs in `pairs.messages`.** Simpler, but a URL copied before someone left would keep working.
- **One uploads table for teams and Pairs, with `teamId` optional.** Every team function that reads an upload would have to rule out Pair rows, and D9 keeps Pair rows out of team tables.
- **A `to` argument on `joined.attachUrl` naming the Pair.** The room-client would have to tell a Pair message id from a team one before posting, and an older room would refuse the argument outright.
- **Saving a Pair message's files for the run when it takes the message,** as the bridge does. The hooks that hand a joined run its messages run on every tool call, and a download there would slow every one of them; the run fetches only what it wants.

## Consequences

- An agent with the `pairs.join` scope and a person's CLI sign-in send files with `pairs.attachUrl` and `pairs.post`, and fetch them with `pairs.attachmentLink`.
- A joined run still hears only the count of a team message's files; `uplink download` saves only a Pair message's.
- A file a Pair keeps stays until the Pair's rows go. Nothing deletes a Pair's messages today, so its files stay too.
