// Builds preview/gallery-fixture.json: every issue and state the Context tab can show, with
// issues computed by the server's own rules from demo threads. Run `npm run gallery`.
import { readFileSync, writeFileSync } from "node:fs";
import { findProblems } from "../src/server/problems.js";
import { MESSAGE_MARGIN } from "../src/server/snapshot.js";
import type { AgentsFile, Block, ContextSnapshot, SkillChoice, SkillChoices, SkillEntry } from "../src/types.js";

const dir = `${process.cwd()}/preview/`; // run from the repo root
const fixture = JSON.parse(readFileSync(dir + "fixture.json", "utf8"));
const base: ContextSnapshot = fixture.panel.structuredContent;
const baseChoices: SkillChoices = fixture.skills;
const DAY = 86_400_000;
const now = Date.now();

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// ---------- a healthy thread to vary ----------

const HOME = "/Users/demo";
const ROOT = `${HOME}/Projects/Demo`;

function file(over: Partial<AgentsFile> & Pick<AgentsFile, "path" | "display">): AgentsFile {
  return {
    scope: "project",
    kind: "AGENTS.md",
    status: "full",
    shadowedBy: null,
    tokens: 600,
    fileTokens: 600,
    bytes: 2500,
    lines: 48,
    changedSinceLoaded: false,
    ...over,
  };
}

const GLOBAL = file({ path: `${HOME}/.codex/AGENTS.md`, display: "~/.codex/AGENTS.md", scope: "global", tokens: 262, fileTokens: 262, bytes: 1090, lines: 21 });
const PROJECT = file({ path: `${ROOT}/AGENTS.md`, display: "AGENTS.md", tokens: 640, fileTokens: 640, bytes: 2700, lines: 52 });

function healthy(): ContextSnapshot {
  const s = clone(base);
  s.generatedAt = now;
  s.errors = [];
  s.notes = [];
  s.agents = { files: [GLOBAL, PROJECT], projectRoot: ROOT, projectBytes: PROJECT.bytes, projectBudget: 32_768, loadedTokens: 940 };
  s.skills = { ...s.skills, units: 4210, tokens: 4180, budgetUnits: 5440, duplicates: [] };
  for (const blocks of [s.start!.blocks, s.now!.blocks]) {
    for (const b of blocks) {
      b.copies = 1;
      if (b.key === "skills") b.tokens = 4180;
      if (b.key === "agents") b.tokens = 940;
    }
  }
  s.now!.compactions = 0;
  return setInput(s, 52_400);
}

// Keeps the donut consistent: conversation is whatever the fixed parts leave.
function setInput(s: ContextSnapshot, input: number): ContextSnapshot {
  const now = s.now!;
  now.inputTokens = input;
  const fixed = now.blocks.reduce((sum, b) => sum + b.tokens * b.copies, 0) + now.toolsTokens;
  now.conversationTokens = Math.max(0, input - fixed);
  return pace(s, s.compaction?.perMessage ?? 5200);
}

// The compaction estimate, worked out the way the server does; null growth: no message done yet.
const LIMIT = 244_800;
function pace(s: ContextSnapshot, perMessage: number | null, samples = 5): ContextSnapshot {
  const current = s.now!.inputTokens + 320;
  const messagesLeft =
    current >= LIMIT ? 0 : perMessage === null ? null : Math.floor((LIMIT - current) / (perMessage * MESSAGE_MARGIN));
  s.compaction = { limit: LIMIT, current, perMessage, samples: perMessage === null ? 0 : samples, messagesLeft };
  return s;
}

function block(s: ContextSnapshot, key: Block["key"]): Block {
  return s.now!.blocks.find((b) => b.key === key)!;
}

function solve(s: ContextSnapshot): ContextSnapshot {
  s.problems = findProblems({ now: s.now, contextWindow: s.contextWindow, agents: s.agents, skills: s.skills });
  return s;
}

// ---------- variations ----------

function contextAt(fraction: number) {
  const s = healthy();
  s.now!.compactions = 2;
  return pace(setInput(s, Math.round(s.contextWindow! * fraction)), 9100);
}

function early(perMessage: number | null) {
  const s = healthy();
  return pace(setInput(s, 38_600), perMessage, 2);
}

function agentsCut(kind: "truncated" | "dropped") {
  const s = healthy();
  const nested = file({
    path: `${ROOT}/apps/desktop/AGENTS.md`,
    display: "apps/desktop/AGENTS.md",
    status: kind,
    tokens: kind === "truncated" ? 880 : 0,
    fileTokens: 3050,
    bytes: 12_650,
    lines: 140,
  });
  const big = file({ path: `${ROOT}/AGENTS.md`, display: "AGENTS.md", tokens: 5900, fileTokens: 5900, bytes: 24_600, lines: 180 });
  s.agents.files = [GLOBAL, big, nested];
  s.agents.projectBytes = big.bytes + nested.bytes;
  s.agents.loadedTokens = 262 + 5900 + nested.tokens;
  block(s, "agents").tokens = s.agents.loadedTokens;
  // Keep "AGENTS.md is long" out of this frame.
  return { s, keepOnly: "agents-cut" };
}

function skillsAt(units: number) {
  const s = healthy();
  s.skills.units = units;
  s.skills.tokens = Math.round(units * 0.98);
  block(s, "skills").tokens = s.skills.tokens;
  return s;
}

function resent(key: "skills" | "agents", copies: number) {
  const s = healthy();
  block(s, key).copies = copies;
  return setInput(s, 61_000);
}

function agentsLong() {
  const s = healthy();
  const long = file({ path: `${ROOT}/AGENTS.md`, display: "AGENTS.md", tokens: 3400, fileTokens: 3400, bytes: 14_100, lines: 264 });
  s.agents.files = [GLOBAL, long];
  s.agents.projectBytes = long.bytes;
  s.agents.loadedTokens = 3662;
  block(s, "agents").tokens = 3662;
  return s;
}

const DUP_NAMES = [
  "tidy-prose",
  "commit-poet",
  "api-mock-maker",
  "sql-explainer",
  "emoji-police",
  "css-untangler",
  "log-detective",
  "readme-polisher",
  "regex-whisperer",
  "i18n-sweeper",
];

function dupEntries(name: string, i: number): SkillEntry[] {
  const tokens = 90 + ((i * 37) % 80);
  return [
    { name, plugin: null, path: `${HOME}/.codex/skills/${name}/SKILL.md`, description: "", tokens, units: tokens + 2 },
    { name: `${name}:${name}`, plugin: name, path: `${HOME}/.codex/plugins/cache/demo/${name}/1.0.0/skills/${name}/SKILL.md`, description: "", tokens, units: tokens + 2 },
  ];
}

function duplicates(n: number) {
  const s = healthy();
  const names = DUP_NAMES.slice(0, n);
  const keep = s.skills.entries.filter((e) => !names.some((d) => e.name === d || e.name.endsWith(`:${d}`)));
  s.skills.entries = [...keep, ...names.flatMap(dupEntries)];
  s.skills.duplicates = names.flatMap((d) => [d, `${d}:${d}`]);
  return s;
}

function agentsChanged() {
  const s = healthy();
  s.agents.files = [GLOBAL, { ...PROJECT, changedSinceLoaded: true, fileTokens: 720 }];
  return s;
}

function everything() {
  const s = contextAt(0.82);
  const cut = agentsCut("truncated").s;
  s.agents = cut.agents;
  s.agents.files = s.agents.files.map((f) => (f.display === "AGENTS.md" ? { ...f, changedSinceLoaded: true } : f));
  block(s, "agents").tokens = s.agents.loadedTokens;
  block(s, "agents").copies = 2;
  block(s, "skills").copies = 3;
  s.skills.units = 5440;
  s.skills.tokens = 5320;
  block(s, "skills").tokens = 5320;
  const dup = duplicates(3).skills;
  s.skills.entries = dup.entries;
  s.skills.duplicates = dup.duplicates;
  return setInput(s, Math.round(s.contextWindow! * 0.82));
}

// ---------- skill lists shown in opened rows ----------

function dupChoices(n: number, offIndex: number | null = null): SkillChoices {
  const names = DUP_NAMES.slice(0, n);
  const keep = baseChoices.entries.filter((c) => !names.includes(c.plugin ? c.name.slice(c.plugin.length + 1) : c.name));
  const copies: SkillChoice[] = names.flatMap((name, i) => {
    const used = i % 3 !== 2;
    const own: SkillChoice = {
      name,
      plugin: null,
      path: `${HOME}/.codex/skills/${name}/SKILL.md`,
      description: `Demo skill “${name}”: what it does, in one or two sentences.`,
      source: "Your skills folder",
      sourceKind: "user",
      pluginIcon: null,
      addedAt: now - 90 * DAY,
      tokens: 90 + ((i * 37) % 80),
      uses: used ? 3 + i : 0,
      lastUsed: used ? now - (2 + i * 3) * DAY : null,
      enabled: true,
    };
    const plugin: SkillChoice = {
      ...own,
      name: `${name}:${name}`,
      plugin: name,
      path: `${HOME}/.codex/plugins/cache/demo/${name}/1.0.0/skills/${name}/SKILL.md`,
      source: `Your plugin "${name}"`,
      sourceKind: "plugin",
      pluginIcon: i % 2 === 0 ? "demo/launchpad" : null,
      uses: used ? 1 : 0,
      lastUsed: used ? now - (20 + i) * DAY : null,
      enabled: offIndex === i ? false : true,
    };
    return [own, plugin];
  });
  return { ...baseChoices, entries: [...keep, ...copies] };
}

// ---------- frames ----------

type Frame = {
  key: string;
  group: string;
  caption: string;
  note?: string;
  tool?: string;
  view?: "panel" | "inline";
  width?: number;
  snapshot: { content: { type: "text"; text: string }[]; structuredContent: ContextSnapshot | Record<string, unknown> };
  choices?: SkillChoices;
  skills?: "never"; // context.skills never answers (loading state)
  setSkillError?: string;
  skipResult?: boolean; // the host never sends the first result
  steps?: { click: string; wait?: number }[];
};

const wrap = (s: ContextSnapshot | Record<string, unknown>) => ({ content: [{ type: "text" as const, text: "" }], structuredContent: s });
const only = (s: ContextSnapshot, id?: string) => {
  solve(s);
  if (id) s.problems = s.problems.filter((p) => p.id === id);
  return wrap(s);
};

const CARDS = "Issues, one at a time (row opened)";
const frames: Frame[] = [];
// Single-issue frames open their row so the body shows; frames with steps set their own.
const add = (f: Frame) => {
  const first = (f.snapshot.structuredContent as ContextSnapshot).problems?.[0];
  if (f.group === CARDS && !f.steps && first) f.steps = [ROW(first.id)];
  frames.push(f);
};
const ROW = (id: string, wait = 300) => ({ click: `[data-action="row"][data-id="${id}"]`, wait });

add({ key: "ok", group: CARDS, caption: "Nothing to fix", snapshot: only(healthy()) });
add({ key: "ctx-78", group: CARDS, caption: "Context 78% full", note: "Warns from 75%.", snapshot: only(contextAt(0.78)) });
add({ key: "ctx-93", group: CARDS, caption: "Context 93% full", note: "Codex compacts at about 245K (95% here), so this issue never goes higher.", snapshot: only(contextAt(0.93)) });
add({ key: "cut-trunc", group: CARDS, caption: "AGENTS.md cut off: file truncated", snapshot: only(agentsCut("truncated").s, "agents-cut") });
add({ key: "cut-drop", group: CARDS, caption: "AGENTS.md cut off: file skipped", snapshot: only(agentsCut("dropped").s, "agents-cut") });
add({ key: "skills-100", group: CARDS, caption: "Skills catalog full", note: "Shows from 97% of the budget.", snapshot: only(skillsAt(5440)) });
add({ key: "resent-skills-2", group: CARDS, caption: "Skills catalog sent twice", snapshot: only(resent("skills", 2)) });
add({ key: "resent-skills-3", group: CARDS, caption: "Skills catalog sent 3 times", snapshot: only(resent("skills", 3)) });
add({ key: "resent-agents", group: CARDS, caption: "AGENTS.md sent twice", snapshot: only(resent("agents", 2)) });
add({ key: "agents-long", group: CARDS, caption: "AGENTS.md is long", snapshot: only(agentsLong()) });
add({ key: "dup-1", group: CARDS, caption: "Duplicate skill: 1", snapshot: only(duplicates(1)) });
add({ key: "dup-2", group: CARDS, caption: "Duplicate skills: 2", snapshot: only(duplicates(2)) });
add({ key: "dup-10", group: CARDS, caption: "Duplicate skills: 10", snapshot: only(duplicates(10)) });
add({ key: "changed", group: CARDS, caption: "Old AGENTS.md in use", snapshot: only(agentsChanged()) });

const PACE = "Messages until Codex compacts";
add({ key: "pace-50", group: PACE, caption: "Early in a thread", note: "Shown as 50+ past 50.", snapshot: only(early(2400)) });
add({ key: "pace-none", group: PACE, caption: "First message still running", note: "No estimate until a message finishes.", snapshot: only(early(null)) });
add({
  key: "pace-why",
  group: PACE,
  caption: "How it's estimated (ⓘ)",
  snapshot: only(contextAt(0.78)),
  steps: [{ click: '[data-action="why"][data-id="compaction"]', wait: 200 }],
});

const MIX = "Combinations";
add({ key: "all", group: MIX, caption: "Everything at once", note: "Sorted by severity, then by cost.", snapshot: only(everything()) });
add({ key: "fixture", group: MIX, caption: "Demo thread from the README", snapshot: fixture.panel });
add({
  key: "readme",
  group: MIX,
  caption: "README screenshot",
  snapshot: fixture.panel,
  steps: [{ click: '[data-action="row"][data-id="skills-full"]', wait: 900 }],
});

const OPEN = "Opened lists and popovers";
add({
  key: "open-skills",
  group: OPEN,
  caption: "Skills catalog full, opened",
  snapshot: only(skillsAt(5440)),
  steps: [ROW("skills-full")],
});
add({
  key: "open-dups",
  group: OPEN,
  caption: "10 duplicate skills, opened",
  note: "A copy you turn off leaves the list on the next refresh.",
  snapshot: only(duplicates(10)),
  choices: dupChoices(10),
  steps: [ROW("skills-duplicated")],
});
add({
  key: "all-closed",
  group: OPEN,
  caption: "Everything closed",
  note: "How the tab opens: one row per item.",
  snapshot: only(everything()),
});
add({
  key: "row-why",
  group: OPEN,
  caption: "ⓘ on a row",
  snapshot: only(skillsAt(5440)),
  steps: [{ click: '[data-action="why"][data-id="skills-full"]', wait: 200 }],
});
add({
  key: "skillinfo",
  group: OPEN,
  caption: "Skill description popover (ⓘ in the list)",
  snapshot: only(skillsAt(5440)),
  steps: [ROW("skills-full"), { click: '[data-action="skillinfo"]', wait: 200 }],
});
add({
  key: "skills-section",
  group: OPEN,
  caption: "Skills catalog row",
  note: "The same list as Show skills.",
  snapshot: only(healthy()),
  steps: [ROW("catalog", 900)],
});
add({
  key: "base-section",
  group: OPEN,
  caption: "Sent with every message",
  snapshot: only(healthy()),
  steps: [ROW("base")],
});
add({
  key: "loading",
  group: OPEN,
  caption: "Skill list loading",
  snapshot: only(skillsAt(5440)),
  skills: "never",
  steps: [ROW("skills-full")],
});
add({
  key: "turn-off-error",
  group: OPEN,
  caption: "Turn off failed",
  snapshot: only(skillsAt(5440)),
  setSkillError: "codex app-server exited (1)",
  steps: [ROW("skills-full"), { click: '[data-action="skill"]', wait: 900 }],
});

const OTHER = "Other screens";
add({ key: "no-first-result", group: OTHER, caption: "Codex didn't send the first result", note: "The tab asks for it after 1.5 s; a spinner until then.", snapshot: only(healthy()), skipResult: true });
add({ key: "legacy", group: OTHER, caption: "Old thread (before Codex kept its context data)", snapshot: fixture.legacy });
add({ key: "empty", group: OTHER, caption: "No thread found", snapshot: fixture.empty });
add({ key: "inline", group: OTHER, caption: "Inline in chat", tool: "context.inspect", view: "inline", width: 640, snapshot: fixture.inline });

writeFileSync(dir + "gallery-fixture.json", JSON.stringify({ skills: baseChoices, frames }, null, 1) + "\n");
console.log(`${frames.length} frames → preview/gallery-fixture.json`);
