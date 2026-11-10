import type { PresetName } from "./presets.js";

/** Sending limits of one account. Each recipient (to, cc, bcc) counts as one email. */
export interface Limits {
  perMinute?: number;
  perHour?: number;
  perDay?: number;
  perMonth?: number;
}

export type WindowName = "minute" | "hour" | "day" | "month";

/** Connection settings. Extra keys are passed to `nodemailer.createTransport` unchanged. */
export interface SmtpSettings {
  host: string;
  port?: number;
  /** `true` for implicit TLS (port 465). `false` uses STARTTLS. */
  secure?: boolean;
  [option: string]: unknown;
}

export interface MailAddress {
  name?: string;
  address: string;
}

export type AddressInput = string | MailAddress | Array<string | MailAddress>;

/**
 * A message. The fields are the nodemailer message fields; unknown keys
 * (attachments, headers, and so on) are passed through unchanged.
 */
export interface MailMessage {
  from?: string | MailAddress;
  to?: AddressInput;
  cc?: AddressInput;
  bcc?: AddressInput;
  replyTo?: string | MailAddress;
  subject?: string;
  text?: string;
  html?: string;
  [field: string]: unknown;
}

/** What a transport returns. This is the subset of nodemailer's `SentMessageInfo` that is used. */
export interface TransportInfo {
  messageId?: string;
  response?: string;
  accepted?: unknown[];
  rejected?: unknown[];
  [key: string]: unknown;
}

/** Anything with a nodemailer-compatible `sendMail`. A nodemailer transporter fits. */
export interface Transport {
  sendMail(message: MailMessage): Promise<TransportInfo>;
  verify?(): Promise<unknown>;
  close?(): void;
}

export interface AccountConfig {
  /** A unique name. Usage counters are stored under it, so keep it stable. */
  id: string;
  /** A known provider. Fills in the SMTP host and port. */
  preset?: PresetName;
  /** The region of a preset that needs one, for example `"us-east-1"` for `ses`. */
  region?: string;
  /** Connection settings. They override the preset. */
  smtp?: SmtpSettings;
  auth?: { user?: string; pass: string };
  /** The sender of this account. It must be an address the provider has verified. */
  from?: string | MailAddress;
  replyTo?: string | MailAddress;
  /** Always use this account's `from`, even when the message has its own. */
  forceFrom?: boolean;
  limits?: Limits;
  /** IANA time zone in which the day and month counters reset. Defaults to the pool's. */
  timezone?: string;
  /** Lower numbers are tried first with the `priority` strategy. Defaults to list order. */
  priority?: number;
  /** `false` takes the account out of rotation. */
  enabled?: boolean;
  /** Extra headers added to every message sent through this account. */
  headers?: Record<string, string>;
  /** A ready transport. When given, `preset`, `smtp` and `auth` are not used. */
  transport?: Transport;
}

export type Strategy = "priority" | "round-robin" | "balanced";

export type FailureReason =
  | "auth"
  | "connection"
  | "quota"
  | "rate_limited"
  | "sender_rejected"
  | "recipient_rejected"
  | "message_rejected"
  | "invalid_message"
  | "provider_error"
  | "timeout";

export interface Attempt {
  accountId: string;
  /** `skipped` means the account had no quota left or was cooling down; no connection was made. */
  outcome: "sent" | "not_sent" | "unknown" | "skipped";
  reason?: FailureReason | "no_quota" | "cooling_down";
  /** The provider's error text. It can hold an email address; treat it as private. */
  detail?: string;
  durationMs: number;
}

export interface SendResult {
  status: "sent";
  accountId: string;
  messageId?: string;
  response?: string;
  accepted?: unknown[];
  rejected?: unknown[];
  attempts: Attempt[];
  /** True when an earlier send with the same `idempotencyKey` already went out. */
  deduplicated?: boolean;
}

export interface SendOptions {
  /**
   * A key that identifies this email, for example `otp:<userId>:<requestId>`.
   * A second send with the same key does not go out again.
   */
  idempotencyKey?: string;
  /** Only use these accounts, in this order of preference. */
  accounts?: string[];
}

export interface Cooldowns {
  /** After a login failure. Default 15 minutes. */
  authMs?: number;
  /** After the provider said to slow down. Default 60 seconds. */
  rateLimitMs?: number;
  /** After a connection failure or a temporary provider error. Default 30 seconds. */
  errorMs?: number;
  /** After the provider rejected the sender address. Default 15 minutes. */
  senderMs?: number;
}

export type PoolEvent =
  | { type: "sent"; accountId: string; recipients: number; durationMs: number }
  | { type: "failed"; accountId: string; outcome: "not_sent" | "unknown"; reason: FailureReason }
  | { type: "skipped"; accountId: string; reason: "no_quota" | "cooling_down" }
  | { type: "blocked"; accountId: string; reason: FailureReason; until: number };

export interface Logger {
  warn(message: string): void;
}

export interface PoolOptions {
  accounts: AccountConfig[];
  /**
   * How the next account is picked.
   * - `priority` (default): the first account in the list that has quota.
   * - `round-robin`: take turns.
   * - `balanced`: the account with the largest share of its quota left.
   */
  strategy?: Strategy;
  /** Where counters live. Defaults to memory, which resets on restart. */
  store?: UsageStore;
  /** Key prefix in the store. Use one per app when apps share a store. */
  namespace?: string;
  /** Defaults for messages and accounts that have no `from` or `replyTo`. */
  defaults?: { from?: string | MailAddress; replyTo?: string | MailAddress };
  /** IANA time zone for day and month resets. Default `"UTC"`. */
  timezone?: string;
  /** The most accounts that are tried for one email. Default 3. */
  maxAttempts?: number;
  /**
   * Try the next account after a result where the email may already have gone out
   * (for example a timeout while sending the body). Default `false`, because it can
   * deliver the same email twice.
   */
  retryUnknown?: boolean;
  cooldowns?: Cooldowns;
  /** How long an idempotency key is remembered. Default 24 hours. */
  idempotencyTtlMs?: number;
  /** Called for each send, failure, skip and block. It never receives message content. */
  onEvent?: (event: PoolEvent) => void;
  /** Receives configuration warnings. Defaults to `console`. Pass `false` to silence. */
  logger?: Logger | false;
  /** Builds a transport from nodemailer options. Defaults to `nodemailer.createTransport`. */
  createTransport?: (options: Record<string, unknown>, account: AccountConfig) => Transport;
  /** The clock, in Unix milliseconds. For tests. */
  now?: () => number;
}

export interface WindowUsage {
  used: number;
  limit: number;
  remaining: number;
  /** When this counter resets, in Unix milliseconds. */
  resetsAt: number;
}

export interface AccountUsage {
  accountId: string;
  enabled: boolean;
  /** Unix milliseconds until which the account is skipped, or 0. */
  blockedUntil: number;
  windows: Partial<Record<WindowName, WindowUsage>>;
}

export interface MailPool {
  /** Sends one email through the first account that has quota and accepts it. */
  send(message: MailMessage, options?: SendOptions): Promise<SendResult>;
  /** Current counters of every account. */
  usage(): Promise<AccountUsage[]>;
  /** Checks the connection and login of every account. */
  verify(): Promise<Array<{ accountId: string; ok: boolean; error?: string }>>;
  /** Clears a cooldown early, for example after fixing a password. */
  unblock(accountId: string): Promise<void>;
  /** Closes pooled SMTP connections and the store. */
  close(): Promise<void>;
  readonly accountIds: readonly string[];
}

// ---------------------------------------------------------------------------
// Store

export interface CounterReservation {
  key: string;
  limit: number;
  amount: number;
  /** Unix milliseconds after which the counter can be deleted. */
  expiresAt: number;
}

/**
 * Persists counters, cooldowns and idempotency keys. `reserve` and `claim` must be
 * atomic, or two processes can both take the last unit of quota.
 */
export interface UsageStore {
  /** Adds `amount` to every counter, or to none when one of them would pass its limit. */
  reserve(reservations: CounterReservation[]): Promise<{ ok: true } | { ok: false; key: string }>;
  /** Gives back a reservation after an email was definitely not sent. */
  release(reservations: Array<{ key: string; amount: number }>): Promise<void>;
  /** Raises a counter to at least `value`. Used when a provider reports its quota is used up. */
  raise(key: string, value: number, expiresAt: number): Promise<void>;
  read(keys: string[]): Promise<number[]>;
  /** Stores a value under `key` until `until` (Unix milliseconds). `until <= now` deletes it. */
  setFlag(key: string, value: string, until: number): Promise<void>;
  getFlags(keys: string[]): Promise<Array<string | undefined>>;
  /** Sets `key` when it is free and returns `undefined`; otherwise returns the stored value. */
  claim(key: string, value: string, until: number): Promise<string | undefined>;
  close?(): Promise<void>;
}
