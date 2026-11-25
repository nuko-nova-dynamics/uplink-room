---
status: accepted
---

# Shared browsers run on Hyperbeam, isolated in their own frame origin

A shared browser is a Hyperbeam cloud browser, started on demand in a channel and ended by Hyperbeam's timeouts or by a person. Hyperbeam sits behind a small provider interface (start, end, set control, open a URL), so it can be replaced. We chose it over Browserbase, Kernel and Steel because it is built for many people in one browser, with roles per connected user, and it gives 10,000 free minutes a month (then $0.007 per participant-minute, checked 2026-11-02). The others are built for an agent browsing with one human stepping in, and bill by browser time on monthly plans.

Three choices come with it:

- **Hyperbeam's web SDK runs only in a dedicated frame origin, `uplink-frame://browser`.** The SDK fetches its client code from Hyperbeam at runtime and `import()`s it, so it is remote code we don't review. In that origin it can't reach the app's sign-in, storage or preload.
- **The backend enforces who drives.** Browsers start with no default roles. The backend, which alone holds the API key and each browser's admin token, gives the `control` role only to the driver's connections. People join with a one-time ticket that Hyperbeam passes to our auth webhook, so the backend knows which connection is which member, and a leaked embed URL lets nobody in.
- **Nothing is kept between browsers.** No Hyperbeam profile is saved or loaded, so logins made in a shared browser end with it. _Superseded by ADR 0011: a browser is still temporary by default, but whoever starts it can keep its logins as saved logins._

## Consequences

- A live check needs a Hyperbeam API key in the Convex environment and a backend reachable from the internet for the webhooks.
- Hyperbeam's CORS must accept requests from the `uplink-frame://browser` origin. If it doesn't, the frame page moves to a Convex HTTP route, which is still an origin apart from the app's. The live check on 2026-11-02 (dev deployment, PR #37) found that it does: two people's frames on that origin connected and played, with no console errors, so the fallback isn't needed.
- The backend schedules its own end at the longest session, and asks Hyperbeam every idle window (and when a start reaches the team's limit) whether each live session still runs, so a lost timeout webhook can't leave a browser holding a slot.
- Ending is confirmed, not assumed: a browser stays "stopping", and counts toward the limit, until Hyperbeam's DELETE succeeds or Hyperbeam reports the session gone. The room retries with backoff.
- Hyperbeam's `addRoles` is additive, so the backend serializes control updates per browser and re-applies them until they match the latest driver.
- Removing a member or revoking an agent key cuts their connections (`DELETE <base_url>/users/<id>`), also while a browser is stopping, and admission rechecks the ticket holder each time. An agent left without a working key that has the scope gives up the wheel.
- An agent can drive a shared browser only through the Room API (`browsers.openUrl`), since it has no mouse in the frame. Agents keep using T3 Code's browser tabs for their own browsing.
