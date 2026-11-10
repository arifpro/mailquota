import { createHash } from "node:crypto";
import { classify, namesMonth, type Classified } from "./classify.js";
import {
  ConfigError,
  DeliveryUnknownError,
  DuplicateSendError,
  InvalidMessageError,
  NoCapacityError,
  SendFailedError,
} from "./errors.js";
import { isPresetName, presetNames, resolvePreset } from "./presets.js";
import { MemoryStore } from "./stores/memory.js";
import type {
  AccountConfig,
  AccountUsage,
  Attempt,
  CounterReservation,
  FailureReason,
  Logger,
  MailMessage,
  MailPool,
  PoolEvent,
  PoolOptions,
  SendOptions,
  SendResult,
  Strategy,
  Transport,
  UsageStore,
  WindowName,
} from "./types.js";
import { assertTimeZone, LIMIT_FIELD_NAMES, periodOf, windowsOf, type Period } from "./windows.js";

const STRATEGIES: readonly Strategy[] = ["priority", "round-robin", "balanced"];
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
/** How long a counter outlives its window, so a late `release` still finds it. */
const COUNTER_GRACE_MS = 60 * 60_000;
/** How long an idempotency key stays "in progress" when the process dies mid-send. */
const PENDING_MS = 2 * 60_000;

interface Account {
  config: AccountConfig;
  id: string;
  index: number;
  timeZone: string;
  windows: Array<{ window: WindowName; limit: number }>;
  /** Options for `createTransport`, or undefined when the account brings its own transport. */
  transportOptions: Record<string, unknown> | undefined;
  transport: Promise<Transport> | undefined;
}

interface ActiveWindow {
  window: WindowName;
  limit: number;
  period: Period;
  key: string;
}

function fail(message: string): never {
  throw new ConfigError(message);
}

/** Counts the addresses in a `to`, `cc` or `bcc` value. */
export function countRecipients(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + countRecipients(item), 0);
  if (typeof value === "object") {
    return typeof (value as { address?: unknown }).address === "string" ? 1 : 0;
  }
  if (typeof value !== "string") return 0;
  // Split on commas that are not inside a quoted name or an <address>.
  let count = 0;
  let current = "";
  let quoted = false;
  let angle = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "\\" && quoted) {
      i++;
      continue;
    }
    if (char === '"') quoted = !quoted;
    else if (char === "<" && !quoted) angle = true;
    else if (char === ">" && !quoted) angle = false;
    if ((char === "," || char === ";") && !quoted && !angle) {
      if (current.trim() !== "") count++;
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim() !== "") count++;
  return count;
}

function prepareAccount(config: AccountConfig, index: number, poolZone: string): Account {
  if (typeof config !== "object" || config === null) fail(`accounts[${index}] must be an object`);
  const id = config.id;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) {
    fail(`accounts[${index}].id must be 1-64 characters of letters, digits, ".", "_" or "-"`);
  }
  const where = `account "${id}"`;

  const limits = config.limits ?? {};
  for (const [field, value] of Object.entries(limits)) {
    if (!LIMIT_FIELD_NAMES.includes(field)) {
      fail(`${where}: unknown limit "${field}". Use ${LIMIT_FIELD_NAMES.join(", ")}`);
    }
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
      fail(`${where}: limits.${field} must be a positive whole number`);
    }
  }

  const timeZone = config.timezone ?? poolZone;
  try {
    assertTimeZone(timeZone);
  } catch {
    fail(`${where}: "${timeZone}" is not a valid IANA time zone`);
  }

  let transportOptions: Record<string, unknown> | undefined;
  if (config.transport) {
    if (typeof config.transport.sendMail !== "function") {
      fail(`${where}: transport must have a sendMail function`);
    }
  } else {
    if (config.preset !== undefined && !isPresetName(config.preset)) {
      fail(`${where}: unknown preset "${String(config.preset)}". Known: ${presetNames.join(", ")}`);
    }
    let preset: ReturnType<typeof resolvePreset> | undefined;
    if (config.preset) {
      try {
        preset = resolvePreset(config.preset, config.region);
      } catch (error) {
        fail(`${where}: ${(error as Error).message}`);
      }
    }
    const smtp = { ...preset?.smtp, ...config.smtp };
    if (typeof smtp.host !== "string" || smtp.host === "") {
      fail(`${where}: give a preset, smtp.host, or a transport`);
    }
    const local = LOCAL_HOSTS.has(smtp.host);
    const secure = smtp.secure ?? smtp.port === 465;
    const user = config.auth?.user ?? preset?.user;
    if (config.auth) {
      if (typeof config.auth.pass !== "string" || config.auth.pass === "") {
        fail(`${where}: auth.pass is empty`);
      }
      if (!user) fail(`${where}: auth.user is missing`);
    } else if (!local) {
      fail(`${where}: auth is missing`);
    }
    transportOptions = {
      pool: true,
      maxConnections: 2,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      // Refuse to send credentials or mail over a connection that is not encrypted.
      requireTLS: !secure && !local,
      ...smtp,
      port: smtp.port ?? (secure ? 465 : 587),
      secure,
      ...(config.auth ? { auth: { user, pass: config.auth.pass } } : {}),
    };
  }

  return {
    config,
    id,
    index,
    timeZone,
    windows: windowsOf(limits),
    transportOptions,
    transport: config.transport ? Promise.resolve(config.transport) : undefined,
  };
}

async function nodemailerFactory(): Promise<(options: Record<string, unknown>) => Transport> {
  let loaded: { createTransport?: unknown; default?: { createTransport?: unknown } };
  try {
    loaded = await import("nodemailer");
  } catch (error) {
    throw new ConfigError(
      'nodemailer is not installed. Run "npm install nodemailer", or pass createTransport / account.transport',
    );
  }
  const create = loaded.createTransport ?? loaded.default?.createTransport;
  if (typeof create !== "function") throw new ConfigError("nodemailer.createTransport was not found");
  return create as (options: Record<string, unknown>) => Transport;
}

/** Creates a pool of sending accounts. Throws a `ConfigError` when the options are wrong. */
export function createMailPool(options: PoolOptions): MailPool {
  if (typeof options !== "object" || options === null) fail("options must be an object");
  if (!Array.isArray(options.accounts) || options.accounts.length === 0) {
    fail("accounts must be a list with at least one account");
  }
  const strategy = options.strategy ?? "priority";
  if (!STRATEGIES.includes(strategy)) fail(`strategy must be one of ${STRATEGIES.join(", ")}`);
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) fail("maxAttempts must be 1 or more");
  const namespace = options.namespace ?? "default";
  if (!ID_PATTERN.test(namespace)) fail("namespace has characters that are not allowed");
  const poolZone = options.timezone ?? "UTC";
  try {
    assertTimeZone(poolZone);
  } catch {
    fail(`"${poolZone}" is not a valid IANA time zone`);
  }

  const logger: Logger | undefined =
    options.logger === false ? undefined : (options.logger ?? console);
  const clock = options.now ?? Date.now;
  const store: UsageStore = options.store ?? new MemoryStore({ now: clock });
  const retryUnknown = options.retryUnknown === true;
  const idempotencyTtlMs = options.idempotencyTtlMs ?? 24 * 60 * 60_000;
  const cooldowns = {
    authMs: options.cooldowns?.authMs ?? 15 * 60_000,
    rateLimitMs: options.cooldowns?.rateLimitMs ?? 60_000,
    errorMs: options.cooldowns?.errorMs ?? 30_000,
    senderMs: options.cooldowns?.senderMs ?? 15 * 60_000,
  };
  for (const [name, value] of Object.entries(cooldowns)) {
    if (!Number.isFinite(value) || value < 0) fail(`cooldowns.${name} must be 0 or more`);
  }

  const accounts = options.accounts.map((config, index) => prepareAccount(config, index, poolZone));
  const byId = new Map<string, Account>();
  for (const account of accounts) {
    if (byId.has(account.id)) fail(`account id "${account.id}" is used twice`);
    byId.set(account.id, account);
    if (account.windows.length === 0) {
      logger?.warn(
        `mailquota: account "${account.id}" has no limits, so it is never skipped for quota.`,
      );
    }
    if (!account.config.from && !options.defaults?.from) {
      logger?.warn(
        `mailquota: account "${account.id}" has no from address. Every message must set one.`,
      );
    }
  }

  const presetCounts = new Map<string, number>();
  for (const account of accounts) {
    const preset = account.config.preset;
    if (preset) presetCounts.set(preset, (presetCounts.get(preset) ?? 0) + 1);
  }
  for (const [preset, count] of presetCounts) {
    if (count > 1) {
      logger?.warn(
        `mailquota: ${count} accounts use the "${preset}" preset. Many providers allow one ` +
          "account per person or organisation; opening extra accounts to get around a plan " +
          "limit can get all of them suspended. See RESPONSIBLE_USE.md.",
      );
    }
  }

  // The braces keep all keys of one namespace in one Redis Cluster slot.
  const prefix = `{mailquota:${namespace}}`;
  const counterKey = (account: Account, period: Period): string =>
    `${prefix}:c:${account.id}:${period.id}`;
  const blockKey = (account: Account): string => `${prefix}:b:${account.id}`;
  const idempotencyKey = (key: string): string =>
    `${prefix}:i:${createHash("sha256").update(key).digest("hex")}`;

  let factory: Promise<(options: Record<string, unknown>, account: AccountConfig) => Transport> | undefined;
  let cursor = 0;
  let closed = false;

  function emit(event: PoolEvent): void {
    if (!options.onEvent) return;
    try {
      options.onEvent(event);
    } catch {
      // A broken listener must not break a send.
    }
  }

  function transportOf(account: Account): Promise<Transport> {
    if (!account.transport) {
      factory ??= options.createTransport
        ? Promise.resolve(options.createTransport)
        : nodemailerFactory();
      const pending = factory.then((create) =>
        create(account.transportOptions ?? {}, account.config),
      );
      // A failed creation is not cached, so a later send can try again.
      pending.catch(() => {
        if (account.transport === pending) account.transport = undefined;
      });
      account.transport = pending;
    }
    return account.transport;
  }

  function activeWindows(account: Account, now: number): ActiveWindow[] {
    return account.windows.map(({ window, limit }) => {
      const period = periodOf(window, now, account.timeZone);
      return { window, limit, period, key: counterKey(account, period) };
    });
  }

  function parseBlock(flag: string | undefined, now: number): number {
    if (!flag) return 0;
    const until = Number(flag.split("|", 1)[0]);
    return Number.isFinite(until) && until > now ? until : 0;
  }

  async function block(account: Account, reason: FailureReason, until: number): Promise<void> {
    if (until <= clock()) return;
    await store.setFlag(blockKey(account), `${until}|${reason}`, until);
    emit({ type: "blocked", accountId: account.id, reason, until });
  }

  /** Takes a failing account out of rotation for a while. */
  async function penalize(
    account: Account,
    result: Classified,
    detail: string,
    now: number,
  ): Promise<void> {
    switch (result.reason) {
      case "auth":
        return block(account, result.reason, now + cooldowns.authMs);
      case "sender_rejected":
        return block(account, result.reason, now + cooldowns.senderMs);
      case "rate_limited":
        return block(account, result.reason, now + cooldowns.rateLimitMs);
      case "connection":
      case "provider_error":
        return block(account, result.reason, now + cooldowns.errorMs);
      case "quota": {
        // The provider says the quota is used up, whatever the local counter says.
        // Trust the provider: skip the account until that window resets.
        const window: WindowName = namesMonth(detail) ? "month" : "day";
        const period = periodOf(window, now, account.timeZone);
        const configured = account.windows.find((w) => w.window === window);
        if (configured) {
          await store.raise(
            counterKey(account, period),
            configured.limit,
            period.resetsAt + COUNTER_GRACE_MS,
          );
        }
        return block(account, result.reason, period.resetsAt);
      }
      default:
        // The message or the recipient was the problem, not the account.
        return;
    }
  }

  async function ordered(usable: Account[], now: number, fixedOrder: boolean): Promise<Account[]> {
    if (fixedOrder || usable.length < 2) return usable;
    if (strategy === "priority") {
      return [...usable].sort(
        (a, b) => (a.config.priority ?? 0) - (b.config.priority ?? 0) || a.index - b.index,
      );
    }
    if (strategy === "round-robin") {
      const start = cursor++ % usable.length;
      return [...usable.slice(start), ...usable.slice(0, start)];
    }
    // balanced: the account with the largest share of quota left goes first.
    const windows = usable.map((account) => activeWindows(account, now));
    const used = await store.read(windows.flat().map((w) => w.key));
    let offset = 0;
    const share = new Map<Account, number>();
    usable.forEach((account, i) => {
      let lowest = 1;
      for (const w of windows[i] ?? []) {
        lowest = Math.min(lowest, Math.max(0, w.limit - (used[offset++] ?? 0)) / w.limit);
      }
      share.set(account, lowest);
    });
    return [...usable].sort(
      (a, b) => (share.get(b) ?? 0) - (share.get(a) ?? 0) || a.index - b.index,
    );
  }

  function compose(account: Account, message: MailMessage): MailMessage {
    const config = account.config;
    const from = config.forceFrom
      ? (config.from ?? message.from ?? options.defaults?.from)
      : (message.from ?? config.from ?? options.defaults?.from);
    if (!from) {
      throw new InvalidMessageError(
        `no from address: set message.from, account "${account.id}".from, or defaults.from`,
      );
    }
    const replyTo = message.replyTo ?? config.replyTo ?? options.defaults?.replyTo;
    const headers =
      config.headers || message.headers
        ? { ...config.headers, ...(message.headers as Record<string, unknown> | undefined) }
        : undefined;
    return {
      ...message,
      from,
      ...(replyTo ? { replyTo } : {}),
      ...(headers ? { headers } : {}),
    };
  }

  async function deliver(message: MailMessage, sendOptions: SendOptions): Promise<SendResult> {
    const recipients =
      countRecipients(message.to) + countRecipients(message.cc) + countRecipients(message.bcc);
    if (recipients === 0) throw new InvalidMessageError("the message has no recipient");

    let candidates = accounts.filter((account) => account.config.enabled !== false);
    const fixedOrder = sendOptions.accounts !== undefined;
    if (sendOptions.accounts) {
      candidates = sendOptions.accounts.map((id) => {
        const account = byId.get(id);
        if (!account) throw new InvalidMessageError(`unknown account "${id}"`);
        return account;
      });
    }

    const now = clock();
    const attempts: Attempt[] = [];
    let retryAt: number | undefined;
    const later = (time: number): void => {
      retryAt = retryAt === undefined ? time : Math.min(retryAt, time);
    };

    const flags = await store.getFlags(candidates.map(blockKey));
    const usable: Account[] = [];
    candidates.forEach((account, i) => {
      const until = parseBlock(flags[i], now);
      if (until === 0) {
        usable.push(account);
        return;
      }
      later(until);
      attempts.push({ accountId: account.id, outcome: "skipped", reason: "cooling_down", durationMs: 0 });
      emit({ type: "skipped", accountId: account.id, reason: "cooling_down" });
    });

    let tried = 0;
    let lastFailure: { result: Classified; error: unknown; accountId: string } | undefined;
    let unknownAccount: string | undefined;

    for (const account of await ordered(usable, now, fixedOrder)) {
      if (tried >= maxAttempts) break;
      const outgoing = compose(account, message);

      const windows = activeWindows(account, now);
      const reservations: CounterReservation[] = windows.map((w) => ({
        key: w.key,
        limit: w.limit,
        amount: recipients,
        expiresAt: w.period.resetsAt + COUNTER_GRACE_MS,
      }));
      // Quota is taken before the send, so two parallel sends cannot both use the last unit.
      const reserved = await store.reserve(reservations);
      if (!reserved.ok) {
        const full = windows.find((w) => w.key === reserved.key);
        if (full) later(full.period.resetsAt);
        attempts.push({ accountId: account.id, outcome: "skipped", reason: "no_quota", durationMs: 0 });
        emit({ type: "skipped", accountId: account.id, reason: "no_quota" });
        continue;
      }

      tried++;
      const started = clock();
      try {
        const transport = await transportOf(account);
        const info = await transport.sendMail(outgoing);
        const durationMs = clock() - started;
        const refused = Array.isArray(info.rejected) ? info.rejected.length : 0;
        if (refused > 0) {
          // Recipients that the server refused did not use quota.
          await store.release(
            reservations.map((r) => ({ key: r.key, amount: Math.min(refused, recipients) })),
          );
        }
        attempts.push({ accountId: account.id, outcome: "sent", durationMs });
        emit({ type: "sent", accountId: account.id, recipients, durationMs });
        return {
          status: "sent",
          accountId: account.id,
          ...(info.messageId ? { messageId: info.messageId } : {}),
          ...(info.response ? { response: info.response } : {}),
          ...(info.accepted ? { accepted: info.accepted } : {}),
          ...(info.rejected ? { rejected: info.rejected } : {}),
          attempts,
        };
      } catch (error) {
        if (error instanceof ConfigError) throw error;
        const result = classify(error);
        const detail = String((error as { message?: unknown })?.message ?? error).slice(0, 300);
        attempts.push({
          accountId: account.id,
          outcome: result.outcome,
          reason: result.reason,
          detail,
          durationMs: clock() - started,
        });
        emit({ type: "failed", accountId: account.id, outcome: result.outcome, reason: result.reason });

        if (result.outcome === "unknown") {
          // The quota stays reserved: the provider may have counted the email.
          unknownAccount = account.id;
          if (!retryUnknown) throw new DeliveryUnknownError(account.id, attempts, error);
          continue;
        }

        await store.release(reservations.map((r) => ({ key: r.key, amount: r.amount })));
        await penalize(account, result, detail, clock());
        lastFailure = { result, error, accountId: account.id };
        if (!result.fallback) {
          throw new SendFailedError(
            result.reason,
            `account "${account.id}" rejected the email (${result.reason}); no other account was tried`,
            attempts,
            error,
          );
        }
      }
    }

    if (unknownAccount) throw new DeliveryUnknownError(unknownAccount, attempts, lastFailure?.error);
    if (lastFailure) {
      throw new SendFailedError(
        lastFailure.result.reason,
        `the email was not sent: ${tried} account(s) tried, last failure "${lastFailure.result.reason}" on "${lastFailure.accountId}"`,
        attempts,
        lastFailure.error,
      );
    }
    throw new NoCapacityError(attempts, retryAt);
  }

  async function send(message: MailMessage, sendOptions: SendOptions = {}): Promise<SendResult> {
    if (closed) throw new ConfigError("the pool is closed");
    if (typeof message !== "object" || message === null) {
      throw new InvalidMessageError("the message must be an object");
    }
    const key = sendOptions.idempotencyKey;
    if (key === undefined) return deliver(message, sendOptions);
    if (typeof key !== "string" || key === "") {
      throw new InvalidMessageError("idempotencyKey must be a non-empty string");
    }

    const stored = idempotencyKey(key);
    const existing = await store.claim(stored, "pending", clock() + PENDING_MS);
    if (existing !== undefined) {
      if (existing.startsWith("sent|")) {
        const saved = JSON.parse(existing.slice(5)) as { accountId: string; messageId?: string };
        return { status: "sent", ...saved, attempts: [], deduplicated: true };
      }
      if (existing.startsWith("unknown|")) {
        throw new DeliveryUnknownError(existing.slice(8), []);
      }
      throw new DuplicateSendError();
    }

    try {
      const result = await deliver(message, sendOptions);
      await store.setFlag(
        stored,
        `sent|${JSON.stringify({ accountId: result.accountId, messageId: result.messageId })}`,
        clock() + idempotencyTtlMs,
      );
      return result;
    } catch (error) {
      if (error instanceof DeliveryUnknownError) {
        // Remember it, so a retry with the same key does not send a second copy.
        await store.setFlag(stored, `unknown|${error.accountId}`, clock() + idempotencyTtlMs);
      } else {
        await store.setFlag(stored, "", 0);
      }
      throw error;
    }
  }

  async function usage(): Promise<AccountUsage[]> {
    const now = clock();
    const windows = accounts.map((account) => activeWindows(account, now));
    const [used, flags] = await Promise.all([
      store.read(windows.flat().map((w) => w.key)),
      store.getFlags(accounts.map(blockKey)),
    ]);
    let offset = 0;
    return accounts.map((account, i) => {
      const report: AccountUsage = {
        accountId: account.id,
        enabled: account.config.enabled !== false,
        blockedUntil: parseBlock(flags[i], now),
        windows: {},
      };
      for (const w of windows[i] ?? []) {
        const count = used[offset++] ?? 0;
        report.windows[w.window] = {
          used: count,
          limit: w.limit,
          remaining: Math.max(0, w.limit - count),
          resetsAt: w.period.resetsAt,
        };
      }
      return report;
    });
  }

  async function verify(): Promise<Array<{ accountId: string; ok: boolean; error?: string }>> {
    return Promise.all(
      accounts.map(async (account) => {
        try {
          const transport = await transportOf(account);
          await transport.verify?.();
          return { accountId: account.id, ok: true };
        } catch (error) {
          return {
            accountId: account.id,
            ok: false,
            error: String((error as { message?: unknown })?.message ?? error),
          };
        }
      }),
    );
  }

  async function unblock(accountId: string): Promise<void> {
    const account = byId.get(accountId);
    if (!account) throw new ConfigError(`unknown account "${accountId}"`);
    await store.setFlag(blockKey(account), "", 0);
  }

  async function close(): Promise<void> {
    closed = true;
    for (const account of accounts) {
      if (!account.transport) continue;
      try {
        (await account.transport).close?.();
      } catch {
        // Closing is best effort.
      }
    }
    await store.close?.();
  }

  return {
    send,
    usage,
    verify,
    unblock,
    close,
    accountIds: accounts.map((account) => account.id),
  };
}
