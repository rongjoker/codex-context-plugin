import { readFile } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RESOURCE_MIME_TYPE, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import type { OpenAIUiResourceMetadata } from "@openai/mcp-extensions/server";
import { z } from "zod/v4";
import type { Block, ContextSnapshot, View } from "../types.js";
import { messagesLeftText } from "../format.js";
import { contextSnapshot } from "./snapshot.js";
import { waitForChange } from "./wait.js";
import { setSkill, shutdownChoices, skillChoices } from "./choices.js";
import { skillUsage } from "./skillusage.js";

declare const __VERSION__: string;
// Versioned so Codex never pairs a cached page with a newer server after an update.
const UI = `ui://context/app-${__VERSION__}`;
const LARGEST_SKILLS = 10;
// Read per request so rebuilds show up without restarting Codex, which keeps this server
// running across reinstalls; fall back to the last copy once a reinstall removes this version.
let lastHtml = await readFile(new URL("./app.html", import.meta.url), "utf8");
async function appHtml(): Promise<string> {
  try {
    lastHtml = await readFile(new URL("./app.html", import.meta.url), "utf8");
  } catch {}
  return lastHtml;
}
const iconSvg = await readFile(new URL("../assets/icon.svg", import.meta.url), "utf8");
const icon = { src: "data:image/svg+xml," + encodeURIComponent(iconSvg), mimeType: "image/svg+xml", sizes: ["any"] };

// Codex sends the calling thread as `threadId` (and `thread_id`) in request _meta.
function threadIdFrom(meta: Record<string, unknown> | undefined): string | undefined {
  for (const key of ["threadId", "thread_id"]) {
    if (typeof meta?.[key] === "string") return meta[key] as string;
  }
  return undefined;
}

const percent = (part: number, whole: number | null) => (whole ? ` (${Math.round((part / whole) * 100)}% of ${whole})` : "");
const blockText = (b: Block) => `${b.label} ${b.tokens}${b.copies > 1 ? ` x${b.copies} copies = ${b.tokens * b.copies}` : ""}`;

// Plain text for the model: every AGENTS.md file, the skills budget and what fills the context.
function summary(s: ContextSnapshot): string {
  const lines: string[] = [];
  const unit = s.exactTokens ? "o200k_base tokens" : "estimated tokens (bytes / 4)";
  if (s.thread) {
    const which = s.thread.isCurrent ? "" : " (the latest thread; the calling thread was not identified)";
    lines.push(`Thread "${s.thread.title}" ${s.thread.id}${which}, model ${s.thread.model ?? "unknown"}, cwd ${s.thread.cwd ?? "unknown"}.`);
  } else lines.push("No Codex thread found.");
  lines.push(`Counts are ${unit}; input totals are measured by Codex.`);

  if (s.now) {
    lines.push(`Latest request: ${s.now.inputTokens} input tokens${percent(s.now.inputTokens, s.contextWindow)}, ${s.now.compactions} compactions so far.`);
    lines.push(`- ${s.now.blocks.map(blockText).join("; ")}`);
    lines.push(`- Tools and framing ${s.now.toolsTokens} (from the first request); conversation ${s.now.conversationTokens}.`);
  }
  const c = s.compaction;
  if (c) {
    const pace = c.perMessage !== null ? ` Each message added ${c.perMessage} tokens on average (last ${c.samples}): ${messagesLeftText(c.messagesLeft)}.` : "";
    lines.push(`Codex auto-compacts at about ${c.limit} tokens; ${c.current} after the latest request.${pace}`);
  }
  if (s.start) {
    lines.push(`First request: ${s.start.inputTokens} input tokens = context blocks + first message ${s.start.userTokens} + tools and framing ${s.start.toolsTokens}.`);
    lines.push(`- ${s.start.blocks.map(blockText).join("; ")}`);
    lines.push("- Tools and framing is the measured remainder: tool definitions and message framing, which Codex does not log.");
  }

  const a = s.agents;
  lines.push(
    `AGENTS.md: loaded message ${a.loadedTokens} tokens; project root ${a.projectRoot ?? "none found (only the cwd is searched)"}; project files use ${a.projectBytes} of ${a.projectBudget} bytes (project_doc_max_bytes).`,
  );
  if (!a.files.length) lines.push("- No AGENTS.md files found.");
  for (const f of a.files) {
    const flags = [f.kind, f.shadowedBy ? `shadowed by ${f.shadowedBy}` : "", f.changedSinceLoaded ? "changed since the thread loaded it" : ""];
    lines.push(
      `- ${f.path} [${f.scope}, ${f.status}]: ${f.tokens} tokens loaded; on disk ${f.fileTokens} tokens, ${f.lines} lines, ${f.bytes} bytes (${flags.filter(Boolean).join("; ")})`,
    );
  }

  const k = s.skills;
  const budget = k.budgetUnits
    ? `${k.units} of ${k.budgetUnits} budget units (${Math.round((k.units / k.budgetUnits) * 100)}%)`
    : `${k.units} budget units (budget unknown)`;
  lines.push(`Skills catalog: ${k.entries.length} skills, ${k.tokens} tokens, ${budget}.`);
  const largest = [...k.entries].sort((x, y) => y.tokens - x.tokens).slice(0, LARGEST_SKILLS);
  if (largest.length) lines.push(`- Largest: ${largest.map((e) => `${e.name} ${e.tokens}`).join(", ")}`);
  if (k.duplicates.length) lines.push(`- Possible duplicates: ${k.duplicates.join(", ")}`);

  if (s.problems.length) {
    lines.push("Problems:");
    for (const p of s.problems) {
      lines.push(`- [${p.severity}, ${p.basis}] ${p.title}${p.cost ? ` (${p.cost})` : ""}: ${p.why} Tip: ${p.tip}. Evidence: ${p.evidence}`);
    }
  }
  if (s.notes.length) lines.push("Notes:", ...s.notes.map((n) => `- ${n}`));
  if (s.errors.length) lines.push("Errors:", ...s.errors.map((e) => `- ${e}`));
  return lines.join("\n");
}

const result = (s: ContextSnapshot) => ({
  content: [{ type: "text" as const, text: summary(s) }],
  structuredContent: s as unknown as Record<string, unknown>,
});
const readonly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const ui = (entrypoints: unknown[] = [], visibility?: string[]) => ({
  ui: { resourceUri: UI, ...(visibility ? { visibility } : {}) },
  "openai/ui": { entrypoints },
  "openai/iconStyle": "monochrome",
});
// When an issue holds a skills list, count skill use in the background so the list opens
// at once; the first count over 30 days of rollouts takes a few seconds, later ones are cached.
function prewarm(s: ContextSnapshot): ContextSnapshot {
  if (s.problems.some((p) => p.panel)) skillUsage().catch(() => {});
  return s;
}

const snapshot = (view: View, threadId: string | undefined, since?: number) =>
  contextSnapshot(view, threadId, since).then(prewarm).then(result);

const server = new McpServer({
  name: "context",
  title: "Context",
  version: __VERSION__,
  icons: [icon],
});

registerAppResource(server, "Context", UI, {}, async () => ({
  contents: [
    {
      uri: UI,
      mimeType: RESOURCE_MIME_TYPE,
      text: await appHtml(),
      _meta: {
        "openai/ui": { availableDisplayModes: ["inline", "fullscreen"] } satisfies OpenAIUiResourceMetadata,
      },
    },
  ],
}));

server.registerTool(
  "context.panel",
  {
    title: "Context",
    description: "Show what fills this conversation's context beside it.",
    inputSchema: z.object({}),
    annotations: readonly,
    _meta: ui([{ type: "thread" }], ["app"]),
  },
  async (_args, extra) => snapshot("panel", threadIdFrom(extra._meta)),
);

server.registerTool(
  "context.inspect",
  {
    title: "Inspect context",
    description:
      "Break down what fills this Codex thread's context window: every AGENTS.md file (path, whether it loaded, was cut by the size limit or changed since, tokens and lines), the skills catalog against its budget, tool definitions, other injected instructions and the conversation. Use when the user asks what fills the context, why the context is large, or to audit or trim AGENTS.md.",
    inputSchema: z.object({}),
    annotations: readonly,
    _meta: ui(),
  },
  async (_args, extra) => snapshot("inline", threadIdFrom(extra._meta)),
);

server.registerTool(
  "context.refresh",
  {
    title: "Refresh context",
    inputSchema: z.object({
      view: z.enum(["panel", "inline"]).default("panel"),
      threadId: z.string().optional(),
      // When the tab opened, for a tab waiting on a new chat's first message.
      since: z.number().optional(),
    }),
    annotations: readonly,
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ view, threadId, since }, extra) => snapshot(view, threadId ?? threadIdFrom(extra._meta), since),
);

server.registerTool(
  "context.skills",
  {
    title: "Skills and their use",
    inputSchema: z.object({ threadId: z.string().optional() }),
    annotations: readonly,
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ threadId }, extra) => {
    const choices = await skillChoices(threadId ?? threadIdFrom(extra._meta));
    return { content: [], structuredContent: choices as unknown as Record<string, unknown> };
  },
);

server.registerTool(
  "context.setSkill",
  {
    title: "Turn a skill on or off",
    description: "Turns one skill on or off in Codex's config. Takes effect in new threads.",
    inputSchema: z.object({ path: z.string(), enabled: z.boolean() }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ path, enabled }) => {
    const result = await setSkill(path, enabled);
    return { content: [], structuredContent: result, isError: result.error != null };
  },
);

server.registerTool(
  "context.wait",
  {
    title: "Wait for thread changes",
    description: "Resolves when the thread records a new model request, or after about 40 seconds.",
    inputSchema: z.object({
      threadId: z.string().optional(),
      since: z.number().optional(),
      size: z.number().optional(),
    }),
    annotations: readonly,
    _meta: { ui: { visibility: ["app"] } },
  },
  async ({ threadId, since, size }) => {
    const waited = await waitForChange(threadId, since, size);
    return { content: [], structuredContent: waited };
  },
);

process.on("SIGTERM", () => {
  shutdownChoices();
  process.exit(0);
});
process.stdin.on("close", shutdownChoices);
await server.connect(new StdioServerTransport());
