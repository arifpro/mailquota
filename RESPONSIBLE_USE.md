# Responsible use

mailquota exists to keep legitimate transactional email (sign-in codes, password
resets, receipts) flowing when one provider is down or one account has reached its
limit. It is not a tool for sending more than you are allowed to, and it is not a tool
for bulk or unsolicited email.

By using this package you agree to follow the rules below. They are not legal advice.

## 1. Send only email that people expect

- Send transactional email that a person triggered themselves, or email they clearly
  agreed to receive.
- Do not send spam, purchased-list mailings, phishing, or email that pretends to be
  from someone else.
- Follow the law where you and your recipients are: for example CAN-SPAM (US), GDPR and
  ePrivacy (EU/UK), and CASL (Canada).

## 2. Follow each provider's terms

- You are responsible for reading and following the terms of service and acceptable-use
  policy of every provider you configure.
- **Do not open several accounts with one provider to get around a plan limit.** Many
  providers allow one account per person or organisation, and they close every linked
  account when they find duplicates. If you need more volume than a free plan gives,
  pay for a larger plan.
- Several accounts with one provider are fine when the provider allows it: for example
  separate paid accounts, sub-accounts the provider offers, or accounts that belong to
  different clients of yours.
- Set each account's `limits` to the real limits of your plan or lower. Never set them
  higher to "see what happens".

mailquota prints a warning when two accounts use the same provider preset, as a
reminder to check this.

## 3. Do not route around a rejection

mailquota deliberately does not retry on another account when a provider rejects:

- the recipient (unknown address, suppression list, unsubscribed, complaint), or
- the message for spam, policy or content reasons.

A provider that refuses an email for one of these reasons is protecting the recipient
or its own network. Do not change this behaviour to push the same email through a
second provider.

## 4. Respect unsubscribes, bounces and complaints

- Stop sending to addresses that hard-bounce, unsubscribe or complain. When you use
  several providers, each one keeps its own suppression list, so keep your own list
  and check it before you call `send`.
- Use real, monitored `from` and `replyTo` addresses on domains you control, with SPF,
  DKIM and DMARC set up for every provider you send through.

## 5. Protect recipients' data

- Email addresses and message contents are personal data. mailquota does not log
  them, and its events never contain them. Keep it that way in your own logging.
- The `detail` field of an error attempt holds the provider's raw error text, which can
  include an email address. Treat it as private.
- Keep SMTP passwords and API keys in environment variables or a secrets manager, never
  in source control. If you use the file store, it holds counters only, never
  credentials or addresses.

## 6. Verification codes

- Limit how often one address or one IP can request a code, so your app cannot be used
  to flood someone's inbox.
- Use short-lived, single-use codes, and never include a code in logs.

## No warranty

This software is provided "as is" under the MIT License. The authors are not
responsible for account suspensions, blocked email, lost email or any other result of
how you use it.
