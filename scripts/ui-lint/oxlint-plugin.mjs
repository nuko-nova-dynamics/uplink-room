import { checkTsx } from "./tsx.mjs";
const cache = new WeakMap();
const names = ["no-inline-svg", "no-inline-px", "no-emoji-icon", "icon-scale", "icon-geometry"];
export default {
  meta: { name: "ui" },
  rules: Object.fromEntries(
    names.map((name) => [
      name,
      {
        create(context) {
          return {
            Program(program) {
              const file = context.filename.replaceAll("\\", "/");
              const relative = file.slice(file.lastIndexOf("/apps/") + 1);
              if (!cache.has(program)) cache.set(program, checkTsx(program, relative));
              for (const hit of cache.get(program))
                if (hit.rule === name) context.report({ node: hit.node, message: hit.message });
            },
          };
        },
      },
    ]),
  ),
};
