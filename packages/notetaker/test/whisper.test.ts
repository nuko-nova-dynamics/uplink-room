import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { whisperTranscriber } from "../src/whisper.ts";

const utterance = { speakerId: "m_julio.p1", startedAt: 0, sampleRate: 16_000, samples: new Int16Array(1600) };

test.skipIf(process.platform === "win32")(
  "whisper.cpp gets the call's names as its prompt, and an utterance it can't place is heard again in the call's language",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "fake-whisper-"));
    try {
      // A stand-in for whisper-cli: unsure about the language with -l auto, and logs its arguments.
      const binary = join(dir, "whisper-cli");
      await writeFile(
        binary,
        `#!/bin/sh
echo "$@" >> "${join(dir, "calls.txt")}"
case "$*" in
  *"-l auto"*) echo "whisper_full_with_state: auto-detected language: ru (p = 0.282699)" >&2; echo " Бали." ;;
  *"-l es"*) echo " Vale." ;;
esac
`,
      );
      await chmod(binary, 0o755);
      const transcribe = whisperTranscriber({ model: "model.bin", binary });

      // Sure of nothing yet: the guess stands, and no language is reported.
      expect(await transcribe(utterance, { names: ["Julio Díaz", "Tomás Ruiz"] })).toEqual({ text: "Бали." });
      // Most of the call has been Spanish: heard again in Spanish.
      expect(await transcribe(utterance, { names: ["Julio Díaz", "Tomás Ruiz"], language: "es" })).toEqual({ text: "Vale." });

      const calls = (await readFile(join(dir, "calls.txt"), "utf8")).trim().split("\n");
      expect(calls).toHaveLength(3);
      expect(calls.every((c) => c.includes("--prompt Julio Díaz, Tomás Ruiz."))).toBe(true);
      expect(calls[2]).toContain("-l es");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")("when transcribing again in the call's language fails, the first transcription stands and the failure is logged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fake-whisper-"));
  try {
    // Unsure with -l auto; crashes when asked for Spanish.
    const binary = join(dir, "whisper-cli");
    await writeFile(
      binary,
      `#!/bin/sh
case "$*" in
  *"-l auto"*) echo "whisper_full_with_state: auto-detected language: ru (p = 0.282699)" >&2; echo " Vale." ;;
  *) echo "ggml_metal_init: failed to allocate buffer" >&2; exit 1 ;;
esac
`,
    );
    await chmod(binary, 0o755);
    const logged: string[] = [];
    const transcribe = whisperTranscriber({ model: "model.bin", binary, log: (m) => logged.push(m) });
    expect(await transcribe(utterance, { language: "es" })).toEqual({ text: "Vale." });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/^Transcribing again in es failed, so the first transcription stands/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
