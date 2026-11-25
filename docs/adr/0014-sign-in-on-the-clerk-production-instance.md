---
status: accepted
---

# Sign-in moves to the Clerk production instance on uplinkroom.com

Packaged builds sign people in with the production instance of the Clerk application "Uplink Room" (`ins_3LZx84SyitZgAHraN1CE1HWojnv`). Its Frontend API is `https://clerk.uplinkroom.com`, which is also the issuer in its session tokens. The development instance (`https://dominant-vervet-6626.clerk.accounts.dev`) stays for local runs, the screenshot and sign-in scripts, and the app that is already released. Set up on 2026-11-02.

A production instance needs a domain even though the app has no website: Clerk serves the production Frontend API from `clerk.<domain>` (clerk.com/docs/guides/development/deployment/electron, checked 2026-11-02). `uplinkroom.com` is registered at Cloudflare.

## The instance

- It was cloned from the development instance, so it has the same session claims (`aud: convex`, `name`, `email`, `picture`) and still needs no JWT template. Email sign-in (password or email code) works. The Native API is on, as `@clerk/electron` needs.
- `allowed_origins` is `uplink-room://app` only. The dev-server origins (`http://localhost:5173`, `:5174`) stay on the development instance, as Clerk's Electron guide says.
- The redirect allowlist (Native applications, "Allowlist for mobile SSO redirect") has `uplink-room://app/`, the URL Clerk's OAuth flow returns to.
- Google sign-in is off in production. It is on in development, where Clerk lends shared OAuth credentials; production needs our own Google OAuth client. GitHub was never enabled. See "Google sign-in" below.
- The Cloudflare zone `uplinkroom.com` holds the five CNAMEs Clerk asked for, all DNS-only (unproxied), because Clerk's DNS check fails behind Cloudflare's proxy: `clerk`, `accounts`, `clkmail`, `clk._domainkey` and `clk2._domainkey`. The zone has no CAA records, which would block Clerk's certificate authorities. DNS, both certificates and mail verified on 2026-11-02.

## Convex accepts both instances during the switch

`convex/auth.config.ts` reads `CLERK_JWT_ISSUER_DOMAIN` as one issuer or a comma-separated list, and makes one provider for each. It stays a single variable on purpose: Convex refuses to push while any variable `auth.config.ts` reads is unset, so a second, optional variable would break every deployment that doesn't set it (the shared dev deployment and each local backend).

Convex applies a change to this variable as soon as it is set, with no push (tested on a local backend on 2026-11-02). So the order on production (`fleet-jaguar-632`) matters:

1. Deploy this code. With the current single value nothing changes.
2. Set both issuers:
   `npx convex env set CLERK_JWT_ISSUER_DOMAIN 'https://clerk.uplinkroom.com,https://dominant-vervet-6626.clerk.accounts.dev' --prod`
3. Release the desktop app built with the new `.env.release`.

Setting the list before step 1 would sign everyone out, because the old `auth.config.ts` would read the whole list as one domain.

## When to drop the development issuer

Remove the development issuer from production once both are true:

- a release built with the production key has been out for 14 days, and
- no development-instance user other than the scripts' `+clerk_test` accounts has been active for 7 days. Check with `clerk api '/users?order_by=-last_active_at' --app app_3LYVlZeCcSUiVlhpdi8qk9cxTu1 --instance dev` and read `last_active_at`. If nobody outside the team has the old build, it is enough that each person has installed the new release.

Then: `npx convex env set CLERK_JWT_ISSUER_DOMAIN https://clerk.uplinkroom.com --prod`. That takes effect at once; anyone still on the old build is signed out and has to update. The dev deployment and local backends keep the development issuer.

## People keep their Convex rows only by Clerk user ID

`people` rows are keyed by Clerk's `subject` (the user ID), and a production user gets a new ID. Someone who signed in with the development instance and then signs in with the production instance is a new person to the room, with no teams. We accept this because, on 2026-11-02, the development instance had six users and all were `+clerk_test@example.com` test accounts made by the screenshot and check scripts. If real people sign up through the released app before the new release ships, map them first: create their production users with `external_id` set to the development user ID, then add a one-time Convex migration that rewrites `people.subject`.

## Google sign-in

To turn Google back on in production, Julio creates (in Google Cloud Console, APIs & Services):

1. An OAuth consent screen, User type **External**, with the app name Uplink Room. Set its publishing status to **In production**; a client left in "Testing" allows only 100 listed test users.
2. An OAuth client ID of type **Web application**, with the Authorized redirect URI that the Clerk Dashboard shows under SSO connections → Google → Use custom credentials (for this instance it should be `https://clerk.uplinkroom.com/v1/oauth_callback`; copy the Dashboard's value).
3. Then, in the Clerk Dashboard on the production instance, paste the client ID and secret into the Google connection and turn on "Enable for sign-up and sign-in". Keep "Block email subaddresses" on.

Google refuses sign-in inside embedded web views; the packaged app opens it in the system browser and returns through `uplink-room://app/`, which is what Google requires.

## Verified

On 2026-11-02, real session tokens from both instances, minted through the Frontend API's ticket sign-in as a native client, were sent to a local Convex backend running this `auth.config.ts`:

| `CLERK_JWT_ISSUER_DOMAIN` | Development token | Production token |
| --- | --- | --- |
| development issuer only (production today) | accepted | `NoAuthProvider` |
| both, comma-separated (the switch) | accepted | accepted |
| production issuer only (after the drop) | `NoAuthProvider` | accepted |

A final run of the committed file showed the providers Convex built: one for a single issuer, and exactly two for `' https://clerk.uplinkroom.com , <dev issuer>,https://clerk.uplinkroom.com,'` (spaces trimmed, duplicate and empty entries dropped). The production token carried `iss: https://clerk.uplinkroom.com`, `aud: convex`, `name` and `email`, and `people.ensure` stored them. The check used a local backend instead of the shared dev deployment `focused-fish-459`, because other checkouts push their own code there, and the check users and sessions were deleted afterwards.
