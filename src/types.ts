// Data the Context server sends to its UI and to the model. Token counts use the
// o200k_base tokenizer when available (`exactTokens`), otherwise ceil(bytes / 4).

export type View = "panel" | "inline";

export type ContextItem = {
  kind: "user" | "assistant" | "terminal" | "mcp" | "tool";
  label: string;
  tokens: number;
};

export type ContextTurn = {
  number: number;
  status: "in-progress" | "finished" | "interrupted" | "incomplete";
  startedAt?: number | null; // Unix milliseconds
  durationMs?: number | null;
  inputTokens: number | null;
  inputDelta: number | null;
  compacted: boolean;
  largest: ContextItem[];
  skippedItems: number;
};

// A context block the host injects before the conversation, e.g. the AGENTS.md
// message or the skills catalog. `copies` counts live copies: every re-send stays
// in context until the next compaction.
export type Block = {
  key:
    | "system"
    | "agents"
    | "skills"
    | "permissions"
    | "environment"
    | "app"
    | "collaboration"
    | "apps"
    | "plugins"
    | "multiAgent"
    | "other";
  label: string;
  tokens: number; // one copy
  copies: number;
};

export type AgentsFile = {
  path: string; // absolute
  display: string; // "~/…" or relative to the project root
  scope: "global" | "project";
  kind: "AGENTS.md" | "AGENTS.override.md" | "fallback";
  // full: loaded as is; truncated: cut by project_doc_max_bytes; dropped: budget ran out;
  // shadowed: another file in the same directory won; empty: whitespace only.
  status: "full" | "truncated" | "dropped" | "shadowed" | "empty";
  shadowedBy: string | null;
  tokens: number; // tokens of the text that reached the model (0 unless full/truncated)
  fileTokens: number; // tokens of the file as it is on disk now
  bytes: number; // file size on disk now
  lines: number;
  // The thread loaded different text than the file holds now (edited after loading).
  changedSinceLoaded: boolean;
};

export type SkillEntry = {
  name: string; // as listed, e.g. "google-drive:google-docs"
  plugin: string | null; // namespace before ":" when present
  path: string | null; // SKILL.md on disk, when the catalog gives a file locator
  description: string;
  tokens: number;
  units: number; // Codex budget units: ceil((utf8 bytes + 1) / 4)
};

// Something in the thread's context worth fixing: a row with title and cost that opens to
// why, the fix and how we know.
export type Problem = {
  id: string;
  severity: "high" | "medium" | "low";
  title: string; // a few words
  cost: string | null; // compact, e.g. "5.3K / request"
  tip: string; // one short recommendation
  why: string;
  evidence: string; // how we know
  // measured: read from Codex's own data and rules; rule: a threshold we chose.
  basis: "measured" | "rule";
  // A list shown in the open row to fix it right there.
  panel: "unused-skills" | "duplicate-skills" | null;
};

// A catalog skill with how much the user used it lately, for turning skills off.
export type SkillChoice = {
  name: string;
  plugin: string | null;
  path: string;
  description: string;
  // Where the skill comes from, in words: 'OpenAI plugin "pdf"', "Your skills folder", "Built-in".
  source: string;
  sourceKind: "user" | "plugin" | "builtin" | "project" | "other";
  pluginIcon: string | null; // key into SkillChoices.icons
  addedAt: number | null; // when its SKILL.md appeared on disk
  tokens: number;
  uses: number; // in the last `days`
  lastUsed: number | null;
  enabled: boolean | null; // null when Codex did not report it
};

export type SkillChoices = {
  days: number;
  entries: SkillChoice[];
  icons: Record<string, string>; // plugin icon data URLs, sent once per plugin
  error: string | null;
};

export type ContextSnapshot = {
  view: View;
  thread: {
    id: string;
    title: string;
    cwd: string | null;
    model: string | null;
    // True when the host named the calling thread or the tab adopted its new thread.
    isCurrent: boolean;
    rolloutBytes: number | null; // rollout size this snapshot was read at
  } | null;
  contextWindow: number | null;
  exactTokens: boolean;

  // First request of the thread: what was fixed before the first reply.
  start: {
    inputTokens: number; // measured by Codex
    blocks: Block[]; // one copy each, as sent in the first request
    userTokens: number; // the first user message
    toolsTokens: number; // measured residual: tool definitions + protocol framing
  } | null;

  // Latest request.
  now: {
    inputTokens: number; // measured by Codex
    blocks: Block[]; // live copies after the latest compaction
    toolsTokens: number; // carried over from start
    conversationTokens: number; // inputTokens - blocks - tools, never below 0
    compactions: number;
  } | null;

  // When Codex will compact the thread: it does at `limit` tokens. Null without a limit or a
  // completed request; messagesLeft is null until a message has finished.
  compaction: {
    limit: number;
    current: number; // context after the latest request
    perMessage: number | null; // mean growth over the last `samples` messages
    samples: number;
    messagesLeft: number | null;
  } | null;

  agents: {
    files: AgentsFile[];
    projectRoot: string | null;
    projectBytes: number; // project files on disk now, counted against the budget as Codex would
    projectBudget: number; // project_doc_max_bytes (default 32768)
    loadedTokens: number; // whole AGENTS.md message as loaded, one copy
  };

  skills: {
    entries: SkillEntry[]; // catalog lines in listing order
    tokens: number;
    units: number;
    budgetUnits: number | null; // skills.max_context_tokens or 2% of the model context window
    duplicates: string[]; // names listed more than once
  };

  problems: Problem[]; // most severe first
  recentTurns?: ContextTurn[];
  turnCount?: number;
  notes: string[]; // lesser observations that need no action
  errors: string[];
  generatedAt: number;
};
