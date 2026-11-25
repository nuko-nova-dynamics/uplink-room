# Cloud machine on Vercel Sandbox, 2026-11-02

A real check of the cloud machine provider and boot step (#10, ADR 0013), run with `packages/backend/scripts/cloud-machine-live.ts` against Vercel Sandbox (team Miami Web AI, Pro, project `uplink-room`) in `iad1` and the dev deployment `focused-fish-459`. The room side ran on the Room API code already deployed there (the script never pushes code), as a throwaway person in a throwaway team. The bridge was this branch's, packed with `pnpm pack` and copied into the box.

| Step | Result |
|---|---|
| Create a named, persistent sandbox with the real adapter | Passed in 0.4 s. Image: Ubuntu 26.04.1 LTS, Node 24.22.1, `python3` and `npm`, **no `make` or `g++`**. |
| First boot: the boot step installs the bridge, pairs as a team machine, registers | Passed: online in the room 20 s after the boot step started, tools `claude`, `tmux`. The first try failed (node-pty couldn't compile without `make`); the boot step now installs `make`, `g++` and `python3` when missing. |
| A terminal through the Room API (`runs.start`, `terminals.input`, `terminals.output`) | Passed: the command wrote `uplink-live-42` to `/vercel/sandbox/persist.txt` and the output came back. |
| Stop the box | Passed: stopped in 3.3 s; the provider reported `stopped`, and the room showed the machine offline once its 90-second window passed. |
| Start it again from its kept disk, with no pairing code | Passed: the bridge was back online 7.4 s after the boot step, as the same machine (one machine in the team, same id). |
| The disk persisted | Passed: a new terminal printed `uplink-live-42` from the file written before the stop, and `~/.uplink-room` still held `bridge.json` (the pairing). |
| Cleanup | The machine was unlinked, the sandbox deleted (`missing` at the provider), and its snapshot deleted with it. The throwaway teams stay in the dev deployment's data. |

Each kept snapshot was about 1 GB (the toolchain is most of it), which is about $0.08 a month per machine at Vercel's snapshot storage rate.

Not covered live: wake-before-start, the idle stop and the other lifecycle rules in the backend, because they would need this branch deployed to the shared dev deployment. The Room API tests in `packages/backend/tests/cloudMachines.test.ts` cover them with a fake provider.

## Rerun with the reconciler, at f3e9fd5

The same script, with three more steps:

- Its box carried its own `room` tag (`live-check-<time>`), and `list` by that tag returned exactly that box, with its boot's generation tag (`gen=2`).
- One reconcile pass with the real `planReconcile` and adapter: the box was left running while the room's row said the machine was stopped. The plan was one stop, and the box was stopped 2.4 s later.
- Before the delete, the adapter listed the box's one snapshot. After the delete, listing by the box's name returned nothing, as found on the first rerun, where a snapshot stayed `created` for about two minutes until Vercel's own cleanup deleted it. Deleting the recorded id worked.

A terminal started after the restart found `uplink-bridge` on its PATH (`~/.uplink-room/npm/bin`), so Claude Code's hooks can reach the bridge. First boot to online took 16.6 s; a later start took 2.7 s. No sandboxes or snapshots were left in the project.
