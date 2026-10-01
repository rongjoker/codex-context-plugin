// The skills in a thread's catalog with how often each was used lately and whether it is
// on, plus switching one on or off through Codex's own API (skills/config/write).
import { readFile, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { AppServer } from "./appserver.js";
import { codexHome } from "./paths.js";
import type { SkillChoice, SkillChoices } from "../types.js";
import { contextSnapshot } from "./snapshot.js";
import { countTokens } from "./tokens.js";
import { skillKey, skillUsage, USAGE_DAYS } from "./skillusage.js";

declare const __VERSION__: string;

const codex = new AppServer({ name: "codex-context-plugin", title: "Context", version: __VERSION__ });

type Listed = {
  data?: {
    skills?: { name?: string; path?: string; enabled?: boolean; description?: string; shortDescription?: string; pluginId?: string | null }[];
  }[];
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

type Source = { label: string; kind: SkillChoice["sourceKind"]; pluginRoot: string | null };

function sourceOf(path: string, cwd: string | null): Source {
  const unix = path.replace(/\\/g, "/");
  const plugin = /^(.*plugins\/cache\/([^/]+)\/([^/]+)\/[^/]+)\//.exec(unix);
  if (plugin) {
    const [, root, marketplace, name] = plugin;
    const label = marketplace.startsWith("openai")
      ? `OpenAI plugin "${name}"`
      : marketplace === "personal"
        ? `Your plugin "${name}"`
        : `Plugin "${name}" from ${marketplace}`;
    return { label, kind: "plugin", pluginRoot: root };
  }
  const home = codexHome().replace(/\\/g, "/");
  if (unix.startsWith(`${home}/skills/.system/`)) return { label: "Built-in", kind: "builtin", pluginRoot: null };
  const own = unix.startsWith(`${home}/skills/`) ? unix.slice(home.length + 8).split("/") : null;
  if (own) {
    // skills/<name>/SKILL.md is the usual place; anything deeper is a copy inside that folder.
    const label = own.length <= 2 ? "Your skills folder" : `Nested copy inside ~/.codex/skills/${own[0]}`;
    return { label, kind: "user", pluginRoot: null };
  }
  if (cwd && path.startsWith(cwd + sep)) return { label: "This project", kind: "project", pluginRoot: null };
  return { label: "Other folder", kind: "other", pluginRoot: null };
}

// A plugin's own icon from its manifest, as a data URL; skipped when too big to inline.
const ICON_MAX_BYTES = 64 * 1024;
const MIME: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };
const iconCache = new Map<string, string | null>();

async function pluginIcon(root: string): Promise<string | null> {
  if (iconCache.has(root)) return iconCache.get(root)!;
  let icon: string | null = null;
  try {
    const manifest = JSON.parse(await readFile(join(root, ".codex-plugin", "plugin.json"), "utf8"));
    const rel = manifest?.interface?.composerIcon || manifest?.interface?.logo;
    const mime = typeof rel === "string" ? MIME[extname(rel).toLowerCase()] : undefined;
    if (mime) {
      const file = join(root, rel);
      if ((await stat(file)).size <= ICON_MAX_BYTES) icon = `data:${mime};base64,${(await readFile(file)).toString("base64")}`;
    }
  } catch {}
  iconCache.set(root, icon);
  return icon;
}

// Birth time where the filesystem has one, else the last change; enough to spot new skills.
async function addedAt(path: string): Promise<number | null> {
  const info = await stat(path).catch(() => null);
  if (!info) return null;
  return info.birthtimeMs > 0 ? info.birthtimeMs : info.ctimeMs;
}

export async function skillChoices(threadId: string | undefined): Promise<SkillChoices> {
  const snapshot = await contextSnapshot("panel", threadId);
  const cwd = snapshot.thread?.cwd ?? null;
  const [usage, listed] = await Promise.all([
    skillUsage(),
    codex.request<Listed>("skills/list", cwd ? { cwds: [cwd] } : {}).catch(() => null),
  ]);
  // Codex's current list, keyed without plugin versions: a thread started before a plugin
  // update still names the old version's folder. It also has the full descriptions, where
  // the thread's catalog may carry shortened ones.
  const current = new Map<string, { name: string | null; plugin: string | null; path: string; enabled: boolean | null; description: string | null }>();
  for (const group of listed?.data ?? []) {
    for (const skill of group.skills ?? []) {
      const key = skill.path ? skillKey(skill.path) : null;
      if (!key || !skill.path) continue;
      current.set(key, {
        name: skill.name ?? null,
        plugin: skill.pluginId ? skill.pluginId.split("@")[0] : null,
        path: skill.path,
        enabled: typeof skill.enabled === "boolean" ? skill.enabled : null,
        description: skill.shortDescription || skill.description || null,
      });
    }
  }
  // Skills turned off before this thread started aren't in its catalog; list them too so
  // they can be turned back on. Their cost is estimated from the line they'd add.
  const catalog = [...snapshot.skills.entries];
  const inCatalog = new Set(catalog.map((e) => (e.path ? skillKey(e.path) : null)));
  for (const [key, skill] of current) {
    if (skill.enabled !== false || inCatalog.has(key)) continue;
    const base = skill.name ?? key.split("/").pop() ?? key;
    const name = skill.plugin && !base.startsWith(`${skill.plugin}:`) ? `${skill.plugin}:${base}` : base;
    const description = skill.description ?? "";
    catalog.push({ name, plugin: skill.plugin, path: skill.path, description, tokens: countTokens(`- ${name}: ${description} (file: ${skill.path})`), units: 0 });
  }
  const seen = new Set<string>();
  const entries: SkillChoice[] = [];
  const icons: Record<string, string> = {};
  for (const e of catalog) {
    if (!e.path) continue;
    const key = skillKey(e.path);
    // Only plugin skills move between versioned folders; others keep the catalog's path.
    const now = key ? current.get(key) : undefined;
    const path = key?.startsWith("plugin:") && now ? now.path : e.path;
    if (seen.has(path)) continue;
    seen.add(path);
    const used = key ? usage.get(key) : undefined;
    const source = sourceOf(path, cwd);
    const icon = source.pluginRoot ? await pluginIcon(source.pluginRoot) : null;
    const iconKey = icon ? source.pluginRoot!.split("/").slice(-3, -1).join("/") : null;
    if (icon && iconKey) icons[iconKey] = icon;
    entries.push({
      name: e.name,
      plugin: e.plugin,
      path,
      description: (now?.path === path ? now.description : null) ?? e.description,
      source: source.label,
      sourceKind: source.kind,
      pluginIcon: iconKey,
      addedAt: await addedAt(path),
      tokens: e.tokens,
      uses: used?.uses ?? 0,
      lastUsed: used?.lastUsed ?? null,
      enabled: now?.path === path ? now.enabled : null,
    });
  }
  return { days: USAGE_DAYS, entries, icons, error: listed ? null : "Codex didn't report which skills are on." };
}

export async function setSkill(path: string, on: boolean): Promise<{ enabled: boolean | null; error: string | null }> {
  try {
    const result = await codex.request<{ effectiveEnabled?: boolean }>("skills/config/write", { path, enabled: on });
    return { enabled: result?.effectiveEnabled ?? on, error: null };
  } catch (error) {
    return { enabled: null, error: message(error) };
  }
}

export function shutdownChoices(): void {
  codex.stop();
}
