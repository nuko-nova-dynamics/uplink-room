# Security

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Please don't open a public issue or pull request for it.

Include what you found, how to reproduce it, and what an attacker could do with it. We'll reply in the report's thread.

## Scope

- The desktop app (`apps/desktop`), the Room API backend (`packages/backend`), the bridge (`packages/bridge`), the room client, MCP server and CLI (`packages/room-client`), and the Notetaker (`packages/notetaker`).
- The update feed and installers served from uplinkroom.com.

Test only against your own team and machines. Don't access other people's data or disrupt the service.

## Supported versions

Only the latest release on the `latest` update channel gets fixes.

## Public values in the source

Some values in the repo look like keys but are meant to be public, because every installed app already carries them: the Clerk publishable keys, the PostHog project key, the Sentry DSN and the Convex deployment URLs in `apps/desktop/.env.release` and `.env.example`. Reports about these alone aren't vulnerabilities.
