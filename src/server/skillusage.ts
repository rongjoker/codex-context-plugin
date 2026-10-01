// Which skills the user actually used in the last 30 days, from local rollouts: explicit
// invocations (a user message opening with <skill>) and tool calls that read a SKILL.md.
// The catalog itself lists every SKILL.md path, so only those two kinds of lines count.
// Rollouts are append-only; each file is scanned once and then from its last offset.
import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { cacheDir, codexHome, writeAtomic } from "./paths.js";

export type Usage = { uses: number; lastUsed: number };
type FileEntry = { size: number; offset: number; hits: Record<string, Usage> };
type Cache = { version: 2; files: Record<string, FileEntry> };

const DAYS = 30;
const CHUNK = 8 * 1024 * 1024;
const NEWLINE = 0x0a;
const MARKERS = ["SKILL.md", "<skill>"].map((m) => Buffer.from(m));
const HEAD = /"timestamp":"([^"]+)".*?"type":"([a-z_]+)","payload":\{(?:"type":"([a-z_]+)")?/;
const TOOL_CALLS = new Set(["function_call", "custom_tool_call", "local_shell_call"]);
const SKILL_PATH = /[A-Za-z0-9_\-./~]*\/SKILL\.md/g;
const CACHE_FILE = () => join(cacheDir(), "skill-usage-v2.json");

let cache: Cache | null = null;
let running: Promise<Map<string, Usage>> | null = null;

// Plugin skills live under plugins/cache/<marketplace>/<plugin>/<version>/skills/<dir>, so the
// key drops the version. Skills in the user's folder key on their path below it, which keeps
// apart two copies that share a folder name (e.g. a cloned repo holding the skill twice).
export function skillKey(path: string): string | null {
  const unix = path.replace(/\\/g, "/");
  const plugin = /plugins\/cache\/[^/]+\/([^/]+)\/[^/]+\/skills\/([^/]+)\/SKILL\.md$/.exec(unix);
  if (plugin) return `plugin:${plugin[1]}/${plugin[2]}`;
  const own = /\.codex\/skills\/(.+)\/SKILL\.md$/.exec(unix);
  if (own) return own[1];
  const folder = /([^/]+)\/SKILL\.md$/.exec(unix);
  return folder ? folder[1] : null;
}

function record(hits: Record<string, Usage>, key: string, at: number): void {
  const hit = (hits[key] ??= { uses: 0, lastUsed: 0 });
  hit.uses++;
  hit.lastUsed = Math.max(hit.lastUsed, at);
}

function scanLine(line: Buffer, hits: Record<string, Usage>): void {
  if (!MARKERS.some((m) => line.includes(m))) return;
  const head = line.toString("latin1", 0, Math.min(line.length, 400));
  const match = HEAD.exec(head);
  if (!match) return;
  const [, timestamp, type, payloadType] = match;
  const at = Date.parse(timestamp);
  if (!Number.isFinite(at) || type !== "response_item") return;
  const text = line.toString("utf8");
  if (payloadType && TOOL_CALLS.has(payloadType)) {
    const seen = new Set<string>();
    for (const path of text.match(SKILL_PATH) ?? []) {
      const key = skillKey(path);
      if (key && !seen.has(key)) {
        seen.add(key);
        record(hits, key, at);
      }
    }
  } else if (payloadType === "message" && text.includes('"role":"user"')) {
    // "<skill>\n<name>…</name>\n<path>…/SKILL.md</path>" opens an explicit invocation.
    const path = /<skill>\\n<name>[^<]*<\/name>\\n<path>([^<]+)<\/path>/.exec(text)?.[1];
    const key = path ? skillKey(path) : null;
    if (key) record(hits, key, at);
  }
}

async function scanFrom(path: string, offset: number, hits: Record<string, Usage>): Promise<number> {
  const handle = await open(path, "r");
  try {
    let position = offset;
    let carry: Buffer = Buffer.alloc(0);
    const chunk = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, CHUNK, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      const end = data.lastIndexOf(NEWLINE);
      if (end < 0) {
        carry = Buffer.from(data);
        continue;
      }
      let start = 0;
      for (let newline = data.indexOf(NEWLINE); newline >= 0 && newline <= end; newline = data.indexOf(NEWLINE, start)) {
        scanLine(data.subarray(start, newline), hits);
        start = newline + 1;
      }
      carry = Buffer.from(data.subarray(end + 1));
    }
    return position - carry.length;
  } finally {
    await handle.close();
  }
}

async function* rollouts(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* rollouts(path);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield path;
  }
}

async function refresh(): Promise<Map<string, Usage>> {
  if (!cache) {
    try {
      const parsed = JSON.parse(await readFile(CACHE_FILE(), "utf8"));
      if (parsed?.version === 2) cache = parsed;
    } catch {}
    cache ??= { version: 2, files: {} };
  }
  const since = Date.now() - DAYS * 86_400_000;
  const seen = new Set<string>();
  let changed = false;
  for (const root of [join(codexHome(), "sessions"), join(codexHome(), "archived_sessions")]) {
    for await (const path of rollouts(root)) {
      const info = await stat(path).catch(() => null);
      if (!info || info.mtimeMs < since) continue;
      seen.add(path);
      let entry = cache.files[path];
      if (!entry || info.size < entry.offset) entry = cache.files[path] = { size: 0, offset: 0, hits: {} };
      if (info.size === entry.size) continue;
      entry.offset = await scanFrom(path, entry.offset, entry.hits);
      entry.size = info.size;
      changed = true;
    }
  }
  for (const path of Object.keys(cache.files)) {
    if (!seen.has(path)) {
      delete cache.files[path];
      changed = true;
    }
  }
  if (changed) await writeAtomic(CACHE_FILE(), JSON.stringify(cache)).catch(() => {});

  const usage = new Map<string, Usage>();
  for (const entry of Object.values(cache.files)) {
    for (const [key, hit] of Object.entries(entry.hits)) {
      if (hit.lastUsed < since) continue;
      const sum = usage.get(key) ?? { uses: 0, lastUsed: 0 };
      usage.set(key, { uses: sum.uses + hit.uses, lastUsed: Math.max(sum.lastUsed, hit.lastUsed) });
    }
  }
  return usage;
}

export const USAGE_DAYS = DAYS;

export function skillUsage(): Promise<Map<string, Usage>> {
  running ??= refresh().finally(() => {
    running = null;
  });
  return running;
}
