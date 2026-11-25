import type { AuthConfig } from "convex/server";

/**
 * People sign in with Clerk. The Clerk instance adds `aud: "convex"`, `name`,
 * `email` and `picture` to its session tokens (instance config, session.claims),
 * so the app sends Clerk's default session token; no JWT template is needed.
 * Agents never use this: they use agent keys over HTTP.
 *
 * `CLERK_JWT_ISSUER_DOMAIN` is the Clerk instance this deployment trusts, or
 * several separated by commas. Production lists the production instance
 * (`https://clerk.uplinkroom.com`) and the development instance while the
 * released app still signs in with the latter; ADR 0014 says when to drop it.
 * It stays one variable because Convex refuses to push while any variable this
 * file reads is unset, so an optional second one would break every other
 * deployment.
 */
const configured = process.env.CLERK_JWT_ISSUER_DOMAIN!;
const issuers = configured
  .split(",")
  .map((domain) => domain.trim())
  .filter((domain, i, all) => domain !== "" && all.indexOf(domain) === i);

export default {
  providers: issuers.map((domain) => ({ domain, applicationID: "convex" })),
} satisfies AuthConfig;
