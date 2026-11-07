import type { CounterReservation, UsageStore } from "../types.js";

/** Runs a Lua script. This is the only Redis operation the store needs. */
export type RedisEval = (
  script: string,
  keys: string[],
  args: string[],
) => Promise<unknown>;

export interface RedisStoreOptions {
  /** Which client library `client` is. Detected when omitted. */
  dialect?: "ioredis" | "node-redis";
}

// Each script changes all of its keys or none, which is what makes quota safe when
// several processes send at once.

const RESERVE = `
for i = 1, #KEYS do
  local used = tonumber(redis.call('GET', KEYS[i]) or '0')
  if used + tonumber(ARGV[i * 3 - 1]) > tonumber(ARGV[i * 3 - 2]) then
    return i
  end
end
for i = 1, #KEYS do
  redis.call('INCRBY', KEYS[i], ARGV[i * 3 - 1])
  redis.call('PEXPIREAT', KEYS[i], ARGV[i * 3])
end
return 0`;

const RELEASE = `
for i = 1, #KEYS do
  local used = tonumber(redis.call('GET', KEYS[i]) or '0')
  local amount = math.min(used, tonumber(ARGV[i]))
  if amount > 0 then redis.call('DECRBY', KEYS[i], amount) end
end
return 0`;

const RAISE = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used < tonumber(ARGV[1]) then redis.call('SET', KEYS[1], ARGV[1]) end
redis.call('PEXPIREAT', KEYS[1], ARGV[2])
return 0`;

const MGET = `return redis.call('MGET', unpack(KEYS))`;

const SET_FLAG = `
redis.call('SET', KEYS[1], ARGV[1])
redis.call('PEXPIREAT', KEYS[1], ARGV[2])
return 0`;

const DELETE = `return redis.call('DEL', KEYS[1])`;

const CLAIM = `
local found = redis.call('GET', KEYS[1])
if found then return found end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('PEXPIREAT', KEYS[1], ARGV[2])
return false`;

interface ClientShape {
  eval?: unknown;
  defineCommand?: unknown;
  sendCommand?: unknown;
}

function evalOf(client: unknown, dialect: RedisStoreOptions["dialect"]): RedisEval {
  if (typeof client === "function") return client as RedisEval;
  const shape = (client ?? {}) as ClientShape;
  if (typeof shape.eval !== "function") {
    throw new TypeError("mailquota: redisStore needs an ioredis or node-redis client");
  }
  const run = shape.eval.bind(client) as (...values: unknown[]) => Promise<unknown>;
  const kind = dialect ?? (typeof shape.defineCommand === "function" ? "ioredis" : "node-redis");
  if (kind === "ioredis") {
    return (script, keys, args) => run(script, keys.length, ...keys, ...args);
  }
  return (script, keys, args) => run(script, { keys, arguments: args });
}

class RedisStore implements UsageStore {
  constructor(private readonly run: RedisEval) {}

  async reserve(
    reservations: CounterReservation[],
  ): Promise<{ ok: true } | { ok: false; key: string }> {
    if (reservations.length === 0) return { ok: true };
    const keys = reservations.map((r) => r.key);
    const args = reservations.flatMap((r) => [
      String(r.limit),
      String(r.amount),
      String(Math.ceil(r.expiresAt)),
    ]);
    const failed = Number(await this.run(RESERVE, keys, args));
    if (failed === 0) return { ok: true };
    return { ok: false, key: keys[failed - 1] ?? "" };
  }

  async release(reservations: Array<{ key: string; amount: number }>): Promise<void> {
    if (reservations.length === 0) return;
    await this.run(
      RELEASE,
      reservations.map((r) => r.key),
      reservations.map((r) => String(r.amount)),
    );
  }

  async raise(key: string, value: number, expiresAt: number): Promise<void> {
    await this.run(RAISE, [key], [String(value), String(Math.ceil(expiresAt))]);
  }

  private async values(keys: string[]): Promise<unknown[]> {
    if (keys.length === 0) return [];
    const reply = await this.run(MGET, keys, []);
    return Array.isArray(reply) ? reply : [];
  }

  async read(keys: string[]): Promise<number[]> {
    const reply = await this.values(keys);
    return keys.map((_, i) => Number(reply[i] ?? 0) || 0);
  }

  async setFlag(key: string, value: string, until: number): Promise<void> {
    if (until <= Date.now()) await this.run(DELETE, [key], []);
    else await this.run(SET_FLAG, [key], [value, String(Math.ceil(until))]);
  }

  async getFlags(keys: string[]): Promise<Array<string | undefined>> {
    const reply = await this.values(keys);
    return keys.map((_, i) => {
      const value = reply[i];
      return value === null || value === undefined ? undefined : String(value);
    });
  }

  async claim(key: string, value: string, until: number): Promise<string | undefined> {
    const found = await this.run(CLAIM, [key], [value, String(Math.ceil(until))]);
    return found === null || found === undefined || found === false ? undefined : String(found);
  }
}

/**
 * Keeps counters in Redis, shared by every process that sends. Pass a connected
 * ioredis or node-redis client, or a function that runs a Lua script.
 * The store does not close the client; you own it.
 */
export function redisStore(client: unknown, options: RedisStoreOptions = {}): UsageStore {
  return new RedisStore(evalOf(client, options.dialect));
}
