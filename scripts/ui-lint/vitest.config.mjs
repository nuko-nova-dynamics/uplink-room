import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["scripts/ui-lint/*.test.mjs", "scripts/lint/*.test.mjs"] } });
