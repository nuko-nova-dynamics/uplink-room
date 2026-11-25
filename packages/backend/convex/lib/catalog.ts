/**
 * The list of Room API functions, filled as each module defines its functions.
 * The HTTP endpoint dispatches by name from it, and `GET /api/v1/functions`
 * serves it so the MCP server and the command-line tool can list every action.
 */
import type { GenericValidator, PropertyValidators } from "convex/values";
import type { Scope } from "./scopes";

export const ROOM_API_VERSION = "v1";

/**
 * What an argument's JSON Schema says beyond its validator: a description, and for a string the
 * values it takes when the validator can't list them (such as a harness, checked in the handler).
 */
export type ArgDoc = string | { description?: string; enum?: readonly string[]; hidden?: true };

/**
 * Where a function acts (ADR 0030, ADR 0032). `team`: in one team, as a member, with `teamId`; agent
 * keys and people both call these. `account`: for a signed-in person, in no team; agent keys can't
 * call them. `pair`: in Pairs (ADR 0034), outside every team, for a signed-in person or an agent key
 * with `pairs.join`. `run`: as one joined run, with that run's own token (`urj_…`) and nothing else.
 */
export type Realm = "team" | "account" | "pair" | "run";

export type CatalogEntry = {
  name: string;
  kind: "query" | "mutation";
  realm: Realm;
  description: string;
  /**
   * The scope an agent key needs. `account` for account functions and `run` for run functions,
   * which no agent key can call.
   */
  scope: Scope | "account" | "run";
  args: PropertyValidators;
  /** Per-argument docs for the JSON Schema that MCP clients and `uplink <fn> --help` show. */
  argDocs?: Record<string, ArgDoc | undefined>;
};

const entries = new Map<string, CatalogEntry>();

export function registerFunction(entry: CatalogEntry): void {
  entries.set(entry.name, entry);
}

export function catalogEntry(name: string): CatalogEntry | undefined {
  return entries.get(name);
}

export function catalog(): CatalogEntry[] {
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The Convex function an agent call runs: `tasks.create` runs the internal
 * function exported as `createAgent` from `convex/tasks.ts`.
 */
export function agentFunctionPath(name: string): string {
  const dot = name.lastIndexOf(".");
  return `${name.slice(0, dot).replaceAll(".", "/")}:${name.slice(dot + 1)}Agent`;
}

/**
 * The Convex function an account function runs over HTTP with a CLI sign-in: `people.me` runs the
 * internal function exported as `meBySignIn` from `convex/people.ts`.
 */
export function accountFunctionPath(name: string): string {
  const dot = name.lastIndexOf(".");
  return `${name.slice(0, dot).replaceAll(".", "/")}:${name.slice(dot + 1)}BySignIn`;
}

/**
 * The Convex function a run function runs over HTTP with a joined run's token: `joined.take` runs the
 * internal function exported as `takeByRun` from `convex/joined.ts`.
 */
export function runFunctionPath(name: string): string {
  const dot = name.lastIndexOf(".");
  return `${name.slice(0, dot).replaceAll(".", "/")}:${name.slice(dot + 1)}ByRun`;
}

type JsonSchema = Record<string, unknown>;

/**
 * Where an agent finds an id of each kind, so an id argument's description says which call
 * returns one. Tables not listed get a plain "An id in <table>".
 */
const ID_SOURCES: Record<string, string> = {
  agents: "An agent's agentId, from teams.members (or members.me for yourself)",
  _storage: "A storageId: what the POST to an upload URL (files.uploadUrl, messages.attachUrl) answers",
  agentKeys: "A keyId, from agents.keys (members.me has your own)",
  browserSuggestions: "A suggestionId, from browsers.suggestions",
  browserWheelRequests: "A requestId, from browsers.wheelRequests",
  browsers: "A browserId, from browsers.list",
  callParticipations: "A participationId, from calls.join",
  calls: "A callId, from calls.live, calls.list or calls.invitations",
  channels: "A channelId, from channels.list (a direct message's comes from channels.openDirect)",
  cliSignIns: "A signInId, from people.signIns",
  pairs: "A pairId, from pairs.list",
  comments: "A commentId, from comments.list",
  connectors: "A connectorId, from connectors.list",
  files: "A fileId, from files.list",
  machines: "A machineId, from machines.list",
  members: "A memberId, from teams.members (yours is in members.me)",
  messages: "A messageId, from messages.list, messages.search or messages.addressed",
  profiles: "A profileId, from profiles.mine",
  projects: "A projectId, from projects.list",
  runs: "A runId, from runs.start, tasks.get, tasks.board or inbox.get",
  savedLogins: "A savedLoginId, from savedLogins.list",
  spaceActions: "An actionId, from spaces.act or spaces.actions",
  spaceSuggestions: "A suggestionId, from spaces.suggestions",
  spaceWheelRequests: "A requestId, from spaces.wheelRequests",
  suggestions: "A suggestionId, from terminals.suggestions",
  taskProposals: "A proposalId, from calls.get (a call's proposed tasks)",
  threadWheelRequests: "A requestId, from threads.wheelRequests",
  threadSuggestions: "A suggestionId, from threads.suggestions",
  spaces: "A spaceId, from spaces.list",
  tasks: "A taskId, from tasks.board or tasks.get",
  terminals: "A terminalId, from runs.start or terminals.list",
  uploads: "An uploadId, from files.uploadUrl or messages.attachUrl",
  wheelRequests: "A requestId, from terminals.wheelRequests",
};

function idDescription(table: string): string {
  return ID_SOURCES[table] ?? `An id in ${table}`;
}

/** JSON Schema for a function's arguments, for MCP tool definitions. Account, pair and run functions take no teamId. */
export function argsJsonSchema(args: PropertyValidators, docs?: CatalogEntry["argDocs"], realm: Realm = "team"): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  if (realm === "team") {
    properties.teamId = {
      type: "string",
      description:
        "The team. Optional with an agent key (the key's team is used) and with a CLI sign-in when you're in one team (people.me lists yours).",
    };
  }
  const required: string[] = [];
  for (const [key, validator] of Object.entries(args)) {
    const doc = docs?.[key];
    // An argument only the app sends (such as Convex's paginationOpts) stays out of agents' schemas.
    if (typeof doc === "object" && doc.hidden && validator.isOptional === "optional") continue;
    properties[key] = withDoc(validatorJsonSchema(validator), doc);
    if (validator.isOptional !== "optional") required.push(key);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

/** An argument's schema with its doc: the doc's text goes first, then what the validator says. */
function withDoc(schema: JsonSchema, doc: ArgDoc | undefined): JsonSchema {
  if (doc === undefined) return schema;
  const { description, enum: values } = typeof doc === "string" ? { description: doc, enum: undefined } : doc;
  const own = typeof schema.description === "string" ? schema.description : undefined;
  const text = [description, own].filter(Boolean).join(". ");
  return { ...schema, ...(text ? { description: text } : {}), ...(values ? { enum: [...values] } : {}) };
}

function validatorJsonSchema(validator: GenericValidator): JsonSchema {
  const anyValidator = validator as unknown as {
    kind: string;
    value?: unknown;
    element?: GenericValidator;
    fields?: Record<string, GenericValidator>;
    members?: GenericValidator[];
    tableName?: string;
  };
  switch (anyValidator.kind) {
    case "id":
      return { type: "string", description: idDescription(anyValidator.tableName!) };
    case "string":
      return { type: "string" };
    case "float64":
    case "int64":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "null":
      return { type: "null" };
    case "literal":
      return { const: anyValidator.value };
    case "array":
      return { type: "array", items: validatorJsonSchema(anyValidator.element!) };
    case "object": {
      const fields = anyValidator.fields ?? {};
      return argsObjectSchema(fields);
    }
    case "union": {
      const members = anyValidator.members ?? [];
      if (members.every((m) => (m as unknown as { kind: string }).kind === "literal")) {
        return { enum: members.map((m) => (m as unknown as { value: unknown }).value) };
      }
      return { anyOf: members.map(validatorJsonSchema) };
    }
    default:
      return {};
  }
}

function argsObjectSchema(fields: Record<string, GenericValidator>): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, validator] of Object.entries(fields)) {
    properties[key] = validatorJsonSchema(validator);
    if (validator.isOptional !== "optional") required.push(key);
  }
  return { type: "object", properties, required };
}
