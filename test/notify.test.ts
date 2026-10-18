import { test } from "node:test";
import assert from "node:assert/strict";
import { discordPayload, failureAlert, maskEmail, notifyDiscord, secretMatches, sendMail, sendTestMail, truncate, type Mail } from "../src/notify.ts";

type Call = { url: string; init: RequestInit };

function fakeFetch(...responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift() ?? new Response(null, { status: 204 });
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fn, calls, json: (i: number) => JSON.parse(String(calls[i].init.body)) };
}

const mail: Mail = {
  from: { address: "form@example.com", name: "Example Site" },
  to: [{ address: "owner@example.com", name: "Owner" }],
  replyTo: { address: "visitor@example.org", name: "Visitor" },
  subject: "New enquiry",
  html: "<p>Hello &amp; welcome</p><p>Second line</p>",
};

test("truncate keeps short text and marks cut text", () => {
  assert.equal(truncate("abc", 10), "abc");
  const cut = truncate("x".repeat(100), 30);
  assert.equal(cut.length, 30);
  assert.ok(cut.endsWith("(truncated)"));
});

test("maskEmail hides the local part", () => {
  assert.equal(maskEmail("jane@example.com"), "j***@example.com");
  assert.equal(maskEmail("nonsense"), "***");
});

test("payload never allows mentions and fits Discord's limits", () => {
  const p = discordPayload({ title: "t".repeat(400), fields: { A: "a".repeat(2000), Empty: undefined }, body: "@everyone " + "b".repeat(9000) });
  assert.deepEqual(p.allowed_mentions, { parse: [] });
  const e = p.embeds[0];
  assert.equal(e.title.length, 256);
  assert.equal(e.fields.length, 1);
  assert.equal(e.fields[0].value.length, 1024);
  const total = e.title.length + e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0) + (e.description?.length ?? 0);
  assert.ok(total <= 6000);
});

test("notifyDiscord returns false without a webhook and never throws", async () => {
  const saved = process.env.ALERTS_DISCORD_WEBHOOK;
  delete process.env.ALERTS_DISCORD_WEBHOOK;
  try {
    assert.equal(await notifyDiscord({ title: "x" }), false);
  } finally {
    if (saved !== undefined) process.env.ALERTS_DISCORD_WEBHOOK = saved;
  }
  const f = fakeFetch(new Error("network down"));
  assert.equal(await notifyDiscord({ title: "x" }, { webhookUrl: "https://discord.test/hook", fetch: f.fn }), false);
});

test("successful send posts to ZeptoMail and sends no alert", async () => {
  const f = fakeFetch(new Response('{"data":[]}', { status: 201 }));
  const r = await sendMail(mail, { token: "Zoho-enczapikey abc", fetch: f.fn, notify: { webhookUrl: "https://discord.test/hook" } });
  assert.deepEqual(r, { ok: true });
  assert.equal(f.calls.length, 1);
  assert.equal((f.calls[0].init.headers as Record<string, string>).Authorization, "Zoho-enczapikey abc");
  const body = f.json(0);
  assert.equal(body.to[0].email_address.address, "owner@example.com");
  assert.equal(body.reply_to[0].address, "visitor@example.org");
});

test("token without prefix gets one", async () => {
  const f = fakeFetch(new Response("{}", { status: 201 }));
  await sendMail(mail, { token: "abc", fetch: f.fn });
  assert.equal((f.calls[0].init.headers as Record<string, string>).Authorization, "Zoho-enczapikey abc");
});

test("failed send alerts with the ZeptoMail error, masked by default", async () => {
  const f = fakeFetch(
    new Response(JSON.stringify({ error: { code: "TM_4001", message: "Access Denied", details: [{ message: "IP not allowed", target: "ip" }] } }), { status: 401 }),
    new Response(null, { status: 204 }),
  );
  const r = await sendMail(mail, { token: "abc", fetch: f.fn, source: "test form", notify: { webhookUrl: "https://discord.test/hook" } });
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : "", /HTTP 401 · TM_4001 · Access Denied · ip: IP not allowed/);
  assert.equal(f.calls[1].url, "https://discord.test/hook");
  const alert = JSON.stringify(f.json(1));
  assert.ok(alert.includes("o***@example.com"));
  assert.ok(!alert.includes("owner@example.com"));
  assert.ok(!alert.includes("New enquiry"));
  assert.ok(alert.includes("test form"));
});

test("missing token is reported as a failure, not a throw", async () => {
  const saved = process.env.ZEPTOMAIL_TOKEN;
  delete process.env.ZEPTOMAIL_TOKEN;
  try {
    const f = fakeFetch();
    const r = await sendMail(mail, { fetch: f.fn, notify: { webhookUrl: "https://discord.test/hook" } });
    assert.deepEqual(r, { ok: false, error: "ZEPTOMAIL_TOKEN is not set" });
    assert.equal(f.calls.length, 1); // only the alert
  } finally {
    if (saved !== undefined) process.env.ZEPTOMAIL_TOKEN = saved;
  }
});

test("network errors are caught", async () => {
  const f = fakeFetch(new TypeError("fetch failed"));
  const r = await sendMail(mail, { token: "abc", fetch: f.fn, notify: { webhookUrl: "https://discord.test/hook" } });
  assert.deepEqual(r, { ok: false, error: "TypeError: fetch failed" });
});

test("alert levels include progressively more", () => {
  const none = JSON.stringify(failureAlert(mail, "boom", "none"));
  assert.ok(!none.includes("New enquiry") && !none.includes("Hello"));
  const summary = JSON.stringify(failureAlert(mail, "boom", "summary"));
  assert.ok(summary.includes("New enquiry") && summary.includes("Visitor <visitor@example.org>") && !summary.includes("Hello"));
  const full = failureAlert(mail, "boom", "full");
  assert.equal(full.body, "Hello & welcome\nSecond line");
});

test("cc and bcc are sent, and masked in a default alert", async () => {
  const f = fakeFetch(new Response(null, { status: 500 }), new Response(null, { status: 204 }));
  await sendMail(
    { ...mail, cc: [{ address: "copy@example.com" }], bcc: [{ address: "audit@example.net" }] },
    { token: "abc", fetch: f.fn, notify: { webhookUrl: "https://discord.test/hook" } },
  );
  const body = f.json(0);
  assert.equal(body.cc[0].email_address.address, "copy@example.com");
  assert.equal(body.bcc[0].email_address.address, "audit@example.net");
  const alert = JSON.stringify(f.json(1));
  assert.ok(alert.includes("a***@example.net") && !alert.includes("audit@example.net"));
});

test("empty cc and bcc are left out of the request", async () => {
  const f = fakeFetch(new Response("{}", { status: 201 }));
  await sendMail({ ...mail, cc: [], bcc: [] }, { token: "abc", fetch: f.fn });
  const body = f.json(0);
  assert.equal(body.cc, undefined);
  assert.equal(body.bcc, undefined);
});

test("secretMatches compares exactly and rejects missing values", () => {
  assert.equal(secretMatches("abc", "abc"), true);
  assert.equal(secretMatches("abc", "abd"), false);
  assert.equal(secretMatches("abc", "abcd"), false);
  assert.equal(secretMatches("", ""), false);
  assert.equal(secretMatches(null, "abc"), false);
  assert.equal(secretMatches("abc", undefined), false);
});

test("sendTestMail sends a delivery test with the configured token", async () => {
  const f = fakeFetch(new Response("{}", { status: 201 }));
  const r = await sendTestMail({ from: mail.from, to: [{ address: "ops@example.com" }], token: "abc", source: "site", fetch: f.fn });
  assert.deepEqual(r, { ok: true });
  const body = f.json(0);
  assert.match(body.subject, /^Delivery test \(site\): /);
  assert.equal(body.to[0].email_address.address, "ops@example.com");
  assert.equal((f.calls[0].init.headers as Record<string, string>).Authorization, "Zoho-enczapikey abc");
});

test("sendTestMail with fail uses a bad token and raises a summary alert", async () => {
  const f = fakeFetch(new Response(JSON.stringify({ error: { code: "TM_3501", message: "Invalid API Token" } }), { status: 401 }), new Response(null, { status: 204 }));
  const r = await sendTestMail({ from: mail.from, to: [{ address: "ops@example.com" }], token: "abc", fail: true, fetch: f.fn, notify: { webhookUrl: "https://discord.test/hook" } });
  assert.equal(r.ok, false);
  assert.equal((f.calls[0].init.headers as Record<string, string>).Authorization, "Zoho-enczapikey invalid-token-for-failure-test");
  const alert = JSON.stringify(f.json(1));
  assert.ok(alert.includes("Failure alert test") && alert.includes("ops@example.com"));
});
