import type { ContextItem, ContextTurn } from "../types.js";
import { countTokens } from "./tokens.js";

export type LoggedItem = {
  type?: string;
  role?: string;
  content?: unknown;
  output?: unknown;
  call_id?: string;
  name?: string;
  namespace?: string;
};

type TurnEvent = {
  turn_id?: string;
  started_at?: number;
  completed_at?: number;
  duration_ms?: number;
};

const DEFAULT_TURN_LIMIT = 5;
const LARGEST_ITEMS = 5;
const PENDING_CALLS = 128;
const PROMPT_TITLE_LENGTH = 96;
const sentences = new Intl.Segmenter(undefined, { granularity: "sentence" });

function promptPreview(item: LoggedItem, content: unknown): ContextTurn["prompt"] {
  for (const part of Array.isArray(content) ? content : []) {
    if (typeof part?.text !== "string") continue;
    let text = part.text.trim();
    if (text.startsWith("# Files mentioned by the user:")) {
      const heading = /^## My request:[ \t]*\r?$/m.exec(text);
      if (!heading) continue;
      text = text.slice(heading.index + heading[0].length).trim();
    }
    if (!text || /^<\/?image(?=[\s>])/.test(text) || text.startsWith("<send_user_message_question_reply>")) continue;
    const line = text.split(/\r?\n/, 1)[0].replace(/\s+/g, " ").trim().slice(0, PROMPT_TITLE_LENGTH * 2 + 2);
    const sentence = sentences.segment(line)[Symbol.iterator]().next().value?.segment.trim() ?? "";
    if (!sentence) continue;
    const chars = Array.from(sentence);
    const title = chars.length > PROMPT_TITLE_LENGTH ? `${chars.slice(0, PROMPT_TITLE_LENGTH - 1).join("").trimEnd()}…` : sentence;
    return { kind: "text", title };
  }
  if (Array.isArray(item.content) && item.content.some((part) => part?.type === "input_image")) return { kind: "image" };
}

function validTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function eventTime(seconds: unknown, timestamp?: string): number | null {
  if (validTime(seconds)) return seconds * 1000;
  const parsed = typeof timestamp === "string" ? Date.parse(timestamp) : NaN;
  return validTime(parsed) ? parsed : null;
}

function textTokens(content: unknown): number {
  if (typeof content === "string") return countTokens(content);
  if (!Array.isArray(content)) return 0;
  return content.reduce((total, part) => total + (typeof part?.text === "string" ? countTokens(part.text) : 0), 0);
}

function toolLabel(item: LoggedItem): Pick<ContextItem, "kind" | "label"> | null {
  if (typeof item.name !== "string" || !item.name) return null;
  const namespace = typeof item.namespace === "string" ? item.namespace : "";
  const qualified = item.name.startsWith("mcp__") ? item.name : `${namespace}${namespace.endsWith("__") ? "" : "__"}${item.name}`;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(qualified);
  if (mcp) return { kind: "mcp", label: `${mcp[1]} / ${mcp[2]}` };
  if (item.name === "exec_command" || item.name === "write_stdin" || item.name === "shell") {
    return { kind: "terminal", label: item.name };
  }
  return { kind: "tool", label: item.name };
}

export class RecentActivity {
  private number = 0;
  private previousInput: number | null = null;
  private active: ContextTurn | null = null;
  private activeId: string | undefined;
  private finished: ContextTurn[] = [];
  private lastFinishedId: string | undefined;
  private calls = new Map<string, Pick<ContextItem, "kind" | "label">>();

  start(event?: TurnEvent, timestamp?: string): void {
    const id = event?.turn_id;
    const startedAt = eventTime(event?.started_at, timestamp);
    if (this.active && (this.activeId === undefined || this.activeId === id)) {
      this.activeId ??= id;
      this.active.startedAt ??= startedAt;
      return;
    }
    this.finish("incomplete");
    this.activeId = id;
    this.active = {
      number: ++this.number,
      status: "in-progress",
      startedAt,
      durationMs: null,
      inputTokens: null,
      inputDelta: null,
      compacted: false,
      largest: [],
      skippedItems: 0,
    };
  }

  request(input: number): void {
    if (!this.active) this.start();
    const turn = this.active!;
    turn.inputTokens = input;
    turn.inputDelta = this.previousInput === null ? null : input - this.previousInput;
  }

  message(item: LoggedItem, content = item.content): void {
    if (item.role === "user") {
      if (!this.active?.prompt) {
        const prompt = promptPreview(item, content);
        if (prompt) {
          if (!this.active) this.start();
          this.active!.prompt = prompt;
        }
      }
      this.add({ kind: "user", label: "User message", tokens: textTokens(content) });
    }
    if (item.role === "assistant") this.add({ kind: "assistant", label: "Assistant response", tokens: textTokens(content) });
  }

  tool(item: LoggedItem): void {
    const name = toolLabel(item);
    const id = typeof item.call_id === "string" ? item.call_id : null;
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      if (id && name) {
        if (this.calls.size >= PENDING_CALLS) {
          const oldest = this.calls.keys().next();
          if (!oldest.done) this.calls.delete(oldest.value);
        }
        this.calls.set(id, name);
      }
    } else {
      const source = name ?? (id ? this.calls.get(id) : null) ?? { kind: "tool", label: "Unattributed tool result" };
      if (id) this.calls.delete(id);
      this.add({ ...source, tokens: textTokens(item.output) });
    }
  }

  skipItem(): void {
    if (!this.active) this.start();
    this.active!.skippedItems++;
  }

  compacted(): void {
    this.previousInput = null;
    if (!this.active) this.start();
    const turn = this.active!;
    turn.inputTokens = null;
    turn.inputDelta = null;
    turn.compacted = true;
  }

  finish(status: Exclude<ContextTurn["status"], "in-progress">, event?: TurnEvent, timestamp?: string): void {
    const id = event?.turn_id;
    if (id !== undefined && id === this.lastFinishedId) return;
    if (!this.active && (validTime(event?.duration_ms) || validTime(event?.started_at))) this.start(event);
    const turn = this.active;
    if (!turn || (id && this.activeId && id !== this.activeId)) return;
    this.lastFinishedId = id ?? this.activeId;
    this.active = null;
    this.activeId = undefined;
    turn.status = status;
    turn.startedAt ??= eventTime(event?.started_at);
    if (validTime(event?.duration_ms)) turn.durationMs = event.duration_ms;
    else if (status !== "incomplete" && turn.startedAt != null) {
      const endedAt = eventTime(event?.completed_at, timestamp);
      if (endedAt !== null && endedAt >= turn.startedAt) turn.durationMs = endedAt - turn.startedAt;
    }
    if (turn.inputTokens !== null) this.previousInput = turn.inputTokens;
    if (turn.inputTokens === null && !turn.prompt && !turn.compacted && !turn.largest.length && !turn.skippedItems
      && turn.startedAt == null && turn.durationMs == null) return;
    this.finished.push(turn);
  }

  result(limit = DEFAULT_TURN_LIMIT, includePrompts = false): { turns: ContextTurn[]; count: number } {
    const reserved = this.active ? 1 : 0;
    const turns = this.finished.slice(Math.max(0, this.finished.length - (limit - reserved))).reverse();
    if (this.active) turns.unshift(this.active);
    return {
      turns: turns.map(({ prompt, ...turn }) => ({
        ...turn,
        largest: [...turn.largest],
        ...(includePrompts && prompt ? { prompt } : {}),
      })),
      count: this.finished.length + reserved,
    };
  }

  private add(item: ContextItem): void {
    if (!item.tokens) return;
    if (!this.active) this.start();
    const largest = this.active!.largest;
    largest.push(item);
    largest.sort((a, b) => b.tokens - a.tokens);
    if (largest.length > LARGEST_ITEMS) largest.pop();
  }
}
