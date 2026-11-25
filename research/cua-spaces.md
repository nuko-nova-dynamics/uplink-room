# Cua Spaces: can a Space be shown inside Uplink Room?

Research for issue #6 (open experiment 4 in `notes.md`). Read on 2026-11-02 from Cua's docs (cua.ai/docs) and its repo (github.com/trycua/cua, `main` pushed 2026-11-02), and checked against the `cua` CLI 0.10.0 installed from the official install script.

## Answer to experiment 4

**Yes, a Space can be shown inside our app.** Every Space runs `cua-spacesd`, which serves an HTML5 viewer at `/viewer/` on its port (3211). The viewer takes a scoped, expiring viewer ticket in its URL fragment, and Cua documents serving it behind a gateway under a path (`/<prefix>/viewer/`). Our app can load that page in a frame. Nothing about the viewer requires Cua's own app.

**What it needs.** Whoever mints the ticket must hold the Space's `cua-spacesd` token, and the person watching must be able to reach the Space's port. The bridge already runs on the Space's machine, so it can hold the token and mint a ticket per person. Reaching the port from a teammate's computer works on the same network or over Tailscale. Through Cua's relay it needs a cua.ai account for every viewer, so the spec does not use the relay.

**Daytona: possible, not proven.** Cua's MIT `cua-contrib` crate has a Daytona provider (`--on daytona`), but only in a `cua` built with `--features contrib`. It runs Linux containers on amd64 only (no Windows or macOS), and exposes `cua-spacesd` at Daytona's public HTTPS preview URL, guarded by the Space's own token. Cua's own support matrix lists Daytona as "not measured": nobody has checked that its desktop, input and streaming work. Treat a Daytona Space as a follow-up with its own live check.

## How Spaces work

Sources: [How Spaces works](https://cua.ai/docs/spaces/concepts/how-spaces-works), [Attach to or run cua-spacesd](https://cua.ai/docs/cua-sdk/guides/spacesd), [`libs/cua-spacesd/README.md`](https://github.com/trycua/cua/blob/main/libs/cua-spacesd/README.md).

- A **computer** is a Mac, Windows or Linux PC you own. A **Space** on it is an isolated sandbox (container, VM, microVM, or the computer's own desktop). Cua rents no computers; Cua Cloud ended on 18 Oct 2026.
- Every Space runs `cua-spacesd`. One port (3211) serves gRPC and gRPC-Web (`System`, `Computer`, `Stream`, `Presence` and other services), `GET /health`, `/files`, `/mcp` (Streamable HTTP MCP over the cua-driver tools), and `/media` (H.264 video over WebSocket). QUIC media is on 3212.
- Input is never injected by `cua-spacesd` itself. It goes through Cua Driver, linked in.
- **Reaching a Space.** Directly (same network or Tailscale) with its address and token: "No account is needed, and the traffic doesn't use the relay." Or through the cua.ai relay after `cua host setup`, which counts toward a plan's live sessions and remote hours.
- **Space ids.** `local:<name>` (made on this computer), `direct:<host:port>` (added by address), `relay:<machine-id>` (a computer on the relay). The app, CLI, SDKs and `cua daemon` share one registry: `$CUA_HOME/spaces.json` (no secrets) and `spaces-credentials.json` (0600, `{ "<id>": { "url", "token" } }`) ([`registry.rs`](https://github.com/trycua/cua/blob/main/libs/cua/crates/cua-spaces/src/registry.rs)).
- **The daemon.** `cua.daemon.v1.SpaceService/ConnectSpace` returns a loopback passthrough URL and a bearer for any registered Space, "so a client runs every `cua.env.v1` call and media WebSocket through the daemon without seeing the Space's token" ([`spaces.proto`](https://github.com/trycua/cua/blob/main/libs/cua/proto/cua/daemon/v1/spaces.proto)).

## Tokens, tickets and roles

Sources: [`system.proto`](https://github.com/trycua/cua/blob/main/libs/cua/proto/cua/env/v1/system.proto), [`stream.proto`](https://github.com/trycua/cua/blob/main/libs/cua/proto/cua/env/v1/stream.proto), [`MEDIA.md`](https://github.com/trycua/cua/blob/main/libs/cua/proto/MEDIA.md), [`PRESENCE.md`](https://github.com/trycua/cua/blob/main/libs/cua/proto/PRESENCE.md).

- The **env token** grants full control of the machine. A token is required for any non-loopback bind.
- `SystemService.CreateViewerTicket` mints a **viewer ticket**: lifetime 1 hour by default, 24 hours at most; the highest `SessionPolicy` the viewer may open media with; clipboard on or off; a guest folder for file access, or none; and the viewer's `Principal`, shown to others. "It authorizes only the calls a viewer makes ... Viewer tickets cannot mint viewer tickets." The response includes `viewer_path`, `/viewer/#ticket=<ticket>`.
- `SessionPolicy` is `VIEW_ONLY` ("Video only; interactive input is refused"), `BACKGROUND_ONLY`, or `ALLOW_ACTIVATION` (full input).
- **There is no call that revokes one viewer ticket.** Rotating the env token (`SystemService.Init`) revokes every ticket and closes every media socket. A media socket stays open after its ticket expires.
- **Presence.** Each viewer joins with a named cursor; your own cursor is drawn locally, others' are interpolated. Agent cursors leave when their driver session ends or after 15 s idle.
- **Cua's roles.** Sharing a Space through the relay gives each teammate **Viewer** ("Can view": presence and the stream, input refused) or **Editor** ("Can edit": pointer, keyboard, shell, files, clipboard, MCP). `cua-spacesd` enforces the role. Sharing is for Cua Teams only and needs a cua.ai account per person ([Share a Space](https://cua.ai/docs/spaces/guides/share-a-space)).

## The viewer

Sources: [`cua-spacesd-html5/web/src/api.ts`](https://github.com/trycua/cua/blob/main/libs/cua/crates/cua-spacesd-html5/web/src/api.ts) and [`viewer.ts`](https://github.com/trycua/cua/blob/main/libs/cua/crates/cua-spacesd-html5/web/src/viewer.ts).

- The page is served "one level below a spacesd-shaped origin": `http://host:3211/viewer/`, `/<prefix>/viewer/` behind a gateway, or `/s/<id>/viewer/` from `cua viewer`. Its gRPC-Web calls, `/media` and `/files` resolve against the parent directory.
- The ticket comes from `#ticket=`, which never reaches a server log, is moved to `sessionStorage` and scrubbed from the address bar.
- It decodes H.264 with WebCodecs, which browsers allow only in a secure context (https or localhost). Elsewhere it falls back to PNG frames.
- Cua already ships a standalone gateway mode: "`cua-spacesd-html5` binary for gateways: a list of sandboxes and the same page per sandbox at `/s/<id>/viewer/`, piping gRPC-Web, `/media` and `/files` to each sandbox and adding only transport credentials."

## Driving a Space from code

Sources: [CLI reference: Spaces, computers and teams](https://cua.ai/docs/cua-cli/reference/cli/spaces-and-computers), [`computer.proto`](https://github.com/trycua/cua/blob/main/libs/cua/proto/cua/env/v1/computer.proto).

- `cua spacesd call <URL> <Service/Method> [proto3-JSON body]`, token in `CUA_ENV_TOKEN`, calls any `cua.env.v1` RPC. Checked against the installed CLI's `--help`.
- `ComputerService` has `Screenshot`, `Pointer`, `Keyboard`, `GetClipboard`, `SetClipboard`, `GetCursorPosition` and `ListDisplays`.
- `cua spaces ls --json` prints `{"spaces": [...], "machines": [...], "durable": [...], "thisMac": {...}, ...}` (checked with the installed CLI on an empty home). Each Space is a `cua.daemon.v1.Space` (`id`, `name`, `os`, `kind`, `powerState`, `features` and more).
- Agents can also drive a Space with Cua's own MCP server (`cua mcp`) or a Space's `/mcp`. Those paths hold the token and bypass anything Uplink Room enforces.

## Licence

Source: [`legal/LICENSING.md`](https://github.com/trycua/cua/blob/main/legal/LICENSING.md).

- The repo default is MIT: the `cua` CLI, `cua daemon`, the SDKs, Cua Driver, Lume, and the `cua.env.v1` and `cua.daemon.v1` protobuf contracts.
- FSL-1.1-MIT covers Cua Spaces: the apps, `cua-spacesd`, `cua-relay`, the streaming client and codecs, the HTML5 viewer (`cua-spacesd-html5`), and the media protocol and transport crates. Use, change and self-hosting are allowed for anything except a Competing Use ("making them, or something substantially similar, available to others as a commercial product or service"). Each release becomes MIT two years after it ships.
- Uplink Room's plan uses the FSL parts only as the Space's machine runs them: it loads the viewer page each `cua-spacesd` serves and calls `cua-spacesd` through the MIT CLI. It copies no FSL code. If Uplink Room is ever sold with shared desktops built in, revisit this with Cua's commercial terms (`legal/COMMERCIAL.md`).

## Plans and pricing

Source: [Plans and Teams](https://cua.ai/docs/spaces/guides/teams).

| Plan | Price | Live sessions | Remote hours |
| --- | --- | --- | --- |
| Free | $0 | 2 | 20 a month |
| Pro | $18 a month or $180 a year | 5 | 200 a month |
| Teams | $30 a seat a month or $300 a seat a year | 5 a seat | 200 a seat a month, pooled |

Only relay use counts: "Spaces you reach directly, for example on your own network, don't use the relay and don't count." Sharing through Cua needs Teams. The spec below reaches Spaces directly, so it needs no Cua account or plan.

## Running Cua here

- `curl -fsSL https://cua.ai/install.sh | sh -s -- --cli-only --yes --prefix DIR --no-modify-path --no-onboarding` installs the CLI without sudo or brew. It put `cua` 0.10.0, `cua-vz`, `cua-microvm-init` and a static Linux `cua-spacesd` in `DIR/bin`.
- `cua runtime doctor` on this Mac (Apple silicon, macOS 27.2, Docker installed but not running): no container engine, so local Linux Spaces use the built-in Linux runtime, a VM with Docker and gVisor (about 455 MB, downloaded on first use).
- The runtime needs a `CUA_HOME` path short enough for a Unix socket (under 103 bytes); a long scratch path fails with "set CUA_HOME to a shorter directory".
- The live check's result is in issue #6 and the PR that closes it.
