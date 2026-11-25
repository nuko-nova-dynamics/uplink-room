// @vitest-environment happy-dom
/**
 * A run's terminal preview fails soft: when reading the terminal is refused (not_found for a run
 * hidden from you, admins included), the preview shows nothing and the screen around it stays up.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test, vi } from "vitest";
import type { MyTeam } from "../lib/api";
import { SessionProvider } from "../lib/session";
import { RunOutput } from "./RunOutput";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("convex/react", async (original) => ({
  ...(await original<typeof import("convex/react")>()),
  // The team's members load; every terminal read is refused, as the server's hiddenByRun does.
  useQuery: () => [],
  useMutation: () => async () => null,
  useQueries: (request: Record<string, unknown>) =>
    Object.fromEntries(Object.keys(request).map((key) => [key, new Error("[not_found] Not found in this team.")])),
}));

test("a terminal preview the server refuses renders nothing instead of taking the screen down", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const team = { teamId: "team", memberId: "admin", role: "admin" } as unknown as MyTeam;
  expect(() =>
    act(() =>
      root.render(
        <SessionProvider team={team}>
          <p>Run card</p>
          <RunOutput terminalId={"t_hidden" as never} onOpen={() => {}} />
        </SessionProvider>,
      ),
    ),
  ).not.toThrow();
  expect(host.textContent).toBe("Run card");
  expect(host.querySelector(".run-output")).toBeNull();
  act(() => root.unmount());
});
