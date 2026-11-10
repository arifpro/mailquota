import type { CounterReservation, UsageStore } from "../types.js";

interface Entry {
  value: number | string;
  expiresAt: number;
}

/**
 * Keeps everything in this process. Counters are lost on restart and are not shared
 * between processes, so use it for one long-running process or for tests.
 */
export class MemoryStore implements UsageStore {
  protected entries = new Map<string, Entry>();
  protected readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  /** Called after every change. Subclasses persist here. */
  protected changed(): void {}

  private live(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private count(key: string): number {
    const entry = this.live(key);
    return typeof entry?.value === "number" ? entry.value : 0;
  }

  protected sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  async reserve(
    reservations: CounterReservation[],
  ): Promise<{ ok: true } | { ok: false; key: string }> {
    for (const r of reservations) {
      if (this.count(r.key) + r.amount > r.limit) return { ok: false, key: r.key };
    }
    for (const r of reservations) {
      this.entries.set(r.key, { value: this.count(r.key) + r.amount, expiresAt: r.expiresAt });
    }
    if (this.entries.size > 2000) this.sweep();
    this.changed();
    return { ok: true };
  }

  async release(reservations: Array<{ key: string; amount: number }>): Promise<void> {
    for (const r of reservations) {
      const entry = this.live(r.key);
      if (entry && typeof entry.value === "number") {
        entry.value = Math.max(0, entry.value - r.amount);
      }
    }
    this.changed();
  }

  async raise(key: string, value: number, expiresAt: number): Promise<void> {
    this.entries.set(key, { value: Math.max(this.count(key), value), expiresAt });
    this.changed();
  }

  async read(keys: string[]): Promise<number[]> {
    return keys.map((key) => this.count(key));
  }

  async setFlag(key: string, value: string, until: number): Promise<void> {
    if (until <= this.now()) this.entries.delete(key);
    else this.entries.set(key, { value, expiresAt: until });
    this.changed();
  }

  async getFlags(keys: string[]): Promise<Array<string | undefined>> {
    return keys.map((key) => {
      const entry = this.live(key);
      return typeof entry?.value === "string" ? entry.value : undefined;
    });
  }

  async claim(key: string, value: string, until: number): Promise<string | undefined> {
    const entry = this.live(key);
    if (entry) return String(entry.value);
    this.entries.set(key, { value, expiresAt: until });
    this.changed();
    return undefined;
  }
}

export function memoryStore(options?: { now?: () => number }): MemoryStore {
  return new MemoryStore(options);
}
