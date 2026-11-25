# Decision for #8: connect agents through both protocols

Prepared for Julio, 2026-11-02. **Decided by Julio on 2026-11-02: both, outbound A2A first.** What was built, and how it differs from this brief, is in ADR 0012.

## Decide in a minute

**Use the Room API for actions in Uplink Room and an A2A client adapter for conversations with Hermes and OpenClaw.** Start with outbound A2A: the room calls an existing agent gateway. A public Uplink Room A2A server can wait. The gateway continues to run the agent, preserving ADR 0001; every room action still uses the Room API, preserving ADR 0003.

**State ownership:** the remote agent owns execution and its A2A task state. One adapter owns reporting that execution into a room run. The backend owns the stored run state, driver, Inbox routing, permissions and audit. MCP calls may change room content but cannot overwrite an A2A-managed run's execution state.

**Question for Julio:** use both, with A2A for agent conversations, the Room API for room actions, and one adapter reporting each run's state?

| Choice | Benefit | Trade-off | Code needed |
| --- | --- | --- | --- |
| Room API only, through MCP/HTTP | Smallest integration; both agents already consume MCP tools | A tool connection does not make an agent callable or deliver mentions to it. We must supply a gateway plugin or worker to receive work and report progress | Add external-agent run registration/reporting and a delivery queue; configure `uplink-mcp` or HTTP on each gateway |
| A2A only for agent integration | Standard discovery and task exchange; external gateways retain execution | A2A does not replace channels, membership, scoped room actions or approvals. An inbound room server must forward to a real agent, or it would contradict ADR 0001 | Add Agent Card, JSON-RPC server/client, peer identity, task store and forwarding; translate room actions into the existing Room API rather than a second authorization path |
| **Both, outbound A2A first** | Standard task conversations plus all existing room tools; fits ADRs 0001–0003 | More adapter work; peer capabilities differ, especially cancellation and approval visibility | Add an A2A conversation adapter and external-run binding; retain MCP/HTTP as the room-action surface. Defer public Agent Card/server |

## What the current sources establish

All external sources in this brief were opened on **2026-11-02**. These are documentation findings, not live interoperability results.

| Source | Verified support and its consequence |
| --- | --- |
| [A2A 1.0 specification](https://a2a-protocol.org/latest/specification/) | Discovery uses Agent Cards; JSON-RPC is one binding. Send `A2A-Version: 1.0`; use canonical methods such as `SendMessage` and `GetTask`, rather than assuming 0.3 path-style methods. Streaming and push depend on advertised capabilities. Authentication does not grant room membership or scopes |
| [Hermes A2A docs](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/a2a) | Both client and server. Discovery at `/.well-known/agent-card.json`; JSON-RPC at `POST /`, default port 9900. Documents send/get/list/cancel, SSE and signed push notifications. Outbound `a2a` toolset is off by default. Remote inbound access requires an explicit host and bearer token; per-peer tokens are supported |
| [Hermes MCP docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp) | Built-in MCP client; local stdio and remote HTTP, discovery and tool filters. Configure `mcp_servers`. It can run the room's existing stdio MCP wrapper locally; no new remote MCP server is required |
| [OpenClaw A2A docs](https://docs.openclaw.ai/channels/a2a) | Inbound and configured outbound peers; A2A 1.0 JSON-RPC at `/a2a/v1`, per-peer bearer tokens. Supports send/get and text/JSON; no streaming, push, cancellation or task listing. Poll it. Local exec approvals leave the task Working and must be answered through an authorized OpenClaw user surface. Terminal task retention is at most 24 hours/500 entries |
| [OpenClaw MCP tools](https://docs.openclaw.ai/tools/mcp), [MCP CLI](https://docs.openclaw.ai/cli/mcp) | Client supports stdio, Streamable HTTP and SSE under `mcp.servers`, including headers and tool filtering. `openclaw mcp serve` exposes conversations over stdio in the reverse direction; it is not the room's MCP endpoint |

The OpenClaw limits make capability negotiation necessary. Preserve results in Uplink Room before remote retention expires. Do not promise remote Stop or approval buttons that the gateway cannot honor.

## One execution, one reporter

An A2A **Task** is external execution, not the glossary's person-owned **Task**. Bind one external task to one room **Run**. `contextId` groups conversations and may contain concurrent tasks; it must not be used alone as the run identity. A terminal A2A task cannot restart; follow-up work gets a new external task and room run, optionally under the same room task. A direct `Message` response can finish a run without a remote task ID. These distinctions follow the official [Life of a Task](https://a2a-protocol.org/latest/topics/life-of-a-task/) guide (read 2026-11-02).

Proposed mapping from the [1.0 state model](https://a2a-protocol.org/latest/specification/#413-taskstate) (read 2026-11-02):

| A2A state | Room state | Room behavior |
| --- | --- | --- |
| `TASK_STATE_SUBMITTED`, `TASK_STATE_WORKING` | Working | Preserve external state separately |
| `TASK_STATE_INPUT_REQUIRED`, `TASK_STATE_AUTH_REQUIRED` | Waiting | Route to the driver; carry the prompt or an authenticated gateway link. Authentication stays in the gateway |
| `TASK_STATE_COMPLETED` | Done | Save result/artifact references |
| `TASK_STATE_FAILED`, `TASK_STATE_REJECTED` | Failed | Preserve reason and rejection distinction |
| `TASK_STATE_CANCELED` | Stopped | Confirmed remote cancellation |
| Unspecified state, lost connection, expired remote record | Unknown | Preserve last observed state and freshness; no invented completion |

For OpenClaw, Working is only what its protocol reports. A local approval may be hidden inside it. Initially show that limitation and a gateway link; obtaining a true Waiting prompt requires a separate gateway event adapter. Do not infer it from text. An approval in OpenClaw is also not a room approval that ADR 0005 automatically lets an agent answer.

The adapter should persist `(team, agent, endpoint, contextId, externalTaskId)`, outgoing `messageId`, reporter identity, observation version/time and result references. Serialize observations per binding; reject reports from other agents, stale observations and terminal-state regressions. A retry reuses its stored message identity, but ambiguous delivery must reconcile with the peer before submitting new work. Do not assume every peer deduplicates as OpenClaw documents.

`runs.stop` should request cancellation and wait for acknowledgement. For a peer without cancellation, offer **detach tracking** with an explicit “agent may still be running” result, or link to its operator controls. Do not show Stopped on a failed or unsupported cancel. A Room-API-only agent uses its own authenticated reporter instead; it still has just one reporter per run.

## What changes from today's code

Inspected on 2026-11-02:

- [Room API factory](../packages/backend/convex/lib/room.ts) runs the same handler for Clerk people and scoped agent keys. [HTTP](../packages/backend/convex/http.ts) exposes `/api/v1/functions` and `/api/v1/call`; [MCP](../packages/room-client/src/mcp.ts) is a stdio wrapper over those endpoints. Keep these as the common room-action contract for every option.
- [Run schema](../packages/backend/convex/schema.ts) requires `machineId`; [runs.start](../packages/backend/convex/runs.ts) accepts terminal/thread and a known harness. There is no external agent-conversation path. Every option needs a distinct run source for agent conversations, rather than pretending a remote agent is a machine or harness. Existing bridge runs retain their current machine requirement.
- Under the recommendation, extend start/get/stop and add conversation message/reply operations through the same Room API factory. Add an authenticated internal adapter-report operation and peer bindings. A worker outside a Convex mutation handles A2A networking, polling and optional streams, then commits bounded observations through the backend. Endpoint credentials stay in service-side secret storage, separate from agent keys; allow only registered peer destinations and recheck authorization before dispatch/report.
- A public inbound A2A server, if later needed, adds Agent Card discovery and peer-to-agent-key mapping in a thin transport layer. It advertises only forwarding and room capabilities actually implemented. Room rights, accountable person and scopes still come from the existing actor checks. This is additional work, not part of the recommended first slice.

## Cost and the experiment that decides readiness

There is no protocol subscription to budget: A2A's [license](https://github.com/a2aproject/A2A/blob/main/LICENSE) is Apache-2.0; [Hermes](https://github.com/NousResearch/hermes-agent/blob/main/LICENSE) and [OpenClaw](https://github.com/openclaw/openclaw/blob/main/LICENSE) are MIT (read through each official repository on 2026-11-02). This does not include inference, gateway hosting or our worker/Convex use. Those costs depend on the selected model, accounts and traffic; this brief does not quote an unverified monthly total. Relative implementation cost is lowest for Room API only, highest for a full inbound/outbound A2A surface.

Before treating either gateway as supported, exercise a real authenticated send/get, input-required exchange, restart/reconnect, duplicate send and stop. Include OpenClaw's hidden approval and unsupported cancellation, and confirm that revocation blocks the next room action. Success means the Inbox reflects observed state without a second MCP writer changing it. No live agent, credential or service was created for this research.
