// Long-poll for the Context tab: resolves when the thread records a new model request, so
// the tab refreshes right after a reply instead of on a timer. Codex appends a token_count
// event to the rollout after every request; the file is watched, not polled.
import { watch, type FSWatcher } from "node:fs";
import { open, stat } from "node:fs/promises";
import { query } from "./codexdb.js";

// Under Codex's tool-call timeout; the tab simply waits again.
const MAX_WAIT_MS = 40_000;
// Let the rest of the turn's lines land before the tab re-reads.
const SETTLE_MS = 400;
const TAIL_BYTES = 64 * 1024;
const NEW_THREAD_CHECK_MS = 2_000;
const MARKER = Buffer.from('"type":"token_count"');

type Waited = { changed: boolean };

async function rolloutPath(threadId: string): Promise<string | null> {
  const [row] = await query<{ rollout_path: string | null }>("select rollout_path from threads where id = ?", threadId);
  return row?.rollout_path ?? null;
}

// Only the end of what was appended matters: token_count lines are short and come last.
async function recordedRequest(path: string, from: number, to: number): Promise<boolean> {
  const start = Math.max(from, to - TAIL_BYTES);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(to - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.includes(MARKER);
  } finally {
    await handle.close();
  }
}

function waitForRequest(path: string, size: number): Promise<Waited> {
  return new Promise((resolve) => {
    let watcher: FSWatcher | null = null;
    let settle: NodeJS.Timeout | null = null;
    let known = size;
    let checking = false;
    const done = (changed: boolean) => {
      clearTimeout(timeout);
      if (settle) clearTimeout(settle);
      watcher?.close();
      resolve({ changed });
    };
    const timeout = setTimeout(() => done(false), MAX_WAIT_MS);
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const now = (await stat(path)).size;
        if (now < known) return done(true); // rewritten; let the tab re-read
        if (now > known && (await recordedRequest(path, known, now))) {
          settle ??= setTimeout(() => done(true), SETTLE_MS);
        }
        known = Math.max(known, now);
      } catch {
        done(true);
      } finally {
        checking = false;
      }
    };
    try {
      watcher = watch(path, check);
      watcher.on("error", () => done(true));
    } catch {
      done(true);
    }
  });
}

// A tab opened on a new chat waits for the thread its first message creates.
async function waitForThread(since: number): Promise<Waited> {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const [row] = await query<{ id: string }>(
      "select id from threads where created_at_ms >= ? and archived = 0 and coalesce(thread_source, '') in ('user', '') and source != 'exec' limit 1",
      since - 5000,
    );
    if (row) return { changed: true };
    await new Promise((r) => setTimeout(r, NEW_THREAD_CHECK_MS));
  }
  return { changed: false };
}

export async function waitForChange(threadId: string | undefined, since: number | undefined, size: number | undefined): Promise<Waited> {
  if (!threadId) return since ? waitForThread(since) : { changed: false };
  const path = await rolloutPath(threadId);
  if (!path) return { changed: false };
  const now = (await stat(path).catch(() => null))?.size ?? 0;
  // A request recorded between the tab's last read and this call counts too.
  if (size !== undefined && now < size) return { changed: true };
  if (size !== undefined && now > size && (await recordedRequest(path, size, now))) return { changed: true };
  return waitForRequest(path, now);
}
