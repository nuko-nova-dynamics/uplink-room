/**
 * Runs once, in Node, before the backend tests (which run in the edge runtime
 * and can't start servers). It serves a small controller the tests call to
 * start fake A2A agents with the options each test needs:
 *
 *   POST /agents            FakeAgentOptions  ->  { id, url, cardUrl }
 *   GET  /agents/:id/calls  ->  the JSON-RPC calls that agent received
 *   POST /agents/:id/options   Partial<FakeAgentOptions>: change them while it runs
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestProject } from "vitest/node";
import { startFakeAgent, type FakeAgent } from "./fakeAgent";

declare module "vitest" {
  export interface ProvidedContext {
    fakeAgents: string;
  }
}

/**
 * A fake Grok Bot routine webhook (tests/webhooks.test.ts): it records each POST's headers and body
 * and answers with what the test set, as docs.x.ai/grok-bot/skills-routines-and-automations
 * describes a routine webhook (200 means a run started, anything else that it didn't).
 *
 *   POST /webhooks                { status?, body?, delayMs?, location? }  ->  { id, url }
 *   GET  /webhooks/:id/calls      ->  [{ headers, body }]
 *   POST /hook/:id                the webhook itself
 */
type FakeHook = {
  status: number;
  body: string;
  delayMs: number;
  location?: string;
  calls: { headers: Record<string, string | string[] | undefined>; body: string }[];
};

export default async function setup(project: TestProject) {
  const agents = new Map<string, FakeAgent>();
  const hooks = new Map<string, FakeHook>();
  let next = 0;
  let base = "";
  const server: Server = createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const readBody = async () => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      return raw;
    };
    try {
      if (req.method === "POST" && req.url === "/webhooks") {
        const raw = await readBody();
        const options = (raw ? JSON.parse(raw) : {}) as Partial<FakeHook>;
        const id = String(++next);
        hooks.set(id, {
          status: options.status ?? 200,
          body: options.body ?? "",
          delayMs: options.delayMs ?? 0,
          ...(options.location ? { location: options.location } : {}),
          calls: [],
        });
        send(200, { id, url: `${base}/hook/${id}` });
        return;
      }
      const hookCalls = req.url?.match(/^\/webhooks\/(\d+)\/calls$/);
      if (req.method === "GET" && hookCalls) {
        send(200, hooks.get(hookCalls[1]!)?.calls ?? []);
        return;
      }
      const hook = req.url?.match(/^\/hook\/(\d+)$/);
      if (hook) {
        const fake = hooks.get(hook[1]!);
        if (!fake) return send(404, { error: "no such routine" });
        const body = await readBody();
        fake.calls.push({ headers: { ...req.headers }, body });
        if (fake.delayMs) await new Promise((resolve) => setTimeout(resolve, fake.delayMs));
        res.writeHead(fake.status, {
          "content-type": "text/plain",
          ...(fake.location ? { location: fake.location } : {}),
        });
        res.end(fake.body);
        return;
      }
      if (req.method === "POST" && req.url === "/agents") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const agent = await startFakeAgent(raw ? JSON.parse(raw) : {});
        const id = String(++next);
        agents.set(id, agent);
        send(200, { id, url: agent.url, cardUrl: agent.cardUrl });
        return;
      }
      const set = req.url?.match(/^\/agents\/(\d+)\/options$/);
      if (req.method === "POST" && set) {
        const agent = agents.get(set[1]!);
        if (!agent) return send(404, { error: "no such agent" });
        let raw = "";
        for await (const chunk of req) raw += chunk;
        agent.setOptions(JSON.parse(raw));
        send(200, {});
        return;
      }
      const match = req.url?.match(/^\/agents\/(\d+)\/calls$/);
      if (req.method === "GET" && match) {
        const agent = agents.get(match[1]!);
        if (!agent) return send(404, { error: "no such agent" });
        send(200, agent.calls);
        return;
      }
      send(404, { error: "not found" });
    } catch (error) {
      send(500, { error: String(error) });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  project.provide("fakeAgents", base);
  return async () => {
    await Promise.all([...agents.values()].map((a) => a.close()));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
}
