/**
 * Which Claude Code hooks each joined session of this computer has in which settings file (ADR 0032),
 * kept in step with the files: a join adds its hooks and records them, a rejoin takes out what no
 * longer applies, and leaving takes out the hooks no other joined session of the file still uses.
 *
 * A hook group stays in a file while any joined session records it there, so one session's rejoin or
 * leave never takes out another's hooks. "Made by a join" (`created`) passes to the sessions still
 * using a file when the one that made it lets go, so the last one out deletes a file a join made.
 */
import { isDeepStrictEqual } from "node:util";
import { addHooks, removeHooks, type HooksBlock } from "./claudeSettings.ts";
import type { Env } from "./config.ts";
import { withFileLock, withFileLocks } from "./files.ts";
import { listJoined, readJoined, removeJoinedFiles, saveJoined, type JoinedSession } from "./joined.ts";

type Hooks = NonNullable<JoinedSession["hooks"]>;
type Group = HooksBlock[string][number];

/** `block`'s groups that aren't in `keep`. */
function without(block: HooksBlock, keep: HooksBlock): HooksBlock {
  const left: HooksBlock = {};
  for (const [event, groups] of Object.entries(block)) {
    const rest = groups.filter((group) => !(keep[event] ?? []).some((kept) => isDeepStrictEqual(kept, group)));
    if (rest.length) left[event] = rest;
  }
  return left;
}

/**
 * Takes `hooks.block`'s groups out of `hooks.file`, except those another joined session (not `key`)
 * records in the same file. A file the join made goes when nothing else is in it.
 */
async function release(env: Env, key: string, hooks: Hooks): Promise<void> {
  const others = (await listJoined(env)).filter((entry) => entry.key !== key && entry.session.hooks?.file === hooks.file);
  const inUse: HooksBlock = {};
  for (const { session } of others) {
    for (const [event, groups] of Object.entries(session.hooks!.block as HooksBlock)) (inUse[event] ??= []).push(...(groups as Group[]));
  }
  const unused = without(hooks.block as HooksBlock, inUse);
  if (Object.keys(unused).length) await removeHooks(hooks.file, unused, hooks.created && !others.length);
  if (hooks.created) {
    for (const { session } of others) if (!session.hooks!.created) await saveJoined(env, { ...session, hooks: { ...session.hooks!, created: true } });
  }
}

/**
 * Records a join (`session`, saved under `key`), with its hooks added to `want.file` when it has
 * any. The same session's previous join, if its record is still there: its hooks that the new join
 * doesn't keep in the same file come out, unless another joined session uses them. All of it under
 * the lock of each settings file involved, so no other join or leave reads or edits them meanwhile.
 */
export async function registerJoin(
  env: Env,
  session: JoinedSession,
  want: { file: string; block: HooksBlock; local: boolean } | undefined,
  key: string,
): Promise<JoinedSession> {
  const seen = (await readJoined(env, key))?.hooks?.file;
  const files = [seen, want?.file].filter((file): file is string => file !== undefined);
  return withFileLocks(files, async () => {
    // Read again under the lock: a leave may have passed on "made by a join" meanwhile.
    const earlier = await readJoined(env, key);
    const before = earlier?.hooks && files.includes(earlier.hooks.file) ? earlier.hooks : undefined;
    const sameFile = before !== undefined && want !== undefined && before.file === want.file;
    if (before) await release(env, key, { ...before, block: without(before.block as HooksBlock, sameFile ? want!.block : {}) });
    const saved: JoinedSession = { ...session };
    delete saved.hooks;
    if (want) {
      const { created } = await addHooks(want.file, want.block, { local: want.local });
      saved.hooks = { file: want.file, block: want.block, created: created || (sameFile && before!.created) };
    }
    await saveJoined(env, saved);
    return saved;
  });
}

/**
 * Forgets a leaving session (`session`, under `key`): its hooks come out of its settings file unless
 * another joined session uses them, and its files go, in one step under the settings file's lock,
 * so two sessions leaving at once can't each still see the other. Nothing, if the session has
 * joined again since (another token).
 */
export async function releaseJoin(env: Env, key: string, session: JoinedSession): Promise<void> {
  const forget = async () => {
    const fresh = await readJoined(env, key);
    if (fresh && fresh.token !== session.token) return;
    const hooks = fresh?.hooks ?? session.hooks;
    if (hooks) await release(env, key, hooks);
    await removeJoinedFiles(env, key);
  };
  await (session.hooks ? withFileLock(session.hooks.file, forget) : forget());
}
