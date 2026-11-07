import type { FailureReason } from "./types.js";

export interface Classified {
  /** `not_sent`: the provider did not take the email. `unknown`: it may have. */
  outcome: "not_sent" | "unknown";
  reason: FailureReason;
  /** Whether another account may be tried for the same email. */
  fallback: boolean;
}

interface SmtpLikeError {
  code?: unknown;
  originalCode?: unknown;
  timeoutType?: unknown;
  command?: unknown;
  responseCode?: unknown;
  response?: unknown;
  message?: unknown;
}

const AUTH_CODES = new Set([530, 534, 535, 538]);

/** SMTP commands that come before the message body. A failure here cannot have sent anything. */
const BEFORE_BODY = /^(EHLO|HELO|LHLO|STARTTLS|MAIL FROM|RCPT TO)\b/;

/** Operating-system errors of a connection that was never opened. */
const NEVER_CONNECTED =
  /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|EADDRNOTAVAIL|^connect E|^getaddrinfo /;

/** nodemailer timeouts that end before the session starts. A plain socket timeout is not one. */
const SETUP_TIMEOUT =
  /CONNECT_TIMEOUT|GREETING_TIMEOUT|UPGRADE_TIMEOUT|^Connection timeout|^Greeting never received|^TLS handshake timed out/;

/** The provider names a period or a quota: the account is used up until a reset. */
const QUOTA = /quota|credit|dai?ly|per day|24 hours|monthly|per month/i;

/** The recipient's own mailbox is full or unavailable (enhanced status 5.2.x / 4.2.x). */
const RECIPIENT_MAILBOX = /mailbox|inbox|\b[45]\.2\.\d\b/i;

/** The provider asks for a pause. */
const RATE =
  /rate.?limit|too many (requests|connections|concurrent|messages|emails)|throttl|slow down|try again (later|in)|limit (exceeded|reached)|exceeded.{0,40}limit/i;

/**
 * A rejection about the content, the recipient's wishes or the sender's reputation.
 * Another provider must not be used to get around it.
 */
const POLICY = /spam|policy|content|block|blacklist|blocklist|suppress|unsubscrib|complain|abuse/i;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** True when the provider's error text names a monthly period. */
export function namesMonth(detail: string): boolean {
  return /month/i.test(detail);
}

const notSent = (reason: FailureReason, fallback: boolean): Classified => ({
  outcome: "not_sent",
  reason,
  fallback,
});

/**
 * Sorts a transport error into "definitely not sent" or "maybe sent", with a reason.
 * It reads the fields that nodemailer sets: `code`, `command`, `responseCode`,
 * `response`, `originalCode` and `timeoutType`.
 *
 * When in doubt the answer is `unknown`. nodemailer reports a dropped or silent
 * connection the same way before and after the message body, so those cases cannot
 * be told apart and are never called "not sent".
 */
export function classify(error: unknown): Classified {
  const e: SmtpLikeError = typeof error === "object" && error !== null ? error : {};
  const code = text(e.code);
  const command = text(e.command).toUpperCase();
  const status = typeof e.responseCode === "number" ? e.responseCode : 0;
  const message = text(e.message);
  const detail = `${text(e.response)} ${message}`;

  if (code === "EAUTH" || command.startsWith("AUTH") || AUTH_CODES.has(status)) {
    return notSent("auth", true);
  }

  if (status >= 400) {
    // The server answered with an error, so it did not accept the email.
    if (RECIPIENT_MAILBOX.test(detail)) {
      // "Mailbox over quota" is about the recipient's inbox, not about this account.
      return notSent("recipient_rejected", false);
    }
    if (QUOTA.test(detail)) return notSent("quota", true);
    if (RATE.test(detail)) return notSent("rate_limited", true);
    if (status < 500) return notSent("provider_error", true);
    if (command.startsWith("MAIL FROM")) return notSent("sender_rejected", true);
    if (command.startsWith("RCPT TO") || code === "EENVELOPE") {
      return notSent("recipient_rejected", false);
    }
    if (command.startsWith("DATA") || code === "EMESSAGE") {
      return notSent("message_rejected", !POLICY.test(detail));
    }
    return notSent("provider_error", !POLICY.test(detail));
  }

  // No server answer from here on.
  if (code === "EMESSAGE") return notSent("invalid_message", false);
  if (code === "EDNS" || code === "ETLS" || BEFORE_BODY.test(command)) {
    return notSent("connection", true);
  }
  if (NEVER_CONNECTED.test(`${code} ${text(e.originalCode)}`) || NEVER_CONNECTED.test(message)) {
    return notSent("connection", true);
  }
  if (code === "ETIMEDOUT" && (SETUP_TIMEOUT.test(text(e.timeoutType)) || SETUP_TIMEOUT.test(message))) {
    return notSent("connection", true);
  }

  return { outcome: "unknown", reason: "timeout", fallback: false };
}
