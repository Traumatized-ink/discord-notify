// discord-notify — https://github.com/Traumatized-ink/discord-notify
// Server-side only: it reads secrets from the environment. Never import it from
// browser or app bundles.
//
// No dependencies; needs a global fetch (Node 18+, Bun, Deno).

type FetchFn = typeof fetch;

// ---------------------------------------------------------------------------
// Discord alerts
// ---------------------------------------------------------------------------

export interface DiscordAlert {
  /** One line saying what failed, e.g. "Nightly export failed". */
  title: string;
  /** Short labelled values (source, error, recipient...). */
  fields?: Record<string, string | undefined>;
  /** Longer free text, such as the content of a failed message. */
  body?: string;
}

export interface NotifyOptions {
  /** Defaults to the ALERTS_DISCORD_WEBHOOK environment variable. */
  webhookUrl?: string;
  fetch?: FetchFn;
}

// Discord's limits for one embed.
const TITLE_MAX = 256;
const FIELD_NAME_MAX = 256;
const FIELD_VALUE_MAX = 1024;
const MAX_FIELDS = 25;
const DESCRIPTION_MAX = 4096;
const EMBED_TOTAL_MAX = 6000;
const RED = 0xd93f3f;

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const note = "… (truncated)";
  return text.slice(0, max - note.length) + note;
}

/** Builds the webhook payload. Exported for tests. */
export function discordPayload(alert: DiscordAlert) {
  const title = truncate(alert.title, TITLE_MAX);
  const fields = Object.entries(alert.fields ?? {})
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .slice(0, MAX_FIELDS)
    .map(([name, value]) => ({
      name: truncate(name, FIELD_NAME_MAX),
      value: truncate(value, FIELD_VALUE_MAX),
      inline: value.length <= 40,
    }));
  const used = title.length + fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
  const room = Math.min(DESCRIPTION_MAX, EMBED_TOTAL_MAX - used);
  const description = alert.body && room > 20 ? truncate(alert.body, room) : undefined;
  return {
    // Alert text can contain user input; never let it ping @everyone or roles.
    allowed_mentions: { parse: [] as string[] },
    embeds: [{ title, color: RED, fields, description, timestamp: new Date().toISOString() }],
  };
}

/**
 * Posts an alert to a Discord channel webhook. Never throws: it returns false
 * when there is no webhook configured or Discord can't be reached, and logs why.
 */
export async function notifyDiscord(alert: DiscordAlert, options: NotifyOptions = {}): Promise<boolean> {
  const url = options.webhookUrl ?? process.env.ALERTS_DISCORD_WEBHOOK;
  if (!url) {
    console.warn(`[discord-notify] ALERTS_DISCORD_WEBHOOK is not set; alert not sent: ${alert.title}`);
    return false;
  }
  try {
    const res = await (options.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(discordPayload(alert)),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error(`[discord-notify] Discord returned ${res.status}; alert not sent: ${alert.title}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[discord-notify] could not reach Discord; alert not sent: ${alert.title}`, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// ZeptoMail sending, with an alert when a send fails
// ---------------------------------------------------------------------------

export interface Address {
  address: string;
  name?: string;
}

export interface Mail {
  from: Address;
  to: Address[];
  replyTo?: Address;
  subject: string;
  text?: string;
  html?: string;
}

/**
 * How much of a failed message goes into the alert.
 * - "none": recipients masked (j***@example.com), no subject or content. Use for
 *   anything with secrets in it: sign-in codes, password resets, invites.
 * - "summary": recipients and subject, no content.
 * - "full": everything, including the message body.
 */
export type AlertContent = "none" | "summary" | "full";

export interface SendOptions {
  /** Defaults to ZEPTOMAIL_TOKEN. With or without the "Zoho-enczapikey " prefix. */
  token?: string;
  /** What the alert should include if this send fails. Defaults to "none". */
  alertContent?: AlertContent;
  /** Names the sender in the alert, e.g. "billing service". */
  source?: string;
  /** Defaults to https://api.zeptomail.com/v1.1/email (ZEPTOMAIL_API_URL overrides). */
  apiUrl?: string;
  /** Options for the failure alert. */
  notify?: NotifyOptions;
  fetch?: FetchFn;
}

export type SendResult = { ok: true } | { ok: false; error: string };

const PREFIX = "Zoho-enczapikey ";

export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 1) return "***";
  return `${address[0]}***${address.slice(at)}`;
}

const formatAddress = (a: Address) => (a.name ? `${a.name} <${a.address}>` : a.address);

function zeptoBody(mail: Mail) {
  return {
    from: { address: mail.from.address, name: mail.from.name },
    to: mail.to.map((a) => ({ email_address: { address: a.address, name: a.name } })),
    reply_to: mail.replyTo ? [{ address: mail.replyTo.address, name: mail.replyTo.name }] : undefined,
    subject: mail.subject,
    textbody: mail.text,
    htmlbody: mail.html,
  };
}

/** Turns HTML into readable text for the alert when there is no text version. */
function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/h\d|\/li|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

/** Builds the failure alert at the requested level of detail. Exported for tests. */
export function failureAlert(mail: Mail, error: string, level: AlertContent, source?: string): DiscordAlert {
  const fields: Record<string, string | undefined> = { Source: source, Error: error };
  if (level === "none") {
    fields.To = mail.to.map((a) => maskEmail(a.address)).join(", ");
    return { title: "Email failed to send", fields };
  }
  fields.From = formatAddress(mail.from);
  fields.To = mail.to.map(formatAddress).join(", ");
  fields["Reply-To"] = mail.replyTo && formatAddress(mail.replyTo);
  fields.Subject = mail.subject;
  if (level === "summary") return { title: "Email failed to send", fields };
  const body = mail.text ?? (mail.html ? htmlToText(mail.html) : undefined);
  return { title: "Email failed to send", fields, body };
}

async function describeFailure(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const err = JSON.parse(text)?.error;
    if (err) {
      const details = Array.isArray(err.details)
        ? err.details.map((d: { message?: string; target?: string }) => [d.target, d.message].filter(Boolean).join(": ")).join("; ")
        : "";
      return [`HTTP ${res.status}`, err.code, err.message, details].filter(Boolean).join(" · ");
    }
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return `HTTP ${res.status}${text ? ` · ${text.slice(0, 300)}` : ""}`;
}

/**
 * Sends one email through the ZeptoMail API. Never throws. On failure it posts a
 * Discord alert (see AlertContent) and returns { ok: false }, so the caller can
 * still answer its own request.
 */
export async function sendMail(mail: Mail, options: SendOptions = {}): Promise<SendResult> {
  const level = options.alertContent ?? "none";
  const raw = options.token ?? process.env.ZEPTOMAIL_TOKEN ?? "";
  const key = raw.startsWith(PREFIX) ? raw.slice(PREFIX.length) : raw;

  let error: string;
  if (!key) {
    error = "ZEPTOMAIL_TOKEN is not set";
  } else {
    try {
      const res = await (options.fetch ?? fetch)(
        options.apiUrl ?? process.env.ZEPTOMAIL_API_URL ?? "https://api.zeptomail.com/v1.1/email",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: PREFIX + key,
          },
          body: JSON.stringify(zeptoBody(mail)),
          signal: AbortSignal.timeout(15000),
        },
      );
      if (res.ok) return { ok: true };
      error = await describeFailure(res);
    } catch (err) {
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
  }

  console.error(`[discord-notify] email failed${options.source ? ` (${options.source})` : ""}: ${error}`);
  await notifyDiscord(failureAlert(mail, error, level, options.source), {
    ...options.notify,
    fetch: options.notify?.fetch ?? options.fetch,
  });
  return { ok: false, error };
}
