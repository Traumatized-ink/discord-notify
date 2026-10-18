# discord-notify

Discord alerts for server-side failures, plus a [ZeptoMail](https://www.zoho.com/zeptomail/) sender that posts an alert whenever an email fails to send.

No dependencies. Ships as an ES module with TypeScript types, and needs a global `fetch` (Node 18+, Bun or Deno).

## Install

```sh
npm install @trstudios/discord-notify
```

**Server-side only.** It reads secrets from the environment, so never import it into browser or app bundles.

## Configuration

| Variable | Used by | Purpose |
|---|---|---|
| `ALERTS_DISCORD_WEBHOOK` | `notifyDiscord`, failed `sendMail` | A Discord channel webhook URL. If it's unset, alerts are logged instead. |
| `ZEPTOMAIL_TOKEN` | `sendMail` | The mail agent's Send Mail token, with or without the `Zoho-enczapikey ` prefix |
| `ZEPTOMAIL_API_URL` | `sendMail` (optional) | Overrides `https://api.zeptomail.com/v1.1/email`, e.g. for a regional data centre |

Each option can also be passed in code instead of through the environment.

## Usage

### Send an alert

```ts
import { notifyDiscord } from "@trstudios/discord-notify";

await notifyDiscord({
  title: "Nightly export failed",
  fields: { Job: "export", Error: String(err) },
  body: "Optional longer text",
});
```

`notifyDiscord` never throws. It returns `false` if the alert couldn't be sent and logs why.

### Send an email

```ts
import { sendMail } from "@trstudios/discord-notify";

const result = await sendMail(
  {
    from: { address: "noreply@example.com", name: "Example" },
    to: [{ address: "someone@example.com" }],
    bcc: [{ address: "audit@example.com" }], // optional, as is cc
    replyTo: { address: "help@example.com" },
    subject: "Your report is ready",
    html: "<p>…</p>",
  },
  { source: "reports", alertContent: "summary" },
);

if (!result.ok) {
  // Already logged, and alerted to Discord. Answer your own request as needed.
}
```

`sendMail` never throws. When a send fails, because of a bad token, a rejected sender or IP, a network error or anything else, it:
1. logs the error;
2. posts a Discord alert;
3. returns `{ ok: false, error }`.

### How much a failure alert includes

`alertContent` decides how much of the failed message goes to Discord:

| Level | Includes |
|---|---|
| `"none"` (default) | Source, error, recipients masked as `j***@example.com` |
| `"summary"` | Adds from, full recipients, reply-to and subject |
| `"full"` | Adds the message body. If there's no text version, it's converted from the HTML. |

Use `"none"` for messages that contain secrets, such as sign-in codes, password resets and invite links. Anyone who can read the alert channel can read whatever an alert includes.

### Check delivery and alerts

`sendTestMail` sends a short test email through the same path as real mail. With `fail: true`, it uses a deliberately invalid token instead, so the send fails and the failure alert fires. That checks the alert path without changing any configuration.

`secretMatches` compares a request header with a configured secret in constant time. It returns `false` when either value is missing.

Here's an example route, shown with Next.js, protected by an admin secret. It sends only to an address from configuration:

```ts
import { secretMatches, sendTestMail } from "@trstudios/discord-notify";

export async function POST(request: Request) {
  if (!secretMatches(request.headers.get("x-admin-token"), process.env.ADMIN_TOKEN)) {
    return Response.json({ error: "Not allowed" }, { status: 403 });
  }
  const to = process.env.TEST_EMAIL_TO;
  if (!to) return Response.json({ error: "TEST_EMAIL_TO is not set" }, { status: 500 });

  const result = await sendTestMail({
    from: { address: "noreply@example.com", name: "Example" },
    to: [{ address: to }],
    source: "example.com",
    fail: new URL(request.url).searchParams.get("fail") === "1",
  });
  return Response.json(result, { status: result.ok ? 200 : 500 });
}
```

Never take the recipient from the request. Otherwise anyone holding the admin secret could use the route to send mail to arbitrary addresses.

## Safety notes

- **No pings:** alerts are posted with mentions disabled, so text in a message can't ping `@everyone` or a role.
- **Discord's size limits:** long fields and bodies are cut off with a `(truncated)` marker.
- **Timeouts:** requests time out after 5 seconds (Discord) and 15 seconds (ZeptoMail), so a hung service can't stall your request handler for long.

## Development

```sh
npm install
npm test
npm run typecheck
```

## Releasing

1. Bump `version` in `package.json` and commit.
2. Push a matching tag, for example `git tag v1.0.1 && git push origin v1.0.1`.

GitHub Actions then publishes it to npm through Trusted Publishing, with provenance.

## License

MIT
