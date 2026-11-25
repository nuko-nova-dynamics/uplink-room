import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // The media test starts a LiveKit server and runs whisper.cpp.
    testTimeout: 120_000,
  },
});
