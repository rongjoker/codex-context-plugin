import { App, applyDocumentTheme, applyHostFonts, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { durationText, messagesLeftText } from "../format.js";
import type { AgentsFile, Block, ContextItem, ContextSnapshot, ContextTurn, Problem, SkillChoice, SkillChoices, View } from "../types.js";

// The tab refreshes when the thread records a new model request (the server watches the
// rollout file and answers a long-poll) and when it becomes visible again; no timer polling.
const RETRY_MS = 10_000;
// Codex usually hands the tab its first result; when it doesn't, the tab asks for it.
const FIRST_RESULT_MS = 1_500;
const FIRST_TRIES = 5;
const openedAt = Date.now();
let checkedAt = Date.now();
const TICK_MS = 30_000;

const app = new App({ name: "context", version: "0.2.0" });
const root = document.getElementById("context-app")!;
let state: ContextSnapshot | null = null;
let loading = false;
let pendingRefresh: Promise<boolean> | null = null;
let turnLimit: number | undefined;
let loadingEarlier = false;
let earlierError = false;
let compactCopy: "copied" | "unavailable" | null = null;
// The open row: a problem or a context section.
let openRow: string | null = null;
let choices: SkillChoices | null = null;
let choicesLoading = false;
let choicesError: string | null = null;
const CHOICES_TTL_MS = 5 * 60_000;
let choicesAt = 0;
// Skill paths being switched, and what each was switched to.
const switching = new Set<string>();
const switched = new Map<string, boolean>();
const switchErrors = new Map<string, string>();

// The open popover: the compaction estimate or a skill's description; at most one.
let whyOpen: string | null = null;
let skillOpen: string | null = null;
const NEW_SKILL_DAYS = 7;

// ---------- formatting ----------

// Tolerates missing fields, so data from a different plugin version can't blank the tab.
const esc = (s: string | null | undefined) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const trimZero = (s: string) => s.replace(/\.0$/, "");

function compact(n: number): string {
  n = Math.max(0, Math.round(n));
  if (n < 1000) return String(n);
  if (n < 99_950) return `${trimZero((n / 1e3).toFixed(1))}K`;
  if (n < 999_500) return `${Math.round(n / 1e3)}K`;
  return `${trimZero((n / 1e6).toFixed(1))}M`;
}

// Our own counts are estimates when the tokenizer was unavailable; Codex's measured
// input totals and the context window never are.
const tk = (n: number) => `${state?.exactTokens === false ? "~" : ""}${compact(n)}`;
const int = (n: number) => n.toLocaleString("en-US");
const pct = (part: number, whole: number) => (whole > 0 ? Math.min(100, Math.max(0, (part / whole) * 100)) : 0);

function updatedText(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60_000);
  return mins < 1 ? "now" : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
}

// ---------- what fills the context ----------

type Slice = { key: string; label: string; tokens: number; hint?: string; estimated?: boolean };

const live = (b: Block) => b.tokens * b.copies;

// The categories a user can act on; the small injected blocks are grouped as "Other".
function slices(s: ContextSnapshot): Slice[] {
  const n = s.now;
  if (!n) return [];
  const pick = (key: Block["key"]) => n.blocks.filter((b) => b.key === key).reduce((sum, b) => sum + live(b), 0);
  const named = new Set<Block["key"]>(["system", "skills", "agents"]);
  const other = n.blocks.filter((b) => !named.has(b.key)).reduce((sum, b) => sum + live(b), 0);
  return [
    { key: "conv", label: "Conversation", tokens: n.conversationTokens, hint: "Estimated from input tokens after subtracting other categories", estimated: true },
    { key: "tools", label: "Tools", tokens: n.toolsTokens, hint: "Estimated tool definitions and protocol framing from the first request", estimated: true },
    { key: "skills", label: "Skills catalog", tokens: pick("skills"), hint: "One line per installed skill" },
    { key: "system", label: "System prompt", tokens: pick("system"), hint: "Codex's own instructions" },
    { key: "agents", label: "AGENTS.md", tokens: pick("agents"), hint: "Your instruction files" },
    { key: "other", label: "Other", tokens: other, hint: "Permissions, environment, app and plugin notes" },
  ].filter((slice) => slice.tokens > 0);
}

// Ring of what fills the context: one arc per category.
function donut(parts: Slice[], size: number): string {
  const whole = parts.reduce((sum, p) => sum + p.tokens, 0) || 1;
  const r = 50;
  const c = 2 * Math.PI * r;
  const gap = parts.length > 1 ? 1.2 : 0;
  let offset = 0;
  const arcs = parts
    .map((part) => {
      const length = (part.tokens / whole) * c;
      const drawn = Math.max(0.6, length - gap);
      const arc = `<circle class="arc c-${part.key}" r="${r}" cx="60" cy="60" stroke-dasharray="${drawn.toFixed(2)} ${(c - drawn).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"><title>${esc(part.label)}: ${compact(part.tokens)}</title></circle>`;
      offset += length;
      return arc;
    })
    .join("");
  return `<svg class="donut" width="${size}" height="${size}" viewBox="0 0 120 120" role="img" aria-label="Context breakdown"><g transform="rotate(-90 60 60)"><circle class="ring" r="${r}" cx="60" cy="60"></circle>${arcs}</g></svg>`;
}

// The "why" popover id for the compaction estimate under the chart.
const COMPACTION = "compaction";

function overview(s: ContextSnapshot, size: number): string {
  const n = s.now;
  if (!n) return `<section class="block"><div class="notice">No model requests recorded for this thread yet.</div></section>`;
  const window = s.contextWindow ?? n.inputTokens;
  const parts = slices(s);
  const used = Math.round(pct(n.inputTokens, window));
  const legend = parts
    .map(
      (p) => `
      <li title="${esc(p.hint ?? "")}">
        <i class="c-${p.key}"></i><span class="name">${esc(p.label)}</span>
        <span class="num">${p.estimated ? `~${compact(p.tokens)}` : tk(p.tokens)}</span><span class="share">${Math.round(pct(p.tokens, n.inputTokens))}%</span>
      </li>`,
    )
    .join("");
  const free = s.contextWindow ? `<li class="free"><i></i><span class="name">Free</span><span class="num">${compact(window - n.inputTokens)}</span><span class="share"></span></li>` : "";
  const compactions = n.compactions > 0 ? `<div class="sub small">Compacted ${n.compactions} time${n.compactions === 1 ? "" : "s"}</div>` : "";
  const left = messagesLeftText(s.compaction?.messagesLeft ?? null);
  const open = whyOpen === COMPACTION;
  const soon = left
    ? `<div class="soon small"><span>${esc(left)}</span><button class="info ${open ? "on" : ""}" type="button" data-action="why" data-id="${COMPACTION}" aria-label="How this is estimated" aria-expanded="${open}">${INFO_ICON}</button></div>`
    : "";
  return `
    <section class="block overview">
      <div class="chart">
        ${donut(parts, size)}
        <div class="center"><b>${compact(n.inputTokens)}</b><span>${s.contextWindow ? `${used}% of ${compact(window)}` : "in context"}</span></div>
      </div>
      <div class="side">
        <ul class="legend">${legend}${free}</ul>
        <div class="sub small">Total recorded by Codex. ~ marks estimates.</div>
        ${soon}
        ${compactions}
        <button class="link compact-copy" type="button" data-action="copy-compact">Copy <code>/compact</code></button>
        ${compactCopy ? `<div class="sub small" role="status">${compactCopy === "copied" ? "Paste the command in the chat and press Enter." : "Clipboard unavailable. Type /compact in the chat."}</div>` : ""}
      </div>
    </section>`;
}

// ---------- problems ----------

const INFO_ICON = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="6.3"/><path d="M8 7.2v3.8" stroke-linecap="round"/><circle cx="8" cy="5" r="0.6" fill="currentColor" stroke="none"/></svg>`;

const CHEVRON = `<svg class="chev" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>`;

// Every item, problem or not, is the same row: dot, title, value, ⓘ; it opens to its body.
// The dot carries severity for problems and is hollow for the rest; explanations live in ⓘ.
function row(id: string, kind: Problem["severity"] | "plain", title: string, value: string | null, body: () => string, subtitle?: string): string {
  const open = openRow === id;
  const why = whyOpen === id;
  const heading = `<span class="item-title">${esc(title)}</span>`;
  const label = subtitle
    ? `<span class="item-title-group" title="${esc(title)}">${heading}<span class="item-subtitle cost">${esc(subtitle)}</span></span>`
    : heading;
  return `
    <li class="item ${kind} ${open ? "open" : ""}">
      <div class="item-head" role="button" tabindex="0" data-action="row" data-id="${esc(id)}" aria-expanded="${open}">
        <i class="sev"></i>${label}${value ? `<span class="cost">${esc(value)}</span>` : ""}
        <button class="info ${why ? "on" : ""}" type="button" data-action="why" data-id="${esc(id)}" aria-label="Why" aria-expanded="${why}">${INFO_ICON}</button>
        ${CHEVRON}
      </div>
      ${open ? `<div class="item-body">${body()}</div>` : ""}
    </li>`;
}

// What the ⓘ of a context row says.
function rowInfo(id: string, s: ContextSnapshot): string | null {
  if (id.startsWith("turn-")) {
    return "Time starts when Codex begins processing the turn and includes tools and waits during the turn. Input change compares the last recorded request of this turn with the previous measured turn in the same context window.";
  }
  switch (id) {
    case "base":
      return "Codex adds this to every request, even in an empty thread; only the conversation grows. You can shrink Tools (fewer plugins and MCP servers), the skills catalog and AGENTS.md. The rest is set by Codex.";
    case "agents":
      return `The AGENTS.md files Codex loaded for this thread. Project files share a ${Math.round(s.agents.projectBudget / 1024)} KB limit.`;
    case "catalog":
      return "One line per skill, sent with every request. Turning a skill off drops it from new threads.";
    default:
      return null;
  }
}

function problemRow(p: Problem): string {
  return row(
    p.id,
    p.severity,
    p.title,
    p.cost,
    () => `<div class="fix">${esc(p.tip)}</div>${p.panel ? fixList(p) : ""}`,
  );
}

// ---------- fix lists ----------

const DAY_MS = 86_400_000;

// Short "last used" label; anything older than the scan window reads "30+ days".
function usedText(c: SkillChoice, days: number): string {
  if (!c.uses || !c.lastUsed) return isNew(c) ? "new" : `${days}+ days`;
  const ago = Math.floor((Date.now() - c.lastUsed) / DAY_MS);
  return ago < 1 ? "today" : ago === 1 ? "yesterday" : `${ago}d ago`;
}

const isOn = (c: SkillChoice) => switched.get(c.path) ?? c.enabled ?? true;
const isNew = (c: SkillChoice) => c.addedAt != null && Date.now() - c.addedAt < NEW_SKILL_DAYS * DAY_MS;
const shortName = (c: SkillChoice) => (c.plugin ? c.name.slice(c.plugin.length + 1) : c.name);

function toggle(c: SkillChoice): string {
  const on = isOn(c);
  const busy = switching.has(c.path);
  const label = busy ? "…" : on ? "Turn off" : "Turn on";
  return `<button class="btn small toggle" type="button" data-action="skill" data-path="${esc(c.path)}" data-on="${on}" ${busy ? "disabled" : ""}>${label}</button>`;
}

const GLYPHS: Record<SkillChoice["sourceKind"], string> = {
  // Person: a skill in the user's own folder.
  user: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="5.5" r="2.6"/><path d="M3 13.5c.6-2.6 2.6-4 5-4s4.4 1.4 5 4" stroke-linecap="round"/></svg>`,
  // Puzzle piece: a plugin without an icon of its own.
  plugin: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M3 5h2.5a1.5 1.5 0 1 1 3 0H11v2.5a1.5 1.5 0 1 1 0 3V13H3z"/></svg>`,
  // Cube: ships with Codex.
  builtin: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M8 2.2 13 5v6l-5 2.8L3 11V5z"/><path d="M3 5l5 2.8L13 5M8 7.8v6"/></svg>`,
  project: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M2.5 4.5h4l1.2 1.4h5.8v6.6h-11z"/></svg>`,
  other: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M2.5 4.5h4l1.2 1.4h5.8v6.6h-11z"/></svg>`,
};

// The skill's origin as an icon: the plugin's own icon when it has one; the words on hover.
function sourceIcon(c: SkillChoice): string {
  const image = c.pluginIcon ? choices?.icons?.[c.pluginIcon] : undefined;
  const inner = image ? `<img src="${esc(image)}" alt="">` : GLYPHS[c.sourceKind] ?? GLYPHS.other;
  return `<span class="src ${image ? "img" : esc(c.sourceKind)}" title="${esc(c.source)}" aria-label="${esc(c.source)}">${inner}</span>`;
}

// Where a skill lives, short: "skills/x", "skills/x/x", "plugins/pdf".
function folderOf(c: SkillChoice): string {
  const dir = tilde(c.path);
  const plugin = /plugins\/cache\/[^/]+\/([^/]+)\//.exec(dir);
  return plugin ? `plugins/${plugin[1]}` : dir.replace(/^~\/\.codex\//, "");
}

// One line per skill: origin icon, name, description behind ⓘ, last use, switch. Copies of
// one skill also show their folder.
function skillRow(c: SkillChoice, days: number, withFolder = false): string {
  const label = shortName(c);
  const on = isOn(c);
  const failed = switchErrors.get(c.path);
  const used = usedText(c, days);
  const info = `<button class="info ${skillOpen === c.path ? "on" : ""}" type="button" data-action="skillinfo" data-path="${esc(c.path)}" aria-label="What is ${esc(label)}?">${INFO_ICON}</button>`;
  return `
    <tr class="${on ? "" : "is-off"}">
      <td class="ic">${sourceIcon(c)}</td>
      <td class="nm"><span class="cname"><span class="title">${esc(label)}</span>${info}${withFolder ? `<span class="folder">${esc(folderOf(c))}</span>` : ""}</span></td>
      <td class="tok">${tk(c.tokens)}</td>
      <td class="when ${c.uses ? "" : "stale"}">${esc(used)}</td>
      <td class="sw">${toggle(c)}</td>
    </tr>
    ${failed ? `<tr class="errrow"><td></td><td colspan="4" class="small err">Couldn't turn ${on ? "off" : "on"}: ${esc(failed)}</td></tr>` : ""}`;
}

function skillTable(rows: string, nameHead: string): string {
  return `
    <table class="skills">
      <thead><tr><th colspan="2">${esc(nameHead)}</th><th class="tok">Tokens</th><th class="when">Last used</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// Unused first (by name), then skills added this week, then used ones from the longest ago.
function byUse(a: SkillChoice, b: SkillChoice): number {
  const rank = (c: SkillChoice) => (c.uses && c.lastUsed ? c.lastUsed : isNew(c) ? 1 : 0);
  return rank(a) - rank(b) || shortName(a).localeCompare(shortName(b));
}

const CHECKING = `<div class="waiting small"><i class="spinner"></i>Checking which skills you used in the last 30 days…</div>`;

// Every skill in the catalog, unused first, with its switch. The "Skills catalog full" issue
// and the "Skills catalog" row show the same list.
function skillsList(): string {
  if (choicesLoading && !choices) return CHECKING;
  if (!choices) return `<div class="sub small">${esc(choicesError ?? "Couldn't load skills.")}</div>`;
  const days = choices.days;
  const all = [...choices.entries].sort(byUse);
  return skillTable(all.map((c) => skillRow(c, days)).join(""), "Skill");
}

function fixList(p: Problem): string {
  if (p.panel === "unused-skills") return `<div class="fixlist">${skillsList()}</div>`;
  if (choicesLoading && !choices) return `<div class="fixlist">${CHECKING}</div>`;
  if (!choices) return `<div class="fixlist"><div class="sub small">${esc(choicesError ?? "Couldn't load skills.")}</div></div>`;
  const days = choices.days;
  // Duplicates: the same list, every copy of each skill, with its folder to tell them apart.
  const names = new Set((state?.skills.duplicates ?? []).filter((name) => !name.includes(":")));
  const copies = choices.entries.filter((c) => names.has(shortName(c))).sort(byUse);
  return `<div class="fixlist">${skillTable(copies.map((c) => skillRow(c, days, true)).join(""), "Skill")}</div>`;
}

const HOME = /^\/Users\/[^/]+|^\/home\/[^/]+/;
const tilde = (path: string) => path.replace(/\/SKILL\.md$/, "").replace(HOME, "~");

async function loadChoices(): Promise<void> {
  if (choicesLoading || (choices && Date.now() - choicesAt < CHOICES_TTL_MS)) return;
  choicesLoading = true;
  render();
  try {
    const result = await app.callServerTool(
      { name: "context.skills", arguments: state?.thread?.isCurrent ? { threadId: state.thread.id } : {} },
      { timeout: 120_000 },
    );
    if (!result.isError && result.structuredContent) {
      choices = result.structuredContent as unknown as SkillChoices;
      choicesAt = Date.now();
      choicesError = null;
    } else choicesError = "Couldn't load skills.";
  } catch {
    choicesError = "Couldn't load skills.";
  } finally {
    choicesLoading = false;
    render();
  }
}

async function switchSkill(path: string, on: boolean): Promise<void> {
  if (switching.has(path)) return;
  switching.add(path);
  switchErrors.delete(path);
  render();
  try {
    const result = await app.callServerTool({ name: "context.setSkill", arguments: { path, enabled: on } });
    const reply = result.structuredContent as { enabled?: boolean | null; error?: string | null } | undefined;
    if (!result.isError && typeof reply?.enabled === "boolean") {
      switched.set(path, reply.enabled);
      // Issues that depend on which skills are on (duplicates) update right away.
      void refresh();
    }
    else switchErrors.set(path, reply?.error ?? "Codex didn't accept the change.");
  } catch (error) {
    switchErrors.set(path, error instanceof Error ? error.message : "Couldn't reach the plugin.");
  } finally {
    switching.delete(path);
    render();
  }
}

function problemsSection(s: ContextSnapshot): string {
  if (!s.problems.length) {
    return `<section class="block"><div class="ok"><i></i>Nothing to fix in this thread's context.</div></section>`;
  }
  return `
    <section class="block">
      <div class="label">Issues (${s.problems.length})</div>
      <ol class="items">${s.problems.map(problemRow).join("")}</ol>
    </section>`;
}

const ITEM_KIND: Record<ContextItem["kind"], string> = {
  user: "User",
  assistant: "Assistant",
  terminal: "Terminal output",
  mcp: "MCP result",
  tool: "Tool result",
};

const TURN_STATUS: Record<ContextTurn["status"], string> = {
  "finished": "Finished",
  "in-progress": "In progress",
  "interrupted": "Interrupted",
  "incomplete": "End not recorded",
};

const turnTime = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

function turnCost(t: ContextTurn): string {
  const elapsed = t.status === "in-progress" && t.startedAt != null
    ? `${durationText(Math.max(0, Date.now() - t.startedAt))} elapsed`
    : null;
  const duration = t.durationMs != null ? durationText(t.durationMs) : elapsed ?? "Duration unavailable";
  if (t.inputDelta === null) return duration;
  const sign = t.inputDelta > 0 ? "+" : t.inputDelta < 0 ? "−" : "";
  return `${duration} · ${sign}${compact(Math.abs(t.inputDelta))} input tokens`;
}

function turnRow(t: ContextTurn): string {
  const turn = `Turn ${t.number}`;
  const title = t.prompt?.kind === "text" ? t.prompt.title
    : t.prompt?.kind === "image" ? "Image prompt"
      : t.compacted ? "Context compaction" : turn;
  return row(`turn-${t.number}`, "plain", title, null, () => `
    <div class="row">
      <span class="sub small">${turn} · ${TURN_STATUS[t.status]}${t.compacted ? " · New context window" : ""}</span>
      <span class="num small">${t.inputTokens === null ? "No input count" : `${compact(t.inputTokens)} input`}</span>
    </div>
    ${t.startedAt != null ? `<div class="sub small">Started ${esc(turnTime.format(t.startedAt))}</div>` : ""}
    ${t.durationMs == null && (t.status !== "in-progress" || t.startedAt == null) ? '<div class="sub small">Duration unavailable.</div>' : ""}
    ${t.largest.length ? `<div class="sub small">Largest recorded text items</div><ul class="list">
      ${t.largest.map((i) => `<li class="kv">
        <span class="title" title="${esc(i.label)}">${esc(i.label)}${i.kind === "user" || i.kind === "assistant" ? "" : ` <span class="sub small">· ${ITEM_KIND[i.kind]}</span>`}</span>
        <span class="num">${tk(i.tokens)}</span>
      </li>`).join("")}
    </ul>` : `<div class="sub small">No countable text was recorded for this turn.</div>`}
    ${t.skippedItems ? `<div class="sub small">${t.skippedItems} oversized record${t.skippedItems === 1 ? "" : "s"} skipped.</div>` : ""}
  `, turnCost(t));
}

function activitySection(s: ContextSnapshot): string {
  const turns = s.recentTurns;
  if (!turns?.length) return "";
  const hasEarlier = (s.turnCount ?? turns.length) > turns.length;
  return `<section class="block">
    <div class="label">Turn history</div>
    <div class="sub small">Time from when Codex begins processing. Expand a turn for token details.</div>
    <ol class="items">${turns.map(turnRow).join("")}</ol>
    ${hasEarlier ? `<button class="btn small" type="button" data-action="earlier-turns"${loadingEarlier ? " disabled" : ""}>${loadingEarlier ? "Loading…" : "Show earlier turns"}</button>` : ""}
    ${earlierError ? '<div class="err small" role="status">Could not load earlier turns. Try again.</div>' : ""}
  </section>`;
}

async function loadEarlierTurns(): Promise<void> {
  if (loadingEarlier) return;
  loadingEarlier = true;
  earlierError = false;
  render();
  await pendingRefresh;
  const shown = state?.recentTurns?.length ?? 0;
  const success = await refresh(false, shown + 10);
  loadingEarlier = false;
  earlierError = !success || ((state?.recentTurns?.length ?? 0) <= shown && (state?.turnCount ?? 0) > shown);
  render();
  root.querySelector<HTMLElement>('[data-action="earlier-turns"]')?.focus();
}

// ---------- what's in context ----------

// Everything Codex sends before the conversation; it rides along with every request.
function baseRow(s: ContextSnapshot): string {
  const st = s.start;
  if (!st) return "";
  const rows = [...st.blocks.map((b) => ({ label: b.label, tokens: b.tokens })), { label: "Tools", tokens: st.toolsTokens }]
    .filter((r) => r.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  const total = rows.reduce((sum, r) => sum + r.tokens, 0);
  const items = rows
    .map(
      (r) => `
        <li class="kv"><span>${esc(r.label)}</span><span class="num">${tk(r.tokens)}</span></li>`,
    )
    .join("");
  return row(
    "base",
    "plain",
    "Sent with every message",
    compact(total),
    () => `<ul class="list">${items}</ul>`,
  );
}

const STATUS: Record<AgentsFile["status"], string> = {
  full: "loaded",
  truncated: "cut off by the size limit",
  dropped: "skipped: size limit used up",
  shadowed: "ignored: another file in this folder wins",
  empty: "empty",
};

function agentsRow(s: ContextSnapshot): string {
  const files = s.agents.files;
  if (!files.length) return row("agents", "plain", "AGENTS.md", "none", () => `<div class="sub small">No AGENTS.md files apply to this thread.</div>`);
  const items = files
    .map((f) => {
      const loaded = f.status === "full" || f.status === "truncated";
      const status = [STATUS[f.status], f.changedSinceLoaded ? "changed since the thread started" : null].filter(Boolean).join(" · ");
      return `
        <li class="file">
          <div class="row"><span class="title" title="${esc(f.path)}">${esc(f.display)}</span><span class="num">${loaded ? tk(f.tokens) : "—"}</span></div>
          <div class="sub small">${f.scope === "global" ? "Global" : "Project"} · ${int(f.lines)} lines · ${esc(status)}</div>
        </li>`;
    })
    .join("");
  return row("agents", "plain", "AGENTS.md", tk(s.agents.loadedTokens), () => `<ul class="list">${items}</ul>`);
}

function catalogRow(s: ContextSnapshot): string {
  if (!s.skills.entries.length) return "";
  return row("catalog", "plain", "Skills catalog", `${s.skills.entries.length} skills`, skillsList);
}

function contextSection(s: ContextSnapshot): string {
  const rows = [baseRow(s), agentsRow(s), catalogRow(s)].join("");
  return `
    <section class="block">
      <div class="label">In context</div>
      <ol class="items">${rows}</ol>
    </section>`;
}

function notesSection(s: ContextSnapshot): string {
  const items = [
    ...s.errors.map((e) => `<li class="note danger"><i class="dot"></i><span>${esc(e)}</span></li>`),
    ...s.notes.map((n) => `<li class="note"><i class="dot"></i><span>${esc(n)}</span></li>`),
  ];
  return items.length ? `<section class="block"><ul class="notes">${items.join("")}</ul></section>` : "";
}

// ---------- page ----------

// Problems come most severe first, so the first one sets the pill's color.
function issuesPill(s: ContextSnapshot | null): string {
  const n = s?.problems.length ?? 0;
  if (!s || !n) return "";
  return `<span class="pill ${s.problems[0].severity}"><i></i>${n} issue${n === 1 ? "" : "s"}</span>`;
}

function header(s: ContextSnapshot | null): string {
  const t = s?.thread;
  const title = t ? t.title || "Untitled thread" : "";
  return `
    <header class="head">
      <div class="head-row">
        <h1>Thread Context</h1>
        ${issuesPill(s)}
        ${s ? `<span class="updated" title="Last checked">${updatedText(checkedAt)}</span>` : ""}
        <button class="icon-btn ${loading ? "spin" : ""}" type="button" data-action="refresh" title="Refresh" aria-label="Refresh">
          <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6"/><path d="M16.5 3.5v3.2h-3.2"/></svg>
        </button>
      </div>
      ${s ? (title ? `<div class="sub thread title">${esc(title)}</div>` : "") : ""}
    </header>`;
}

function render(): void {
  draw();
  placePopover();
}

function draw(): void {
  const s = state;
  const view: View = s?.view ?? guessView();
  document.body.dataset.view = view;
  if (!s) {
    root.innerHTML = `${header(null)}<section class="block"><div class="waiting"><i class="spinner"></i>Reading this thread…</div></section>`;
  } else if (!s.thread) {
    root.innerHTML = `${header(s)}<section class="block"><div class="notice">Send the first message — this thread's context shows up here.</div></section>${notesSection(s)}`;
  } else if (view === "inline") {
    const top = s.problems[0];
    root.innerHTML = `
      ${header(s)}
      ${overview(s, 108)}
      ${top ? `<section class="block"><ol class="items">${problemRow(top)}</ol>${s.problems.length > 1 ? `<div class="sub small">+${s.problems.length - 1} more in the Context tab</div>` : ""}</section>` : problemsSection(s)}`;
  } else {
    root.innerHTML = `
      ${header(s)}
      ${overview(s, 132)}
      ${activitySection(s)}
      ${problemsSection(s)}
      ${contextSection(s)}
      ${notesSection(s)}`;
  }
}

async function copyCompact(): Promise<void> {
  try {
    await navigator.clipboard.writeText("/compact");
    compactCopy = "copied";
  } catch {
    compactCopy = "unavailable";
  }
  render();
  root.querySelector<HTMLElement>('[data-action="copy-compact"]')?.focus();
}

root.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target) return;
  event.preventDefault();
  if (target.dataset.action === "refresh") refresh(true);
  if (target.dataset.action === "copy-compact") void copyCompact();
  if (target.dataset.action === "earlier-turns") void loadEarlierTurns();
  if (target.dataset.action === "row" && target.dataset.id) {
    openRow = openRow === target.dataset.id ? null : target.dataset.id;
    render();
    // Rows that hold a skill list load it as they open.
    if (openRow === "catalog" || state?.problems.some((p) => p.id === openRow && p.panel)) loadChoices();
  }
  if (target.dataset.action === "skill" && target.dataset.path) switchSkill(target.dataset.path, target.dataset.on !== "true");
  if (target.dataset.action === "skillinfo" && target.dataset.path) {
    skillOpen = skillOpen === target.dataset.path ? null : target.dataset.path;
    whyOpen = null;
    render();
  }
  if (target.dataset.action === "why" && target.dataset.id) {
    whyOpen = whyOpen === target.dataset.id ? null : target.dataset.id;
    skillOpen = null;
    render();
  }
});

// Row heads are not buttons (they hold the ⓘ button), so they take Enter and Space themselves.
root.addEventListener("keydown", (event) => {
  const head = event.target as HTMLElement;
  if ((event.key === "Enter" || event.key === " ") && head.dataset?.action === "row") {
    event.preventDefault();
    head.click();
  }
});

// ---------- "why" popover ----------

// Lives outside the re-rendered root and floats over the content next to its icon.
const pop = document.createElement("div");
pop.className = "pop";
pop.hidden = true;
pop.setAttribute("role", "dialog");
document.body.appendChild(pop);

const POP_WIDTH = 280;
const POP_GAP = 6;
const EDGE = 10;

// What the open popover shows and the icon it hangs from.
function popoverContent(): { anchor: HTMLElement; html: string } | null {
  const c = state?.compaction;
  if (whyOpen === COMPACTION && c) {
    const anchor = root.querySelector<HTMLElement>(`[data-action="why"][data-id="${COMPACTION}"]`);
    if (anchor) {
      const pace =
        c.perMessage !== null
          ? ` Your last ${c.samples === 1 ? "message" : `${c.samples} messages`} added ${tk(c.perMessage)} tokens${c.samples === 1 ? "" : " each on average"}.`
          : "";
      return {
        anchor,
        html: `
          <span class="basis">Estimate</span>
          <p>Codex compacts the thread at about ${compact(c.limit)} tokens and keeps only a summary, so earlier details can get lost. ${compact(c.current)} in context now.${esc(pace)}</p>
          <p class="ev">The estimate counts each message as 1.5× that, since one with long tool output can be much bigger. Checked against your past threads: right on average, though one heavy message can shift it by a few.</p>`,
      };
    }
  }
  if (whyOpen && state) {
    const anchor = root.querySelector<HTMLElement>(`[data-action="why"][data-id="${CSS.escape(whyOpen)}"]`);
    const problem = state.problems.find((p) => p.id === whyOpen);
    const info = problem ? null : rowInfo(whyOpen, state);
    if (anchor && (problem || info)) {
      return {
        anchor,
        html: problem
          ? `
            <span class="basis">${problem.basis === "measured" ? "Measured" : "Our threshold"}</span>
            <p>${esc(problem.why)}</p>
            ${problem.panel ? "<p>Changes apply to new threads.</p>" : ""}
            <p class="ev">${esc(problem.evidence)}</p>`
          : `<p>${esc(info!)}</p>`,
      };
    }
  }
  if (skillOpen) {
    const skill = choices?.entries.find((c) => c.path === skillOpen);
    const anchor = skill ? root.querySelector<HTMLElement>(`[data-action="skillinfo"][data-path="${CSS.escape(skill.path)}"]`) : null;
    if (skill && anchor) {
      return {
        anchor,
        html: `
          <span class="basis">${esc(skill.plugin ? skill.name.slice(skill.plugin.length + 1) : skill.name)}</span>
          <p>${esc(skill.description || "No description.")}</p>
          <p class="ev">${esc(skill.source)} · ${tk(skill.tokens)} tokens in the list · ${esc(tilde(skill.path))}</p>`,
      };
    }
  }
  return null;
}

function placePopover(): void {
  const content = popoverContent();
  if (!content) {
    whyOpen = null;
    skillOpen = null;
    pop.hidden = true;
    return;
  }
  const { anchor, html } = content;
  pop.innerHTML = html;
  pop.hidden = false;
  const width = Math.min(POP_WIDTH, window.innerWidth - EDGE * 2);
  pop.style.width = `${width}px`;
  const icon = anchor.getBoundingClientRect();
  const left = Math.min(Math.max(EDGE, icon.right - width), window.innerWidth - width - EDGE);
  // Below the icon, or above it when there is no room below.
  let top = icon.bottom + POP_GAP;
  if (top + pop.offsetHeight > window.innerHeight - EDGE && icon.top - POP_GAP - pop.offsetHeight > EDGE) {
    top = icon.top - POP_GAP - pop.offsetHeight;
  }
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function closePopover(): void {
  if (!whyOpen && !skillOpen) return;
  whyOpen = null;
  skillOpen = null;
  render();
}

document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  if (!pop.contains(target) && !target.closest('[data-action="why"], [data-action="skillinfo"]')) closePopover();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePopover();
});
window.addEventListener("scroll", placePopover, { passive: true });
window.addEventListener("resize", placePopover);


function guessView(): View {
  return app.getHostContext()?.toolInfo?.tool?.name === "context.inspect" ? "inline" : "panel";
}

// What the user sees, minus the timestamp: equal keys mean nothing to redraw.
const seen = (s: ContextSnapshot | null) => (s ? JSON.stringify({ ...s, generatedAt: 0 }) : "");

// Background checks stay silent; only a click on refresh shows the spinner.
function refresh(manual = false, requestedTurnLimit = turnLimit): Promise<boolean> {
  pendingRefresh ??= readSnapshot(manual, requestedTurnLimit).finally(() => { pendingRefresh = null; });
  return pendingRefresh;
}

async function readSnapshot(manual: boolean, requestedTurnLimit: number | undefined): Promise<boolean> {
  loading = true;
  if (manual) render();
  const before = seen(state);
  try {
    const result = await app.callServerTool({
      name: "context.refresh",
      arguments: {
        view: state?.view ?? guessView(),
        ...(state?.thread?.isCurrent ? { threadId: state.thread.id } : { since: openedAt }),
        ...(requestedTurnLimit != null ? { turnLimit: requestedTurnLimit } : {}),
      },
    });
    if (!result.isError && result.structuredContent) {
      state = result.structuredContent as unknown as ContextSnapshot;
      checkedAt = Date.now();
      turnLimit = requestedTurnLimit;
      return true;
    }
  } catch {
    // Keep the last snapshot; the next tick retries.
  } finally {
    loading = false;
    if (manual || seen(state) !== before) render();
  }
  return false;
}

function applyContext(ctx: ReturnType<App["getHostContext"]>): void {
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx?.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  // Codex reports areas covered by its own chrome, e.g. the composer over sidebar apps.
  const insets = ctx?.safeAreaInsets;
  if (insets) {
    for (const side of ["top", "right", "bottom", "left"] as const) {
      document.documentElement.style.setProperty(`--safe-${side}`, `${insets[side] ?? 0}px`);
    }
  }
}

app.ontoolresult = (result) => {
  if (result.structuredContent) {
    state = result.structuredContent as unknown as ContextSnapshot;
    checkedAt = Date.now();
    render();
    follow();
  }
};
app.addEventListener("hostcontextchanged", applyContext);
render();
app.connect().then(async () => {
  applyContext(app.getHostContext());
  render();
  for (let i = 0; i < FIRST_TRIES && !state; i++) {
    await new Promise((r) => setTimeout(r, FIRST_RESULT_MS));
    if (state) break;
    await refresh();
    if (state) follow();
  }
});

// One long-poll at a time; a newer loop (e.g. after the tab became visible) retires older ones.
let loop = 0;
async function follow(): Promise<void> {
  const mine = ++loop;
  while (mine === loop && state && state.view !== "inline" && document.visibilityState === "visible") {
    const t = state.thread;
    const started = Date.now();
    try {
      const result = await app.callServerTool({
        name: "context.wait",
        arguments: t?.isCurrent ? { threadId: t.id, ...(t.rolloutBytes != null ? { size: t.rolloutBytes } : {}) } : { since: openedAt },
      });
      if (mine !== loop) return;
      if ((result.structuredContent as { changed?: boolean } | undefined)?.changed) await refresh();
      // A wait that ends at once with nothing new (e.g. no rollout yet) must not spin.
      else if (Date.now() - started < 1000) await new Promise((r) => setTimeout(r, RETRY_MS));
    } catch {
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
}

function wake(): void {
  if (!state || state.view === "inline" || document.visibilityState !== "visible") return;
  refresh().then(follow);
}

// The inline view stays a snapshot of when it was posted; tabs keep themselves current.
setInterval(() => {
  if (state && !loading) render();
}, TICK_MS);
setInterval(() => {
  const turn = state?.recentTurns?.[0];
  if (state?.view !== "panel" || document.visibilityState !== "visible"
    || turn?.status !== "in-progress" || turn.startedAt == null) return;
  const cost = root.querySelector<HTMLElement>(`[data-id="turn-${turn.number}"][data-action="row"] .item-subtitle`);
  if (cost) cost.textContent = turnCost(turn);
}, 1000);
document.addEventListener("visibilitychange", wake);
window.addEventListener("focus", wake);
