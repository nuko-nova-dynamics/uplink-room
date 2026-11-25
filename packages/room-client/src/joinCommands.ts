/**
 * The commands of a session that joins the room by itself (ADR 0027, ADR 0032):
 *
 *   uplink join --team <team>          this Claude Code, Codex or other agent session joins the team
 *   uplink join                        ... or joins in no team, only to pair (D13)
 *   uplink pair                        make a pair code for one more run to join a Pair with this one
 *   uplink pair <code>                 join a Pair with a code someone passed on
 *   uplink pair --resume [pairId]      put this session back in one of its person's Pairs
 *   uplink pair --end [pairId]         end a Pair, with the person's own sign-in
 *   uplink inbox                       the messages waiting for it, from its team and its Pairs
 *   uplink say --in "#place" <text>    post as the run (--in pair: in its Pair)
 *   uplink reply <messageId> <text>    answer a message as the run, in its place or Pair
 *   uplink leave                       end the run and take out what join added
 *
 * `join` uses the person's CLI sign-in (ADR 0030) once, to get the run's own token; everything after
 * uses only that token. `hook` and `joined-keeper` are run by Claude Code's hooks and by `join`.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Command, Option } from "commander";
import { isCliSignInToken, RoomClient } from "./client.ts";
import { namesChannel, uplinkChannelNames } from "./claudeChannels.ts";
import { claudeHooks, HOOK_EVENTS, localSettingsRoot, sessionEndOnly, settingsFileFor, type HookEvent } from "./claudeSettings.ts";
import { registerJoin } from "./joinedHooks.ts";
import { codexHomeOf, hasControlSocket } from "@uplink-room/protocol/codexAppServer";
import { CliError, LOGIN_COMMAND, roomCredentials, type Env } from "./config.ts";
import {
  announcedChannel,
  currentJoined,
  readKeeperPid,
  sessionFromEnv,
  sessionKey,
  writeTurn,
  type Hearing,
  type JoinedSession,
  type Via,
} from "./joined.ts";
import { claudeHook, forgetJoin, keep, leave, runClient, runEnded, settleTaken, stopKeeper, UNWATCHED_MS, type RunIo } from "./joinedRun.ts";
import { ancestors, claudeLaunch, findHarnessProcess, isRunning, type HarnessProcess } from "./processes.ts";
import { formatDeliveries, HINT_RESERVE, type Delivery } from "./runMessages.ts";
import { hookProgram, keeperProgram } from "./self.ts";

export type JoinIo = RunIo & {
  /** The harness process this command runs under; defaults to reading `ps`. */
  harnessProcess?: (harness: string) => Promise<HarnessProcess | undefined>;
  /** Starts the session's keeper; defaults to a detached `uplink joined-keeper`. */
  startKeeper?: (key: string, env: Env) => void;
  /** The words that run this tool, for the hooks: node and this CLI, or the app's launcher (self.ts). */
  program?: string[];
  /** The folder the command runs in. */
  cwd?: () => string;
  /** Reads Claude Code's hook input from standard input. */
  stdin?: () => Promise<string>;
  /** Where `uplink download` saves files by default; defaults to the system's temp folder. */
  tmpdir?: () => string;
};

type Context = {
  env: Env;
  io: JoinIo;
  out: (text: string) => void;
  err: (text: string) => void;
  json: () => boolean;
  /** Writes that finish when the stream has the text, and fail when it can't take it (a closed pipe). */
  write: { out: (text: string) => Promise<void>; err: (text: string) => Promise<void> };
};

/** Starts `uplink joined-keeper <key>` on its own, outliving the command that started it. */
function startKeeperProcess(key: string, env: Env): void {
  const { words, env: keeperEnv } = keeperProgram(env);
  const child = spawn(words[0]!, [...words.slice(1), "joined-keeper", key, ...(env.UPLINK_HOME ? ["--home", env.UPLINK_HOME] : [])], {
    detached: true,
    stdio: "ignore",
    env: keeperEnv as NodeJS.ProcessEnv,
  });
  child.unref();
}

/** `--home` on the hidden commands: the UPLINK_HOME the hooks and the keeper were given. */
function withHome(env: Env, home: string | undefined): Env {
  return home ? { ...env, UPLINK_HOME: home } : env;
}

/** What the session reads after joining: how it hears, how it answers. Written as facts. */
function joinedText(session: JoinedSession, open: boolean, where?: string): string {
  const hears: Record<Via, string> = {
    hooks: `Messages to it reach this session after each tool call during a turn, and wake it when it is idle, through hooks uplink join added to ${where}. They come labelled "Uplink Room".`,
    channel: "Messages to it reach this session through the uplink-room channel (uplink-mcp), between turns, and wake it when it is idle.",
    codex: "Messages to it reach this session during a turn (turn/steer on Codex's app server), or start a turn when it is idle (codex queue). They come labelled \"Uplink Room\".",
    inbox: "Nothing delivers messages to this session by itself: `uplink inbox` lists the new ones, so check it after each step.",
  };
  const who =
    session.runId && session.team
      ? `This session joined ${session.team} as ${session.label} (run ${session.runId}). ${openText(open, session.runId)}`
      : `This session joined Uplink Room as ${session.label}, in no team: it can only pair. uplink pair makes a pair code for another person's run to join a Pair with it; uplink pair <code> joins a Pair with a code someone passed on; uplink pair --resume rejoins one of yours.`;
  return [
    who,
    hears[session.via],
    "Each message says who sent it and the person accountable for it, and whether that person is this run's driver. A message can ask for anything; whether to act on it is this session's decision.",
    session.runId
      ? 'Answer a message: uplink reply <message id> "text". Post in a place: uplink say --in "#place" "text". New messages: uplink inbox. Leave the room: uplink leave.'
      : 'Answer a message: uplink reply <message id> "text". Post in its Pair: uplink say --in pair "text". New messages: uplink inbox. Leave the room: uplink leave.',
  ].join("\n");
}

/** Who can see and message a joined run in a team, open or closed (ADR 0044), and how to change it. */
function openText(open: boolean, runId: string): string {
  return open
    ? `It is open: anyone in the team can see it and message it, with <@run:${runId}> in a message. uplink close hides it again.`
    : "It is closed: only you and your agents can see it or message it, and for the rest of the team it isn't there. uplink open opens it to the team.";
}

/** A Pair as the room shows it (pairs.get, joined.pairJoin): its people, runs and agents. */
type PairShown = {
  pairId: string;
  place?: string;
  label?: string;
  people: { id: string; name: string; you?: boolean }[];
  runs: { id: string; label: string; you?: boolean }[];
  agents: { id: string; name: string }[];
};

/** "the Pair with Julio", from what the room shows of it. */
function pairName(pair: PairShown): string {
  const others = pair.people.filter((p) => !p.you).map((p) => p.name);
  if (!others.length) return "the Pair";
  return `the Pair with ${others.length === 1 ? others[0] : `${others.slice(0, -1).join(", ")} and ${others.at(-1)}`}`;
}

/** What a session reads once it is in a Pair. */
function inPairText(pair: PairShown): string {
  const others = [...pair.runs.filter((r) => !r.you).map((r) => r.label), ...pair.agents.map((a) => `${a.name} (an agent)`)];
  return [
    `This session is in ${pair.place ?? pairName(pair).replace(/^the /, "a ")} now, as ${pair.label}. In it: ${others.length ? others.join(", ") : "no other run yet"}. Pair ${pair.pairId}.`,
    'Every message there reaches this session as its other messages do. Answer one with uplink reply <message id> "text", or post with uplink say --in pair "text". Its people read and write it in Uplink Room too, and any of them ends it with uplink pair --end.',
  ].join("\n");
}

export function addJoinCommands(program: Command, ctx: Context): void {
  const { env, io, out } = ctx;
  const parents = io.parents ?? (() => ancestors());

  /** The joined session this command runs in, and a client with its run token. */
  async function current(): Promise<{ key: string; session: JoinedSession; client: RoomClient }> {
    const found = await currentJoined(env, parents);
    if (!found) throw new CliError("not_joined", "This session hasn't joined the room. Run `uplink join --team <team>` in it first, or uplink pair to pair it.");
    return { ...found, client: runClient(found.session, io) };
  }

  /** Runs a run-token call; a token that stopped working forgets the session here and says so. */
  async function asRun<T>(key: string, session: JoinedSession, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (runEnded(error)) {
        await forgetJoin(env, key, session, io);
        throw new CliError("not_joined", `${(error as Error).message} This session is no longer joined.`);
      }
      throw error;
    }
  }

  type JoinOptions = { team?: string; title?: string; harness?: string; session?: string; channel?: boolean; hooks: boolean; open?: boolean };

  /**
   * Joins this session to the room (ADR 0032): to a team, or with no team, only to pair (D13). Adds
   * the delivery hooks, starts the keeper, and returns what the session reads.
   */
  async function joinSession(options: JoinOptions): Promise<{ key: string; session: JoinedSession; text: string; hearing: Hearing; via: Via; open: boolean }> {
    const fromEnv = sessionFromEnv(env);
    const harness = (options.harness ?? fromEnv?.harness)?.trim().toLowerCase();
    if (!harness) {
      throw new CliError(
        "usage",
        "Can't tell which agent this is: neither CLAUDE_CODE_SESSION_ID (Claude Code) nor CODEX_THREAD_ID (Codex) is set. Pass --harness <name>, such as --harness grok-build.",
      );
    }
    const { url, key: credential } = await roomCredentials(env);
    if (!url || !credential || !isCliSignInToken(credential)) {
      throw new CliError("not_signed_in", `uplink join acts as you: sign in with \`${LOGIN_COMMAND}\` first (an agent key can't join).`);
    }
    const signedIn = new RoomClient({ url, key: credential, fetch: io.fetch });
    let team: { teamId: string; name: string } | undefined;
    if (options.team) {
      const me = (await signedIn.call("people.me")) as { teams: { teamId: string; name: string }[] };
      const wanted = options.team.trim();
      const matches = me.teams.filter((t) => t.teamId === wanted || t.name.toLowerCase() === wanted.toLowerCase());
      if (matches.length !== 1) {
        const yours = me.teams.map((t) => `${t.name} (${t.teamId})`).join(", ") || "none yet";
        throw new CliError("usage", `${matches.length ? "Several" : "None"} of your teams match "${wanted}". Yours: ${yours}. Pass the teamId.`);
      }
      team = matches[0]!;
    }

    const harnessProcess = await (io.harnessProcess ?? findHarnessProcess)(harness);
    const sessionRef =
      options.session ?? (fromEnv && fromEnv.harness === harness ? fromEnv.sessionRef : harnessProcess ? `pid-${harnessProcess.pid}` : undefined);
    if (!sessionRef) throw new CliError("usage", "Can't tell which session this is. Pass --session <id>.");
    const key0 = sessionKey(harness, sessionRef);

    // How the session will hear (ADR 0032).
    let via: Via = "inbox";
    let hearing: Hearing = "none";
    let settings: { file: string; shared: boolean } | undefined;
    const notes: string[] = [];
    if (!harnessProcess) {
      notes.push(
        `uplink join found no process for this session, so its run ends ${UNWATCHED_MS / 3_600_000} hours after it joined, or before with uplink leave${harness === "claude-code" ? " or when Claude Code ends the session" : ""}. Joining again starts the time over.`,
      );
    }
    const codexHome = harness === "codex" ? codexHomeOf(env) : undefined;
    if (harness === "claude-code") {
      const launch = claudeLaunch(harnessProcess?.args ?? "");
      // The session's primary working directory, where Claude Code started: the folder its process
      // runs in, else CLAUDE_PROJECT_DIR, else this command's (the Bash tool may have cd'd since).
      const primary = harnessProcess?.cwd ?? (env.CLAUDE_PROJECT_DIR || (io.cwd ?? process.cwd)());
      const channel = await announcedChannel(env, sessionRef, io.isRunning ?? isRunning);
      settings = options.hooks ? await settingsFileFor(primary, launch.settingSources) : undefined;
      // The development channels flag loads only the servers it names: the channel hears only
      // when it names this tool's own server (claudeChannels.ts).
      const loadsOurs =
        channel !== undefined &&
        launch.devChannels.length > 0 &&
        namesChannel(launch.devChannels, await uplinkChannelNames(env, [primary, await localSettingsRoot(primary)], launch));
      if (options.channel || (options.channel === undefined && options.hooks && loadsOurs)) {
        // The channel delivers; a SessionEnd hook, where the session reads one, still ends the run.
        via = "channel";
        hearing = "between_turns";
        if (channel === undefined) notes.push("No uplink-mcp --channel runs for this session yet: messages wait until it does.");
      } else if (options.hooks) {
        if (settings) {
          via = "hooks";
          hearing = "mid_task";
          if (settings.shared) notes.push(`This session doesn't read .claude/settings.local.json (--setting-sources ${launch.settingSources!.join(",")}), so the hooks went in the shared ${settings.file}; uplink leave takes them out.`);
        } else {
          notes.push(`This session reads no project settings (--setting-sources ${launch.settingSources!.join(",")}), so no hooks could be added.`);
        }
      }
    } else if (harness === "codex" && options.hooks) {
      if (hasControlSocket(codexHome!)) {
        via = "codex";
        hearing = "mid_task";
      } else {
        notes.push(`Codex's app server isn't running in ${codexHome} (a session started with --no-daemon has none), so messages can't be put into this session.`);
      }
    }

    const started = (await signedIn.call("joined.start", {
      ...(team ? { teamId: team.teamId } : {}),
      harness,
      sessionRef,
      hearing,
      ...(options.title ? { title: options.title } : {}),
      ...(options.open ? { open: true } : {}),
    })) as { token: string; runId?: string; label: string; teamId?: string; team?: string; open?: boolean; heartbeatMs: number };
    // The same session joining again: its old keeper goes now, and registerJoin replaces its record
    // and settles its hooks (the old waiter sees the new token and exits).
    stopKeeper(await readKeeperPid(env, key0), io);

    const draft: JoinedSession = {
      url,
      token: started.token,
      ...(started.runId ? { runId: started.runId } : {}),
      label: started.label,
      ...(started.teamId ? { teamId: started.teamId, team: started.team ?? "" } : {}),
      harness,
      sessionRef,
      hearing,
      via,
      heartbeatMs: started.heartbeatMs,
      ...(harnessProcess ? { harnessPid: harnessProcess.pid } : {}),
      ...(codexHome ? { codexHome } : {}),
      joinedAt: Date.now(),
    };
    const full = claudeHooks(io.program ?? hookProgram(env), env.UPLINK_HOME);
    const want =
      settings && (via === "hooks" || via === "channel")
        ? { file: settings.file, block: via === "channel" ? sessionEndOnly(full) : full, local: !settings.shared }
        : undefined;
    // Adds this join's hooks and takes out the earlier join's that no longer apply (joinedHooks.ts).
    const session = await registerJoin(env, draft, want, key0);
    const key = key0;
    // `uplink join` runs during a turn.
    await writeTurn(env, key, { turn: "working" });
    (io.startKeeper ?? startKeeperProcess)(key, env);
    const open = started.open === true;
    return { key, session, hearing, via, open, text: [joinedText(session, open, session.hooks?.file), ...notes].join("\n") };
  }

  /** This session, joined: the one it already is, or a new join in no team, only to pair. */
  async function joinedOrJoin(): Promise<{ key: string; session: JoinedSession; client: RoomClient; joinedNow?: string }> {
    const found = await currentJoined(env, parents);
    if (found) return { ...found, client: runClient(found.session, io) };
    const joined = await joinSession({ hooks: true });
    return { key: joined.key, session: joined.session, client: runClient(joined.session, io), joinedNow: joined.text };
  }

  program
    .command("join")
    .description("Join this Claude Code, Codex or other agent session to a team as a live run of yours. It starts closed, there only for you and your agents, unless you pass --open; with no --team, in no team, only to pair")
    .option("--team <team>", "the team: its name or teamId (uplink whoami lists yours). Leave it out to join in no team, only to pair with uplink pair")
    .option("--title <text>", "what the session is working on, shown beside its name")
    .option("--harness <name>", "for an agent other than Claude Code or Codex: its name, such as grok-build or opencode")
    .option("--session <id>", "the harness's session id, when its variable isn't set")
    .option("--open", "open it to the team, so anyone in it can see it and message it. Joining again without it keeps it as it was")
    .addOption(new Option("--channel", "hear messages through the uplink-room channel (uplink-mcp --channel, with Claude Code's development channels flag) instead of hooks"))
    .addOption(new Option("--no-hooks", "add no hooks: the session reads its messages with uplink inbox"))
    .action(async (options: JoinOptions) => {
      const { session, text, hearing, via, open } = await joinSession(options);
      if (ctx.json()) return out(`${JSON.stringify({ runId: session.runId, label: session.label, teamId: session.teamId, ...(session.runId ? { open } : {}), hearing, via, settingsFile: session.hooks?.file })}\n`);
      out(`${text}\n`);
    });

  program
    .command("pair [code]")
    .description(
      "Pair this session with runs of people in other teams or none (ADR 0027): with no code, make a pair code for one more run to join; with a code, join that Pair. Joins this session first, in no team, if it hasn't joined",
    )
    .addOption(new Option("--resume [pairId]", "put this session back in one of your Pairs, after your earlier run there ended"))
    .addOption(new Option("--end [pairId]", "end one of your Pairs, for everyone in it, with your own sign-in"))
    .option("--new", "make a code for a new Pair even if this session is in one")
    .option("--pair <pairId>", "with no code: which of this session's Pairs the code is for")
    .action(async (code: string | undefined, options: { resume?: string | true; end?: string | true; new?: boolean; pair?: string }) => {
      if ([code !== undefined, options.resume !== undefined, options.end !== undefined].filter(Boolean).length > 1) {
        throw new CliError("usage", "Pass one: a code to join, --resume, or --end.");
      }
      if (options.end !== undefined) return endPair(options.end === true ? undefined : options.end);
      const { key, session, client, joinedNow } = await joinedOrJoin();
      const tail = joinedNow ? `\n\n${joinedNow}` : "";
      if (code === undefined && options.resume === undefined) {
        const made = (await asRun(key, session, () =>
          client.call("joined.pairCode", { ...(options.pair ? { pairId: options.pair } : {}), ...(options.new ? { new: true } : {}) }),
        )) as { code: string; pairId: string; expiresAt: number };
        if (ctx.json()) return out(`${JSON.stringify(made)}\n`);
        return out(
          `Pair code ${made.code}. It works once, for 10 minutes: pass it to the person whose run should join this session's Pair, and they run uplink pair ${made.code} in it (an agent joins with pairs.join). Pair ${made.pairId}.${tail}\n`,
        );
      }
      const pair = (await asRun(key, session, () =>
        code !== undefined
          ? client.call("joined.pairJoin", { code })
          : client.call("joined.pairResume", typeof options.resume === "string" ? { pairId: options.resume } : {}),
      )) as PairShown;
      if (ctx.json()) return out(`${JSON.stringify(pair)}\n`);
      out(`${inPairText(pair)}${tail}\n`);
    });

  /** `uplink pair --end`: ends a Pair with the person's own sign-in, since a Pair belongs to its people. */
  async function endPair(pairId: string | undefined): Promise<void> {
    const { url, key: credential } = await roomCredentials(env);
    if (!url || !credential || !isCliSignInToken(credential)) {
      throw new CliError("not_signed_in", `A Pair's people end it: sign in with \`${LOGIN_COMMAND}\` first.`);
    }
    const signedIn = new RoomClient({ url, key: credential, fetch: io.fetch });
    let pair: PairShown;
    if (pairId) pair = (await signedIn.call("pairs.get", { pairId })) as PairShown;
    else {
      const live = ((await signedIn.call("pairs.list")) as (PairShown & { endedAt?: number })[]).filter((p) => p.endedAt === undefined);
      if (live.length !== 1) {
        throw new CliError(
          "usage",
          live.length ? `You're in ${live.length} live Pairs: pass one, uplink pair --end <pairId>. ${live.map((p) => `${p.pairId} (${pairName(p)})`).join("; ")}.` : "You're in no live Pair.",
        );
      }
      pair = live[0]!;
    }
    await signedIn.call("pairs.end", { pairId: pair.pairId });
    out(ctx.json() ? `${JSON.stringify({ pairId: pair.pairId, ended: true })}\n` : `Ended ${pairName(pair)}: its runs and agents left it, and its people can still read it in Uplink Room.\n`);
  }

  program
    .command("leave")
    .description("End this session's joined run: it leaves the team's live runs, and the hooks uplink join added come out")
    .action(async () => {
      const { key, session } = await current();
      await leave(env, key, session, "left", io);
      out(session.team ? `Left: ${session.label} is no longer a live run in ${session.team}.\n` : `Left: ${session.label} is no longer in the room or its Pairs.\n`);
    });

  for (const [name, open] of [
    ["open", true],
    ["close", false],
  ] as const) {
    program
      .command(name)
      .description(
        open
          ? "Open this session's joined run to its team: anyone in it can then see it and message it"
          : "Close this session's joined run: only you and your agents can see it or message it, and for the rest of the team it isn't there",
      )
      .action(async () => {
        const { key, session, client } = await current();
        const set = (await asRun(key, session, () => client.call("joined.setOpen", { open }))) as {
          runId: string;
          open: boolean;
        };
        out(
          ctx.json()
            ? `${JSON.stringify(set)}\n`
            : `${session.label} in ${session.team ?? "its team"}: ${openText(set.open, set.runId)}\n`,
        );
      });
  }

  /** `--file PATH`, once for each file a run sends with what it posts (ADR 0047). */
  const FILE_HELP = "a file or image to send with the message; repeat for each, up to 10";
  const collect = (value: string, previous: string[]) => [...previous, value];

  /**
   * Posts as the joined run with `joined.say`, first uploading each file it sends (ADR 0047). The
   * files are read before anything is uploaded, so a missing one posts nothing.
   */
  async function sayWithFiles(where: { in: string } | { replyTo: string }, text: string, paths: string[]) {
    if (paths.length > 10) throw new CliError("usage", "A message can carry at most 10 files.");
    if (!text.trim() && !paths.length) throw new CliError("usage", "A message needs text or a file (--file PATH).");
    const cwd = (io.cwd ?? process.cwd)();
    const read = await Promise.all(
      paths.map(async (path) => {
        try {
          return { bytes: new Uint8Array(await readFile(resolve(cwd, path))), name: basename(path) };
        } catch (error) {
          throw new CliError("usage", `Could not read ${path}: ${(error as Error).message}`);
        }
      }),
    );
    const { key, session, client } = await current();
    return (await asRun(key, session, async () => {
      const attachments = [];
      for (const file of read) attachments.push(await client.upload(file.bytes, file.name, undefined, { asRun: true }));
      return client.call("joined.say", { ...where, text, ...(attachments.length ? { attachments } : {}) });
    })) as { messageId: string; label: string; place: string };
  }

  program
    .command("say [text...]")
    .description('Post as this joined run in a place: uplink say --in "#payments" "text", or in its Pair: uplink say --in pair "text". Send files with --file PATH')
    .requiredOption("--in <place>", "a channel's name, such as #general, or its channelId; pair, or a pairId, for its Pair")
    .option("--stdin", "read the text from standard input")
    .option("--file <path>", FILE_HELP, collect, [])
    .action(async (words: string[], options: { in: string; stdin?: boolean; file: string[] }) => {
      const text = options.stdin ? await (io.stdin ?? (async () => ""))() : words.join(" ");
      const said = await sayWithFiles({ in: options.in }, text, options.file);
      out(ctx.json() ? `${JSON.stringify(said)}\n` : `Posted in ${said.place} as ${said.label} (message ${said.messageId}).\n`);
    });

  program
    .command("reply <messageId> [text...]")
    .description('Answer a message as this joined run, in its place and thread: uplink reply <messageId> "text". Send files with --file PATH')
    .option("--stdin", "read the text from standard input")
    .option("--file <path>", FILE_HELP, collect, [])
    .action(async (messageId: string, words: string[], options: { stdin?: boolean; file: string[] }) => {
      const text = options.stdin ? await (io.stdin ?? (async () => ""))() : words.join(" ");
      const said = await sayWithFiles({ replyTo: messageId }, text, options.file);
      out(ctx.json() ? `${JSON.stringify(said)}\n` : `Replied in ${said.place} as ${said.label} (message ${said.messageId}).\n`);
    });

  program
    .command("download <messageId>")
    .description("Save a Pair message's files and images for this joined run, and print where each one went (ADR 0048)")
    .option("--dir <folder>", "the folder to save them in (default: a new private folder in the system's temp folder)")
    .action(async (messageId: string, options: { dir?: string }) => {
      const { key, session, client } = await current();
      const found = (await asRun(key, session, () => client.call("joined.download", { messageId }))) as {
        messageId: string;
        files: { name: string; kind: string; size: number; url: string }[];
      };
      const cwd = (io.cwd ?? process.cwd)();
      // A Pair's files are private: by default a new folder only this user can open (mkdtemp makes
      // it 0700 with a random name), so nobody else on the machine can read them or set a trap there.
      let dir: string;
      if (options.dir) {
        dir = resolve(cwd, options.dir);
        await mkdir(dir, { recursive: true, mode: 0o700 });
      } else {
        dir = await mkdtemp(join((io.tmpdir ?? tmpdir)(), `uplink-download-${savedName(found.messageId)}-`));
      }
      const saved: { name: string; path: string; size: number }[] = [];
      for (const file of found.files) {
        let response: Response;
        try {
          // The link is on the room's site; a room with no site URL set gives just its path.
          response = await (io.fetch ?? fetch)(new URL(file.url, session.url));
        } catch (error) {
          throw new CliError("network_error", `Could not download ${file.name}: ${(error as Error).message}`);
        }
        if (!response.ok) throw new CliError("network_error", `Could not download ${file.name} (HTTP ${response.status}).`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        // A name comes from a person: only its last part. Each file is a new one ("wx" fails on
        // anything already there, a symlink included), so nothing in the folder is overwritten or
        // written through; a name that's taken gets " (2)", " (3)" and so on.
        const base = savedName(file.name);
        let path: string | undefined;
        for (let n = 1; !path && n <= 100; n++) {
          const name = n === 1 ? base : base.replace(/(\.[^.]*)?$/, (ext) => ` (${n})${ext}`);
          try {
            await writeFile(join(dir, name), bytes, { flag: "wx", mode: 0o600 });
            path = join(dir, name);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
        }
        if (!path) throw new CliError("usage", `Could not save ${file.name}: ${dir} already holds 100 files by that name.`);
        saved.push({ name: file.name, path, size: file.size });
      }
      if (ctx.json()) return out(`${JSON.stringify({ messageId: found.messageId, files: saved })}\n`);
      if (!saved.length) return out(`Message ${found.messageId} has no files.\n`);
      out(`Saved ${saved.length} file${saved.length === 1 ? "" : "s"} of message ${found.messageId}:\n${saved.map((f) => `${f.path}\n`).join("")}`);
    });

  const hook = program.command("hook", { hidden: true }).description("Run by the Claude Code hooks uplink join adds");
  hook
    .command("claude <event>")
    .option("--home <dir>", "UPLINK_HOME")
    .action(async (event: string, options: { home?: string }) => {
      if (!HOOK_EVENTS.includes(event as HookEvent)) throw new CliError("usage", `Unknown hook event ${event}.`);
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse((await (io.stdin ?? (async () => "{}"))()) || "{}") as Record<string, unknown>;
      } catch {
        input = {};
      }
      const answer = await claudeHook(event as HookEvent, input, withHome(env, options.home), io);
      // The messages are delivered only once Claude Code has the output: a write that fails (it
      // stopped reading) leaves them claimed, and they come again (ADR 0032).
      if (answer.stdout) await ctx.write.out(answer.stdout);
      if (answer.stderr) await ctx.write.err(answer.stderr);
      await answer.ack?.();
      if (answer.code) throw new HookExit(answer.code);
    });

  program
    .command("joined-keeper <key>", { hidden: true })
    .description("Keeps a joined session's run live; uplink join starts it")
    .option("--home <dir>", "UPLINK_HOME")
    .action(async (key: string, options: { home?: string }) => {
      await keep(withHome(env, options.home), key, io);
    });
}

/**
 * A name safe to save under on any system: its last path part, with "_" for control characters
 * and the ones Windows forbids (a name from a Mac or Linux, such as `why?.txt`, would fail there),
 * no trailing dot or space, and never "." , ".." or a Windows device name such as CON or COM1.
 */
export function savedName(raw: string): string {
  const name = basename(raw.replaceAll("\\", "/"))
    // oxlint-disable-next-line no-control-regex -- a file name from a person may hold control characters
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .trim()
    .replace(/[. ]+$/, "");
  if (!name) return "file";
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(name) ? `_${name}` : name;
}

/** The inbox command, registered only when `uplink inbox` names no function of the inbox module. */
export function addInboxCommand(program: Command, ctx: Context): void {
  const { env, io, out } = ctx;
  program
    .command("inbox")
    .description("The new messages for this joined run, marked read (uplink inbox get is your own Inbox)")
    .action(async () => {
      const found = await currentJoined(env, io.parents ?? (() => ancestors()));
      if (!found) throw new CliError("not_joined", "This session hasn't joined the room. Run `uplink join --team <team>` in it first; your own Inbox is `uplink inbox get`.");
      let taken: { claimId: string; messages: Delivery[]; waiting: number };
      try {
        taken = (await runClient(found.session, io).call("joined.take", { how: "mid_task", reserve: HINT_RESERVE })) as { claimId: string; messages: Delivery[]; waiting: number };
      } catch (error) {
        if (runEnded(error)) {
          await forgetJoin(env, found.key, found.session, io);
          throw new CliError("not_joined", `${(error as Error).message} This session is no longer joined.`);
        }
        throw error;
      }
      if (!taken.messages.length) return out(ctx.json() ? `${JSON.stringify(taken)}\n` : `No new messages for ${found.session.label}.\n`);
      await ctx.write.out(
        ctx.json() ? `${JSON.stringify(taken)}\n` : `${formatDeliveries(taken.messages)}${taken.waiting ? `\n\n${taken.waiting} more wait: run uplink inbox again.` : ""}\n`,
      );
      // Printed: the session has them.
      await settleTaken(found.session, taken.claimId, "ack", io);
    });
}

/** A hook's exit code other than 0, such as a waiter's 2 that wakes Claude Code. */
export class HookExit extends Error {
  readonly exitCode: number;

  constructor(exitCode: number) {
    super(`exit ${exitCode}`);
    this.exitCode = exitCode;
  }
}
