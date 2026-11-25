/**
 * Files a run sends with what it posts (ADR 0047): `uplink-bridge say --file PATH` and `reply --file
 * PATH`. The command reads each file and names it to the bridge by its path, size and SHA-256, and the
 * bridge reads it again, checks it has the same bytes, and uploads it to a URL from
 * `bridge:runAttachUrl` before `bridge:runSay` posts the message. So the bridge sends only bytes the
 * command itself could read, and the run, which holds no room key, never sees an upload URL.
 */
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  RUN_SAY_FILE_BYTES_MAX,
  RUN_SAY_FILES_MAX,
  attachmentContentType,
  type RunAttachTarget,
  type RunSayAttachment,
} from "@uplink-room/protocol";
import { LocalRequestError } from "./localErrors.ts";

/** A file a run names in `say` or `reply`: where it is, and the bytes the command read there. */
export type RunSayFile = { path: string; size: number; sha256: string };

/**
 * Stops a message whose command went away (`signal`: its local request closed, such as a hook that
 * timed out on a slow upload): it posts nothing, so sending it again can't post it twice.
 */
export function stillWanted(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw new RunFileError("The command stopped waiting while the files uploaded, so nothing was posted. Send it again.");
}

/** A file that can't go, said to the command as it is: a local request error the socket passes on. */
export class RunFileError extends LocalRequestError {}

/** How long one file's upload may take. */
const UPLOAD_MS = 120_000;

const MB = 1024 * 1024;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Reads a file the command names, relative to `cwd`, and describes it for the bridge. */
export async function describeRunFile(path: string, cwd = process.cwd()): Promise<RunSayFile> {
  const full = resolve(cwd, path);
  let size: number;
  try {
    const info = await stat(full);
    if (!info.isFile()) throw new RunFileError(`${path} isn't a file.`);
    size = info.size;
  } catch (error) {
    if (error instanceof RunFileError) throw error;
    throw new RunFileError(`Can't read ${path}: ${(error as Error).message}`);
  }
  if (size > RUN_SAY_FILE_BYTES_MAX) throw tooLarge(path, size);
  const bytes = await readFile(full).catch((error: unknown) => {
    throw new RunFileError(`Can't read ${path}: ${(error as Error).message}`);
  });
  return { path: full, size: bytes.length, sha256: digest(bytes) };
}

function tooLarge(name: string, size: number) {
  return new RunFileError(
    `${name} is ${Math.ceil(size / MB)} MB. A run sends files up to ${RUN_SAY_FILE_BYTES_MAX / MB} MB (images up to 20 MB); share a link to it instead.`,
  );
}

/** The files a local request names, or an error saying what's wrong with them. */
export function runSayFiles(value: unknown): RunSayFile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new RunFileError("files must be a list.");
  if (value.length > RUN_SAY_FILES_MAX) throw new RunFileError(`A message can carry at most ${RUN_SAY_FILES_MAX} files.`);
  return value.map((item: unknown) => {
    const file = item as Partial<RunSayFile> | null;
    if (
      !file ||
      typeof file.path !== "string" ||
      !file.path ||
      typeof file.size !== "number" ||
      !Number.isInteger(file.size) ||
      file.size < 0 ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256)
    ) {
      throw new RunFileError("Each file needs its path, size and sha256.");
    }
    return { path: file.path, size: file.size, sha256: file.sha256 };
  });
}

/**
 * Uploads each file, in order, to its own URL from `attachUrl`, and returns what `bridge:runSay`
 * takes in `attachments`. A file whose bytes changed since the command read it, or that the bridge
 * can't read, fails the whole message before anything is posted.
 */
export async function uploadRunFiles(
  files: RunSayFile[],
  attachUrl: () => Promise<RunAttachTarget>,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<RunSayAttachment[]> {
  const attachments: RunSayAttachment[] = [];
  for (const file of files) {
    stillWanted(signal);
    const name = basename(file.path);
    if (file.size > RUN_SAY_FILE_BYTES_MAX) throw tooLarge(name, file.size);
    let bytes: Buffer;
    try {
      const info = await stat(file.path);
      if (!info.isFile() || info.size !== file.size) throw new Error("changed");
      bytes = await readFile(file.path);
    } catch {
      throw new RunFileError(`${name} changed or went away after the command read it. Send it again.`);
    }
    if (bytes.length !== file.size || digest(bytes) !== file.sha256) {
      throw new RunFileError(`${name} changed after the command read it. Send it again.`);
    }
    const target = await attachUrl();
    const contentType = attachmentContentType(name);
    let response: Response;
    try {
      response = await fetchImpl(target.uploadUrl, {
        method: "POST",
        headers: { "content-type": contentType },
        body: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: contentType }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(UPLOAD_MS)]) : AbortSignal.timeout(UPLOAD_MS),
      });
    } catch (error) {
      stillWanted(signal);
      throw new RunFileError(`Couldn't upload ${name} to the room: ${(error as Error).message}`);
    }
    const body = (await response.json().catch(() => null)) as { storageId?: unknown } | null;
    if (!response.ok || typeof body?.storageId !== "string") {
      throw new RunFileError(`The room didn't take ${name} (HTTP ${response.status}).`);
    }
    attachments.push({ uploadId: target.uploadId, storageId: body.storageId, name });
  }
  return attachments;
}
