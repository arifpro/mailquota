import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MemoryStore } from "./memory.js";

/**
 * A memory store that also writes its state to a JSON file, so counters survive a
 * restart. It is for ONE process: two processes writing the same file overwrite each
 * other. Use the Redis store when more than one process sends.
 */
export class FileStore extends MemoryStore {
  private readonly path: string;

  constructor(path: string, options: { now?: () => number } = {}) {
    super(options);
    this.path = path;
    let raw: string | undefined;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (raw !== undefined && raw.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`mailquota: the store file ${path} is not valid JSON`);
      }
      if (typeof parsed === "object" && parsed !== null) {
        for (const [key, entry] of Object.entries(parsed)) {
          const value: unknown = entry?.value;
          const expiresAt: unknown = entry?.expiresAt;
          if (
            (typeof value === "number" || typeof value === "string") &&
            typeof expiresAt === "number"
          ) {
            this.entries.set(key, { value, expiresAt });
          }
        }
      }
      this.sweep();
    }
  }

  protected override changed(): void {
    this.sweep();
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    // Write to a temporary file and rename, so a crash never leaves a half-written file.
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.entries)), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}

export function fileStore(path: string, options?: { now?: () => number }): FileStore {
  return new FileStore(path, options);
}
