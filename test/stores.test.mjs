import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createMailPool, fileStore, memoryStore, NoCapacityError, redisStore } from "../dist/index.js";
import { account, fakeTransports } from "./helpers.mjs";

const mail = { to: "user@example.com", subject: "Hi", text: "Hello" };

/** The same checks for every store. */
async function contract(store, prefix) {
  const far = Date.now() + 60_000;
  const k = (name) => `{t:${prefix}}:${name}`;

  assert.deepEqual(await store.reserve([]), { ok: true });
  assert.deepEqual(
    await store.reserve([
      { key: k("a"), limit: 3, amount: 2, expiresAt: far },
      { key: k("b"), limit: 5, amount: 2, expiresAt: far },
    ]),
    { ok: true },
  );
  // "a" would pass its limit, so neither counter changes.
  assert.deepEqual(
    await store.reserve([
      { key: k("b"), limit: 5, amount: 2, expiresAt: far },
      { key: k("a"), limit: 3, amount: 2, expiresAt: far },
    ]),
    { ok: false, key: k("a") },
  );
  assert.deepEqual(await store.read([k("a"), k("b"), k("none")]), [2, 2, 0]);

  await store.release([{ key: k("a"), amount: 5 }, { key: k("none"), amount: 1 }]);
  assert.deepEqual(await store.read([k("a"), k("none")]), [0, 0]);

  await store.raise(k("b"), 5, far);
  await store.raise(k("b"), 1, far);
  assert.deepEqual(await store.read([k("b")]), [5]);

  await store.setFlag(k("f"), "123|auth", far);
  assert.deepEqual(await store.getFlags([k("f"), k("g")]), ["123|auth", undefined]);
  await store.setFlag(k("f"), "", 0);
  assert.deepEqual(await store.getFlags([k("f")]), [undefined]);

  assert.equal(await store.claim(k("c"), "pending", far), undefined);
  assert.equal(await store.claim(k("c"), "other", far), "pending");

  // Parallel reservations: exactly `limit` succeed.
  const results = await Promise.all(
    Array.from({ length: 25 }, () =>
      store.reserve([{ key: k("race"), limit: 10, amount: 1, expiresAt: far }]),
    ),
  );
  assert.equal(results.filter((r) => r.ok).length, 10);

  // Entries expire.
  await store.reserve([{ key: k("short"), limit: 5, amount: 1, expiresAt: Date.now() + 150 }]);
  await store.setFlag(k("shortflag"), "x", Date.now() + 150);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(await store.read([k("short")]), [0]);
  assert.deepEqual(await store.getFlags([k("shortflag")]), [undefined]);
}

test("memory store follows the store contract", async () => {
  await contract(memoryStore(), "mem");
});

test("file store follows the contract and survives a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mailquota-"));
  const path = join(dir, "nested", "usage.json");
  try {
    await contract(fileStore(path), "file");

    const { createTransport } = fakeTransports();
    const make = () =>
      createMailPool({
        logger: false,
        store: fileStore(path),
        createTransport,
        accounts: [account("a", { limits: { perDay: 2 } })],
      });
    await make().send(mail);
    await make().send(mail);
    // A new process would build a new store from the same file.
    await assert.rejects(make().send(mail), NoCapacityError);
    assert.doesNotThrow(() => JSON.parse(readFileSync(path, "utf8")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const redisUrl = process.env.REDIS_URL;
const skip = redisUrl ? false : "set REDIS_URL to run the Redis tests";

test("redis store with ioredis", { skip }, async () => {
  const { default: Redis } = await import("ioredis");
  const client = new Redis(redisUrl);
  after(() => client.disconnect());
  await contract(redisStore(client), `io${Date.now()}`);
});

test("redis store with node-redis", { skip }, async () => {
  const { createClient } = await import("redis");
  const client = createClient({ url: redisUrl });
  await client.connect();
  after(() => client.close?.() ?? client.quit());
  await contract(redisStore(client), `nr${Date.now()}`);
});

test("redis store shares limits between pools", { skip }, async () => {
  const { default: Redis } = await import("ioredis");
  const client = new Redis(redisUrl);
  after(() => client.disconnect());
  const { createTransport, sent } = fakeTransports();
  const namespace = `t${Date.now()}`;
  const make = () =>
    createMailPool({
      logger: false,
      namespace,
      store: redisStore(client),
      createTransport,
      accounts: [account("a", { limits: { perDay: 5 } }), account("b", { limits: { perDay: 3 } })],
    });
  const pools = [make(), make(), make()];
  const results = await Promise.allSettled(
    Array.from({ length: 30 }, (_, i) => pools[i % 3].send(mail)),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 8);
  assert.equal(sent.filter((s) => s.accountId === "a").length, 5);
  const usage = await pools[0].usage();
  assert.equal(usage[0].windows.day.remaining, 0);
  assert.equal(usage[1].windows.day.remaining, 0);
});
