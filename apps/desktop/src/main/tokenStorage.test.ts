import { expect, test } from "vitest";
import type { TokenStorage } from "@clerk/electron";
import { guardedStorage, protectsTokens } from "./tokenStorage.ts";

test("only a real keyring protects tokens on Linux; basic_text and unknown don't", () => {
  expect(protectsTokens("darwin")).toBe(true);
  expect(protectsTokens("win32")).toBe(true);
  expect(protectsTokens("linux", "gnome_libsecret")).toBe(true);
  expect(protectsTokens("linux", "kwallet6")).toBe(true);
  expect(protectsTokens("linux", "basic_text")).toBe(false);
  expect(protectsTokens("linux", "unknown")).toBe(false);
  expect(protectsTokens("linux")).toBe(false);
});

test("an unprotected session stays in memory and its copy on disk is deleted", async () => {
  const files = new Map([["session", "written by an earlier launch"]]);
  const disk: TokenStorage = {
    getItem: (key) => files.get(key) ?? null,
    setItem: (key, value) => void files.set(key, value),
    removeItem: (key) => void files.delete(key),
  };
  let decision: boolean | undefined;
  const storage = guardedStorage(disk, () => decision);

  // Not decided yet: memory only, and the disk is left alone.
  await storage.setItem("early", "1");
  expect(await storage.getItem("early")).toBe("1");
  expect(files.has("early")).toBe(false);
  expect(files.get("session")).toBe("written by an earlier launch");

  decision = false;
  expect(await storage.getItem("session")).toBeNull();
  expect(files.has("session")).toBe(false);
  await storage.setItem("session", "token");
  expect(await storage.getItem("session")).toBe("token");
  expect(files.has("session")).toBe(false);

  decision = true;
  await storage.setItem("other", "kept");
  expect(files.get("other")).toBe("kept");
  expect(await storage.getItem("other")).toBe("kept");
});
