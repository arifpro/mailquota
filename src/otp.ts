import type { MailMessage } from "./types.js";

export interface OtpMessageOptions {
  to: string;
  code: string;
  /** Shown in the subject and the body. */
  appName: string;
  /** How long the code is valid. Default 10. */
  ttlMinutes?: number;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
}

/**
 * Builds a short verification-code email with a text and an HTML part. It has no
 * links, images or tracking, which helps it reach the inbox.
 */
export function otpMessage(options: OtpMessageOptions): MailMessage {
  const { to, code, appName } = options;
  const minutes = options.ttlMinutes ?? 10;
  const ignore = "If you did not request this code, you can ignore this email.";
  return {
    to,
    subject: `${code} is your ${appName} verification code`,
    text: `Your ${appName} verification code is ${code}.\n\nIt expires in ${minutes} minutes. ${ignore}`,
    html:
      `<p>Your ${escapeHtml(appName)} verification code is:</p>` +
      `<p style="font-size:24px;font-weight:bold;letter-spacing:4px">${escapeHtml(code)}</p>` +
      `<p>It expires in ${minutes} minutes. ${ignore}</p>`,
  };
}
