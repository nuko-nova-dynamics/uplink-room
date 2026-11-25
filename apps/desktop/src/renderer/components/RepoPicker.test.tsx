// @vitest-environment happy-dom
/**
 * The repo picker (ADR 0020) and New project from a repo: search the synced repos, type a repo
 * that isn't connected, and see which chosen repos a connected GitHub account gives the team.
 */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { getFunctionName } from "convex/server";
import { afterEach, expect, test, vi } from "vitest";
import { settle } from "@ui-sdk/core/testing";

const SYNCED = [
  { githubId: 1, fullName: "Harbor-Labs/tide-tables", repo: "github.com/Harbor-Labs/tide-tables", private: true, archived: false, defaultBranch: "main", account: "Harbor-Labs" },
  { githubId: 2, fullName: "Harbor-Labs/tide-tables-export", repo: "github.com/Harbor-Labs/tide-tables-export", private: false, archived: false, defaultBranch: "main", account: "Harbor-Labs" },
  { githubId: 3, fullName: "Harbor-Labs/charts", repo: "github.com/Harbor-Labs/charts", private: false, archived: true, defaultBranch: "main", account: "Harbor-Labs" },
];
const mocks = vi.hoisted(() => ({ created: [] as unknown[], statusCalls: [] as number[], statusFails: false }));

/** What the backend answers, and how it refuses: github.repoStatus takes at most 100 repos. */
function answer(name: string, args: Record<string, unknown>) {
  if (name === "github:accounts") return { configured: true, canConnect: true, canConnectOrganizations: true, accounts: [{ accountId: "a1", login: "Harbor-Labs" }] };
  if (name === "github:repos") {
    const q = String(args["search"] ?? "").toLowerCase();
    return SYNCED.filter((r) => r.fullName.toLowerCase().includes(q));
  }
  if (name === "github:repoStatus") {
    const repos = args["repos"] as string[];
    mocks.statusCalls.push(repos.length);
    if (repos.length > 100) throw new Error("Ask about at most 100 repos at once.");
    if (mocks.statusFails) throw new Error("GitHub isn't set up on this deployment yet.");
    return repos.map((repo) => ({ repo, synced: SYNCED.find((r) => r.repo.toLowerCase() === repo.toLowerCase()) ?? null }));
  }
  return undefined;
}

vi.mock("../lib/session", () => {
  const soft = (name: string, args: Record<string, unknown>, failed: unknown) => {
    try {
      return answer(name, args);
    } catch {
      return failed;
    }
  };
  return {
    // A query that fails throws during render, as convex/react's useQuery does.
    useRoomQuery: (ref: never, args: Record<string, unknown> | "skip") => (args === "skip" ? undefined : answer(getFunctionName(ref), args)),
    useSoftRoomQuery: (ref: never, args: Record<string, unknown> | "skip", failed?: unknown) =>
      args === "skip" ? undefined : soft(getFunctionName(ref), args, failed),
    useSoftRoomQueries: (ref: never, list: Record<string, unknown>[], failed?: unknown) => list.map((args) => soft(getFunctionName(ref), args, failed)),
    useAct: () => async (args: unknown) => {
      mocks.created.push(args);
      return "ks7project";
    },
  };
});

const { RepoPicker } = await import("./RepoPicker");
const { NewProjectDialog } = await import("./NewWork");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  mocks.created.length = 0;
  mocks.statusCalls.length = 0;
  mocks.statusFails = false;
});

function render(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(node));
  // A dialog (UI SDK) renders into the body beside the host: this render's is the newest one.
  return ([...document.querySelectorAll<HTMLElement>('[data-slot="dialog-content"]')].at(-1) ?? host);
}

const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
/** Types into the search, then lets the combobox's list open and highlight its first result. */
async function typeIn(input: HTMLInputElement, text: string) {
  act(() => {
    input.focus();
    setValue.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(() => settle());
}
function key(input: HTMLElement, name: string) {
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
}

function Picker({ start = [] as string[] }) {
  const [repos, setRepos] = useState(start);
  return <RepoPicker inputId="repos" repos={repos} onChange={setRepos} />;
}

// The results are a combobox list in the top layer, rendered into the body.
const options = () => [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);
const chosen = (host: HTMLElement) => [...host.querySelectorAll(".repo-chosen li")].map((li) => li.textContent);

test("search lists synced repos not already chosen, and picking one adds the string a project keeps", async () => {
  const host = render(<Picker start={["github.com/harbor-labs/charts"]} />);
  const input = host.querySelector<HTMLInputElement>("#repos")!;
  await typeIn(input, "tide");
  expect(options()).toEqual(["Harbor-Labs/tide-tablesPrivate", "Harbor-Labs/tide-tables-export"]);
  key(input, "ArrowDown");
  key(input, "Enter");
  // Already listed in another case, charts isn't offered again; the export was picked.
  expect(chosen(host)).toEqual(["Harbor-Labs/chartsArchived, from Harbor-Labs", "Harbor-Labs/tide-tables-exportfrom Harbor-Labs"]);
  expect(input.value).toBe("");
});

test("a repo typed by hand is offered when nothing synced matches, kept as github.com/owner/name, and shows as not connected", async () => {
  const host = render(<Picker />);
  const input = host.querySelector<HTMLInputElement>("#repos")!;
  await typeIn(input, "nuko/legacy-billing");
  // Kept as projects keep it, with GitHub's host, so a run in it finds the T3 Code project.
  expect(options()).toEqual(["Add github.com/nuko/legacy-billingNot connected"]);
  key(input, "Enter");
  expect(chosen(host)).toEqual(["github.com/nuko/legacy-billingNot connected"]);
  // Escape clears the search first and doesn't reach the dialog behind it.
  const closed = vi.fn();
  window.addEventListener("keydown", closed);
  await typeIn(input, "tide");
  key(input, "Escape");
  expect(input.value).toBe("");
  expect(closed).not.toHaveBeenCalled();
  window.removeEventListener("keydown", closed);
});

test("New project from a repo: picking a synced repo before naming the project names it after the repo", async () => {
  const host = render(<NewProjectDialog onClose={() => {}} onCreated={() => {}} />);
  const name = host.querySelector<HTMLInputElement>("#project-name")!;
  const search = host.querySelector<HTMLInputElement>("#project-repos")!;
  // The dialog puts focus on Name once it has opened.
  await act(() => settle());
  await typeIn(search, "tide-tables-ex");
  key(search, "Enter");
  expect(name.value).toBe("tide-tables-export");
  await act(async () => host.querySelector<HTMLButtonElement>(".btn.primary")!.click());
  expect(mocks.created).toEqual([{ name: "tide-tables-export", repos: ["github.com/Harbor-Labs/tide-tables-export"] }]);
});

test("a project with 101 repos asks their status 100 at a time, and a failed lookup leaves them blank instead of breaking the picker", () => {
  const many = Array.from({ length: 101 }, (_, i) => `nuko/r${i}`);
  const host = render(<Picker start={[...many.slice(0, 100), "github.com/Harbor-Labs/charts"]} />);
  expect(mocks.statusCalls).toEqual(expect.arrayContaining([100, 1]));
  expect(mocks.statusCalls.every((n) => n <= 100)).toBe(true);
  expect(chosen(host)).toHaveLength(101);
  expect(chosen(host).at(-1)).toBe("Harbor-Labs/chartsArchived, from Harbor-Labs");
  expect(chosen(host)[0]).toBe("nuko/r0Not connected");

  mocks.statusFails = true;
  const failing = render(<Picker start={many} />);
  expect(chosen(failing)).toHaveLength(101);
  expect(chosen(failing)[0]).toBe("nuko/r0");
});
