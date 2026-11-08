export { createMailPool, countRecipients } from "./pool.js";
export { classify, type Classified } from "./classify.js";
export { otpMessage, type OtpMessageOptions } from "./otp.js";
export { presetNames, resolvePreset, type PresetName } from "./presets.js";
export { memoryStore, MemoryStore } from "./stores/memory.js";
export { fileStore, FileStore } from "./stores/file.js";
export { redisStore, type RedisEval, type RedisStoreOptions } from "./stores/redis.js";
export {
  MailQuotaError,
  ConfigError,
  InvalidMessageError,
  NoCapacityError,
  SendFailedError,
  DeliveryUnknownError,
  DuplicateSendError,
  type ErrorCode,
} from "./errors.js";
export type {
  AccountConfig,
  AccountUsage,
  AddressInput,
  Attempt,
  Cooldowns,
  CounterReservation,
  FailureReason,
  Limits,
  Logger,
  MailAddress,
  MailMessage,
  MailPool,
  PoolEvent,
  PoolOptions,
  SendOptions,
  SendResult,
  SmtpSettings,
  Strategy,
  Transport,
  TransportInfo,
  UsageStore,
  WindowName,
  WindowUsage,
} from "./types.js";
