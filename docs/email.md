# Email

The room sends four emails, all transactional, through Resend from `mail.uplinkroom.com`:

| Email | Goes to | When |
| --- | --- | --- |
| Invite | The invited address | `invites.create`, `invites.resend`, and `invites.regenerate` unless the invite was made with `sendEmail: false` |
| Reminder | The invited address | Once, 3 days after the invite was made, if nobody accepted it, it wasn't revoked, regenerated or resent, and the team has reminders on |
| Welcome | The person who joined | When they accept |
| Joined | Whoever sent the invite (an agent's accountable person) | When the person they invited accepts, unless they turned it off in Settings, Notifications |

`packages/backend/convex/lib/email.ts` queues each one as a row in `emails`, and `convex/emailSend.ts` renders it (React Email templates in `packages/backend/emails/`) and posts it with one Resend idempotency key, so a retry never sends it twice. 429s, 5xx answers and network errors are retried four times over about 73 minutes; anything else fails at once. The row, and for invite and reminder emails the invite, record where it stands, with the error in words and no secrets. Nothing in an email loads from anywhere: no images, fonts or tracking pixel. Open and click tracking stay off for the domain in Resend.

`pnpm --filter @uplink-room/backend emails` previews the templates with React Email's dev server on port 3300.

## Deployment settings

| Variable | What it is |
| --- | --- |
| `RESEND_API_KEY` | A Resend API key with sending access only, for `mail.uplinkroom.com`. Without it no email is sent. |
| `EMAIL_FROM` | `Uplink Room <hello@mail.uplinkroom.com>` |
| `INVITE_TOKEN_KEYS` | The keys that seal invite tokens (below). Without it invites still work, but no invite or reminder email can carry the link: each is recorded as failed with the reason, and Copy link can't show a waiting invite's link again. |
| `UPLINK_SITE_URL` | Optional. The https origin the emails link to, such as a site preview on a development deployment. Absent: `https://uplinkroom.com`. |

Set them with `npx convex env set` (add `--prod` for production). Never paste a key into a command line or a chat; the commands below read it from a file that's deleted right after.

## INVITE_TOKEN_KEYS

The room checks an invite token against its SHA-256, as with every secret. It also keeps the current token sealed with AES-GCM, so the invite email, its reminder and Copy link can hand out the same link later. `INVITE_TOKEN_KEYS` holds the sealing keys: `id:key` entries separated by commas, where `id` is letters, digits, `-` or `_` and `key` is 32 random bytes in base64.

```
k2:<32 bytes, base64>,k1:<32 bytes, base64>
```

New tokens are sealed with the first entry. A sealed token names its key's id and opens with that entry wherever it sits in the list. A malformed entry is skipped with a warning in the logs that names its position or id, never the key.

Make the first key:

```sh
umask 077
printf 'INVITE_TOKEN_KEYS=k1:%s\n' "$(openssl rand -base64 32)" > /tmp/invite-keys.env
npx convex env set --from-file /tmp/invite-keys.env --prod
rm /tmp/invite-keys.env
```

Rotate it:

1. Put a new entry in front and keep the old ones, so the value becomes `k2:<new>,k1:<old>`:

   ```sh
   umask 077
   printf 'INVITE_TOKEN_KEYS=k2:%s,%s\n' "$(openssl rand -base64 32)" "$(npx convex env get INVITE_TOKEN_KEYS --prod)" > /tmp/invite-keys.env
   npx convex env set --from-file /tmp/invite-keys.env --prod
   rm /tmp/invite-keys.env
   ```
2. From then on new and regenerated tokens are sealed with `k2`, and tokens sealed with `k1` still open.
3. Remove `k1` once no waiting invite was sealed with it: after 30 days at most, the longest an invite lasts.

Removing a key early doesn't stop those invites from being accepted with the token their person already has. But their reminder and Copy link can't read the link back, and the list says to regenerate the token.

## Who can accept an invite

An invite works only for the account whose verified email is the invited address, compared without case. The room reads that from the sign-in's `email` and `email_verified` claims. The Clerk instances put `aud`, `name`, `email` and `picture` in their session token (ADR 0014), so each instance a deployment trusts also needs this session claim:

```json
"email_verified": "{{user.email_verified}}"
```

Without it, every sign-in counts as unverified and no invite can be accepted. Add it in the Clerk Dashboard (Sessions, Customize session token) or with the instance config, on the development instance and the production instance, before deploying invites that check it. A sign-in at another address gets "This invite is for a…@company.com. You're signed in as b…@x.com." and the Join dialog offers Switch account.

Only people accept invites. An agent joins when a person adds it with `agents.add` and is accountable for it (ADR 0003).

## Testing

Tests use a fake sender (`setEmailSenderForTests`), so nothing reaches Resend. The real sender never posts to an address at a reserved test domain (example.com, .net and .org, and the .example, .invalid, .test and .localhost names): Clerk's `+clerk_test@example.com` accounts and the screenshot and call scripts use them, and those emails are recorded as failed with the reason instead of bouncing against `mail.uplinkroom.com`. Live checks run on the development deployment with throwaway accounts, and send real email only to an address of our own.
