import type { SmtpSettings } from "./types.js";

interface Preset {
  /** The host, or a function of the region. */
  host: string | ((region: string | undefined) => string);
  port: number;
  secure: boolean;
  /** The SMTP username when the provider uses a fixed one. */
  user?: string;
  /** True when `region` is required. */
  needsRegion?: boolean;
}

// Hosts and ports only. Limits are not listed here on purpose: free-plan limits change,
// and the limit that applies is the one of your own plan. Set `limits` per account.
const PRESETS = {
  brevo: { host: "smtp-relay.brevo.com", port: 587, secure: false },
  resend: { host: "smtp.resend.com", port: 465, secure: true, user: "resend" },
  sendgrid: { host: "smtp.sendgrid.net", port: 587, secure: false, user: "apikey" },
  mailgun: {
    host: (region) => (region === "eu" ? "smtp.eu.mailgun.org" : "smtp.mailgun.org"),
    port: 587,
    secure: false,
  },
  mailjet: { host: "in-v3.mailjet.com", port: 587, secure: false },
  smtp2go: { host: "mail.smtp2go.com", port: 587, secure: false },
  postmark: { host: "smtp.postmarkapp.com", port: 587, secure: false },
  mailersend: { host: "smtp.mailersend.net", port: 587, secure: false },
  mailtrap: { host: "live.smtp.mailtrap.io", port: 587, secure: false },
  zeptomail: { host: "smtp.zeptomail.com", port: 587, secure: false },
  ses: {
    host: (region) => `email-smtp.${region}.amazonaws.com`,
    port: 587,
    secure: false,
    needsRegion: true,
  },
  gmail: { host: "smtp.gmail.com", port: 465, secure: true },
} satisfies Record<string, Preset>;

export type PresetName = keyof typeof PRESETS;

export const presetNames = Object.keys(PRESETS) as PresetName[];

export function isPresetName(value: unknown): value is PresetName {
  return typeof value === "string" && Object.hasOwn(PRESETS, value);
}

/** The SMTP settings and fixed username of a preset. Throws when a needed region is missing. */
export function resolvePreset(
  name: PresetName,
  region?: string,
): { smtp: SmtpSettings; user?: string } {
  const preset: Preset = PRESETS[name];
  if (preset.needsRegion && !region) {
    throw new TypeError(`preset "${name}" needs a region`);
  }
  if (region !== undefined && !/^[a-z0-9-]+$/.test(region)) {
    throw new TypeError(`region "${region}" is not valid`);
  }
  const host = typeof preset.host === "function" ? preset.host(region) : preset.host;
  return {
    smtp: { host, port: preset.port, secure: preset.secure },
    ...(preset.user ? { user: preset.user } : {}),
  };
}
