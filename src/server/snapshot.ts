// Assembles the Context snapshot for a thread: rollout measurements, AGENTS.md files on
// disk, the skills catalog and the problems that follow from them.
import { stat } from "node:fs/promises";
import { query } from "./codexdb.js";
import type { Block, ContextSnapshot, View } from "../types.js";
import { agentsReport } from "./agents.js";
import { modelLimits, readSettings } from "./config.js";
import { readRollout, type BlockKey, type Rollout, type Tally } from "./rollout.js";
import { findProblems } from "./problems.js";
import { skillsReport } from "./skills.js";
import { exactTokens, loadTokenizer } from "./tokens.js";

type Row = { id: string; title: string; cwd: string | null; model: string | null; rollout_path: string | null };

const COLUMNS = `id, coalesce(nullif(name, ''), nullif(title, ''), preview, 'Untitled') as title, cwd, model, rollout_path`;
// Conversations started by the user in the app or TUI; `exec` runs are scripts and automations.
const USER_THREADS = `archived = 0 and coalesce(thread_source, '') in ('user', '') and source != 'exec'`;

const LABELS: Record<Block["key"], string> = {
  system: "System prompt",
  agents: "AGENTS.md",
  skills: "Skills catalog",
  permissions: "Permissions",
  environment: "Environment",
  app: "App context",
  collaboration: "Collaboration mode",
  apps: "Apps",
  plugins: "Plugins",
  multiAgent: "Multi-agent",
  other: "Other instructions",
};
const ORDER = Object.keys(LABELS) as Block["key"][];

// The host names the calling thread. A tab opened on a new, unsent chat has no thread yet:
// it passes `since` (when it opened) and adopts the first thread created after that.
const CLOCK_SLACK_MS = 5000;

async function findThread(threadId: string | undefined, since: number | undefined): Promise<{ row: Row; isCurrent: boolean } | null> {
  if (threadId) {
    const [row] = await query<Row>(`select ${COLUMNS} from threads where id = ?`, threadId);
    if (row) return { row, isCurrent: true };
  }
  if (since) {
    const [row] = await query<Row>(
      `select ${COLUMNS} from threads where ${USER_THREADS} and created_at_ms >= ? order by created_at_ms asc limit 1`,
      since - CLOCK_SLACK_MS,
    );
    if (row) return { row, isCurrent: true };
  }
  return null;
}

function blocks(systemTokens: number, parts: Map<BlockKey, Tally>): Block[] {
  const all = new Map<Block["key"], Tally>(parts);
  if (systemTokens) all.set("system", { tokens: systemTokens, copies: 1 });
  return ORDER.filter((key) => all.has(key)).map((key) => {
    const { tokens, copies } = all.get(key)!;
    // Copies can differ slightly (a re-sent AGENTS.md carries a notice); report the mean.
    return { key, label: LABELS[key], tokens: Math.round(tokens / copies), copies };
  });
}

const total = (list: Block[]) => list.reduce((sum, b) => sum + b.tokens * b.copies, 0);

// Tool definitions never reach the rollout: they are what the first request measured beyond
// every block Codex logged.
function startOf(first: NonNullable<Rollout["start"]>): NonNullable<ContextSnapshot["start"]> {
  const list = blocks(first.systemTokens, new Map([...first.blocks].map(([key, tokens]) => [key, { tokens, copies: 1 }])));
  return {
    inputTokens: first.inputTokens,
    blocks: list,
    userTokens: first.userTokens,
    toolsTokens: Math.max(0, first.inputTokens - total(list) - first.userTokens),
  };
}

function nowOf(latest: NonNullable<Rollout["latest"]>, toolsTokens: number): NonNullable<ContextSnapshot["now"]> {
  const list = blocks(latest.systemTokens, latest.blocks);
  return {
    inputTokens: latest.inputTokens,
    blocks: list,
    toolsTokens,
    conversationTokens: Math.max(0, latest.inputTokens - total(list) - toolsTokens),
    compactions: latest.compactions,
  };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Without its own limit a model compacts at 90% of the raw window: no request in 509
// compactions across 45 days of local threads got past 248.7K of 272K.
const AUTO_COMPACT_SHARE = 0.9;
// Codex compacts before the limit when a pending tool output would cross it, and one message
// can be far bigger than the average. Backtested on those 45 days, counting a message as
// 1.5x the recent mean gave a median error of 0 (the plain mean overshot by 2).
export const MESSAGE_MARGIN = 1.5;

function compactionOf(rollout: Rollout | null, configured: number | null, window: number | null): ContextSnapshot["compaction"] {
  const limit = configured ?? (window ? Math.floor(window * AUTO_COMPACT_SHARE) : null);
  const current = rollout?.latestTotal ?? null;
  if (!limit || current === null) return null;
  const perMessage = rollout?.growth?.perMessage ?? null;
  let messagesLeft: number | null = null;
  if (current >= limit) messagesLeft = 0;
  else if (perMessage !== null) {
    messagesLeft = perMessage > 0 ? Math.floor((limit - current) / (perMessage * MESSAGE_MARGIN)) : Number.MAX_SAFE_INTEGER;
  }
  return { limit, current, perMessage, samples: rollout?.growth?.samples ?? 0, messagesLeft };
}

export async function contextSnapshot(view: View, threadId: string | undefined, since?: number, turnLimit?: number): Promise<ContextSnapshot> {
  const errors: string[] = [];
  const [settings, found] = await Promise.all([
    readSettings(),
    findThread(threadId, since).catch((error) => {
      errors.push(`Could not read Codex threads: ${message(error)}`);
      return null;
    }),
    loadTokenizer(),
  ]);
  if (settings.error) errors.push(settings.error);
  const row = found?.row ?? null;

  // Taken before the read, so a later wait never misses lines appended during it.
  const rolloutBytes = row?.rollout_path ? ((await stat(row.rollout_path).catch(() => null))?.size ?? null) : null;
  let rollout: Rollout | null = null;
  if (row?.rollout_path) {
    try {
      // Only an app-only panel with an explicit thread can receive prompt titles.
      rollout = await readRollout(row.id, row.rollout_path, { turnLimit, includePrompts: view === "panel" && row.id === threadId });
      if (rollout.historyMissing) errors.push("The start of this thread's history is missing, so first-request figures are unavailable.");
    } catch (error) {
      errors.push(`Could not read the thread's rollout: ${message(error)}`);
    }
  }

  const start = rollout?.start ? startOf(rollout.start) : null;
  const now = rollout?.latest ? nowOf(rollout.latest, start?.toolsTokens ?? 0) : null;
  const agents = await agentsReport(row?.cwd ?? null, rollout ? rollout.agents : null, settings);
  const limits = await modelLimits(row?.model ?? null);
  const window = settings.contextWindow ?? limits?.contextWindow ?? null;
  const compaction = compactionOf(rollout, settings.autoCompactLimit ?? limits?.autoCompact ?? null, window);
  const skills = skillsReport(rollout?.skillsCatalog ?? null, settings, window);
  const contextWindow = rollout?.contextWindow ?? null;

  return {
    view,
    thread: row
      ? { id: row.id, title: row.title, cwd: row.cwd, model: row.model, isCurrent: found!.isCurrent, rolloutBytes }
      : null,
    contextWindow,
    exactTokens: exactTokens(),
    start,
    now,
    agents: agents.agents,
    skills,
    recentTurns: rollout?.recentTurns ?? [],
    turnCount: rollout?.turnCount ?? 0,
    compaction,
    problems: findProblems({ now, contextWindow, agents: agents.agents, skills }),
    notes: agents.notes,
    errors,
    generatedAt: Date.now(),
  };
}
