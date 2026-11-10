import type { Limits, WindowName } from "./types.js";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    // Throws a RangeError for an unknown zone, which is how a zone is validated.
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, found);
  }
  return found;
}

export function assertTimeZone(timeZone: string): void {
  formatter(timeZone);
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  /** The wall-clock time expressed as if it were UTC, in milliseconds. */
  asUtc: number;
}

function localParts(ms: number, timeZone: string): LocalParts {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const year = parts.year ?? 1970;
  const month = parts.month ?? 1;
  const day = parts.day ?? 1;
  const asUtc = Date.UTC(year, month - 1, day, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0);
  return { year, month, day, asUtc };
}

/** The instant at which the local date `year-month-day 00:00` begins in `timeZone`. */
function localMidnight(year: number, month: number, day: number, timeZone: string): number {
  const wall = Date.UTC(year, month - 1, day);
  // The offset at the guess can differ from the offset at the answer near a DST change,
  // so the offset is taken twice.
  let instant = wall;
  for (let i = 0; i < 2; i++) {
    const seconds = Math.floor(instant / 1000) * 1000;
    const offset = localParts(seconds, timeZone).asUtc - seconds;
    instant = wall - offset;
  }
  return instant;
}

export interface Period {
  /** Identifies the current window, for example `d2026-11-10`. Part of the counter key. */
  id: string;
  /** When the window ends, in Unix milliseconds. */
  resetsAt: number;
}

const pad = (value: number): string => String(value).padStart(2, "0");

export function periodOf(window: WindowName, now: number, timeZone: string): Period {
  switch (window) {
    case "minute": {
      const index = Math.floor(now / MINUTE);
      return { id: `m${index}`, resetsAt: (index + 1) * MINUTE };
    }
    case "hour": {
      const index = Math.floor(now / HOUR);
      return { id: `h${index}`, resetsAt: (index + 1) * HOUR };
    }
    case "day": {
      const local = localParts(now, timeZone);
      let resetsAt = localMidnight(local.year, local.month, local.day + 1, timeZone);
      if (resetsAt <= now) resetsAt = now + DAY;
      return { id: `d${local.year}-${pad(local.month)}-${pad(local.day)}`, resetsAt };
    }
    case "month": {
      const local = localParts(now, timeZone);
      let resetsAt = localMidnight(local.year, local.month + 1, 1, timeZone);
      if (resetsAt <= now) resetsAt = now + 31 * DAY;
      return { id: `M${local.year}-${pad(local.month)}`, resetsAt };
    }
  }
}

const LIMIT_FIELDS: ReadonlyArray<[keyof Limits, WindowName]> = [
  ["perMinute", "minute"],
  ["perHour", "hour"],
  ["perDay", "day"],
  ["perMonth", "month"],
];

/** The configured windows of an account, shortest first. */
export function windowsOf(limits: Limits | undefined): Array<{ window: WindowName; limit: number }> {
  const result: Array<{ window: WindowName; limit: number }> = [];
  for (const [field, window] of LIMIT_FIELDS) {
    const limit = limits?.[field];
    if (limit !== undefined) result.push({ window, limit });
  }
  return result;
}

export const LIMIT_FIELD_NAMES: readonly string[] = LIMIT_FIELDS.map(([field]) => field);
