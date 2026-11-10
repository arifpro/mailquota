// These tests use the real nodemailer against a small local SMTP server, so they check
// that real nodemailer errors are classified the way the pool expects.

import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  createMailPool,
  DeliveryUnknownError,
  SendFailedError,
} from "../dist/index.js";
import { smtpServer } from "./helpers.mjs";

const servers = [];
const pools = [];
after(async () => {
  for (const pool of pools) await pool.close();
  for (const server of servers) await server.close();
});

async function setup(scriptA, extra = {}) {
  const a = await smtpServer(scriptA);
  const b = await smtpServer();
  servers.push(a, b);
  const local = (id, port) => ({
    id,
    smtp: { host: "127.0.0.1", port, socketTimeout: 1500 },
    auth: { user: "u", pass: "p" },
    from: `no-reply@${id}.test`,
    limits: { perDay: 10 },
  });
  const pool = createMailPool({
    logger: false,
    accounts: [local("a", a.port), local("b", b.port)],
    ...extra,
  });
  pools.push(pool);
  return { pool, a, b };
}

const mail = { to: "user@example.com", subject: "Code", text: "123456" };

test("nodemailer: a normal send goes through the first account", async () => {
  const { pool, a, b } = await setup({});
  const result = await pool.send(mail);
  assert.equal(result.accountId, "a");
  assert.match(result.response, /queued/);
  assert.equal(a.received.length, 1);
  assert.equal(b.received.length, 0);
  assert.match(a.received[0], /From: no-reply@a\.test/);
});

test("nodemailer: a login failure falls back and blocks the account", async () => {
  const { pool, b } = await setup({ auth: "535 5.7.8 Authentication failed" });
  const result = await pool.send(mail);
  assert.equal(result.accountId, "b");
  assert.equal(result.attempts[0].reason, "auth");
  assert.equal(b.received.length, 1);
  assert.ok((await pool.usage())[0].blockedUntil > Date.now());
});

test("nodemailer: a quota reply falls back and blocks until the reset", async () => {
  const { pool } = await setup({ mailFrom: "452 4.5.3 Daily sending quota exceeded" });
  const result = await pool.send(mail);
  assert.equal(result.accountId, "b");
  assert.equal(result.attempts[0].reason, "quota");
  const usage = (await pool.usage())[0];
  assert.equal(usage.windows.day.used, 10);
  assert.equal(usage.blockedUntil, usage.windows.day.resetsAt);
});

test("nodemailer: a rejected sender falls back", async () => {
  const { pool } = await setup({ mailFrom: "550 5.7.1 Sender address not verified" });
  const result = await pool.send(mail);
  assert.equal(result.accountId, "b");
  assert.equal(result.attempts[0].reason, "sender_rejected");
});

test("nodemailer: a rejected recipient stops without trying another account", async () => {
  const { pool, b } = await setup({ rcptTo: "550 5.1.1 No such user" });
  await assert.rejects(pool.send(mail), (error) => {
    assert.ok(error instanceof SendFailedError);
    assert.equal(error.reason, "recipient_rejected");
    return true;
  });
  assert.equal(b.received.length, 0);
});

test("nodemailer: a spam rejection of the body stops without trying another account", async () => {
  const { pool, b } = await setup({ data: "554 5.7.1 Message rejected as spam" });
  await assert.rejects(pool.send(mail), (error) => {
    assert.ok(error instanceof SendFailedError);
    assert.equal(error.reason, "message_rejected");
    return true;
  });
  assert.equal(b.received.length, 0);
});

test("nodemailer: a server that goes silent after the body gives DeliveryUnknownError", async () => {
  const { pool, b } = await setup({ hangOnData: true });
  await assert.rejects(pool.send(mail), DeliveryUnknownError);
  assert.equal(b.received.length, 0);
  assert.equal((await pool.usage())[0].windows.day.used, 1);
});

test("nodemailer: a closed port falls back", async () => {
  const a = await smtpServer();
  const b = await smtpServer();
  servers.push(b);
  const deadPort = a.port;
  await a.close();
  const pool = createMailPool({
    logger: false,
    accounts: [
      { id: "a", smtp: { host: "127.0.0.1", port: deadPort }, auth: { user: "u", pass: "p" }, from: "a@a.test" },
      { id: "b", smtp: { host: "127.0.0.1", port: b.port }, auth: { user: "u", pass: "p" }, from: "b@b.test" },
    ],
  });
  pools.push(pool);
  const result = await pool.send(mail);
  assert.equal(result.accountId, "b");
  assert.equal(result.attempts[0].reason, "connection");
  const check = await pool.verify();
  assert.equal(check[0].ok, false);
  assert.equal(check[1].ok, true);
});
