// Turns what the snapshot measured into issues a user can act on. Each one carries a short
// tip for its row and, behind the info icon, why it matters and how we know.
import type { ContextSnapshot, Problem } from "../types.js";
import { catalogFull } from "./skills.js";

type Input = Pick<ContextSnapshot, "now" | "contextWindow" | "agents" | "skills">;
type Ranked = Problem & { weight: number };

const CONTEXT_FULL = 0.75;
const AGENTS_LARGE_TOKENS = 2000;
const AGENTS_LONG_LINES = 200;
const TOP_SKILLS = 3;
const SEVERITY = { high: 0, medium: 1, low: 2 };

const k = (n: number) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "")}K`);
const kb = (n: number) => `${Math.round(n / 1024)} KB`;
const int = (n: number) => n.toLocaleString("en-US");
const perRequest = (tokens: number) => `${k(tokens)} / request`;
const list = (names: string[]) => (names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

function contextFull({ now, contextWindow }: Input): Ranked | null {
  if (!now || !contextWindow) return null;
  const used = now.inputTokens / contextWindow;
  if (used < CONTEXT_FULL) return null;
  return {
    id: "context-full",
    severity: "high",
    title: `Context ${Math.round(used * 100)}% full`,
    cost: null,
    tip: "Wrap up and continue in a new thread",
    why: `${k(now.inputTokens)} of ${k(contextWindow)} in use. Near the limit Codex compacts the thread and keeps only a summary, so earlier details can get lost.`,
    evidence: `The latest request used ${int(now.inputTokens)} of ${int(contextWindow)} tokens. Warning at 75% is our threshold.`,
    basis: "rule",
    panel: null,
    weight: now.inputTokens,
  };
}

function agentsCut({ agents }: Input): Ranked | null {
  const cut = agents.files.filter((f) => f.status === "truncated" || f.status === "dropped");
  if (!cut.length) return null;
  const lost = cut.reduce((sum, f) => sum + Math.max(0, f.fileTokens - f.tokens), 0);
  return {
    id: "agents-cut",
    severity: "high",
    title: "AGENTS.md cut off",
    cost: `${k(lost)} ignored`,
    tip: "Shorten it or move parts into skills",
    why: `Project AGENTS.md files share a ${kb(agents.projectBudget)} limit and add up to ${kb(agents.projectBytes)}, so the rest never reaches the model. ${cut
      .map((f) => (f.status === "dropped" ? `${f.display} is skipped.` : `${f.display} is cut off.`))
      .join(" ")}`,
    evidence: "Codex's project_doc_max_bytes rule (32,768 bytes by default), checked against Codex's source.",
    basis: "measured",
    panel: null,
    weight: lost,
  };
}

function skillsFull({ skills, now }: Input): Ranked | null {
  if (!catalogFull(skills)) return null;
  // The block in context also carries the catalog's intro and roots table.
  const tokens = now?.blocks.find((b) => b.key === "skills")?.tokens ?? skills.tokens;
  const largest = [...skills.entries].sort((a, b) => b.tokens - a.tokens).slice(0, TOP_SKILLS);
  const budget = skills.budgetUnits!;
  return {
    id: "skills-full",
    severity: "medium",
    title: "Skills catalog full",
    cost: perRequest(tokens),
    tip: "Turn off skills you haven't used lately",
    why: `${skills.entries.length} skills fill the whole budget (${int(skills.units)} of ${int(budget)}), so Codex shortens every skill description to fit.${
      largest.length ? ` Largest: ${largest.map((s) => s.name).join(", ")}.` : ""
    }`,
    evidence: "Budget is 2% of the model's context window, counted the way Codex does: (bytes + 1) / 4 per catalog line.",
    basis: "measured",
    panel: "unused-skills",
    weight: tokens,
  };
}

// A standalone skill that is also installed as a plugin appears as "x" and "x:x".
function skillsDuplicated({ skills }: Input): Ranked | null {
  const names = skills.duplicates.filter((name) => !name.includes(":"));
  if (!names.length) return null;
  const copies = names.map((name) => {
    const standalone = skills.entries.find((e) => e.name === name);
    const plugin = skills.entries.find((e) => e.name === `${name}:${name}`);
    return { name, extra: Math.min(standalone?.tokens ?? 0, plugin?.tokens ?? 0) };
  });
  const extra = copies.reduce((sum, c) => sum + c.extra, 0);
  return {
    id: "skills-duplicated",
    severity: "low",
    title: names.length === 1 ? "Duplicate skill" : `${names.length} duplicate skills`,
    cost: perRequest(extra),
    tip: "Turn off one copy of each",
    why: `${list(names)} ${names.length === 1 ? "is" : "are each"} installed twice, on ${names.length === 1 ? "its" : "their"} own and inside a plugin, so the catalog lists ${names.length === 1 ? "it" : "them"} twice.`,
    evidence: "The catalog lists both “name” and “name:name”. Matched by name, so most likely the same skill.",
    basis: "measured",
    panel: "duplicate-skills",
    weight: extra,
  };
}

function resent({ now }: Input): Ranked[] {
  return (now?.blocks ?? [])
    .filter((b) => (b.key === "agents" || b.key === "skills") && b.copies > 1)
    .map((b) => {
      const extra = b.tokens * (b.copies - 1);
      return {
        id: `resent-${b.key}`,
        severity: b.key === "skills" ? ("medium" as const) : ("low" as const),
        title: `${b.label} sent ${b.copies === 2 ? "twice" : `${b.copies} times`}`,
        cost: `+${perRequest(extra)}`,
        tip: "Start a new thread to drop old copies",
        why: `${b.key === "skills" ? "Your skills changed after this thread started (a plugin was installed or updated, or a skill turned on or off)" : "AGENTS.md changed after this thread started"}, so Codex sent it again. Old copies stay in context until the thread is compacted.`,
        evidence: `This thread's history holds ${b.copies} copies of it since the last compaction.`,
        basis: "measured" as const,
        panel: null,
        weight: extra,
      };
    });
}

function agentsLarge({ agents }: Input): Ranked | null {
  const long = agents.files.filter((f) => (f.status === "full" || f.status === "truncated") && f.lines > AGENTS_LONG_LINES);
  if (agents.loadedTokens < AGENTS_LARGE_TOKENS && !long.length) return null;
  return {
    id: "agents-large",
    severity: "medium",
    title: "AGENTS.md is long",
    cost: perRequest(agents.loadedTokens),
    tip: "Trim what Codex can read from the code",
    why: `Long instruction files bury the rules that matter.${long.length ? ` ${long.map((f) => `${f.display}: ${f.lines} lines.`).join(" ")}` : ""}`,
    evidence: "Our threshold: over 2,000 tokens or 200 lines, after Anthropic's guidance for CLAUDE.md. Codex has no such rule.",
    basis: "rule",
    panel: null,
    weight: agents.loadedTokens,
  };
}

function changed({ agents }: Input): Ranked | null {
  // The global file is re-read on every turn; project files only when a thread starts.
  const stale = agents.files.filter((f) => f.scope === "project" && f.changedSinceLoaded);
  if (!stale.length) return null;
  return {
    id: "agents-changed",
    severity: "low",
    title: "Old AGENTS.md in use",
    cost: null,
    tip: "Start a new thread to pick up your edits",
    why: `${stale.map((f) => f.display).join(", ")} changed after this thread started; the thread keeps the old text.`,
    evidence: "The text this thread loaded differs from the file on disk now.",
    basis: "measured",
    panel: null,
    weight: 0,
  };
}

export function findProblems(input: Input): Problem[] {
  const found = [
    contextFull(input),
    agentsCut(input),
    skillsFull(input),
    ...resent(input),
    agentsLarge(input),
    skillsDuplicated(input),
    changed(input),
  ].filter((p): p is Ranked => p !== null);
  found.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || b.weight - a.weight);
  return found.map(({ weight: _weight, ...problem }) => problem);
}
