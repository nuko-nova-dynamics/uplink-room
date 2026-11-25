// @vitest-environment happy-dom
/**
 * useSoftRoomQuery must hand useQueries the same request object from one render to the next.
 * `api.x.y` is a new reference on every read (convex's anyApi), so a request keyed on it changed
 * every render, useQueries resubscribed every render, and React stopped with error 301: 0.2.3's
 * task panel crashed that way on any run card with a terminal.
 */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

const requests: unknown[] = [];
vi.mock("convex/react", async (actual) => ({
  ...(await actual<typeof import("convex/react")>()),
  useQueries: (request: unknown) => {
    requests.push(request);
    return {};
  },
  // SessionProvider reads the team's members and sets up its mutations.
  useQuery: () => [],
  useMutation: () => () => Promise.resolve(),
}));

const { api } = await import("./api");
const { SessionProvider, useSoftRoomQuery } = await import("./session");
const team = { teamId: "team1", memberId: "m1", role: "member" } as never;

afterEach(() => {
  requests.length = 0;
  document.body.innerHTML = "";
});

function Probe({ n }: { n: number }) {
  useSoftRoomQuery(api.terminals.get, { terminalId: "t1" as never });
  return <span>{n}</span>;
}

test("the request useQueries gets stays the same across renders, though api.x.y is new each read", async () => {
  expect(api.terminals.get).not.toBe(api.terminals.get);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  for (const n of [1, 2, 3])
    await act(async () =>
      root.render(
        <SessionProvider team={team}>
          <Probe n={n} />
        </SessionProvider>,
      ),
    );
  expect(requests.length).toBeGreaterThanOrEqual(3);
  expect(new Set(requests).size).toBe(1);
  root.unmount();
});
