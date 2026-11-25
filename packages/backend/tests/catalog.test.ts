/// <reference types="vite/client" />
import { expect, test } from "vitest";
// Only what the HTTP endpoint loads: it fills the catalog the MCP server and the CLI list.
import "../convex/http";
import { catalog } from "../convex/lib/catalog";

const sources = import.meta.glob("../convex/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

test("every Room API function defined in convex/ is in the HTTP and MCP catalog", () => {
  const defined = Object.values(sources).flatMap((source) =>
    [...source.matchAll(/(?:room|account)(?:Query|Mutation)\(\{\s*name: "([a-z]+\.[A-Za-z]+)"/g)].map((m) => m[1]!),
  );
  const listed = new Set(catalog().map((entry) => entry.name));

  expect(defined).toEqual(expect.arrayContaining(["spaces.act", "spaces.share", "spaces.openView", "terminals.input", "people.me"]));
  expect(defined.filter((name) => !listed.has(name))).toEqual([]);
});
