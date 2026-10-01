// Smoke test: spawn the built server over stdio and call its tools.
// node scripts/smoke.mjs [thread id]
// Prints numbers and file names only: never message content or the thread title.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const threadId = process.argv[2];
const _meta = threadId ? { threadId } : undefined;

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/server.js"], cwd: "plugins/context" }));
const info = client.getServerVersion();
console.log("server:", info.name, info.version);
const { tools } = await client.listTools();
for (const t of tools) console.log("tool:", t.name, JSON.stringify(t._meta ?? {}));
const uri = tools.find((t) => t._meta?.ui?.resourceUri)._meta.ui.resourceUri;
const res = await client.readResource({ uri });
console.log("resource:", uri, res.contents[0].mimeType, res.contents[0].text.length, "chars");

async function call(name, args = {}) {
  const t = Date.now();
  const r = await client.callTool({ name, arguments: args, _meta });
  return { r, ms: Date.now() - t };
}

function breakdown(s) {
  const sum = (blocks) => blocks.reduce((n, b) => n + b.tokens * b.copies, 0);
  const list = (blocks) => blocks.map((b) => `${b.key}=${b.tokens}${b.copies > 1 ? `x${b.copies}` : ""}`).join(" ");
  const t = s.thread;
  console.log(`thread ${t?.id} current=${t?.isCurrent} model=${t?.model} window=${s.contextWindow} exact=${s.exactTokens}`);
  if (s.start) {
    const blocks = sum(s.start.blocks);
    const ok = blocks + s.start.userTokens + s.start.toolsTokens === s.start.inputTokens;
    console.log(`start input=${s.start.inputTokens} blocks=${blocks} user=${s.start.userTokens} tools=${s.start.toolsTokens} sum=${ok ? "ok" : "MISMATCH"}`);
    console.log(`  ${list(s.start.blocks)}`);
  } else console.log("start: none");
  if (s.now) {
    console.log(`now input=${s.now.inputTokens} blocks=${sum(s.now.blocks)} tools=${s.now.toolsTokens} conversation=${s.now.conversationTokens} compactions=${s.now.compactions}`);
    console.log(`  ${list(s.now.blocks)}`);
  } else console.log("now: none");
  const c = s.compaction;
  console.log(c ? `compaction limit=${c.limit} current=${c.current} perMessage=${c.perMessage} samples=${c.samples} messagesLeft=${c.messagesLeft}` : "compaction: none");
  const a = s.agents;
  console.log(`agents root=${a.projectRoot ? "set" : "none"} projectBytes=${a.projectBytes}/${a.projectBudget} loadedTokens=${a.loadedTokens}`);
  for (const f of a.files) {
    const flags = [f.shadowedBy && `shadowedBy=${f.shadowedBy}`, f.changedSinceLoaded && "CHANGED"].filter(Boolean).join(" ");
    console.log(`  ${f.scope} ${f.kind} ${f.status} tokens=${f.tokens} file=${f.fileTokens} lines=${f.lines} bytes=${f.bytes} ${flags}`);
  }
  const k = s.skills;
  const plugins = new Set(k.entries.map((e) => e.plugin).filter(Boolean)).size;
  console.log(`skills entries=${k.entries.length} plugins=${plugins} tokens=${k.tokens} units=${k.units}/${k.budgetUnits} duplicates=${k.duplicates.length}`);
  for (const p of s.problems) console.log(`  problem [${p.severity}/${p.basis}] ${p.id} | ${p.cost ?? "-"} | list: ${p.panel ?? "-"}`);
  for (const e of s.errors) console.log(`  error: ${e}`);
}

for (const [name, args] of [
  ["context.panel", {}],
  ["context.inspect", {}],
  ["context.refresh", { view: "panel", ...(threadId ? { threadId } : {}) }],
]) {
  const { r, ms } = await call(name, args);
  const s = r.structuredContent;
  console.log(`\n== ${name} (${ms} ms, view ${s.view})`);
  if (name !== "context.inspect") breakdown(s);
  else console.log(`${r.content[0].text.split("\n").length} lines of text for the model`);
}

const { r, ms } = await call("context.skills", threadId ? { threadId } : {});
const choices = r.structuredContent;
const used = choices.entries.filter((e) => e.uses > 0).length;
const off = choices.entries.filter((e) => e.enabled === false).length;
console.log(`\n== context.skills (${ms} ms) entries=${choices.entries.length} used=${used} off=${off} icons=${Object.keys(choices.icons).length} error=${choices.error}`);
await client.close();
