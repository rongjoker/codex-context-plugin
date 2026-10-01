// Read-only queries against Codex's local state DB (threads, projects).
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { codexHome } from "./paths.js";

// node:sqlite ships with Node 22.5+; load it lazily so older runtimes still start.
type Database = { prepare(sql: string): { all(...params: (string | number)[]): unknown[] }; close(): void };
type DatabaseCtor = new (path: string | URL, options: { readOnly: boolean }) => Database;
let DatabaseSync: DatabaseCtor | null = null;

function openDb(): Database {
  const path = join(codexHome(), "state_5.sqlite");
  try {
    return new DatabaseSync!(path, { readOnly: true });
  } catch (error) {
    // The DB is in WAL mode; while Codex has it closed and no -wal/-shm files exist,
    // a plain read-only open fails. An immutable open is safe in exactly that state.
    const url = pathToFileURL(path);
    url.search = "mode=ro&immutable=1";
    try {
      return new DatabaseSync!(url, { readOnly: true });
    } catch {
      throw error;
    }
  }
}

export async function query<T>(sql: string, ...params: (string | number)[]): Promise<T[]> {
  if (!DatabaseSync) {
    try {
      ({ DatabaseSync } = (await import("node:sqlite")) as unknown as { DatabaseSync: DatabaseCtor });
    } catch {
      throw new Error(`Thread stats need Node.js 22.5 or newer (running ${process.version})`);
    }
  }
  const db = openDb();
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}
