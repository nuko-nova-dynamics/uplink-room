/**
 * Lint rules for the kinds of error Sentry has caught, so the next one fails `pnpm lint` instead
 * (docs/error-reports.md, "Kept out by lint and models").
 *
 * - room/entry-handles-closed-output: a Node entry point (a `#!/usr/bin/env node` file under a
 *   `src` folder) calls `onClosedOutput` (@uplink-room/protocol/closedOutput). Without it a write
 *   after its reader went away is an uncaught EPIPE: UPLINK-ROOM-BRIDGE-3.
 * - room/public-functions-answer-refusals: a backend function is public only through
 *   `publicQuery` or `publicMutation` (lib/refusals.ts), so a refusal is answered to the clients
 *   that take one, never reported as an uncaught exception (ADR 0046, UPLINK-ROOM-BACKEND-5 to -8).
 * - room/convex-calls-accept-refusals: shipped code calls the room through a client that sends
 *   `acceptsRefusals` (`acceptingRefusals`, `RoomConvexClient`), never a bare `ConvexClient`,
 *   `ConvexReactClient` or `ConvexHttpClient`, whose refusals throw in the room and are reported.
 * - room/run-by-name-through-catalog: the backend runs a function by name (`makeFunctionReference`)
 *   only at a path from the catalog (`agentFunctionPath`, `accountFunctionPath`, `runFunctionPath`):
 *   the internal functions lib/room.ts builds, which check an agent's ids themselves (lib/idArgs.ts).
 *   Any other function rejects a wrong-table id in Convex's validator, which Sentry gets as an
 *   uncaught ArgumentValidationError (UPLINK-ROOM-BACKEND-J).
 * - room/room-api-reads-runs-through-access: a Room API handler (`roomQuery`, `roomMutation`) that
 *   lists rows of the `runs` or `tasks` table itself also calls a check that decides who may see
 *   such a row (`seesRun`, `runVisible`, `taskOutsideChannels`, ...). A2a.runs and a channel-limited key's
 *   run lists didn't, so a key limited to some channels read runs outside them (ADR 0049, the
 *   first review of the Board lessons).
 * - room/child-process-reports-start-failure: code that reads a `spawnSync` result's `status` also
 *   reads its `error`. A program that can't start (not found, or ENOEXEC: a file with no `#!` line,
 *   as a half-installed pnpm was on the release Mac) has status null, and a check on status alone
 *   says only "exit null" (the 0.2.22 release, docs/releases.md).
 */

/** Calls the visitor on every node under `node`, depth first. */
function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== "string") return;
  visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (Array.isArray(value)) for (const child of value) walk(child, visit, node);
    else if (value && typeof value === "object" && typeof value.type === "string") walk(value, visit, node);
  }
}

/** Like walk, with the nearest enclosing function (or the program) for each node. */
function walkScoped(node, visit, scope) {
  if (!node || typeof node.type !== "string") return;
  const inner = /Function/.test(node.type) || node.type === "Program" ? node : scope;
  visit(node, inner);
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent") continue;
    if (Array.isArray(value)) for (const child of value) walkScoped(child, visit, inner);
    else if (value && typeof value === "object" && typeof value.type === "string") walkScoped(value, visit, inner);
  }
}

const isSpawnSync = (node) =>
  node?.type === "CallExpression" &&
  ((node.callee.type === "Identifier" && node.callee.name === "spawnSync") ||
    (node.callee.type === "MemberExpression" && node.callee.property.type === "Identifier" && node.callee.property.name === "spawnSync"));

const isTest = (file) => /\.test\.[cm]?[jt]sx?$/.test(file) || /(^|\/)(test|tests)\//.test(file);

const isSource = (file) => /(^|\/)(apps|packages)\/[^/]+\/src\//.test(file) && !/\.test\.[cm]?[jt]sx?$/.test(file);

/** `a`, `this.a`, `this.#a`, as text, for an expression that names where a client is kept. */
function nameOf(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && node.object.type === "ThisExpression") {
    if (node.property.type === "Identifier") return `this.${node.property.name}`;
    if (node.property.type === "PrivateIdentifier") return `this.#${node.property.name}`;
  }
  return null;
}

const CALLS = new Set(["query", "mutation", "action", "onUpdate"]);
/** The Room API's factories (lib/room.ts) for team functions. */
const ROOM_API = new Set(["roomQuery", "roomMutation"]);
/**
 * The checks that decide who may see a listed run or task (lib/runLabels.ts, lib/channels.ts,
 * lib/members.ts). `inTeam` isn't one: it checks one id, not the rows a query lists.
 */
const ACCESS_CHECKS = {
  runs: new Set(["seesRun", "runOutsideChannels", "runVisible", "hiddenByRun"]),
  tasks: new Set(["taskOutsideChannels", "taskIsHidden"]),
};
const CATALOG_PATHS = new Set(["agentFunctionPath", "accountFunctionPath", "runFunctionPath"]);

/**
 * Whether `node` is always a catalog path: a call of one of CATALOG_PATHS, a conditional of such
 * calls, a variable set to one, or a parameter that every call in the file passes one.
 */
function catalogPath(node, scope, seen = new Set()) {
  if (!node) return false;
  if (node.type === "CallExpression") return node.callee.type === "Identifier" && CATALOG_PATHS.has(node.callee.name);
  if (node.type === "ConditionalExpression") return catalogPath(node.consequent, scope, seen) && catalogPath(node.alternate, scope, seen);
  if (node.type !== "Identifier" || seen.has(node.name)) return false;
  seen.add(node.name);
  if (scope.variables.has(node.name)) return catalogPath(scope.variables.get(node.name), scope, seen);
  const param = scope.params.get(node.name);
  if (!param) return false;
  const calls = scope.calls.get(param.fn) ?? [];
  return calls.length > 0 && calls.every((call) => catalogPath(call.arguments[param.index], scope, seen));
}

export function checkRoom(program, file, source) {
  const hits = [];
  const hit = (rule, node, message) => hits.push({ rule, node, message });

  if (isSource(file) && /^#!.*\bnode\b/.test(source)) {
    let handled = false;
    walk(program, (node) => {
      if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "onClosedOutput") handled = true;
    });
    if (!handled) {
      hit(
        "entry-handles-closed-output",
        program,
        "A Node entry point calls onClosedOutput (@uplink-room/protocol/closedOutput) before anything else, or a write after its reader is gone crashes it with EPIPE.",
      );
    }
  }

  if (/(^|\/)packages\/backend\/convex\//.test(file) && !file.endsWith("/lib/refusals.ts") && !/\/_generated\//.test(file)) {
    walk(program, (node) => {
      if (node.type !== "ImportDeclaration" || !node.source.value.endsWith("_generated/server")) return;
      for (const spec of node.specifiers) {
        if (spec.type !== "ImportSpecifier" || spec.importKind === "type") continue;
        const name = spec.imported.name ?? spec.imported.value;
        if (name === "query" || name === "mutation") {
          hit(
            "public-functions-answer-refusals",
            spec,
            `Make a public function with publicQuery or publicMutation (lib/refusals.ts), not ${name}: a refusal from a bare one reaches Sentry as an uncaught exception (ADR 0046).`,
          );
        }
      }
    });
  }

  if (isSource(file) && !/(^|\/)packages\/backend\//.test(file)) {
    const clients = new Set();
    const calls = [];
    walk(program, (node, parent) => {
      if (node.type === "NewExpression" && node.callee.type === "Identifier") {
        const kind = node.callee.name;
        if (kind === "ConvexReactClient" || kind === "ConvexHttpClient") {
          hit(
            "convex-calls-accept-refusals",
            node,
            `Use the app's RoomConvexClient or acceptingRefusals (@uplink-room/protocol/refusals), not a bare ${kind}: refusals to it are thrown in the room and reported to Sentry (ADR 0046).`,
          );
        }
        if (kind === "ConvexClient" && parent) {
          const kept =
            parent.type === "VariableDeclarator" ? nameOf(parent.id) : parent.type === "AssignmentExpression" ? nameOf(parent.left) : null;
          if (kept) clients.add(kept);
        }
      }
      if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && node.callee.property.type === "Identifier") {
        if (CALLS.has(node.callee.property.name)) calls.push(node);
      }
    });
    for (const call of calls) {
      const target = nameOf(call.callee.object);
      if (target && clients.has(target)) {
        hit(
          "convex-calls-accept-refusals",
          call,
          `Call the room through acceptingRefusals(${target}) (@uplink-room/protocol/refusals): a refusal to a bare ConvexClient is thrown in the room and reported to Sentry (ADR 0046).`,
        );
      }
    }
  }

  if (/(^|\/)packages\/backend\/convex\//.test(file) && !/\/_generated\//.test(file)) {
    const scope = { variables: new Map(), params: new Map(), calls: new Map() };
    const references = [];
    walk(program, (node) => {
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init) scope.variables.set(node.id.name, node.init);
      if (node.type === "FunctionDeclaration" && node.id) {
        node.params.forEach((param, index) => {
          if (param.type === "Identifier") scope.params.set(param.name, { fn: node.id.name, index });
        });
      }
      if (node.type === "CallExpression" && node.callee.type === "Identifier") {
        if (node.callee.name === "makeFunctionReference") references.push(node);
        else scope.calls.set(node.callee.name, [...(scope.calls.get(node.callee.name) ?? []), node]);
      }
    });
    for (const reference of references) {
      if (!catalogPath(reference.arguments[0], scope)) {
        hit(
          "run-by-name-through-catalog",
          reference,
          "Run a function by name only at agentFunctionPath, accountFunctionPath or runFunctionPath (lib/catalog.ts): those internal functions check an agent's ids themselves (lib/idArgs.ts), and any other one reports a wrong-table id to Sentry as an uncaught ArgumentValidationError.",
        );
      }
    }
  }

  if (/(^|\/)packages\/backend\/convex\/[^/]+\.ts$/.test(file) && !isTest(file)) {
    walk(program, (node) => {
      if (node.type !== "CallExpression" || node.callee.type !== "Identifier" || !ROOM_API.has(node.callee.name)) return;
      const def = node.arguments[0];
      if (def?.type !== "ObjectExpression") return;
      const handler = def.properties.find((p) => p.type === "Property" && p.key.type === "Identifier" && p.key.name === "handler")?.value;
      if (!handler) return;
      const reads = [];
      const called = new Set();
      walk(handler, (inner) => {
        if (inner.type !== "CallExpression") return;
        const callee = inner.callee;
        if (callee.type === "Identifier") called.add(callee.name);
        if (
          callee.type === "MemberExpression" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "query" &&
          inner.arguments[0]?.type === "Literal" &&
          (inner.arguments[0].value === "runs" || inner.arguments[0].value === "tasks")
        )
          reads.push(inner);
      });
      for (const read of reads) {
        const table = read.arguments[0].value;
        if ([...ACCESS_CHECKS[table]].some((check) => called.has(check))) continue;
        hit(
          "room-api-reads-runs-through-access",
          read,
          `Filter the ${table} this handler lists through who may see them (${[...ACCESS_CHECKS[table]].join(", ")}): a closed run, one from a private conversation, or one outside a channel-limited key's channels (ADR 0049) would show otherwise.`,
        );
      }
    });
  }

  if (!isTest(file)) {
    // Per function: the spawnSync results kept in a variable, and which of their fields are read.
    const kept = new Map();
    const reads = new Map();
    const key = (scope, name) => `${scope.start}:${name}`;
    walkScoped(program, (node, scope) => {
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && isSpawnSync(node.init))
        kept.set(key(scope, node.id.name), node);
      if (node.type === "MemberExpression" && node.property.type === "Identifier") {
        if (isSpawnSync(node.object) && node.property.name === "status") {
          hit(
            "child-process-reports-start-failure",
            node,
            "Keep the spawnSync result and check its error too: a program that can't start has status null, and its error says why (ENOENT, ENOEXEC).",
          );
        }
        if (node.object.type === "Identifier") {
          const fields = reads.get(key(scope, node.object.name)) ?? new Set();
          fields.add(node.property.name);
          reads.set(key(scope, node.object.name), fields);
        }
      }
    });
    for (const [name, declarator] of kept) {
      const fields = reads.get(name) ?? new Set();
      if (fields.has("status") && !fields.has("error")) {
        hit(
          "child-process-reports-start-failure",
          declarator,
          `Check ${declarator.id.name}.error as well as its status: a program that can't start has status null, and its error says why (ENOENT, ENOEXEC).`,
        );
      }
    }
  }

  return hits;
}
