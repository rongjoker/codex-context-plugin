// What a thread's rollout says about its context: the blocks and measured input of the
// first request, the blocks still live at the latest request, and the AGENTS.md text and
// skills catalog the thread loaded. Rollouts are append-only JSONL that can reach GBs, so
// only the record types that matter are JSON-parsed, and each thread's parse is kept and
// resumed from the last complete line.
import { open, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { codexHome } from "./paths.js";
import type { Block } from "../types.js";
import { countTokens } from "./tokens.js";

export type BlockKey = Exclude<Block["key"], "system">;
export type Tally = { tokens: number; copies: number };

export type Rollout = {
  // Null when the thread has no completed request yet or its first segment is missing.
  start: { inputTokens: number; systemTokens: number; blocks: Map<BlockKey, number>; userTokens: number } | null;
  latest: { inputTokens: number; systemTokens: number; blocks: Map<BlockKey, Tally>; compactions: number } | null;
  contextWindow: number | null;
  // AGENTS.md text as loaded, without the message wrapper; null when the history is incomplete.
  agents: { text: string; directory: string | null } | null;
  skillsCatalog: string | null;
  historyMissing: boolean;
  // Context after the latest request (its input plus output), and how much a message adds:
  // the mean growth over the last few completed turns, measured between compactions.
  latestTotal: number | null;
  growth: { perMessage: number; samples: number } | null;
};

const GROWTH_TURNS = 5;

// Leading markers of the context blocks Codex injects as developer or user message parts.
const TAGS: [string, BlockKey][] = [
  ["# AGENTS.md instructions", "agents"],
  ["<skills_instructions>", "skills"],
  ["<permissions instructions>", "permissions"],
  ["<environment_context>", "environment"],
  ["<app-context>", "app"],
  ["<collaboration_mode>", "collaboration"],
  ["<apps_instructions>", "apps"],
  ["<codex_apps", "apps"],
  ["<external_codex_apps", "apps"],
  ["<plugins_instructions>", "plugins"],
  ["<recommended_plugins>", "plugins"],
  ["<multi_agent_mode>", "multiAgent"],
  ["<multi_agent_role>", "multiAgent"],
];

// Developer parts are all injected context; user parts without a known tag are the conversation.
function blockKey(role: string, text: string): BlockKey | null {
  for (const [tag, key] of TAGS) if (text.startsWith(tag)) return key;
  return role === "developer" ? "other" : null;
}

const AGENTS_HEADER = "# AGENTS.md instructions";
const REPLACED = "These AGENTS.md instructions replace all previously provided AGENTS.md instructions.\n\n";
const REMOVED = "The previously provided AGENTS.md instructions no longer apply.";

function agentsFromMessage(part: string): { text: string; directory: string | null } {
  const newline = part.indexOf("\n");
  const header = newline < 0 ? part : part.slice(0, newline);
  const directory = header.startsWith(`${AGENTS_HEADER} for `) ? header.slice(AGENTS_HEADER.length + 5) : null;
  const open = part.indexOf("<INSTRUCTIONS>\n");
  const close = part.lastIndexOf("\n</INSTRUCTIONS>");
  let text = open >= 0 && close > open ? part.slice(open + 15, close) : "";
  if (text.startsWith(REPLACED)) text = text.slice(REPLACED.length);
  return { text: text === REMOVED ? "" : text, directory };
}

// RFC 7386: world_state records after the first full one carry only what changed.
function mergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const result: Record<string, unknown> =
    target !== null && typeof target === "object" && !Array.isArray(target) ? (target as Record<string, unknown>) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

const WORLD_KEYS = ["agents_md", "host_skills"] as const;
type World = Partial<Record<(typeof WORLD_KEYS)[number], any>>;

const NEWLINE = 0x0a;
const HEAD_BYTES = 256;
const HEAD = /"type":"([a-z_]+)","payload":\{(?:"type":"([a-z_]+)")?/;
const ROLE = /"role":"([a-z]+)"/;
const TAG_TEXT = ['"text":"<', `"text":"${AGENTS_HEADER}`].map((tag) => Buffer.from(tag));

type Route = "parse" | "tagged" | "compacted" | "skip";
// Where a compacted record sits, so it can be read back without holding it in memory.
type Place = { path: string; start: number; end: number };
type Compaction = { place: Place | null; tallies: Map<BlockKey, Tally> | null };
type Latest = { inputTokens: number; systemTokens: number; ledger: Map<BlockKey, Tally>; base: Compaction | null; compactions: number };

class Parser {
  // True until the thread's first model output: those parts make up the first request.
  private collecting: boolean;
  private startBlocks = new Map<BlockKey, number>();
  private userTokens = 0;
  private start: Rollout["start"] = null;
  // A block sent again in a later request is another copy; a compaction keeps one of each.
  private ledger = new Map<BlockKey, Tally & { request: number }>();
  private request = 0;
  private compactions = 0;
  // The latest compaction's replacement_history seeds the ledger. Compacted records can be
  // tens of MB and only the last one matters, so only its place is kept; it is read once, on demand.
  private compaction: Compaction | null = null;
  private latest: Latest | null = null;
  private contextWindow: number | null = null;
  private firstSystemTokens: number | null = null;
  private systemTokens = 0;
  private world: World | null = null;
  private lastAgents: string | null = null;
  private lastSkills: string | null = null;
  private lastTotal: number | null = null;
  private turnBase: number | null = null; // context size the current turn grows from
  private deltas: number[] = [];

  constructor(readonly fromBase: boolean) {
    this.collecting = fromBase;
  }

  private route(head: string): Route {
    const match = HEAD.exec(head);
    if (!match) return "parse";
    const [, type, payloadType] = match;
    switch (type) {
      case "response_item": {
        if (this.collecting) return "parse";
        if (payloadType !== "message") return "skip";
        const role = ROLE.exec(head)?.[1];
        return role === "user" ? "tagged" : role === "assistant" ? "skip" : "parse";
      }
      case "event_msg":
        return payloadType === "token_count" || payloadType === "task_complete" ? "parse" : "skip";
      case "session_meta":
      case "world_state":
        return "parse";
      case "compacted":
        return "compacted";
      default:
        return "skip";
    }
  }

  // For a line too long to buffer whole: skip it, or skip it but note its place (compactions).
  wants(head: Buffer): "keep" | "place" | "skip" {
    const route = this.route(head.toString("latin1", 0, Math.min(head.length, HEAD_BYTES)));
    return route === "skip" ? "skip" : route === "compacted" ? "place" : "keep";
  }

  feed(line: Buffer, place: Place): void {
    const route = this.route(line.toString("latin1", 0, Math.min(line.length, HEAD_BYTES)));
    if (route === "skip") return;
    // Most user messages are the conversation; parse only those that open with a context tag.
    if (route === "tagged" && !TAG_TEXT.some((tag) => line.includes(tag))) return;
    if (route === "compacted") return this.compacted(place);
    let record;
    try {
      record = JSON.parse(line.toString("utf8"));
    } catch {
      return;
    }
    const payload = record?.payload;
    switch (record?.type) {
      case "session_meta":
        return this.meta(payload);
      case "response_item":
        return this.item(payload);
      case "event_msg":
        if (payload?.type === "token_count") this.tokenCount(payload.info);
        else if (payload?.type === "task_complete") this.turnEnd();
        return;
      case "world_state":
        return this.worldState(payload);
    }
  }

  private meta(payload: any): void {
    const base = payload?.base_instructions;
    const text = typeof base === "string" ? base : typeof base?.text === "string" ? base.text : null;
    if (text === null) return;
    this.systemTokens = countTokens(text);
    this.firstSystemTokens ??= this.systemTokens;
  }

  private add(key: BlockKey, text: string, ledger = this.ledger): void {
    const tokens = countTokens(text);
    if (this.collecting) this.startBlocks.set(key, (this.startBlocks.get(key) ?? 0) + tokens);
    const tally = ledger.get(key);
    if (!tally) ledger.set(key, { tokens, copies: 1, request: this.request });
    else {
      tally.tokens += tokens;
      if (tally.request !== this.request) {
        tally.copies++;
        tally.request = this.request;
      }
    }
    if (ledger !== this.ledger) return;
    if (key === "agents") this.lastAgents = text;
    else if (key === "skills") this.lastSkills = text;
  }

  private parts(message: any, first: boolean, ledger = this.ledger): void {
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (typeof part?.text !== "string") continue;
      const key = blockKey(message.role, part.text);
      if (key) this.add(key, part.text, ledger);
      else if (first) this.userTokens += countTokens(part.text);
    }
  }

  private item(payload: any): void {
    if (payload?.type === "message") {
      if (payload.role === "assistant") this.modelOutput();
      else if (payload.role === "developer" || payload.role === "user") this.parts(payload, this.collecting);
    } else if (typeof payload?.type === "string" && (payload.type === "reasoning" || payload.type.endsWith("_call"))) {
      this.modelOutput();
    }
  }

  private modelOutput(): void {
    if (!this.collecting) return;
    this.collecting = false;
    this.request++;
  }

  private tokenCount(info: any): void {
    if (typeof info?.model_context_window === "number") this.contextWindow = info.model_context_window;
    const input = info?.last_token_usage?.input_tokens;
    // A compaction resets usage with a zero record; it measures no request.
    if (typeof input !== "number" || input <= 0) return;
    const output = info?.last_token_usage?.output_tokens;
    this.lastTotal = input + (typeof output === "number" ? output : 0);
    this.turnBase ??= input;
    if (this.fromBase && !this.start) {
      this.collecting = false;
      this.start = {
        inputTokens: input,
        systemTokens: this.firstSystemTokens ?? 0,
        blocks: new Map(this.startBlocks),
        userTokens: this.userTokens,
      };
    }
    this.latest = {
      inputTokens: input,
      systemTokens: this.systemTokens,
      ledger: new Map([...this.ledger].map(([key, t]) => [key, { tokens: t.tokens, copies: t.copies }])),
      base: this.compaction,
      compactions: this.compactions,
    };
    this.request++;
  }

  private worldState(payload: any): void {
    const state = payload?.state;
    if (!state || typeof state !== "object") return;
    if (payload.full || !this.world) this.world = {};
    for (const key of WORLD_KEYS) {
      if (!(key in state)) continue;
      const value = mergePatch(this.world[key], state[key]);
      if (value === null) delete this.world[key];
      else this.world[key] = value;
    }
  }

  // A turn ends: what it added is the growth one message brings.
  private turnEnd(): void {
    if (this.turnBase === null || this.lastTotal === null) return;
    this.deltas.push(Math.max(0, this.lastTotal - this.turnBase));
    if (this.deltas.length > GROWTH_TURNS) this.deltas.shift();
    this.turnBase = this.lastTotal;
  }

  compacted(place: Place): void {
    this.compactions++;
    // Growth across a compaction means nothing; the next request starts a new base.
    this.turnBase = null;
    this.lastTotal = null;
    this.request += 2;
    this.ledger = new Map();
    this.compaction = { place, tallies: null };
  }

  // Reads the compaction the latest request builds on, once.
  async settle(): Promise<void> {
    const base = this.latest?.base;
    if (!base || base.tallies || !base.place) return;
    const tallies = new Map<BlockKey, Tally & { request: number }>();
    const { path, start, end } = base.place;
    base.place = null;
    try {
      const handle = await open(path, "r");
      try {
        const buffer = Buffer.allocUnsafe(end - start);
        await handle.read(buffer, 0, buffer.length, start);
        const history = JSON.parse(buffer.toString("utf8"))?.payload?.replacement_history;
        for (const item of Array.isArray(history) ? history : []) {
          if (item?.type === "message" && (item.role === "developer" || item.role === "user")) this.parts(item, false, tallies);
        }
      } finally {
        await handle.close();
      }
    } catch {}
    base.tallies = new Map([...tallies].map(([key, t]) => [key, { tokens: t.tokens, copies: t.copies }]));
  }

  // One copy of each block survives a compaction; blocks sent after it add to those.
  private blocksAt(latest: Latest): Map<BlockKey, Tally> {
    const base = latest.base;
    const blocks = new Map<BlockKey, Tally>();
    for (const source of [base?.tallies, latest.ledger]) {
      for (const [key, t] of source ?? []) {
        const sum = blocks.get(key) ?? { tokens: 0, copies: 0 };
        blocks.set(key, { tokens: sum.tokens + t.tokens, copies: sum.copies + t.copies });
      }
    }
    return blocks;
  }

  result(): Rollout {
    let agents: Rollout["agents"] = null;
    if (this.world) {
      const md = this.world.agents_md;
      agents = { text: typeof md?.text === "string" ? md.text : "", directory: typeof md?.directory === "string" ? md.directory : null };
    } else if (this.lastAgents !== null) agents = agentsFromMessage(this.lastAgents);
    else if (this.fromBase) agents = { text: "", directory: null };

    let skillsCatalog: string | null = null;
    const host = this.world?.host_skills;
    if (typeof host?.body === "string") skillsCatalog = host.includeInstructions === false ? null : host.body;
    else if (this.lastSkills !== null) {
      skillsCatalog = this.lastSkills.replace(/^<skills_instructions>/, "").replace(/<\/skills_instructions>\s*$/, "");
    }

    const latest = this.latest;
    return {
      start: this.start,
      latest: latest && {
        inputTokens: latest.inputTokens,
        systemTokens: latest.systemTokens,
        blocks: this.blocksAt(latest),
        compactions: latest.compactions,
      },
      contextWindow: this.contextWindow,
      agents,
      skillsCatalog,
      historyMissing: !this.fromBase,
      latestTotal: this.lastTotal,
      growth: this.deltas.length
        ? { perMessage: Math.round(this.deltas.reduce((sum, d) => sum + d, 0) / this.deltas.length), samples: this.deltas.length }
        : null,
    };
  }
}

// Paginated threads span several rollout files. Each later segment's session_meta names the
// previous segment in history_base and where its history ends, since that file may go on.
type Segment = { path: string; end: number | null };

const MAX_FIRST_LINE = 64 * 1024 * 1024;
const MAX_SEGMENTS = 64;

async function firstLine(path: string): Promise<any> {
  const handle = await open(path, "r");
  try {
    const parts: Buffer[] = [];
    const chunk = Buffer.alloc(256 * 1024);
    for (let position = 0; position < MAX_FIRST_LINE; ) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      const data = chunk.subarray(0, bytesRead);
      const newline = data.indexOf(NEWLINE);
      parts.push(Buffer.from(newline < 0 ? data : data.subarray(0, newline)));
      if (newline >= 0) break;
      position += bytesRead;
    }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function findFile(dir: string, match: (name: string) => boolean): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (entry.isFile() && match(entry.name)) return join(dir, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFile(join(dir, entry.name), match);
    if (found) return found;
  }
  return null;
}

const segmentPaths = new Map<string, string>();

// The base segment is rollout-*-<thread>.jsonl, later ones rollout-*-<thread>_<segment>.jsonl.
async function findSegment(threadId: string, segmentId: string, near: string): Promise<string | null> {
  const key = `${threadId}/${segmentId}`;
  const known = segmentPaths.get(key);
  if (known && (await stat(known).catch(() => null))) return known;
  const suffix = segmentId === threadId ? `-${threadId}.jsonl` : `-${threadId}_${segmentId}.jsonl`;
  const match = (name: string) => name.startsWith("rollout-") && name.endsWith(suffix);
  const nearby = (await readdir(near).catch(() => [] as string[])).find(match);
  let path = nearby ? join(near, nearby) : null;
  for (const root of [join(codexHome(), "sessions"), join(codexHome(), "archived_sessions")]) {
    path ??= await findFile(root, match);
  }
  if (path) segmentPaths.set(key, path);
  return path;
}

async function segmentChain(threadId: string, latest: string): Promise<{ segments: Segment[]; fromBase: boolean }> {
  const segments: Segment[] = [{ path: latest, end: null }];
  for (let current = latest; segments.length <= MAX_SEGMENTS; ) {
    const base = (await firstLine(current))?.payload?.history_base;
    if (typeof base?.thread_id !== "string") return { segments, fromBase: true };
    const previous = await findSegment(threadId, base.thread_id, dirname(current));
    if (!previous) return { segments, fromBase: false };
    segments.unshift({ path: previous, end: typeof base.end_byte_offset === "number" ? base.end_byte_offset : Infinity });
    current = previous;
  }
  return { segments, fromBase: false };
}

const CHUNK = 8 * 1024 * 1024;
const MIN_CHUNK = 64 * 1024;
const BIG_LINE = 4 * 1024 * 1024;

// Feeds every complete line in [from, end) to the parser; returns the offset just past the
// last complete line.
async function scan(path: string, from: number, end: number | null, parser: Parser): Promise<number> {
  const handle = await open(path, "r");
  try {
    // Refreshes usually read a few KB; size the buffer to what is there.
    const available = (end ?? (await handle.stat()).size) - from;
    const chunk = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(MIN_CHUNK, available)));
    let position = from;
    let lineStart = from;
    let parts: Buffer[] = [];
    let pending = 0;
    let skipping = false;
    let placing = false;
    for (;;) {
      const want = end === null ? chunk.length : Math.min(chunk.length, end - position);
      if (want <= 0) break;
      const { bytesRead } = await handle.read(chunk, 0, want, position);
      if (bytesRead === 0) break;
      const data = chunk.subarray(0, bytesRead);
      let start = 0;
      for (let newline = data.indexOf(NEWLINE); newline >= 0; newline = data.indexOf(NEWLINE, start)) {
        const place = { path, start: lineStart, end: position + newline };
        if (placing) parser.compacted(place);
        else if (!skipping) {
          const piece = data.subarray(start, newline);
          parser.feed(parts.length ? Buffer.concat([...parts, piece]) : piece, place);
        }
        parts = [];
        pending = 0;
        skipping = false;
        placing = false;
        start = newline + 1;
        lineStart = position + start;
      }
      if (start < bytesRead && !skipping) {
        parts.push(Buffer.from(data.subarray(start)));
        pending += bytesRead - start;
        // Huge lines are mostly tool output or compactions; stop buffering one once its head says so.
        const want = pending > BIG_LINE ? parser.wants(Buffer.concat(parts.slice(0, 2), HEAD_BYTES)) : "keep";
        if (want !== "keep") {
          skipping = true;
          placing = want === "place";
          parts = [];
        }
      }
      position += bytesRead;
    }
    return lineStart;
  } finally {
    await handle.close();
  }
}

type Entry = { parser: Parser; done: Segment[]; open: { path: string; offset: number } | null };

const MAX_THREADS = 8;
const entries = new Map<string, Entry>();
const locks = new Map<string, Promise<unknown>>();

// A cached parse resumes when the new chain extends it: the same closed segments, then the
// segment it left open, still at least as long as what was read.
async function resumeAt(entry: Entry, segments: Segment[], fromBase: boolean): Promise<number> {
  if (entry.parser.fromBase !== fromBase || !entry.open) return -1;
  const at = entry.done.length;
  for (let i = 0; i < at; i++) {
    if (segments[i]?.path !== entry.done[i].path || segments[i].end !== entry.done[i].end) return -1;
  }
  const next = segments[at];
  if (next?.path !== entry.open.path) return -1;
  const size = next.end ?? (await stat(next.path)).size;
  return size >= entry.open.offset ? at : -1;
}

async function update(threadId: string, path: string): Promise<Rollout> {
  const { segments, fromBase } = await segmentChain(threadId, path);
  let entry = entries.get(threadId);
  let at = entry ? await resumeAt(entry, segments, fromBase) : -1;
  if (!entry || at < 0) {
    entry = { parser: new Parser(fromBase), done: [], open: null };
    at = 0;
  }
  entries.delete(threadId);
  entries.set(threadId, entry);
  for (const key of entries.keys()) {
    if (entries.size <= MAX_THREADS) break;
    entries.delete(key);
  }
  try {
    for (const segment of segments.slice(at)) {
      const from = entry.open?.path === segment.path ? entry.open.offset : 0;
      const offset = await scan(segment.path, from, segment.end, entry.parser);
      if (segment.end === null) entry.open = { path: segment.path, offset };
      else {
        entry.done.push(segment);
        entry.open = null;
      }
    }
  } catch (error) {
    entries.delete(threadId);
    throw error;
  }
  await entry.parser.settle();
  return entry.parser.result();
}

// Requests for one thread run one at a time so they share a single resumable parse.
export function readRollout(threadId: string, path: string): Promise<Rollout> {
  const run = (locks.get(threadId) ?? Promise.resolve()).catch(() => {}).then(() => update(threadId, path));
  locks.set(threadId, run);
  const release = () => {
    if (locks.get(threadId) === run) locks.delete(threadId);
  };
  run.then(release, release);
  return run;
}
