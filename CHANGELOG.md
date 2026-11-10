# Changelog

## 0.1.0

First release.

- Account pool over nodemailer with per-minute, per-hour, per-day and per-month limits.
- `priority`, `round-robin` and `balanced` strategies.
- Failover on definite failures only; `retryUnknown` to opt in to retrying unclear results.
- Cooldowns after login, sender, rate-limit and connection failures.
- Memory, file and Redis stores.
- Idempotency keys.
- `usage()`, `verify()`, `unblock()` and events.
- `otpMessage()` helper.
