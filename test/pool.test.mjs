import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConfigError,
  createMailPool,
  countRecipients,
  DeliveryUnknownError,
  DuplicateSendError,
  InvalidMessageError,
  memoryStore,
  NoCapacityError,
  otpMessage,
  SendFailedError,
} from "../dist/index.js";
import { account, clock, fakeTransports, smtpError } from "./helpers.mjs";

const mail = { to: "user@example.com", subject: "Hi", text: "Hello" };
const quiet = { logger: false };

test("priority: uses the first account, then moves on when its limit is reached", async () => {
  const { createTransport } = fakeTransports();
  const pool = createMailPool({
    ...quiet,
    createTransport,
    accounts: [
      account("a", { limits: { perDay: 2 } }),
      account("b", { limits: { perDay: 1 } }),
    ],
  });
  const used = [];
  for (let i = 0; i < 3; i++) used.push((await pool.send(mail)).accountId);
  assert.deepEqual(used, ["a", "a", "b"]);

  await assert.rejects(pool.send(mail), (error) => {
    assert.ok(error instanceof NoCapacityError);
    assert.equal(error.code, "NO_CAPACITY");
    assert.ok(error.retryAt > Date.now());
    assert.deepEqual(error.attempts.map((a) => a.reason), ["no_quota", "no_quota"]);
    return true;
  });
});

test("each recipient counts toward the limit", async () => {
  const { createTransport } = fakeTransports();
  const pool = createMailPool({
    ...quiet,
    createTransport,
    accounts: [account("a", { limits: { perDay: 3 } }), account("b", { limits: { perDay: 10 } })],
  });
  const first = await pool.send({ ...mail, to: ["x@e.com", "y@e.com"], cc: "z@e.com" });
  assert.equal(first.accountId, "a");
  const second = await pool.send(mail);
  assert.equal(second.accountId, "b");
  const usage = await pool.usage();
  assert.equal(usage[0].windows.day.used, 3);
  assert.equal(usage[0].windows.day.remaining, 0);
  assert.equal(usage[1].windows.day.used, 1);
});

test("countRecipients handles names with commas and lists", () => {
  assert.equal(countRecipients('"Doe, Jane" <jane@e.com>, bob@e.com'), 2);
  assert.equal(countRecipients(["a@e.com", { name: "B", address: "b@e.com" }]), 2);
  assert.equal(countRecipients("a@e.com, "), 1);
  assert.equal(countRecipients(undefined), 0);
});

test("parallel sends never pass a limit", async () => {
  const { createTransport, sent } = fakeTransports();
  const pool = createMailPool({
    ...quiet,
    createTransport,
    accounts: [account("a", { limits: { perDay: 5 } }), account("b", { limits: { perDay: 7 } })],
  });
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => pool.send(mail)));
  const ok = results.filter((r) => r.status === "fulfilled");
  assert.equal(ok.length, 12);
  assert.equal(sent.filter((s) => s.accountId === "a").length, 5);
  assert.equal(sent.filter((s) => s.accountId === "b").length, 7);
});

test("a connection failure falls back, gives the quota back, and cools the account down", async () => {
  const now = clock();
  const { createTransport } = fakeTransports({
    a: () => {
      throw smtpError({ code: "ESOCKET", command: "CONN", originalCode: "ECONNREFUSED" });
    },
  });
  const events = [];
  const pool = createMailPool({
    ...quiet,
    now,
    createTransport,
    onEvent: (e) => events.push(e),
    accounts: [account("a", { limits: { perDay: 5 } }), account("b", { limits: { perDay: 5 } })],
  });
  const result = await pool.send(mail);
  assert.equal(result.accountId, "b");
  assert.deepEqual(result.attempts.map((a) => [a.accountId, a.outcome]), [
    ["a", "not_sent"],
    ["b", "sent"],
  ]);
  const usage = await pool.usage();
  assert.equal(usage[0].windows.day.used, 0);
  assert.equal(usage[0].blockedUntil, now() + 30_000);
  assert.ok(events.some((e) => e.type === "blocked" && e.accountId === "a"));

  // While cooling down, "a" is skipped without a connection attempt.
  const second = await pool.send(mail);
  assert.equal(second.attempts[0].reason, "cooling_down");
  now.advance(31_000);
  const usageLater = await pool.usage();
  assert.equal(usageLater[0].blockedUntil, 0);
});

test("a login failure blocks the account; unblock clears it", async () => {
  const now = clock();
  let broken = true;
  const { createTransport } = fakeTransports({
    a: () => {
      if (broken) throw smtpError({ code: "EAUTH", responseCode: 535, command: "AUTH PLAIN" });
    },
  });
  const pool = createMailPool({
    ...quiet,
    now,
    createTransport,
    accounts: [account("a"), account("b")],
  });
  assert.equal((await pool.send(mail)).accountId, "b");
  assert.equal((await pool.usage())[0].blockedUntil, now() + 15 * 60_000);
  broken = false;
  assert.equal((await pool.send(mail)).accountId, "b");
  await pool.unblock("a");
  assert.equal((await pool.send(mail)).accountId, "a");
});

test("a provider quota error blocks the account until the daily reset", async () => {
  const now = clock(Date.UTC(2026, 10, 10, 12, 0, 0));
  const { createTransport } = fakeTransports({
    a: () => {
      throw smtpError({
        responseCode: 452,
        command: "DATA",
        response: "452 4.5.3 Daily sending quota exceeded",
      });
    },
  });
  const pool = createMailPool({
    ...quiet,
    now,
    createTransport,
    accounts: [account("a", { limits: { perDay: 300 } }), account("b")],
  });
  assert.equal((await pool.send(mail)).accountId, "b");
  const usage = (await pool.usage())[0];
  assert.equal(usage.blockedUntil, Date.UTC(2026, 10, 11, 0, 0, 0));
  assert.equal(usage.windows.day.used, 300);
  now.set(Date.UTC(2026, 10, 11, 0, 0, 1));
  const next = (await pool.usage())[0];
  assert.equal(next.blockedUntil, 0);
  assert.equal(next.windows.day.used, 0);
});

test("a rejected recipient is not retried on another account", async () => {
  const { createTransport, sent } = fakeTransports({
    a: () => {
      throw smtpError({
        code: "EENVELOPE",
        responseCode: 550,
        command: "RCPT TO",
        response: "550 5.1.1 recipient is on the suppression list",
      });
    },
  });
  const pool = createMailPool({
    ...quiet,
    createTransport,
    accounts: [account("a", { limits: { perDay: 5 } }), account("b")],
  });
  await assert.rejects(pool.send(mail), (error) => {
    assert.ok(error instanceof SendFailedError);
    assert.equal(error.reason, "recipient_rejected");
    assert.equal(error.attempts.length, 1);
    return true;
  });
  assert.equal(sent.length, 0);
  const usage = await pool.usage();
  assert.equal(usage[0].windows.day.used, 0);
  assert.equal(usage[0].blockedUntil, 0);
});

test("an unclear result is not retried by default, and keeps its quota", async () => {
  const timeout = () => {
    throw smtpError({ code: "ETIMEDOUT", command: "DATA" });
  };
  const first = fakeTransports({ a: timeout });
  const pool = createMailPool({
    ...quiet,
    createTransport: first.createTransport,
    accounts: [account("a", { limits: { perDay: 5 } }), account("b")],
  });
  await assert.rejects(pool.send(mail), (error) => {
    assert.ok(error instanceof DeliveryUnknownError);
    assert.equal(error.accountId, "a");
    return true;
  });
  assert.equal(first.sent.length, 0);
  assert.equal((await pool.usage())[0].windows.day.used, 1);

  const second = fakeTransports({ a: timeout });
  const eager = createMailPool({
    ...quiet,
    retryUnknown: true,
    createTransport: second.createTransport,
    accounts: [account("a"), account("b")],
  });
  assert.equal((await eager.send(mail)).accountId, "b");
});

test("all accounts failing gives SendFailedError with every attempt", async () => {
  const down = () => {
    throw smtpError({ code: "ESOCKET", command: "CONN", originalCode: "ECONNREFUSED" });
  };
  const { createTransport } = fakeTransports({ a: down, b: down, c: down, d: down });
  const pool = createMailPool({
    ...quiet,
    createTransport,
    accounts: [account("a"), account("b"), account("c"), account("d")],
  });
  await assert.rejects(pool.send(mail), (error) => {
    assert.ok(error instanceof SendFailedError);
    assert.equal(error.reason, "connection");
    // maxAttempts defaults to 3.
    assert.deepEqual(error.attempts.map((a) => a.accountId), ["a", "b", "c"]);
    return true;
  });
});

test("round-robin takes turns", async () => {
  const { createTransport } = fakeTransports();
  const pool = createMailPool({
    ...quiet,
    strategy: "round-robin",
    createTransport,
    accounts: [account("a"), account("b"), account("c")],
  });
  const used = [];
  for (let i = 0; i < 6; i++) used.push((await pool.send(mail)).accountId);
  assert.deepEqual(used, ["a", "b", "c", "a", "b", "c"]);
});

test("balanced picks the account with the largest share of quota left", async () => {
  const { createTransport } = fakeTransports();
  const pool = createMailPool({
    ...quiet,
    strategy: "balanced",
    createTransport,
    accounts: [account("a", { limits: { perDay: 2 } }), account("b", { limits: { perDay: 4 } })],
  });
  const used = [];
  for (let i = 0; i < 6; i++) used.push((await pool.send(mail)).accountId);
  assert.deepEqual(used, ["a", "b", "b", "a", "b", "b"]);
});

test("the day counter resets at midnight of the account's time zone", async () => {
  // 17:30 UTC is 23:30 in Dhaka.
  const now = clock(Date.UTC(2026, 10, 10, 17, 30, 0));
  const { createTransport } = fakeTransports();
  const pool = createMailPool({
    ...quiet,
    now,
    createTransport,
    accounts: [account("a", { limits: { perDay: 1 }, timezone: "Asia/Dhaka" })],
  });
  await pool.send(mail);
  await assert.rejects(pool.send(mail), (error) => {
    assert.ok(error instanceof NoCapacityError);
    assert.equal(error.retryAt, Date.UTC(2026, 10, 10, 18, 0, 0));
    return true;
  });
  now.advance(31 * 60_000);
  assert.equal((await pool.send(mail)).accountId, "a");
});

test("minute and month limits apply together", async () => {
  const now = clock();
  const { createTransport } = fakeTransports();
  const pool = createMailPool({
    ...quiet,
    now,
    createTransport,
    accounts: [account("a", { limits: { perMinute: 1, perMonth: 2 } })],
  });
  await pool.send(mail);
  await assert.rejects(pool.send(mail), NoCapacityError);
  now.advance(60_000);
  await pool.send(mail);
  now.advance(60_000);
  await assert.rejects(pool.send(mail), (error) => {
    assert.equal(error.retryAt, Date.UTC(2026, 11, 1));
    return true;
  });
});

test("idempotency: the same key is sent once", async () => {
  const { createTransport, sent } = fakeTransports();
  const pool = createMailPool({ ...quiet, createTransport, accounts: [account("a")] });
  const first = await pool.send(mail, { idempotencyKey: "otp:42:1" });
  const second = await pool.send(mail, { idempotencyKey: "otp:42:1" });
  assert.equal(sent.length, 1);
  assert.equal(second.deduplicated, true);
  assert.equal(second.messageId, first.messageId);
  await pool.send(mail, { idempotencyKey: "otp:42:2" });
  assert.equal(sent.length, 2);
});

test("idempotency: a parallel duplicate is refused, a failed send frees the key", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let fails = true;
  const { createTransport, sent } = fakeTransports({
    a: async () => {
      await gate;
    },
    b: () => {
      if (fails) throw smtpError({ code: "ESOCKET", command: "CONN", originalCode: "ECONNREFUSED" });
    },
  });
  const pool = createMailPool({
    ...quiet,
    cooldowns: { errorMs: 0 },
    createTransport,
    accounts: [account("a"), account("b")],
  });
  const running = pool.send(mail, { idempotencyKey: "k1", accounts: ["a"] });
  await assert.rejects(pool.send(mail, { idempotencyKey: "k1", accounts: ["a"] }), DuplicateSendError);
  release();
  await running;

  await assert.rejects(pool.send(mail, { idempotencyKey: "k2", accounts: ["b"] }), SendFailedError);
  fails = false;
  await pool.send(mail, { idempotencyKey: "k2", accounts: ["b"] });
  assert.equal(sent.length, 2);
});

test("from: the message wins unless the account forces its own", async () => {
  const { createTransport, sent } = fakeTransports();
  const pool = createMailPool({
    ...quiet,
    createTransport,
    defaults: { replyTo: "help@example.com" },
    accounts: [
      account("a", { limits: { perDay: 2 }, headers: { "X-Pool": "a" } }),
      account("b", { forceFrom: true }),
    ],
  });
  await pool.send(mail);
  await pool.send({ ...mail, from: "custom@example.com" });
  await pool.send({ ...mail, from: "custom@example.com" });
  assert.equal(sent[0].message.from, "no-reply@a.example.test");
  assert.equal(sent[0].message.replyTo, "help@example.com");
  assert.deepEqual(sent[0].message.headers, { "X-Pool": "a" });
  assert.equal(sent[1].message.from, "custom@example.com");
  assert.equal(sent[2].message.from, "no-reply@b.example.test");
});

test("invalid messages and options are rejected", async () => {
  const { createTransport } = fakeTransports();
  const pool = createMailPool({ ...quiet, createTransport, accounts: [account("a")] });
  await assert.rejects(pool.send({ subject: "x" }), InvalidMessageError);
  await assert.rejects(pool.send(mail, { accounts: ["nope"] }), InvalidMessageError);

  const bad = (options, pattern) =>
    assert.throws(() => createMailPool({ ...quiet, ...options }), (error) => {
      assert.ok(error instanceof ConfigError, String(error));
      assert.match(error.message, pattern);
      return true;
    });
  bad({ accounts: [] }, /at least one/);
  bad({ accounts: [account("a"), account("a")] }, /used twice/);
  bad({ accounts: [account("a", { limits: { daily: 5 } })] }, /unknown limit/);
  bad({ accounts: [account("a", { limits: { perDay: 0 } })] }, /positive/);
  bad({ accounts: [account("a", { timezone: "Mars/Olympus" })] }, /time zone/);
  bad({ accounts: [{ id: "a", preset: "nope", auth: { user: "u", pass: "p" } }] }, /unknown preset/);
  bad({ accounts: [{ id: "a", preset: "ses", auth: { user: "u", pass: "p" } }] }, /region/);
  bad({ accounts: [{ id: "a", preset: "brevo" }] }, /auth is missing/);
  bad({ accounts: [{ id: "a", preset: "brevo", auth: { pass: "p" } }] }, /auth.user/);
  bad({ accounts: [account("a")], strategy: "random" }, /strategy/);
});

test("presets fill in host, port and fixed usernames; TLS is required off localhost", () => {
  const seen = [];
  const pool = createMailPool({
    ...quiet,
    createTransport: (options) => {
      seen.push(options);
      return { sendMail: async () => ({}) };
    },
    accounts: [
      { id: "brevo", preset: "brevo", auth: { user: "u", pass: "p" }, from: "a@b.c" },
      { id: "resend", preset: "resend", auth: { pass: "re_x" }, from: "a@b.c" },
      { id: "ses", preset: "ses", region: "eu-west-1", auth: { user: "u", pass: "p" }, from: "a@b.c" },
      { id: "dev", smtp: { host: "localhost", port: 1025 }, from: "a@b.c" },
    ],
  });
  return Promise.all(pool.accountIds.map((id) => pool.send(mail, { accounts: [id] }))).then(() => {
    const byHost = Object.fromEntries(seen.map((o) => [o.host, o]));
    assert.equal(byHost["smtp-relay.brevo.com"].port, 587);
    assert.equal(byHost["smtp-relay.brevo.com"].requireTLS, true);
    assert.equal(byHost["smtp.resend.com"].secure, true);
    assert.equal(byHost["smtp.resend.com"].auth.user, "resend");
    assert.equal(byHost["email-smtp.eu-west-1.amazonaws.com"].port, 587);
    assert.equal(byHost.localhost.requireTLS, false);
    assert.equal(byHost.localhost.auth, undefined);
  });
});

test("a shared store shares limits between two pools", async () => {
  const { createTransport } = fakeTransports();
  const store = memoryStore();
  const make = () =>
    createMailPool({
      ...quiet,
      store,
      createTransport,
      accounts: [account("a", { limits: { perDay: 2 } })],
    });
  const one = make();
  const two = make();
  await one.send(mail);
  await two.send(mail);
  await assert.rejects(one.send(mail), NoCapacityError);
});

test("events never carry message content", async () => {
  const { createTransport } = fakeTransports();
  const events = [];
  const pool = createMailPool({
    ...quiet,
    createTransport,
    onEvent: (e) => events.push(e),
    accounts: [account("a")],
  });
  await pool.send({ to: "secret@example.com", subject: "S3CRET", text: "123456" });
  const dump = JSON.stringify(events);
  assert.ok(!dump.includes("secret@example.com"));
  assert.ok(!dump.includes("S3CRET"));
  assert.ok(!dump.includes("123456"));
});

test("otpMessage escapes the app name and has no links", () => {
  const message = otpMessage({ to: "u@e.com", code: "482913", appName: "A<b>&Co" });
  assert.match(message.subject, /^482913 is your/);
  assert.ok(message.html.includes("A&lt;b&gt;&amp;Co"));
  assert.ok(!/https?:/.test(message.html + message.text));
});

test("verify reports each account", async () => {
  const pool = createMailPool({
    ...quiet,
    createTransport: (_o, config) => ({
      sendMail: async () => ({}),
      verify: async () => {
        if (config.id === "b") throw new Error("Invalid login");
      },
    }),
    accounts: [account("a"), account("b")],
  });
  assert.deepEqual(await pool.verify(), [
    { accountId: "a", ok: true },
    { accountId: "b", ok: false, error: "Invalid login" },
  ]);
});

test("warns when two accounts use the same provider preset", () => {
  const warnings = [];
  createMailPool({
    logger: { warn: (m) => warnings.push(m) },
    createTransport: () => ({ sendMail: async () => ({}) }),
    accounts: [
      { id: "b1", preset: "brevo", auth: { user: "u", pass: "p" }, from: "a@b.c", limits: { perDay: 1 } },
      { id: "b2", preset: "brevo", auth: { user: "u2", pass: "p" }, from: "a@b.c", limits: { perDay: 1 } },
    ],
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /2 accounts use the "brevo" preset/);
});
