/**
 * Delivery that keeps going until nothing is left (ADR 0032): a joined run keeper's Codex delivery,
 * the channel's pushes, and the bridge's delivery to a Codex terminal (ADR 0038). A notice says only
 * that messages wait, so a run that drops an update, takes only part of a burst, or fails once must
 * not wait for the next one.
 */

/** What one step did: nothing left, more to take now, or a failure to try again after a pause. */
export type Step = "done" | "more" | "retry";

/** The first pause after a failure, doubled each time up to RETRY_MAX_MS. */
export const RETRY_MIN_MS = 1000;
export const RETRY_MAX_MS = 30_000;

/**
 * Runs `step` again and again, one at a time: right away while it says "more", after a pause that
 * doubles (RETRY_MIN_MS to RETRY_MAX_MS) while it says "retry" or throws, and until it says "done".
 * `kick` starts it; a kick while it runs makes it run once more after, so no update is lost.
 */
export function drainer(step: () => Promise<Step>, sleep: (ms: number) => Promise<void>): { kick: () => void; stop: () => void } {
  let running = false;
  let again = false;
  let stopped = false;
  const loop = async () => {
    let pause = RETRY_MIN_MS;
    try {
      for (;;) {
        again = false;
        const result = await step().catch((): Step => "retry");
        if (stopped) return;
        if (result === "retry") {
          await sleep(pause);
          pause = Math.min(pause * 2, RETRY_MAX_MS);
          continue;
        }
        pause = RETRY_MIN_MS;
        if (result === "done" && !again) return;
      }
    } finally {
      running = false;
    }
  };
  return {
    kick: () => {
      if (stopped) return;
      if (running) {
        again = true;
        return;
      }
      running = true;
      void loop();
    },
    stop: () => {
      stopped = true;
    },
  };
}
