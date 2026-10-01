// Which AGENTS.md files Codex loads for a thread, recomputed on disk the way Codex discovers
// them and matched against the text the thread actually loaded: the rollout keeps only the
// combined text, with no per-file markers.
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { codexHome } from "./paths.js";
import type { AgentsFile, ContextSnapshot } from "../types.js";
import type { Settings } from "./config.js";
import { countTokens } from "./tokens.js";

export type LoadedAgents = { text: string; directory: string | null };

const OVERRIDE = "AGENTS.override.md";
const DEFAULT = "AGENTS.md";
const HEADER = "# AGENTS.md instructions";
// Marks where project files begin, only when global instructions come first.
const PROJECT_SEPARATOR = "\n\n--- project-doc ---\n\n";

// Rust's str::trim strips Unicode White_Space, which unlike JS's trim excludes U+FEFF.
const WS = "[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const EDGES = new RegExp(`^${WS}+|${WS}+$`, "g");
const trim = (text: string) => text.replace(EDGES, "");

// `loaded` is the text that would reach the model now: trimmed for the global file, cut to
// the remaining byte budget for project files.
type Found = { file: AgentsFile; loaded: string | null; loadedBytes: number };

const home = homedir();
const tildify = (path: string) => (path === home || path.startsWith(home + sep) ? "~" + path.slice(home.length) : path);
const lineCount = (text: string) => (text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0);

async function readRegular(path: string): Promise<Buffer | null> {
  try {
    return (await stat(path)).isFile() ? await readFile(path) : null;
  } catch {
    return null;
  }
}

function describe(path: string, data: Buffer, scope: AgentsFile["scope"], name: string, display: string): AgentsFile {
  const text = data.toString("utf8");
  return {
    path,
    display,
    scope,
    kind: name === OVERRIDE ? "AGENTS.override.md" : name === DEFAULT ? "AGENTS.md" : "fallback",
    status: "full",
    shadowedBy: null,
    tokens: 0,
    fileTokens: countTokens(text),
    bytes: data.length,
    lines: lineCount(text),
    changedSinceLoaded: false,
  };
}

// CODEX_HOME holds one global file: AGENTS.override.md when it has content, else AGENTS.md.
async function globalFiles(): Promise<Found[]> {
  const found: Found[] = [];
  let winner: string | null = null;
  for (const name of [OVERRIDE, DEFAULT]) {
    const path = join(codexHome(), name);
    const data = await readRegular(path);
    if (!data) continue;
    const file = describe(path, data, "global", name, tildify(path));
    const text = trim(data.toString("utf8"));
    if (winner) {
      file.status = "shadowed";
      file.shadowedBy = winner;
    } else if (!text) file.status = "empty";
    else winner = path;
    found.push({ file, loaded: file.status === "full" ? text : null, loadedBytes: file.status === "full" ? Buffer.byteLength(text) : 0 });
  }
  return found;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

// The nearest ancestor of cwd (inclusive) holding a root marker; without one only cwd is searched.
async function projectRoot(cwd: string, markers: string[]): Promise<string | null> {
  if (!markers.length) return null;
  for (let dir = cwd; ; dir = dirname(dir)) {
    for (const marker of markers) if (await exists(join(dir, marker))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

function candidateNames(fallbacks: string[]): string[] {
  const names = [OVERRIDE, DEFAULT];
  for (const name of fallbacks) {
    if (!name || name === "." || name === ".." || /[/\0]/.test(name) || (process.platform === "win32" && /[\\:]/.test(name))) continue;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

// One file per directory from the root down to cwd, sharing one byte budget.
async function projectFiles(cwd: string, root: string | null, settings: Settings): Promise<Found[]> {
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    dirs.unshift(dir);
    if (!root || dir === root || dirname(dir) === dir) break;
  }
  const names = candidateNames(settings.fallbackFilenames);
  const base = root ?? cwd;
  let remaining = settings.projectDocMaxBytes;
  const found: Found[] = [];
  for (const dir of dirs) {
    let winner: string | null = null;
    for (const name of names) {
      const path = join(dir, name);
      const data = await readRegular(path);
      if (!data) continue;
      const file = describe(path, data, "project", name, relative(base, path) || name);
      if (winner) {
        file.status = "shadowed";
        file.shadowedBy = winner;
        found.push({ file, loaded: null, loadedBytes: 0 });
        continue;
      }
      winner = path;
      const kept = data.length > remaining ? data.subarray(0, Math.max(0, remaining)) : data;
      const text = kept.toString("utf8");
      if (!trim(data.toString("utf8"))) file.status = "empty";
      else if (!trim(text)) file.status = "dropped";
      else {
        file.status = kept.length < data.length ? "truncated" : "full";
        remaining -= kept.length;
      }
      const loads = file.status === "full" || file.status === "truncated";
      found.push({ file, loaded: loads ? text : null, loadedBytes: loads ? kept.length : 0 });
    }
  }
  return found;
}

// Removes the matched spans from `text` and the blank-line joins around them.
function leftover(text: string, spans: [number, number][]): string {
  const pieces: string[] = [];
  let cursor = 0;
  for (const [from, to] of spans) {
    pieces.push(text.slice(cursor, from));
    cursor = to;
  }
  pieces.push(text.slice(cursor));
  return pieces
    .map((piece) => piece.replace(/^\n+|\n+$/g, ""))
    .filter(Boolean)
    .join("\n\n");
}

function render(text: string, directory: string | null): string {
  return `${HEADER}${directory ? ` for ${directory}` : ""}\n\n<INSTRUCTIONS>\n${text}\n</INSTRUCTIONS>`;
}

export async function agentsReport(
  cwd: string | null,
  loaded: LoadedAgents | null,
  settings: Settings,
): Promise<{ agents: ContextSnapshot["agents"]; notes: string[] }> {
  const globals = await globalFiles();
  const root = cwd ? await projectRoot(cwd, settings.projectRootMarkers) : null;
  const projects = cwd ? await projectFiles(cwd, root, settings) : [];
  const notes: string[] = [];
  let unattributed = 0;

  let globalText = "";
  let projectText = "";
  if (loaded) {
    const at = loaded.text.indexOf(PROJECT_SEPARATOR);
    if (at >= 0) {
      globalText = loaded.text.slice(0, at);
      projectText = loaded.text.slice(at + PROJECT_SEPARATOR.length);
    } else if (loaded.directory) projectText = loaded.text;
    else globalText = loaded.text;
  }

  const global = globals.find((f) => f.loaded !== null);
  if (global) {
    const expected = global.loaded!;
    // Without the thread's history, report what would load now and flag nothing.
    const matched = !loaded || globalText === expected || globalText.startsWith(expected + "\n\n");
    global.file.changedSinceLoaded = !matched;
    global.file.tokens = countTokens(matched ? expected : globalText);
  } else if (globalText) unattributed += countTokens(globalText);

  const contributing = projects.filter((f) => f.loaded !== null);
  const spans: [number, number][] = [];
  const unmatched: Found[] = [];
  let cursor = 0;
  for (const found of contributing) {
    const expected = found.loaded!;
    const at = loaded ? projectText.indexOf(expected, cursor) : -1;
    if (loaded && at < 0) {
      unmatched.push(found);
      continue;
    }
    found.file.tokens = countTokens(expected);
    if (at >= 0) {
      spans.push([at, at + expected.length]);
      cursor = at + expected.length;
    }
  }
  const rest = loaded ? leftover(projectText, spans) : "";
  for (const found of unmatched) {
    found.file.changedSinceLoaded = true;
    // A single edited file owns whatever the thread loaded beyond the unchanged ones.
    found.file.tokens = unmatched.length === 1 ? countTokens(rest) : countTokens(found.loaded!);
  }
  if (!unmatched.length && rest) unattributed += countTokens(rest);

  let loadedTokens = 0;
  if (loaded?.text) loadedTokens = countTokens(render(loaded.text, loaded.directory));
  else if (!loaded && (global || contributing.length)) {
    const project = contributing.map((f) => f.loaded!).join("\n\n");
    const text = global && project ? global.loaded + PROJECT_SEPARATOR + project : (global?.loaded ?? project);
    loadedTokens = countTokens(render(text, project ? cwd : null));
  }

  if (cwd && !(await exists(cwd))) {
    notes.push(`The thread's folder ${tildify(cwd)} no longer exists, so its project AGENTS.md files can't be checked.`);
  } else if (unattributed > 0) {
    notes.push(`${unattributed} tokens of AGENTS.md text this thread loaded match no current file (moved, renamed or deleted since).`);
  }

  return {
    agents: {
      files: [...globals, ...projects].map((f) => f.file),
      projectRoot: root,
      projectBytes: contributing.reduce((sum, f) => sum + f.loadedBytes, 0),
      projectBudget: settings.projectDocMaxBytes,
      loadedTokens,
    },
    notes,
  };
}
