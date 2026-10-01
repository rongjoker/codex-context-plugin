// The few Codex settings the breakdown depends on, read from the user config only:
// project config layers cannot set project_root_markers, and the other keys rarely differ.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse, TomlError } from "smol-toml";
import { codexHome } from "./paths.js";

export type Settings = {
  projectRootMarkers: string[];
  projectDocMaxBytes: number;
  fallbackFilenames: string[];
  skillsMaxTokens: number | null;
  contextWindow: number | null; // model_context_window override
  autoCompactLimit: number | null; // model_auto_compact_token_limit override
  disabledSkills: string[]; // SKILL.md paths turned off with [[skills.config]]
  error: string | null;
};

const DEFAULTS: Settings = {
  projectRootMarkers: [".git"],
  projectDocMaxBytes: 32_768,
  fallbackFilenames: [],
  skillsMaxTokens: null,
  contextWindow: null,
  autoCompactLimit: null,
  disabledSkills: [],
  error: null,
};

type Cached<T> = { key: string; value: T };
let settingsCache: Cached<Settings> | null = null;
type ModelLimits = { contextWindow: number; autoCompact: number | null };
let modelsCache: Cached<Map<string, ModelLimits>> | null = null;

async function fileKey(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return null;
  }
}

const strings = (value: unknown) =>
  Array.isArray(value) && value.every((v) => typeof v === "string") ? (value as string[]) : null;
const count = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);

function pick(config: Record<string, unknown>): Settings {
  const skills = config.skills as Record<string, unknown> | undefined;
  const maxTokens = count(skills?.max_context_tokens);
  const switches = Array.isArray(skills?.config) ? (skills.config as Record<string, unknown>[]) : [];
  const disabledSkills = switches
    .filter((s) => s?.enabled === false && typeof s.path === "string")
    .map((s) => s.path as string);
  return {
    projectRootMarkers: strings(config.project_root_markers) ?? DEFAULTS.projectRootMarkers,
    projectDocMaxBytes: count(config.project_doc_max_bytes) ?? DEFAULTS.projectDocMaxBytes,
    fallbackFilenames: strings(config.project_doc_fallback_filenames) ?? [],
    skillsMaxTokens: maxTokens ? maxTokens : null,
    contextWindow: count(config.model_context_window) || null,
    autoCompactLimit: count(config.model_auto_compact_token_limit) || null,
    disabledSkills,
    error: null,
  };
}

export async function readSettings(): Promise<Settings> {
  const path = join(codexHome(), "config.toml");
  const key = await fileKey(path);
  if (!key) return DEFAULTS;
  if (settingsCache?.key === key) return settingsCache.value;
  let value: Settings;
  try {
    value = pick(parse(await readFile(path, "utf8")) as Record<string, unknown>);
  } catch (error) {
    // Never echo the parser message: it quotes the offending line, which may hold secrets.
    const where = error instanceof TomlError ? ` (line ${error.line})` : "";
    value = { ...DEFAULTS, error: `Could not parse config.toml${where}; using default settings.` };
  }
  settingsCache = { key, value };
  return value;
}

// The raw context window (Codex sizes the skills budget from it, not from the effective
// window) and the model's own auto-compaction limit, from Codex's model cache.
export async function modelLimits(model: string | null): Promise<ModelLimits | null> {
  if (!model) return null;
  const path = join(codexHome(), "models_cache.json");
  const key = await fileKey(path);
  if (!key) return null;
  if (modelsCache?.key !== key) {
    const limits = new Map<string, ModelLimits>();
    try {
      const { models } = JSON.parse(await readFile(path, "utf8")) as {
        models?: { slug?: unknown; context_window?: unknown; auto_compact_token_limit?: unknown }[];
      };
      for (const m of models ?? []) {
        if (typeof m.slug === "string" && typeof m.context_window === "number") {
          limits.set(m.slug, { contextWindow: m.context_window, autoCompact: count(m.auto_compact_token_limit) || null });
        }
      }
    } catch {}
    modelsCache = { key, value: limits };
  }
  return modelsCache.value.get(model) ?? null;
}
