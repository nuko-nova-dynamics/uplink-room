import { checkRoom } from "./room.mjs";
const cache = new WeakMap();
const names = ["entry-handles-closed-output", "public-functions-answer-refusals", "convex-calls-accept-refusals", "run-by-name-through-catalog", "room-api-reads-runs-through-access", "child-process-reports-start-failure"];
export default {
  meta: { name: "room" },
  rules: Object.fromEntries(
    names.map((name) => [
      name,
      {
        create(context) {
          return {
            Program(program) {
              const file = context.filename.replaceAll("\\", "/");
              if (!cache.has(program)) cache.set(program, checkRoom(program, file, context.sourceCode.text));
              for (const hit of cache.get(program))
                if (hit.rule === name) context.report({ node: hit.node, message: hit.message });
            },
          };
        },
      },
    ]),
  ),
};
