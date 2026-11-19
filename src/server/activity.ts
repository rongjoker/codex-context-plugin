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

const RECENT_TURNS = 5;
const LARGEST_ITEMS = 5;
const PENDING_CALLS = 128;

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
  private recent: ContextTurn[] = [];
  private calls = new Map<string, Pick<ContextItem, "kind" | "label">>();

  start(id?: string): void {
    if (this.active && (this.activeId === undefined || this.activeId === id)) {
      this.activeId ??= id;
      return;
    }
    this.finish("incomplete");
    this.activeId = id;
    this.active = {
      number: ++this.number,
      status: "in-progress",
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
    if (item.role === "user") this.add({ kind: "user", label: "User message", tokens: textTokens(content) });
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

  finish(status: Exclude<ContextTurn["status"], "in-progress">, id?: string): void {
    const turn = this.active;
    if (!turn || (id && this.activeId && id !== this.activeId)) return;
    this.active = null;
    this.activeId = undefined;
    turn.status = status;
    if (turn.inputTokens !== null) this.previousInput = turn.inputTokens;
    if (turn.inputTokens === null && !turn.compacted && !turn.largest.length && !turn.skippedItems) return;
    this.recent.push(turn);
    if (this.recent.length > RECENT_TURNS) this.recent.shift();
  }

  result(): ContextTurn[] {
    const turns = this.active ? [...this.recent, this.active] : this.recent;
    return turns.slice(-RECENT_TURNS).reverse().map((turn) => ({ ...turn, largest: [...turn.largest] }));
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
