# mailquota

**A quota-aware SMTP account pool for Node.js.** It wraps
[nodemailer](https://nodemailer.com), tracks how much each account has sent, and moves
to the next account when one is out of quota or failing.

It is built for transactional email such as sign-in codes and password resets, where
one stuck provider must not stop people from logging in.

```js
import { createMailPool, otpMessage } from "mailquota";

const mailer = createMailPool({
  accounts: [
    {
      id: "brevo",
      preset: "brevo",
      auth: { user: process.env.BREVO_SMTP_USER, pass: process.env.BREVO_SMTP_KEY },
      from: "MyApp <no-reply@auth.example.com>",
      limits: { perDay: 300 },
    },
    {
      id: "resend",
      preset: "resend",
      auth: { pass: process.env.RESEND_API_KEY },
      from: "MyApp <no-reply@auth.example.com>",
      limits: { perDay: 100, perMonth: 3000 },
    },
  ],
});

await mailer.send(otpMessage({ to: "user@example.com", code: "482913", appName: "MyApp" }));
```

> Please read [RESPONSIBLE_USE.md](RESPONSIBLE_USE.md) before you use this package.
> In short: send only email people expect, follow each provider's terms, and do not
> open duplicate accounts to get around a plan limit.

## What it does

- **Tracks limits per account:** per minute, hour, day and month. Each recipient
  counts as one email.
- **Skips full accounts without a network call:** quota is checked and reserved
  before the send, so parallel sends cannot pass a limit.
- **Fails over safely:** it tries the next account only when the email was definitely
  not sent. If the result is unclear it stops, so nobody gets the same code twice.
- **Learns from provider replies:** when a provider says its quota is used up, the
  account is skipped until the next reset. A bad password or a refused connection
  puts the account on a short cooldown.
- **Does not route around rejections:** a rejected recipient or a spam rejection is
  not retried on another provider.
- **Per-account settings:** each account has its own `from`, `replyTo`, headers,
  limits, time zone and priority.
- **Shared counters:** memory, a JSON file, or Redis when several processes send.
- **No runtime dependencies** other than nodemailer, which is a peer dependency.

## Install

```sh
npm install mailquota nodemailer
```

Node.js 18.18 or later. ESM only. Works with nodemailer 6.9 and later.

## Accounts

| Field | Meaning |
|---|---|
| `id` | A unique, stable name. Counters are stored under it. |
| `preset` | A known provider (see below). Fills in host and port. |
| `region` | The region of a preset that needs one, for example `ses` or `mailgun` (`"eu"`). |
| `smtp` | `{ host, port, secure, ... }`. Overrides the preset. Extra keys go to nodemailer. |
| `auth` | `{ user, pass }`. `user` can be left out when the preset has a fixed one. |
| `from`, `replyTo` | The sender of this account. Use an address the provider has verified. |
| `forceFrom` | Always use this account's `from`, even when the message sets one. |
| `limits` | `{ perMinute, perHour, perDay, perMonth }`. Any combination. |
| `timezone` | IANA zone in which this account's day and month reset. Default: the pool's. |
| `priority` | Lower is tried first with the `priority` strategy. Default: list order. |
| `enabled` | `false` takes the account out of rotation. |
| `headers` | Headers added to every email sent through this account. |
| `transport` | A ready nodemailer transport (or anything with `sendMail`). Replaces `preset`, `smtp` and `auth`. |

**Presets:** `brevo`, `resend`, `sendgrid`, `mailgun`, `mailjet`, `smtp2go`,
`postmark`, `mailersend`, `mailtrap`, `zeptomail`, `ses`, `gmail`. A preset holds a
host and a port only. Check them against your provider's SMTP settings page, and use
`smtp: { host, port }` for any provider that is not listed.

**Limits are yours to set.** The package does not ship provider limits, because plans
change. Look up the limit of your own plan, check when it resets (many reset at
midnight UTC), and set `limits` and `timezone` to match. Setting a limit slightly
below the real one leaves room for email sent outside this package.

Connections that are not to `localhost` must use TLS: port 465 uses TLS from the start,
and other ports must upgrade with STARTTLS or the send fails.

## Pool options

```js
createMailPool({
  accounts: [...],
  strategy: "priority",      // "priority" | "round-robin" | "balanced"
  store: memoryStore(),      // or fileStore(path), redisStore(client)
  namespace: "myapp",        // key prefix when apps share a store
  timezone: "UTC",           // default reset zone for day and month limits
  defaults: { from: "MyApp <no-reply@example.com>", replyTo: "help@example.com" },
  maxAttempts: 3,            // most accounts tried for one email
  retryUnknown: false,       // see "Unclear results"
  cooldowns: { authMs: 900_000, senderMs: 900_000, rateLimitMs: 60_000, errorMs: 30_000 },
  idempotencyTtlMs: 86_400_000,
  onEvent: (event) => {},    // "sent" | "failed" | "skipped" | "blocked"
  logger: console,           // or false
});
```

**Strategies**

- `priority`: always the first account in the list that has quota. Use it to drain a
  preferred account first.
- `round-robin`: accounts take turns.
- `balanced`: the account with the largest share of its quota left goes first, so all
  accounts run down together.

## Sending

`send(message, options)` takes a nodemailer message. Attachments, headers and other
nodemailer fields pass through unchanged.

```js
const result = await mailer.send(
  { to: "user@example.com", subject: "Welcome", text: "Hello" },
  { idempotencyKey: `welcome:${userId}` },
);
// { status: "sent", accountId: "brevo", messageId: "<...>", attempts: [...] }
```

Options:

- `idempotencyKey`: a second `send` with the same key does not go out again and
  returns the first result with `deduplicated: true`.
- `accounts`: only use these account ids, in this order.

### Errors

Every error extends `MailQuotaError` and has a `code` and the list of `attempts`.

| Class | `code` | Meaning | What to do |
|---|---|---|---|
| `NoCapacityError` | `NO_CAPACITY` | Every account is full or cooling down. Nothing was sent. | Retry after `error.retryAt`, or add capacity. |
| `SendFailedError` | `SEND_FAILED` | The email was not sent. `error.reason` says why. | For `recipient_rejected` or `message_rejected`, fix the address or content. Otherwise retry later. |
| `DeliveryUnknownError` | `DELIVERY_UNKNOWN` | The connection broke after the email was handed over. It may have been sent. | Do not resend blindly. For a sign-in code, let the user press "resend". |
| `DuplicateSendError` | `DUPLICATE_IN_PROGRESS` | A send with the same idempotency key is running. | Ignore, or wait. |
| `InvalidMessageError` | `INVALID_MESSAGE` | No recipient, no sender, or an unknown account id. | Fix the call. |
| `ConfigError` | `CONFIG` | Wrong options, or nodemailer is missing. | Fix the configuration. |

### How a failure is handled

| Failure | Next account tried? | Effect on the account |
|---|---|---|
| Out of quota by the local counter | Yes | Skipped, no connection made |
| Provider says quota is used up | Yes | Skipped until the day (or month) resets |
| Provider asks to slow down | Yes | Cooldown `rateLimitMs` |
| Wrong login | Yes | Cooldown `authMs` |
| Sender address refused | Yes | Cooldown `senderMs` |
| Cannot connect, DNS, TLS, temporary 4xx | Yes | Cooldown `errorMs` |
| Recipient refused | No | None |
| Rejected as spam or by policy | No | None |
| Timeout or dropped connection mid-session | No, unless `retryUnknown` | Quota stays counted |

Quota is given back when an email was definitely not sent.

### Unclear results

nodemailer reports a silent or dropped connection the same way whether it happened
before or after the email body was transmitted. mailquota therefore treats those cases
as "may have been sent" and stops with `DeliveryUnknownError`.

Set `retryUnknown: true` to try the next account anyway. A recipient can then get the
same email twice. For sign-in codes that is usually acceptable; for receipts or
anything with side effects it usually is not.

## Stores

| Store | Survives restart | Shared between processes | Use for |
|---|---|---|---|
| `memoryStore()` (default) | No | No | One long-running process, tests |
| `fileStore("./data/mail-usage.json")` | Yes | No | One process that restarts |
| `redisStore(client)` | Yes | Yes | Several processes or servers |

```js
import Redis from "ioredis";
import { createMailPool, redisStore } from "mailquota";

const mailer = createMailPool({
  store: redisStore(new Redis(process.env.REDIS_URL)),
  namespace: "myapp",
  accounts: [...],
});
```

`redisStore` accepts an [ioredis](https://github.com/redis/ioredis) client or a
connected [node-redis](https://github.com/redis/node-redis) client. It uses Lua
scripts, so a reservation is atomic across processes. You own the client; `close()`
does not disconnect it.

With the memory store, counters start at zero after a restart. The pool still works,
because a provider that rejects for quota puts the account on hold until its reset.

To write your own store, implement the `UsageStore` interface. `reserve` and `claim`
must be atomic.

## Monitoring

```js
await mailer.usage();
// [{ accountId: "brevo", enabled: true, blockedUntil: 0,
//    windows: { day: { used: 120, limit: 300, remaining: 180, resetsAt: 1794268800000 } } }]

await mailer.verify();
// [{ accountId: "brevo", ok: true }, { accountId: "resend", ok: false, error: "Invalid login..." }]

await mailer.unblock("resend"); // clear a cooldown after fixing the password
await mailer.close();           // on shutdown
```

`onEvent` receives `sent`, `failed`, `skipped` and `blocked` events with the account
id and a reason. Events never contain recipients or message content.

## Deliverability

Failover only helps if every account can deliver. For each provider you configure:

1. Verify your sending domain and add the SPF and DKIM records it gives you.
2. Publish a DMARC record for the domain.
3. Use the same `from` domain on every account, or set a `from` per account that the
   provider has verified.
4. Keep transactional email on its own subdomain, for example `auth.example.com`.

No tool can guarantee the inbox. Short plain messages from an authenticated domain,
sent only to people who asked for them, get close.

## Limits of this package

- It sends through SMTP. It has no webhook handling for bounces or complaints.
- The `balanced` and `round-robin` orders are per process; only the counters are shared.
- Counters are estimates of what the provider counted. Email sent outside this package
  is not counted, and the provider's own number always wins.
- Presets were written from provider documentation and are not checked against live
  servers by the test suite.

## Development

```sh
npm install
npm test                                   # builds, then runs the tests
REDIS_URL=redis://127.0.0.1:6379 npm test  # also runs the Redis store tests
```

## Credits

The rule "never fall back after an unclear result" follows the design of
[mailswitch](https://github.com/me-shaon/mailswitch), a provider-switching library for
Cloudflare Workers. mailquota shares no code with it and targets a different job:
quota rotation over nodemailer in Node.js.

## License

MIT. See [LICENSE](LICENSE). Use is also subject to [RESPONSIBLE_USE.md](RESPONSIBLE_USE.md).
