// The skills catalog a thread carries: one line per skill, charged against a budget that
// Codex meters in its own units, ceil((utf8 bytes + 1) / 4) per line.
import { join } from "node:path";
import type { ContextSnapshot, SkillEntry } from "../types.js";
import type { Settings } from "./config.js";
import { skillKey } from "./skillusage.js";
import { countTokens } from "./tokens.js";

const LOCATORS = [" (file: ", " (executor package: ", " (cloud package: ", " (custom resource: "];
const MAX_CONFIGURED_BUDGET = 10_000;
const WINDOW_PERCENT = 2;
const FULL = 0.97;

const approx = (text: string) => Math.ceil(Buffer.byteLength(text) / 4);
const units = (line: string) => approx(line + "\n");

// Codex charges the skill roots table as the extra cost of the aliased catalog header over
// the plain one, which opens with this intro.
const PLAIN_INTRO =
  "A skill is a set of instructions provided through a `SKILL.md` source. Below is the list of skills that can be used. Each entry includes a name, description, and source locator. `file` locators are on the host filesystem, `executor package` locators are owned by their execution environment, `cloud package` locators are opaque package identifiers, and `custom resource` locators use their provider's access mechanism.";

function rootsOverhead(lines: string[]): number {
  const top = lines.indexOf("## Skills");
  const available = lines.indexOf("### Available skills");
  if (top < 0 || available < top || !lines.includes("### Skill roots")) return 0;
  const aliased = `\n${lines.slice(top, available + 1).join("\n")}\n`;
  const plain = `\n${["## Skills", PLAIN_INTRO, "### Available skills"].join("\n")}\n`;
  return Math.max(0, approx(aliased) - approx(plain));
}

// "- `r0` = `/abs/root`": aliases that file locators start with.
const ROOT = /^- `(r\d+)` = `(.+)`$/;

// "- name: description (file: r0/x/SKILL.md)". Names may hold a bare ":" (plugin:skill) and
// descriptions may hold anything, so cut the locator from the right and the name at the
// first ": ". Older catalogs give absolute paths instead of root aliases.
function parseLine(line: string, roots: Map<string, string>): Omit<SkillEntry, "tokens" | "units"> {
  let head = line.slice(2);
  let path: string | null = null;
  const cut = Math.max(...LOCATORS.map((locator) => head.lastIndexOf(locator)));
  if (cut >= 0 && head.endsWith(")")) {
    const locator = head.slice(cut + 2, -1);
    if (locator.startsWith("file: ")) {
      const file = locator.slice(6);
      const slash = file.indexOf("/");
      const alias = slash > 0 ? roots.get(file.slice(0, slash)) : undefined;
      path = alias ? join(alias, file.slice(slash + 1)) : file.startsWith("/") ? file : null;
    }
    head = head.slice(0, cut);
  }
  const at = head.indexOf(": ");
  const name = at >= 0 ? head.slice(0, at) : head.replace(/:$/, "");
  const namespace = name.indexOf(":");
  return { name, plugin: namespace > 0 ? name.slice(0, namespace) : null, path, description: at >= 0 ? head.slice(at + 2) : "" };
}

export function skillsReport(
  catalog: string | null,
  settings: Settings,
  contextWindow: number | null,
): ContextSnapshot["skills"] {
  const lines = catalog?.split("\n") ?? [];
  const entries: SkillEntry[] = [];
  const roots = new Map<string, string>();
  let section = "";
  for (const line of lines) {
    if (line.startsWith("#")) section = line;
    else if (section === "### Skill roots") {
      const root = ROOT.exec(line);
      if (root) roots.set(root[1], root[2]);
    } else if (section === "### Available skills" && line.startsWith("- ")) {
      entries.push({ ...parseLine(line, roots), tokens: countTokens(line), units: units(line) });
    }
  }

  const budgetUnits = settings.skillsMaxTokens
    ? Math.min(settings.skillsMaxTokens, MAX_CONFIGURED_BUDGET)
    : contextWindow
      ? Math.max(1, Math.floor((contextWindow * WINDOW_PERCENT) / 100))
      : null;
  const totalUnits = rootsOverhead(lines) + entries.reduce((sum, e) => sum + e.units, 0);

  // A copy turned off since the thread started no longer counts: new threads won't list it.
  const off = new Set(settings.disabledSkills.map(skillKey));
  const counts = new Map<string, number>();
  for (const { name, path } of entries) {
    if (path && off.has(skillKey(path))) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const duplicates: string[] = [];
  for (const [name, n] of counts) {
    if (n > 1) duplicates.push(name);
    // A skill folder that is also a plugin shows up both bare and as name:name.
    const namespaced = `${name}:${name}`;
    if (!name.includes(":") && counts.has(namespaced)) duplicates.push(name, namespaced);
  }

  return {
    entries,
    tokens: entries.reduce((sum, e) => sum + e.tokens, 0),
    units: totalUnits,
    budgetUnits,
    duplicates: [...new Set(duplicates)],
  };
}

// Codex shortens descriptions only when the full lines would not fit, and then fills the
// budget, so a nearly full catalog is a shortened one.
export const catalogFull = (skills: ContextSnapshot["skills"]) =>
  skills.budgetUnits != null && skills.units >= skills.budgetUnits * FULL;
