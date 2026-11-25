/**
 * Id arguments an agent's call gets wrong are refused, not reported.
 *
 * An agent passes the wrong kind of id now and then: a Pair message's id to `messages.get`, a task's
 * where a run's goes. Convex checks an id's table before the function runs, and a call that fails
 * that check is an uncaught exception, which Convex reports to Sentry (UPLINK-ROOM-BACKEND-J) though
 * the agent only made a mistake and got its 400. So the internal functions the HTTP endpoint,
 * `live:query` and the remote MCP connector call take such ids as strings (`looseIds`), and check
 * each one's table themselves before anything else runs (`checkIds`), refusing a wrong one with
 * `invalid`, which they answer like any refusal (lib/refusals.ts, ADR 0046).
 *
 * The handler gets exactly what Convex would have let through: every id it reads is checked here.
 * An id inside a union is loosened only where a string can't mean anything else, as in
 * `v.union(v.id("projects"), v.null())`; any other union keeps Convex's own check. The public
 * functions the app calls keep Convex's checks as they are.
 */
import { v, type GenericValidator, type PropertyValidators } from "convex/values";
import type { QueryCtx } from "../_generated/server";
import type { TableNames } from "../_generated/dataModel";
import schema from "../schema";
import { roomError } from "./errors";

type Shape = {
  kind: string;
  isOptional: "optional" | "required";
  tableName?: string;
  value?: unknown;
  fields?: Record<string, GenericValidator>;
  element?: GenericValidator;
  members?: GenericValidator[];
  key?: GenericValidator;
};

const shape = (validator: GenericValidator) => validator as unknown as Shape;

function hasId(validator: GenericValidator): boolean {
  const s = shape(validator);
  switch (s.kind) {
    case "id":
      return true;
    case "object":
      return Object.values(s.fields!).some(hasId);
    case "array":
      return hasId(s.element!);
    case "record":
      return hasId(s.key!) || hasId(shape(validator).value as GenericValidator);
    case "union":
      return s.members!.some(hasId);
    default:
      return false;
  }
}

function takesString(validator: GenericValidator): boolean {
  const s = shape(validator);
  if (s.kind === "string" || s.kind === "id") return true;
  if (s.kind === "literal") return typeof s.value === "string";
  if (s.kind === "union") return s.members!.some(takesString);
  return false;
}

/**
 * The tables a union's string names, when its ids can be loosened: its other members take no string
 * and hold no id, so a string matches an id member and nothing else. Otherwise null.
 */
function unionIdTables(validator: GenericValidator): string[] | null {
  const members = shape(validator).members!;
  const ids = members.filter((m) => shape(m).kind === "id");
  if (ids.length === 0) return null;
  const others = members.filter((m) => shape(m).kind !== "id");
  if (others.some((m) => hasId(m) || takesString(m))) return null;
  return ids.map((m) => shape(m).tableName!);
}

function loose(validator: GenericValidator): GenericValidator {
  if (!hasId(validator)) return validator;
  const s = shape(validator);
  let looser: GenericValidator;
  switch (s.kind) {
    case "id":
      looser = v.string();
      break;
    case "object":
      looser = v.object(looseIds(s.fields!));
      break;
    case "array":
      looser = v.array(loose(s.element!));
      break;
    case "record":
      looser = v.record(loose(s.key!) as never, loose(s.value as GenericValidator));
      break;
    case "union": {
      if (!unionIdTables(validator)) return validator;
      const others = s.members!.filter((m) => shape(m).kind !== "id");
      looser = v.union(v.string(), ...others);
      break;
    }
    default:
      return validator;
  }
  return s.isOptional === "optional" ? v.optional(looser) : looser;
}

/** A function's argument validators with its ids taken as strings, for `checkIds` to check. */
export function looseIds<Args extends PropertyValidators>(args: Args): Args {
  return Object.fromEntries(Object.entries(args).map(([name, validator]) => [name, loose(validator)])) as Args;
}

function idOf(ctx: QueryCtx, table: string, value: string): boolean {
  return table.startsWith("_")
    ? ctx.db.system.normalizeId(table as "_storage", value) !== null
    : ctx.db.normalizeId(table as TableNames, value) !== null;
}

function wrongId(ctx: QueryCtx, path: string, tables: string[], value: string): never {
  const from = (Object.keys(schema.tables) as TableNames[]).find((table) => ctx.db.normalizeId(table, value) !== null);
  const wanted = tables.join(" or ");
  throw roomError(
    "invalid",
    from ? `${path} takes an id from ${wanted}; this one is from ${from}.` : `${path} takes an id from ${wanted}; this isn't one.`,
  );
}

function check(ctx: QueryCtx, validator: GenericValidator, value: unknown, path: string): void {
  if (value === undefined || !hasId(validator)) return;
  const s = shape(validator);
  switch (s.kind) {
    case "id":
      if (!idOf(ctx, s.tableName!, value as string)) wrongId(ctx, path, [s.tableName!], value as string);
      return;
    case "object":
      for (const [name, field] of Object.entries(s.fields!)) check(ctx, field, (value as Record<string, unknown>)[name], `${path}.${name}`);
      return;
    case "array":
      (value as unknown[]).forEach((item, i) => check(ctx, s.element!, item, `${path}[${i}]`));
      return;
    case "record":
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        check(ctx, s.key!, key, `${path} key ${key}`);
        check(ctx, s.value as GenericValidator, item, `${path}.${key}`);
      }
      return;
    case "union": {
      const tables = unionIdTables(validator);
      // Not loosened, so Convex checked it; or a non-string, which matched a member with no id.
      if (!tables || typeof value !== "string") return;
      if (!tables.some((table) => idOf(ctx, table, value))) wrongId(ctx, path, tables, value);
      return;
    }
  }
}

/** Refuses, with `invalid`, an id in `values` from another table than `args` names. */
export function checkIds(ctx: QueryCtx, args: PropertyValidators, values: Record<string, unknown>): void {
  for (const [name, validator] of Object.entries(args)) check(ctx, validator, values[name], name);
}
