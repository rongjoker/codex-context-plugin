// Builds the installable plugin into plugins/context: node scripts/build.mjs [--out <dir>]
import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const author = { name: "Dmitry Nehaychik", url: "https://github.com/nnixaa" };
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const homepage = pkg.repository.url.replace(/\.git$/, "");

const args = process.argv.slice(2);
const outArg = args[args.indexOf("--out") + 1];
const out = resolve(args.includes("--out") && outArg ? outArg : "plugins/context");

const app = await build({
  entryPoints: ["src/app/index.ts"],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  logLevel: "warning",
});
const template = await readFile("src/app/index.html", "utf8");
const html = template.replace(
  "<!-- APP_SCRIPT -->",
  () => `<script>${app.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}</script>`,
);

await rm(out, { recursive: true, force: true });
await mkdir(join(out, ".codex-plugin"), { recursive: true });

// The tokenizer ranks are a separate bundle with a stable name: a running server may import
// them lazily after a reinstall replaced the files.
await build({
  entryPoints: { server: "src/server/index.ts", o200k: "src/server/o200k.ts" },
  bundle: true,
  outdir: join(out, "dist"),
  format: "esm",
  platform: "node",
  target: "node22",
  logLevel: "warning",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  define: { __VERSION__: JSON.stringify(pkg.version) },
});
await writeFile(join(out, "dist/app.html"), html);
await cp("assets", join(out, "assets"), { recursive: true });

const manifest = {
  name: "context-dev",
  version: pkg.version,
  description: "See what fills a Codex thread's context: the skills catalog, AGENTS.md files, tools and the conversation.",
  author,
  homepage,
  license: "MIT",
  mcpServers: "./.mcp.json",
  interface: {
    displayName: "Context Dev",
    shortDescription: "What fills your thread's context, and what to fix",
    longDescription:
      "Breaks down a thread's context: the conversation, tools, the skills catalog, AGENTS.md files and Codex's own instructions. Flags what wastes it, such as a full or resent skills catalog, duplicate skills and AGENTS.md cut off by the size limit, estimates how many messages are left before Codex compacts the thread, and lists every skill with its cost and last use so you can turn unused ones off.",
    developerName: "rongjoker",
    websiteUrl: homepage,
    category: "Developer Tools",
    capabilities: ["Interactive", "Read", "Write"],
    composerIcon: "./assets/icon.svg",
    logo: "./assets/icon.svg",
    defaultPrompt: ["@Context Dev what is using my context?"],
  },
};
const mcp = { mcpServers: { context_dev: { command: "node", args: ["./dist/server.js"], cwd: "." } } };
await writeFile(join(out, ".codex-plugin/plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
await writeFile(join(out, ".mcp.json"), JSON.stringify(mcp, null, 2) + "\n");
console.log(`Built ${out} (context v${pkg.version})`);
