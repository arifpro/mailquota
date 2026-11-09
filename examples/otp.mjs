// Run with: node --env-file=.env examples/otp.mjs you@example.com
//
// .env
//   MAIL_FROM="MyApp <no-reply@auth.example.com>"
//   BREVO_SMTP_USER=...
//   BREVO_SMTP_KEY=...
//   RESEND_API_KEY=re_...

import { randomInt } from "node:crypto";
import {
  createMailPool,
  DeliveryUnknownError,
  fileStore,
  NoCapacityError,
  otpMessage,
} from "mailquota";

const to = process.argv[2];
if (!to) {
  console.error("usage: node examples/otp.mjs <recipient>");
  process.exit(1);
}

const mailer = createMailPool({
  store: fileStore("./mail-usage.json"),
  defaults: { from: process.env.MAIL_FROM },
  accounts: [
    {
      id: "brevo",
      preset: "brevo",
      auth: { user: process.env.BREVO_SMTP_USER, pass: process.env.BREVO_SMTP_KEY },
      limits: { perDay: 300 },
    },
    {
      id: "resend",
      preset: "resend",
      auth: { pass: process.env.RESEND_API_KEY },
      limits: { perDay: 100, perMonth: 3000 },
    },
  ],
  onEvent: (event) => console.log("[mail]", event),
});

console.table(await mailer.verify());

const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
try {
  const result = await mailer.send(otpMessage({ to, code, appName: "MyApp" }));
  console.log(`sent through ${result.accountId}`);
} catch (error) {
  if (error instanceof NoCapacityError) {
    console.error("all accounts are full until", new Date(error.retryAt ?? 0).toISOString());
  } else if (error instanceof DeliveryUnknownError) {
    console.error("the email may have been sent; let the user ask for a new code");
  } else {
    console.error(error.code, error.message, error.attempts);
  }
}

console.dir(await mailer.usage(), { depth: 4 });
await mailer.close();
