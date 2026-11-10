# Contributing

Thanks for your interest in mailquota.

## Setup

```sh
npm install
npm test                                   # builds, then runs the tests
REDIS_URL=redis://127.0.0.1:6379 npm test  # also runs the Redis store tests
```

Node.js 20 or newer is recommended. CI runs Node 20, 22 and 24.

## Guidelines

- Keep changes focused. One behaviour change per pull request.
- Add or update tests in `test/` for any change to sending, failover, quota or store behaviour.
- Failover must stay conservative: never retry a message after an unclear result unless the caller opted in with `retryUnknown`.
- Update `CHANGELOG.md` under an "Unreleased" heading for user-visible changes.
- Do not add dependencies to `dependencies`. `nodemailer` is an optional peer dependency.

## Reporting bugs

Open an issue with the mailquota version, Node.js version, the store you use, and a minimal
reproduction. Remove real SMTP credentials and recipient addresses from logs before posting.

For security issues, follow [SECURITY.md](SECURITY.md) instead.
