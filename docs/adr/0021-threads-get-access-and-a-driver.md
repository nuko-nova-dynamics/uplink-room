---
status: accepted
---

# T3 Code threads get the terminal's access levels and driver, through the bridge

A thread run gets an access level (Watch, Suggest, Drive, Open) and a driver, with the same rules as a terminal (ADR 0002): whoever starts the thread picks the level, up to the most open level its machine allows, and whoever the machine belongs to can lower it; the driver passes the wheel, teammates ask for it on Drive and take it on Open, and below Drive it only goes back to whoever started the thread. A thread found in T3 Code is started and driven by whoever linked the machine, and starts at Watch. Julio approved this on 2026-11-04 with the full T3 Code integration (`research/t3code-capabilities.md`, Plan).

The bridge stays the only T3 Code client on its machine, with its one pairing (`orchestration:read` and `orchestration:operate`); every teammate acts through it, so the room's access decides who may do what, and the bridge checks the driver again, as it does for terminal input. We chose this over giving each teammate a T3 Code pairing of their own, or making the room an outside MCP client of T3 Code: T3 Code grants a whole server, not one thread, knows nothing of the room's people, and MCP can't answer approvals or push events. T3 Code's own levels play no part: its runtime modes (Supervised to Full access) decide what the agent may do without asking, and the room launches at Supervised and never changes that; its linked-environment access is between T3 Code servers. Amended by ADR 0045: the room reaches only threads launched for its runs and threads someone on their machine picked to share; every other thread stays private, and the bridge sends nothing of it.

## Consequences

- Approvals keep ADR 0005's rule: the driver, the task's owner or an admin answers, and the room sends the answer as the driver's. Passing the wheel changes who that is.
- Agents drive threads with the `terminals.drive` scope, which now covers threads, so an agent trusted to drive terminals can drive threads, and no existing key changes.
- A bridge from before this ignores the new room messages and would keep a thread's first driver, refusing everyone else's answers. So the bridge names the room messages it handles (`bridge_features`, right after `register_machine`), and the room passes a thread's wheel only through a bridge that named `thread_driver`. The other way, a room refuses a bridge message it doesn't know, which stops sharing; so `bridge.send` names the bridge messages the room takes (`features`), and the bridge sends newer ones only once the room has named them.
- The T3 Code pairing is a state of the machine (`t3_status`): connected, unreachable, or needs pairing again, with when it ends. T3 Code gives a bearer session 30 days and no refresh, so the room warns in its last week and says "T3 Code needs pairing again" once T3 Code refuses it; the bridge then waits for a new pairing instead of retrying the old one every few seconds, and its threads read Unknown meanwhile.
- Revoking the bridge is done in T3 Code's Settings → Sharing & access, which closes its socket at once. `t3 auth session revoke` only stops new connections, because the CLI writes the revocation from its own process.
- A secret or link request card in a thread reads Waiting with "answer it in T3 Code" and no buttons. A secret never goes through the room.
