import { expect, test } from "vitest";
import { isLoopback, pairWithT3 } from "../src/adapters/t3pair.ts";

test("the bridge mints a T3 Code token only for a T3 Code server on this machine", async () => {
  expect(isLoopback("http://127.0.0.1:3773")).toBe(true);
  expect(isLoopback("http://localhost:3773")).toBe(true);
  expect(isLoopback("http://[::1]:3773")).toBe(true);
  expect(isLoopback("https://t3.example.com")).toBe(false);
  // No t3 CLI runs, and nothing is sent: the local token never reaches another server.
  await expect(pairWithT3({ url: "https://t3.example.com", executable: "/bin/false" })).rejects.toThrow(/on this machine/);
});
