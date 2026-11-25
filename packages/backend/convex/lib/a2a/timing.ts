/**
 * How the A2A worker paces itself (ADR 0012). Tests swap in fast timings, the
 * way they swap in a fake browser provider.
 */
export type A2ATiming = {
  /** Delays between polls of an unchanged task, in order; the last repeats. */
  pollMs: number[];
  /** Delays after failed contact, in order; the last repeats. */
  retryMs: number[];
  /** Failed contacts in a row before the run shows Unknown (connection lost). */
  failuresBeforeUnknown: number;
  /** No contact for this long and the room stops following the run. */
  giveUpAfterMs: number;
  /** No change for this long and the room stops following the run. */
  quietLimitMs: number;
  /** Longest one stream is held open before the worker resubscribes. Actions run for at most 10 minutes. */
  streamWindowMs: number;
  /** Timeout for one JSON-RPC call (SendMessage may block until the agent answers). */
  callTimeoutMs: number;
  /** Timeout for reading an Agent Card. */
  cardTimeoutMs: number;
  /** How long a worker step may hold a binding before another step may take over. */
  leaseMs: number;
  /** Between commits of artifact-only stream events (state changes commit at once). */
  streamCommitMs: number;
  /** Longest one step spends on calls. Actions run for at most 10 minutes; a step past this saves its place and stops. */
  stepBudgetMs: number;
  /** While a stream is open: how often it checks whether someone replied or stopped the run, which ends the stream early. */
  wakeCheckMs: number;
};

const MINUTE = 60_000;

const NORMAL: A2ATiming = {
  pollMs: [2_000, 5_000, 10_000, 30_000, 60_000],
  retryMs: [5_000, 15_000, 60_000, 5 * MINUTE],
  failuresBeforeUnknown: 4,
  giveUpAfterMs: 24 * 60 * MINUTE,
  quietLimitMs: 7 * 24 * 60 * MINUTE,
  streamWindowMs: 4 * MINUTE,
  callTimeoutMs: 4.5 * MINUTE,
  cardTimeoutMs: 15_000,
  leaseMs: 11 * MINUTE,
  streamCommitMs: 2_000,
  wakeCheckMs: 2_000,
  stepBudgetMs: 8 * MINUTE,
};

const FAST: A2ATiming = {
  pollMs: [10, 20, 40],
  retryMs: [10, 20],
  failuresBeforeUnknown: 2,
  giveUpAfterMs: 2_000,
  quietLimitMs: 60_000,
  streamWindowMs: 3_000,
  callTimeoutMs: 3_000,
  cardTimeoutMs: 3_000,
  leaseMs: 5_000,
  streamCommitMs: 10,
  wakeCheckMs: 20,
  stepBudgetMs: 5_000,
};

let override: A2ATiming | undefined;

/** Tests pass `{ fast: true }`; `undefined` goes back to normal. */
export function setA2ATimingForTests(value: { fast: true } | A2ATiming | undefined): void {
  override = value === undefined ? undefined : "fast" in value ? FAST : value;
}

export function a2aTiming(): A2ATiming {
  return override ?? NORMAL;
}

/** The nth delay of a schedule; past its end, the last one. */
export function nth(delays: number[], n: number): number {
  return delays[Math.min(Math.max(n, 0), delays.length - 1)]!;
}
