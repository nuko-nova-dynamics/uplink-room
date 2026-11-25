# Profile logins on one Mac

Research for [#18](https://github.com/nuko-nova-dynamics/uplink-room/issues/18), experiment 6. Tested on Julio's Mac on 2026-11-02, under one macOS user. Bridge baseline: `994c21a40957e97335f7145bd4675e8ecd00b8fc`.

**Config folders can separate several harness logins, but the bridge's current variables do not provide the complete profile promised by #3.** Claude Code is the strongest candidate. Codex needs separate MCP credential storage and a solution for shared skills. OpenCode needs a fourth XDG directory and its external-skill import disabled. Grok still imports machine customizations. Cursor CLI's macOS login store is shared. Antigravity was not installed.

No two-account subscription, token-refresh, or authenticated MCP separation test was performed. Those remain **unverified**. The tests below establish whether an empty folder inherits the existing login, not whether two paid accounts remain independent through refresh and expiry. No account was logged into. No real token or credential file was printed, copied, moved, or opened by a research script. Harness status commands read their own stores normally; their output was filtered in memory to status fields, paths, and counts. There were no model requests using the machine setup.

## Results

“Works with caveats” means the login-folder probe passes, with additional controls or acceptance tests needed for a complete profile. “Doesn't” means the installed harness cannot currently satisfy the full profile with the tested controls, or is unavailable here. It does not assert impossibility on every OS or future version.

| Harness, installed version | Result | Empty folder versus machine setup | Bridge recommendation |
| --- | --- | --- | --- |
| Claude Code, `claude` `2.1.316` | **Works with caveats** | `CLAUDE_CONFIG_DIR`: logged out; default: logged in with claude.ai, before and after scoped logout. User MCP config writes inside the new folder. | Keep `CLAUDE_CONFIG_DIR`. Add scoped credential cleanup before deleting the folder. Qualify with the two-account and MCP tests below before promising complete separation. |
| Codex, `codex-cli 0.166.0` | **Works with caveats** | `CODEX_HOME`: logged out with `file`, `keyring`, and `auto`; default: logged in using ChatGPT before and after scoped logout. | Keep `CODEX_HOME`; force profile-local CLI and MCP file stores. Resolve `~/.agents/skills` import before offering full profiles. Until then offer only the machine setup. |
| Grok Build, `grok 1.0.70 (f50904eaee6c) [stable]` | **Doesn't**, for a complete profile with tested controls | `GROK_HOME`: unauthenticated; default: logged in with grok.com. Empty profile still discovers machine skills, enabled plugins, and MCP definitions. Compatibility switches do not remove all of them. | Add `GROK_HOME` to any future mapping, but **offer only the machine setup** until all imports can be excluded and tested. |
| OpenCode, `1.19.5` | **Works with caveats** | Four XDG folders: 0 credentials; default: 1 credential before and after. External machine skills remain until `OPENCODE_DISABLE_EXTERNAL_SKILLS=true`; that probe then returns only the built-in skill. | Keep config/data/cache XDG mappings; add `XDG_STATE_HOME`; disable external skills and Claude user-prompt imports. Qualify authenticated provider/MCP and deletion behavior before enabling profiles. |
| Cursor CLI, `cursor-agent 2026.10.22-27dcf5f` | **Doesn't**, with config/data-folder overrides on macOS | Default and empty folders both report unauthenticated, so there is no existing login to compare. Installed code uses fixed Keychain services, independent of the config folder. | **Offer only the machine setup.** `CURSOR_CONFIG_DIR` and `CURSOR_DATA_DIR` move some state, not the macOS login. |
| Antigravity | **Doesn't run here** (not installed); separation **unverified** | Neither `antigravity` nor `agy` on PATH; no Antigravity app in `/Applications` or `~/Applications`. | Do not advertise profile support. If installed later, repeat the source and empty-folder tests before deciding whether to offer anything beyond the machine setup. |

## What a profile protects

The glossary defines a [machine setup and profile](https://github.com/nuko-nova-dynamics/uplink-room/blob/994c21a40957e97335f7145bd4675e8ecd00b8fc/GLOSSARY.md#L145-L150) as different sets of logins, settings, and skills. That is state selection, not an OS access boundary.

[#3 story 53](https://github.com/nuko-nova-dynamics/uplink-room/issues/3) is right to disclose that the person the machine belongs to can read a profile's files and potentially use its logins. The bridge creates `0700` folders, but terminals run as that same OS user. That user can read plaintext credential stores and can run the harness that accesses its Keychain entries. Keychain access can require an unlocked keychain or OS approval; a profile does not make its credential inaccessible to the machine's user.

The reverse matters too: an unrestricted terminal running as the same OS user can reach the machine setup or another profile by changing variables or reading its files. Config overrides cannot guarantee hostile-tenant separation. A separate OS identity or VM with restricted host access is needed for that stronger requirement. Profiles also do not relocate shared repo settings, `.env` files, cloud SDK credentials, SSH agents, third-party plugin stores, or managed policy. Do not describe them as keeping *all* machine credentials out of reach.

## 1. Claude Code

### Storage and selection

The official [environment-variable reference](https://code.claude.com/docs/en/env-vars#environment-variables-reference) verifies `CLAUDE_CONFIG_DIR`, including side-by-side account use, and relocation of settings, sessions, and plugins. The [authentication reference, Credential management](https://code.claude.com/docs/en/authentication#credential-management) explicitly says macOS Keychain entries are keyed to that directory. A different config directory reads a different entry. File fallback is `<config>/.credentials.json` with mode `0600`; on macOS it is used if the Keychain rejects a write. This is stronger evidence than assuming a folder variable also moves Keychain identity.

User settings and skills live in `<config>/settings.json` and `<config>/skills/`; plugins and their registry/cache live beneath `<config>/plugins/`. See [settings scopes](https://code.claude.com/docs/en/settings), [skill locations](https://code.claude.com/docs/en/skills#choose-where-skills-load), and [plugin installation](https://code.claude.com/docs/en/discover-plugins). Repo `.claude/settings.json`, local settings, `.claude/skills`, `.mcp.json`, and managed settings are separate scopes and still apply.

User and local MCP definitions normally live in `~/.claude.json`; the fresh-profile write below proves that, with this override, they instead go to `<config>/.claude.json`. [MCP installation scopes](https://code.claude.com/docs/en/mcp#mcp-installation-scopes) distinguishes those definitions from the shared project `.mcp.json`. `--strict-mcp-config` can limit definitions to explicitly supplied servers; it does not itself prove credential isolation. OAuth MCP credential separation and cleanup were not exercised with authenticated servers.

`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, API-key helpers, provider selection, and cloud credentials can supply auth independently. A bridge must exclude inherited machine auth, not just set `CLAUDE_CONFIG_DIR`. See the authentication reference's precedence section. No such API-key/token variable was present in these tests; variable values were never emitted.

### Observed output

`P` below denotes the new private temporary test root. `CLAUDE_CONFIG_DIR` was unset for default probes; `HOME` stayed unchanged throughout all tests.

```text
$ claude --version
2.1.316 (Claude Code)
$ claude auth status                         # JSON reduced to three fields
exit 0: {loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty"}
$ CLAUDE_CONFIG_DIR="$P/claude" claude auth status
exit 1: {loggedIn: false, authMethod: "none", apiProvider: "firstParty"}
$ CLAUDE_CONFIG_DIR="$P/claude" claude mcp add --scope user --transport http uplink-profile-probe http://127.0.0.1:9
exit 0: Added HTTP MCP server uplink-profile-probe ... to user config
File modified: $P/claude/.claude.json
$ CLAUDE_CONFIG_DIR="$P/claude" claude auth logout
exit 0
$ claude auth status
exit 0: {loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty"}
```

The MCP probe only added a loopback definition to the empty profile; it did not connect to a server. Installed `claude auth --help` lists `login`, `logout`, and `status`; `auth status --help` verifies `--json` and `--text`.

### Complete deletion

Stop the profile's terminals **and any detached/background harness processes**. With the same absolute config path, log out of authenticated MCP servers while their definitions are still available, then run scoped `claude auth logout`. Remove the profile folder, including `.claude.json`, backups, plugins, caches, and fallback credentials. Confirm that the same empty path is logged out and the default path remains logged in. Merely removing the directory cannot remove its Keychain entry. Whether `auth logout` removes every MCP-specific secret is **unverified**; do not promise expiry erases those until the MCP cleanup acceptance test passes. Locally deleting credentials also does not prove upstream token revocation or deletion of backups.

## 2. Codex

### Storage, Keychain identity, and shared skills

The official [advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced) identifies `CODEX_HOME`, default `~/.codex`, as the state root. It includes `config.toml`, local sessions/history, logs, and file auth. [Authentication](https://developers.openai.com/codex/auth) documents `cli_auth_credentials_store`. File auth is `<CODEX_HOME>/auth.json`; Keychain auth is an alternative. `--profile` selects a named configuration section; it is not a separate login/state directory.

Source inspected at the installed release tag `rust-v0.166.0`, commit `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`:

- [CLI auth storage, lines 285–298](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/login/src/auth/storage.rs#L285-L298): service `Codex Auth`, account `cli|` plus a truncated SHA-256 of the canonical home path. Different real directories have different CLI login identities. Symlinks to the same directory are not separate profiles.
- [Auth removal, lines 380–390](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/login/src/auth/storage.rs#L380-L390): Keychain deletion also removes file fallback. Newer secrets-backed storage also has a cleanup path in this file; choose and pin the storage policy instead of relying on defaults.
- [MCP OAuth key derivation, lines 1056–1083](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/rmcp-client/src/oauth.rs#L1056-L1083): ordinary server keys include server name and endpoint identity, **not** `CODEX_HOME`. The special enterprise identity case adds the home; ordinary direct-Keychain entries can collide across profiles. Service name is `Codex MCP Credentials` at line 100. File fallback is `<CODEX_HOME>/.credentials.json` at lines 1101–1102.
- [Configuration fields, lines 289–313](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/config/src/config_toml.rs#L289-L313): CLI auth defaults to `file`; MCP OAuth defaults to `auto`. Set **both** `cli_auth_credentials_store = "file"` and `mcp_oauth_credentials_store = "file"` for new profiles before any login. The MCP store's file backend is distinct from Keychain ([resolved store](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/rmcp-client/src/oauth/resolved_store.rs#L216-L251)). This recommendation is source-backed; two authenticated MCP accounts were not tested.
- [Skill roots, lines 134–158](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/ext/skills/src/host_roots.rs#L134-L158): the legacy `<CODEX_HOME>/skills` directory moves, but `~/.agents/skills` is also read from the OS home. The former is explicitly deprecated. A folder override alone therefore does not give the teammate their own complete skill set. System and repo skills remain too.

User MCP definitions and plugin enablement live in `<CODEX_HOME>/config.toml`. Native plugin cache and data live under that home: [PluginStore, lines 25–27 and 87–95](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/core-plugins/src/store.rs#L25-L95) uses `plugins/data` for persistent plugin data; the [cache constant at line 11](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/core-plugin-common/src/installed.rs#L11) is `plugins/cache`. Changing the user config root does not remove repo/managed declarations, explicit plugin paths, or a plugin's own external credentials. The bridge must not inherit machine API tokens or attach to an already-running machine-setup app server.

### Observed output

```text
$ codex --version
codex-cli 0.166.0
$ codex login status
exit 0: Logged in using ChatGPT
$ CODEX_HOME="$P/codex" codex login status       # directory created first
exit 1: Not logged in
$ CODEX_HOME="$P/codex" codex -c 'cli_auth_credentials_store="file"' login status
exit 1: Not logged in
$ CODEX_HOME="$P/codex" codex -c 'cli_auth_credentials_store="keyring"' login status
exit 1: Not logged in
$ CODEX_HOME="$P/codex" codex -c 'cli_auth_credentials_store="auto"' login status
exit 1: Not logged in
$ CODEX_HOME="$P/codex" codex -c 'cli_auth_credentials_store="auto"' logout
exit 0
$ codex login status
exit 0: Logged in using ChatGPT
```

Installed `codex login --help` verifies the `status` subcommand and `-c` override. No login command without `status` was run.

### Complete deletion

Use file-only stores from profile creation, then stop all profile processes and servers before removing the whole profile tree, including `auth.json`, `.credentials.json`, config, plugin state, databases, sessions, and logs. If Keychain mode was ever used, log out using the original path and mode **before** removing the directory. For ordinary shared MCP Keychain entries, a profile-scoped logout can affect the machine setup's same server: do not call it automatically as a profile cleanup strategy. Migrate the design to isolated file storage before users authenticate, or reject that profile. Leave shared `~/.agents` skills in place when a profile expires.

## 3. Grok Build

### Storage and imports

[Official settings](https://docs.x.ai/build/settings) verifies `GROK_HOME` and `<GROK_HOME>/config.toml`. The official repo's [authentication guide](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md) describes file-based `auth.json` and `mcp_credentials.json`, owner-only permissions, and `XAI_API_KEY` fallback. [Skills/plugins](https://docs.x.ai/build/features/skills-plugins-marketplaces) and [MCP](https://docs.x.ai/build/features/mcp-servers) document those configuration surfaces.

Native user skills are under `<GROK_HOME>/skills`; native plugins and marketplace state are beneath `<GROK_HOME>/plugins` and related install directories. Native user MCP declarations are `[mcp_servers]` in `<GROK_HOME>/config.toml`. Repo `.grok/config.toml` and imported Claude/Cursor declarations remain additional sources.

Source inspected at public commit `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`. **This is not the installed build's `f50904eaee6c` commit**: GitHub did not resolve that build hash. Use it as current source evidence, with the installed CLI probes establishing behavior on this Mac.

- [Home resolution, lines 49–96](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-dirs/src/lib.rs#L49-L96) uses `GROK_HOME`; [auth path, lines 46–55](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-login/src/storage.rs#L46-L55) also allows `GROK_AUTH_PATH`. Do not inherit an override pointing to machine credentials.
- [MCP credentials, lines 57–94](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-mcp/src/credentials.rs#L57-L94) use a file beneath `GROK_HOME`, not a shared Keychain item. This avoids the Codex ordinary-MCP Keychain collision for this store.
- [Plugin discovery, lines 209–218](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-agent/src/plugins/discovery.rs#L209-L218) combines `<GROK_HOME>/plugins` with `~/.claude/plugins`. [Compatibility switches, lines 103–211](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-config/src/compat.rs#L103-L211) cover vendor skills, rules, agents, MCPs, hooks, and sessions; they are not a complete profile switch.

### Observed output

```text
$ grok --version
grok 1.0.70 (f50904eaee6c) [stable]
$ grok models                              # only auth banner retained
exit 0: You are logged in with grok.com.
$ GROK_HOME="$P/grok" grok models
exit 0: You are not authenticated.
$ GROK_HOME="$P/grok" grok -p 'Reply OK.'
exit 1: Not signed in. To authenticate without a browser, run:
  grok login --device-code
```

The empty-profile headless attempt exited before a model request. No default-profile prompt was submitted. `grok login --help` has no `status` subcommand; `grok models` supplies the login banner without submitting a task.

`grok inspect --json`, from an unrelated empty working directory with `GROK_HOME` plus the bridge's config overrides, reported:

```text
skills:       220, all referencing /Users/<user>/... machine paths
plugins:       22, all machine paths, all enabled
MCP servers:   15, all machine paths
```

The initial skill-path filter looked only for a top-level `path`; the actual field is nested under `source`. The counts above use the corrected traversal.

A second probe set `GROK_{CLAUDE,CURSOR,CODEX}_{SKILLS,RULES,AGENTS,MCPS,HOOKS,SESSIONS}_ENABLED=false` individually. `externalCompat.cells` confirmed all 13 implemented cells were false, source `env`. Inspect still listed 220 skills: 84 marked disabled, 136 without a disabled flag; 22 machine plugins remained enabled. Of 15 MCP entries, 12 were marked disabled and 3 were unmarked plugin entries. Discovery is not proof of a server connection, but these remaining enabled/imported surfaces are enough to reject complete profile separation with the tested controls.

### Complete deletion

With imports excluded, stop the profile's processes/leaders, run `grok logout` scoped to `GROK_HOME` and any profile-local `GROK_AUTH_PATH`, then remove that root including config, native skills/plugins, auth and MCP credential files, sessions, caches, and plugin data. The source also supports credentials supplied by environment or external providers; folder deletion does not revoke those. Do not delete imported `~/.claude` or `~/.agents` data. Because the import controls tested here are incomplete, complete profile expiry is **unverified**. Keep this harness on the machine setup for now.

## 4. OpenCode

### Storage and selection

Installed `opencode debug paths` and release source agree: `~/.opencode/bin/opencode` is the executable location here, not the complete state home. Four XDG roots select config, data, cache, and state.

Source at release `v1.19.5`, commit `810c0eba1a7348036f8bdf61e6632d0c36c6876c`:

- [Global paths, lines 3–28](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/core/src/global.ts#L3-L28): `XDG_CONFIG_HOME/opencode`, `XDG_DATA_HOME/opencode`, `XDG_CACHE_HOME/opencode`, and `XDG_STATE_HOME/opencode`. The temp path remains OS-temp `/opencode`; four XDG overrides do not relocate it.
- [Installed CLI auth store, lines 10 and 58–79](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/opencode/src/auth/index.ts#L10-L79): data-root `auth.json`; `OPENCODE_AUTH_CONTENT` can override it. [MCP auth, lines 37–80](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/opencode/src/mcp/auth.ts#L37-L80): data-root `mcp-auth.json`. These paths do not use the macOS Keychain.
- The release also contains a [V2 credential table](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/core/src/credential.ts#L49-L75) and a [data-root database path](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/core/src/database/database.ts#L43-L54). Current [V2 provider docs](https://dev.opencode.ai/v2/docs/cli/providers) describe migration into SQLite. Do not assume every release/entry point stores credentials only in `auth.json`; delete the whole data root and exclude inherited `OPENCODE_DB` overrides.
- [Skill discovery, lines 188–215](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/opencode/src/skill/index.ts#L188-L215) reads `.claude` and `.agents` in the OS home as well as profile config. [Runtime flags, lines 21–30](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/opencode/src/effect/runtime-flags.ts#L21-L30) verifies `OPENCODE_DISABLE_EXTERNAL_SKILLS` and `OPENCODE_DISABLE_CLAUDE_CODE`. The first disables both external skill directories; the second also excludes Claude prompt imports.

[Official config docs](https://opencode.ai/docs/config/) describe merged user/project/managed settings and MCP declarations. Profile-global skills/plugins are under config-root `opencode/skills` and `opencode/plugins`; downloaded plugins also use caches. [Skills](https://opencode.ai/docs/skills/) explicitly document the external home-directory imports. `OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR` are not substitutes for moving auth/data/state: custom config is merged with other sources.

### Observed output

```text
$ opencode --version
1.19.5
$ opencode debug paths                     # selected default lines
data       /Users/<user>/.local/share/opencode
config     /Users/<user>/.config/opencode
cache      /Users/<user>/.cache/opencode
state      /Users/<user>/.local/state/opencode
$ opencode auth list                       # numeric summary only
exit 0: 1 credentials
```

For the following child processes, `XDG_CONFIG_HOME=$P/config`, `XDG_DATA_HOME=$P/data`, `XDG_CACHE_HOME=$P/cache`, and `XDG_STATE_HOME=$P/state`:

```text
$ opencode debug paths
exit 0: config=$P/config/opencode, data=$P/data/opencode,
        cache=$P/cache/opencode, state=$P/state/opencode
        home=/Users/<user>, tmp=<OS temp>/opencode
$ opencode auth list
exit 0: 0 credentials
$ opencode debug skill                     # only location fields counted
exit 0: at least 19 machine-home skill locations in captured output
$ OPENCODE_DISABLE_EXTERNAL_SKILLS=true opencode debug skill
exit 0: 1 skill, 0 machine-home locations   # built-in customize-opencode
```

The first large skill report did not parse as complete JSON, so its count is a lower bound from location fields, not a total. No skill bodies were printed or saved. The small report with external skills disabled parsed successfully. Default `auth list` still reported 1 credential afterward. Credential presence is not proof that the provider will accept or refresh it.

### Complete deletion

Stop profile clients and backend servers, including attached/detached processes. Remove its four XDG roots, including credential files, SQLite databases and WAL/SHM files, plugins, caches, logs, and state. Do not run a global uninstall or delete `~/.opencode/bin`. Require plugins not to put profile secrets in external directories; account for any profile-owned temp files without deleting the shared `/opencode` temp directory or another process's files. Exclude inherited credentials/config/DB/server-attachment overrides and API-key variables. Full provider refresh, MCP OAuth, detached-server, and temp cleanup tests remain unverified.

## 5. Cursor CLI

### Storage and selection

[Official CLI config](https://cursor.com/docs/cli/reference/configuration) documents `~/.cursor/cli-config.json`, `CURSOR_CONFIG_DIR`, and an XDG config override described for Linux/BSD. [Authentication](https://cursor.com/docs/cli/reference/authentication) documents status/login/logout and `CURSOR_API_KEY`; it does not promise separate accounts per config folder.

The installed executable is a launcher for a readable bundled program:

```text
~/.local/share/cursor-agent/versions/2026.10.22-27dcf5f/index.js
SHA-256: 943765eeedb4fe5d4ab6d95fc839c3eaf0c070e734577409badb9dea5b0ed293
```

This proprietary bundle has no verified public source commit. Exact local references are `index.js:414` at that version/hash, using its preserved module names:

- `../cursor-config/dist/paths.js`: `CURSOR_CONFIG_DIR` selects CLI config; this installed version also honors `XDG_CONFIG_HOME` on macOS, despite the docs' narrower platform description. `CURSOR_DATA_DIR` selects the base of `projects/` state, including project MCP auth files. Neither changes the login store.
- `./src/utils/credential-store.ts`: `AGENT_CLI_CREDENTIAL_STORE` selects `file`, `memory`, or `default`.
- `../cli-credentials/dist/index.js`: `default` on macOS constructs a Keychain store for the constant domain `cursor`. Services include `cursor-access-token`, `cursor-refresh-token`, and `cursor-api-key`, account `cursor-user`. Config path is absent from those identities, so two config folders share them.
- The same module's file store uses `os.homedir()/.cursor/auth.json` on macOS. `AGENT_CLI_CREDENTIAL_STORE=file` therefore **does not fix separation** with `CURSOR_CONFIG_DIR` or `CURSOR_DATA_DIR`. Memory mode cannot preserve a teammate's profile login across terminals.

Global [skills](https://cursor.com/docs/skills) include `~/.cursor/skills` and `~/.agents/skills`; [MCP definitions](https://cursor.com/docs/mcp) include `~/.cursor/mcp.json` and repo `.cursor/mcp.json`. The installed bundle also has home-based `.cursor/plugins` marketplace paths and project-state `mcp-auth.json`. No single verified override relocates all of these together.

### Observed output

```text
$ cursor-agent --version
2026.10.22-27dcf5f
$ cursor-agent status --format json
exit 0: {status: "unauthenticated", isAuthenticated: false}
$ XDG_CONFIG_HOME="$P/config" XDG_DATA_HOME="$P/data" XDG_CACHE_HOME="$P/cache" cursor-agent status --format json
exit 0: {status: "unauthenticated", isAuthenticated: false}
$ CURSOR_CONFIG_DIR="$P/cursor" CURSOR_DATA_DIR="$P/cursor-data" cursor-agent status --format json
exit 0: {status: "unauthenticated", isAuthenticated: false}
$ CURSOR_CONFIG_DIR="$P/cursor" CURSOR_DATA_DIR="$P/cursor-data" AGENT_CLI_CREDENTIAL_STORE=file cursor-agent status --format json
exit 0: {status: "unauthenticated", isAuthenticated: false}
```

Default status was still unauthenticated at the end. **No positive-control login existed**, so these results alone cannot prove separation. The fixed Keychain/file identities in the installed program explain why folder overrides are insufficient. Do not infer login isolation from the empty status alone. `status --help` verifies `--format json`.

### Complete deletion

There is no independent persistent login to delete under the tested folder overrides. `cursor-agent logout` in a supposed profile can clear the machine setup's shared Keychain credentials; do not run it as profile expiry. Deleting `CURSOR_CONFIG_DIR` leaves those credentials and other home-based stores. A separately isolated OS user/VM could support a different design, but it was not tested. With the current same-user bridge, offer only the machine setup.

## 6. Antigravity

`command -v antigravity agy` found neither command. A directory-name inventory found no Antigravity app in `/Applications` or `~/Applications`. No executable was installed and no account or credential paths were opened. Login/config/skill/plugin/MCP storage, override names, Keychain identity, and deletion behavior are **unverified**. Do not borrow VS Code's `--user-data-dir` semantics or another harness's variables without Antigravity's own evidence. Future verification requires installation, its current help/docs, and the tests below.

## Exact bridge changes recommended to the lead

The baseline [folder table](https://github.com/nuko-nova-dynamics/uplink-room/blob/994c21a40957e97335f7145bd4675e8ecd00b8fc/packages/bridge/src/profiles.ts#L4-L12) is a generic set of variables, not a per-harness capability check. [Terminal startup](https://github.com/nuko-nova-dynamics/uplink-room/blob/994c21a40957e97335f7145bd4675e8ecd00b8fc/packages/bridge/src/bridge.ts#L224-L240) overlays it on the whole inherited environment, preserving machine auth variables. [Deletion](https://github.com/nuko-nova-dynamics/uplink-room/blob/994c21a40957e97335f7145bd4675e8ecd00b8fc/packages/bridge/src/profiles.ts#L52-L55) only removes the directory; it does not clean Keychain entries. [Expiry](https://github.com/nuko-nova-dynamics/uplink-room/blob/994c21a40957e97335f7145bd4675e8ecd00b8fc/packages/bridge/src/bridge.ts#L118-L121) ends tracked terminals first, but does not establish detached-process cleanup. The [README qualification](https://github.com/nuko-nova-dynamics/uplink-room/blob/994c21a40957e97335f7145bd4675e8ecd00b8fc/packages/bridge/README.md#L96-L98) is warranted.

For eligible harnesses, the folder mapping should be:

```ts
CLAUDE_CONFIG_DIR: "claude",  // keep
CODEX_HOME: "codex",         // keep; not sufficient for shared skills/MCP Keychain
GROK_HOME: "grok",           // missing; future support only after import isolation
XDG_CONFIG_HOME: "config",  // keep
XDG_DATA_HOME: "data",      // keep
XDG_CACHE_HOME: "cache",    // keep
XDG_STATE_HOME: "state",    // missing; OpenCode state otherwise stays shared
T3CODE_HOME: "t3code",      // existing mapping; T3 Code is outside this issue's six harnesses
```

Do **not** add `CURSOR_CONFIG_DIR: "cursor"` and `CURSOR_DATA_DIR: "cursor-data"` and claim that enables Cursor profiles. Those would only move parts of its settings/data; authentication remains shared. No Antigravity mapping is verified.

The variable table alone cannot fix this feature:

1. Choose support by harness and tested version; reject unsupported profile launches. Arbitrary shells can bypass folder routing, so this is an honest feature limit, not an access-control guarantee.
2. Build a clean per-profile child environment. Exclude inherited auth tokens/API keys, credential-file redirects, custom config overrides, cloud provider credential selection, and existing daemon/server attachments. Keep the ordinary environment unchanged for machine-setup terminals. Recheck after shell startup because shell rc files can reintroduce them.
3. For Codex, initialize the profile's `config.toml` with the two file-store settings above. A separate solution is still needed for shared `~/.agents/skills`; do not rely on the deprecated `CODEX_HOME/skills` path as the sole future interface.
4. For OpenCode, set `OPENCODE_DISABLE_EXTERNAL_SKILLS=true` and `OPENCODE_DISABLE_CLAUDE_CODE=true`, move all four XDG roots, and keep new user skills/plugins in that profile's native config. Only the external-skill flag was tested live here; prompt-import suppression is source-verified.
5. Add harness-specific expiry cleanup, error handling, and post-deletion checks. Do not silently report credentials deleted when Keychain cleanup failed, a detached process still holds them, or a plugin wrote them elsewhere. Never delete shared machine stores to clean up one profile.

## Remaining acceptance tests

Use test accounts owned for this purpose, with the required subscriptions. Do not use a teammate's real credentials. These are instructions for a later authorized test, **not actions performed in this research**.

1. Create two fresh profile roots A/B without symlinks or copied config. Use the proposed environment and storage policy. Start two ordinary terminals plus a machine-setup terminal. Install harmless, differently named settings/skills/plugins and a local dummy MCP definition in A/B; verify each terminal sees only its own user customizations plus deliberately shared repo/managed policy.
2. Authenticate A and B to two different test accounts. Verify account identity in each terminal, restart both, then exercise token refresh and concurrent activity. Default machine-setup status must remain unchanged. For Cursor, test on a separate OS identity if evaluating that alternative; same-user folder separation is not supported by the inspected stores.
3. Authenticate the same test MCP endpoint/server name to different test identities in A/B. Verify no token reuse across profiles, including after refresh, restart, removal, and re-add. This specifically probes Codex's shared Keychain case and Claude's untested MCP lifecycle. Use file-only Codex MCP auth from the start.
4. Expire A while a normal and a detached run exist. Verify all A processes stop; its files, caches, databases, profile-specific Keychain entries, and owned temp artifacts are gone. Relaunch at A's old path: it must ask to log in and contain no old customizations. B and the machine setup must still work. Verify cleanup failure produces an explicit incomplete state rather than success.
5. Audit every installed plugin's credential store, external helpers, inherited API-key/cloud auth, and shared repo settings. Repeat on harness upgrades and on each supported OS. Do not broaden the result of this Mac-only, same-user probe.

The research answers the storage/selection question and records the safe probes. Issue #18's stronger two-account acceptance remains open. Its done condition also asks to update experiment 6 in `research/notes.md`; that edit belongs to the lead because this task authorizes a commit containing **only this research file**. Suggested note: “Partial evidence in [profile-logins.md](profile-logins.md): folder isolation passes for several logins, but complete profiles require per-harness controls and two-account/MCP/expiry qualification; Grok and Cursor remain machine-setup-only, Antigravity untested.”
