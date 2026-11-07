import type { Attempt, FailureReason } from "./types.js";

export type ErrorCode =
  | "CONFIG"
  | "INVALID_MESSAGE"
  | "NO_CAPACITY"
  | "SEND_FAILED"
  | "DELIVERY_UNKNOWN"
  | "DUPLICATE_IN_PROGRESS";

/** The base class of every error this package throws. */
export class MailQuotaError extends Error {
  readonly code: ErrorCode;
  /** What happened on each account, in order. */
  readonly attempts: Attempt[];

  constructor(code: ErrorCode, message: string, attempts: Attempt[] = [], cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.code = code;
    this.attempts = attempts;
  }
}

/** The pool options are wrong. Thrown by `createMailPool`. */
export class ConfigError extends MailQuotaError {
  constructor(message: string) {
    super("CONFIG", `mailquota: ${message}`);
  }
}

/** The message cannot be sent by any account, for example it has no recipient. */
export class InvalidMessageError extends MailQuotaError {
  constructor(message: string) {
    super("INVALID_MESSAGE", `mailquota: ${message}`);
  }
}

/** Every account is out of quota or cooling down. Nothing was sent. */
export class NoCapacityError extends MailQuotaError {
  /** The earliest time an account becomes usable again, in Unix milliseconds, when known. */
  readonly retryAt: number | undefined;

  constructor(attempts: Attempt[], retryAt: number | undefined) {
    super("NO_CAPACITY", "mailquota: no account has sending capacity right now", attempts);
    this.retryAt = retryAt;
  }
}

/** The email was not sent. `reason` is the failure of the last account that was tried. */
export class SendFailedError extends MailQuotaError {
  readonly reason: FailureReason;

  constructor(reason: FailureReason, message: string, attempts: Attempt[], cause?: unknown) {
    super("SEND_FAILED", `mailquota: ${message}`, attempts, cause);
    this.reason = reason;
  }
}

/**
 * The connection broke after the email body was handed over, so the email may or may
 * not have gone out. Sending it again can deliver it twice.
 */
export class DeliveryUnknownError extends MailQuotaError {
  readonly accountId: string;

  constructor(accountId: string, attempts: Attempt[], cause?: unknown) {
    super(
      "DELIVERY_UNKNOWN",
      `mailquota: account "${accountId}" may or may not have sent the email`,
      attempts,
      cause,
    );
    this.accountId = accountId;
  }
}

/** Another send with the same idempotency key is still running. */
export class DuplicateSendError extends MailQuotaError {
  constructor() {
    super("DUPLICATE_IN_PROGRESS", "mailquota: a send with this idempotency key is in progress");
  }
}
