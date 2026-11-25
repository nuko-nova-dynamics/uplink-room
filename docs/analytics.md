# Product analytics

The desktop app sends product analytics to PostHog, project "Uplink Room" (id 706231, US Cloud, organization Nuko Nova Dynamics). This page covers what it sends, what it never sends, and how to change either.

## Where the code is

| File | What it does |
|---|---|
| `apps/desktop/src/main/analyticsSpec.ts` | The event list (`EVENTS`) and the properties each event may carry, plus `scrubEvent`, the last check every event passes before it leaves the app |
| `apps/desktop/src/main/analytics.ts` | The main process: the "Share usage data" setting (`analytics.json` in the app's user data folder), the anonymous install ID, and posthog-node for main's own events |
| `apps/desktop/src/renderer/lib/analytics.ts` | The renderer: posthog-js, its privacy settings, `track()`, and the setting's hook |
| `apps/desktop/src/renderer/views/settings/Privacy.tsx` | Settings, Privacy, "Share usage data" |

Only release builds carry the project key (`VITE_POSTHOG_KEY` in `apps/desktop/.env.release`). Development, the tests and the screenshot scripts send nothing.

## Events

| Event | Sent from | Properties |
|---|---|---|
| `app_launched` | main | `app_version`, `platform`, `arch` |
| `signed_in`, `signed_out` | renderer | none |
| `team_created`, `team_joined` | renderer | none |
| `team_opened` | renderer | `team_count` |
| `pairing_code_created` | renderer | `belongs_to`: person or team |
| `machine_linked` | main | `method`: this_computer; `result`: ok or failed |
| `cloud_machine_created` | renderer | none |
| `run_started` | renderer | `harness`, `kind` (terminal, thread, space, a2a, cloud), `access`, `has_profile` |
| `call_joined` | renderer | none |
| `shared_browser_started`, `shared_browser_opened` | renderer | none |
| `space_opened`, `terminal_opened` | renderer | none |
| `file_opened` | renderer | `file_kind`: doc, html, pdf, image, canvas |
| `approval_answered` | renderer | `answer`: allow or deny; `from`: inbox, inbox_keyboard, task, notification |
| `inbox_opened` | renderer | none |
| `inbox_view_changed` | renderer | `view`: mine or team |

Every event also carries `team_id` once a team is open. The person's distinct ID is their member ID. Before a team opens, both processes use the same random anonymous ID (kept by main in `analytics.json`), which PostHog merges into the member when the team opens. A person in two teams is two members, so two people in PostHog.

When the person changes (sign-out, or opening another team's member), the renderer moves both processes to a new anonymous ID: posthog-js through `reset({ bootstrap })`, main by keeping the new ID. posthog-js is given main's ID as its bootstrap only when it doesn't already have it (`startIdentity`), so a restart never brings back an ID that was merged into the previous member.

## What is never sent

- Names or emails. People and teams are only their IDs.
- What is in messages, terminals, transcripts, documents, prompts or web addresses. Every property is an enum, a boolean, a count or the app version. `scrubEvent` drops any property `EVENTS` doesn't name and any value outside its rule, so a careless `track()` call can't leak.
- posthog-js's own page properties: `$current_url`, `$pathname`, `$host`, `$referrer`, `$title`, the `$initial_*` and `$session_entry_*` addresses, and the raw user agent. `scrubEvent` keeps only an allowlist of SDK, OS and session properties.
- A location. `scrubEvent` sets `$geoip_disable` on every event in both processes, so PostHog doesn't look up a city from the IP address before dropping it, even after posthog-js resets its own properties.
- Autocapture, pageviews, page leaves, rage and dead clicks, heatmaps, exceptions (Sentry covers errors), console logs, network timing, surveys, product tours, web experiments and feature flags are all off in code, and off in the project's settings too. The project drops IP addresses.

## Session replay

Replay is on, with everything masked. The project's replay settings repeat the same masking, and the code's settings in `posthogConfig()` are these:

- Every text node is masked (`maskTextSelector: "*"`), and every input (`maskAllInputs`).
- Every attribute is emptied except the ones that only lay the page out (`maskAttributeFn`): links, image addresses, titles, aria-labels, placeholders and data attributes never reach a recording.
- Terminals, files, Spaces and shared browsers are blocked whole (`ph-no-capture` on their views), and so is every frame, canvas and video (`REPLAY_BLOCK`). A blocked element shows as an empty box.
- No cross-origin frames, request headers, request bodies or network timing. The page address in a recording is cut to the page (no query or hash).

## Share usage data

Settings, Privacy, "Share usage data". It is on by default. Main keeps the setting so both processes follow it from the first event. Off means:

- main sends nothing more. posthog-node sends each event at once (`captureImmediate`), so nothing waits in a queue;
- main sends nothing more, and doesn't retry: posthog-node sends each event at once (`captureImmediate`, no retries), so nothing waits in a queue;
- posthog-js is opted out and replay stops. If the setting is off at launch, posthog-js never starts, so not even its remote config is fetched;
- `before_send` drops every event while it is off;
- posthog-js's retry queue, which resends failed requests without running `before_send` again, is emptied and takes and sends nothing while sharing is off;
- main cancels every request from the app's pages to PostHog's hosts (`session.webRequest.onBeforeRequest`), whatever posthog-js still had queued.

Turning it back on opts posthog-js in and restarts replay with `startSessionRecording()` and no override, so the project's own replay setting and sampling still decide.

`src/renderer/lib/analytics.test.ts` runs the real posthog-js in a page with the network stubbed. It checks that no forbidden field goes out, that GeoIP stays off after resets, that a restart after sign-out doesn't revive the previous member's ID, that a failed request isn't retried once the setting is off, and that replay can start again when it's turned back on.

## Adding an event

1. Add it to `EVENTS` with each property's rule: a list of values, `"boolean"`, `"count"` or `"version"`. Never free text.
2. Call `track("event_name", { ... })` in the renderer, or `analytics.capture(...)` in main.
3. Add it to the table above.

## Not covered yet

- Events from Convex, for work that happens with no app open (an agent starting a run through the Room API, a bridge pairing from another machine). The person's "Share usage data" lives on their computer, so server events would need that setting stored in the room first. That changes the database schema, so it is left for its own change.
