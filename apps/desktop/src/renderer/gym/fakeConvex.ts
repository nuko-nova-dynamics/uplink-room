import { jsonToConvex } from "convex/values";
import { getFunctionName, type FunctionReference } from "convex/server";

/**
 * A stand-in for ConvexReactClient that answers every query from recorded results (fixtures.json)
 * and answers mutations without a backend. It implements what convex/react's hooks call:
 * `watchQuery`, `watchPaginatedQuery`, `mutation`, `action` and `logger`.
 */
export type Fixture = { udfPath: string; args: Record<string, unknown>; value: unknown };
export type Answer = (udfPath: string, args: Record<string, unknown>) => unknown;

/** The same JSON for the same args, whatever order their keys came in. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/** What a query is looked up by: its args without the team, and a page's options without the paginator's id. */
export function keyOf(udfPath: string, args: Record<string, unknown>): string {
  const rest: Record<string, unknown> = { ...args };
  delete rest["teamId"];
  const page = rest["paginationOpts"] as { numItems?: number; cursor?: unknown } | undefined;
  if (page) rest["paginationOpts"] = { numItems: page.numItems, cursor: page.cursor ?? null };
  return `${udfPath} ${canonical(rest)}`;
}

export function fixtureTable(fixtures: Fixture[]): Map<string, unknown> {
  return new Map(fixtures.map((f) => [keyOf(f.udfPath, f.args), jsonToConvex(f.value as never)]));
}

export class FakeConvex {
  readonly logger = { log: () => {}, warn: () => {}, error: console.error, logVerbose: () => {} };
  private readonly answer: Answer;
  private readonly onMutation: (udfPath: string, args: Record<string, unknown>) => Promise<unknown>;
  private readonly subscribe: (listener: () => void) => () => void;
  /**
   * `subscribe` tells every watched query that the answers may have changed, as a Convex
   * subscription would after a mutation (the gym's chat scene, gym/chat.ts).
   */
  constructor(
    answer: Answer,
    onMutation: (udfPath: string, args: Record<string, unknown>) => Promise<unknown> = async () => null,
    subscribe: (listener: () => void) => () => void = () => () => {},
  ) {
    this.answer = answer;
    this.onMutation = onMutation;
    this.subscribe = subscribe;
  }

  watchQuery(query: FunctionReference<"query">, args: Record<string, unknown> = {}) {
    const udfPath = getFunctionName(query);
    return {
      onUpdate: (callback: () => void) => this.subscribe(callback),
      localQueryResult: () => this.answer(udfPath, args),
      localQueryLogs: () => undefined,
      journal: () => undefined,
    };
  }

  watchPaginatedQuery(query: FunctionReference<"query">, args: Record<string, unknown> = {}) {
    return this.watchQuery(query, args);
  }

  mutation(mutation: FunctionReference<"mutation">, args: Record<string, unknown> = {}) {
    return this.onMutation(getFunctionName(mutation), args);
  }

  action(action: FunctionReference<"action">, args: Record<string, unknown> = {}) {
    return this.onMutation(getFunctionName(action), args);
  }

  prewarmQuery() {}
  close() {
    return Promise.resolve();
  }
}
