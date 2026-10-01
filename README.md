# Codex Context

A Codex plugin that shows what fills a thread's context and what wastes it: the skills catalog, AGENTS.md files, tools and the conversation. Built on OpenAI [plugin extensions](https://developers.openai.com/plugins/build/extensions).

<img src="docs/screenshot.png" width="420" alt="Context tab beside a thread">

## What it shows

- **What's in context.** The conversation, tools, the skills catalog, Codex's system prompt and AGENTS.md, as a chart of the latest request.
- **Messages until compaction.** About how many more messages fit before Codex compacts the thread and keeps only a summary.
- **Issues.** Each one is a row with its cost per request; ⓘ explains why and how it was measured. A colored count next to the title shows when there are any.
  - The skills catalog fills its budget, so Codex shortens every description.
  - The catalog or AGENTS.md was sent again mid-thread, so old copies still take space.
  - Duplicate skills: the same skill installed on its own and inside a plugin.
  - AGENTS.md cut off by the 32 KB limit, too long, or edited after the thread started.
  - The context is close to full.
- **Every skill.** Its source (your folder, a plugin, built in), tokens and when you last used it, unused first, with a switch to turn it off.

Open it from a thread's side panel: `+` → **Context**, or ask in the chat: `@Context what is using my context?`

## Install

Requirements: the ChatGPT desktop app with Codex, and Node.js 22.5+ on your `PATH`. Tested on macOS.

```sh
codex plugin marketplace add nnixaa/codex-context-plugin
codex plugin add context@codex-context
```

Quit and reopen the app, then open any thread and add **Context** from the side panel's `+` menu.

Update:

```sh
codex plugin marketplace upgrade codex-context
codex plugin add context@codex-context
```

Codex keeps plugin servers and pages running across reinstalls, so quit and reopen the app after updating.

Remove:

```sh
codex plugin remove context@codex-context
codex plugin marketplace remove codex-context
```

## How it measures

Totals come from Codex itself: the `token_count` it records for every request. The plugin splits them using the thread's own history in `~/.codex/sessions`, counting text with the o200k tokenizer, and applies Codex's rules for the skills budget (2% of the context window), AGENTS.md (32 KB shared by project files) and compaction (90% of the window unless the model or your config sets it).

Issues marked "Measured" come from that data. The rest use a threshold the plugin chose, and ⓘ says so. The messages-left estimate assumes each message adds 1.5× your recent average; checked against past threads, it's right on average but one heavy message can shift it by a few.

## Turning skills off

**Turn off** calls your local `codex app-server` (`skills/config/write`), which records the change in `~/.codex/config.toml`. It applies to new threads. Codex sends the whole catalog again whenever it changes, so continuing an older thread after turning skills off, or after any plugin update, adds one more copy of the catalog to that thread.

While the catalog is over its budget, Codex shortens descriptions to fit, so turning a few skills off makes the rest more complete before it makes the catalog smaller.

## Privacy

Everything runs on your machine. The plugin reads:

- thread history from `~/.codex/sessions` and `~/.codex/archived_sessions`;
- thread metadata from `~/.codex/state_5.sqlite`, read-only;
- `~/.codex/config.toml`, `~/.codex/models_cache.json`, your AGENTS.md files, and installed plugin manifests for their icons;
- the skill list through `codex app-server` (`skills/list`). It never touches Codex credentials.

It writes only skill on/off switches, through `codex app-server`, and a small cache of skill usage in your OS cache directory (`~/Library/Caches/codex-context-plugin` on macOS). No network requests, no telemetry.

## Development

```sh
npm install
npm run build        # bundles the plugin into plugins/context
npm run smoke        # starts the built server and calls its tools; pass a thread id to pick one
codex plugin marketplace add .
codex plugin add context@codex-context
```

`src/server` is the MCP server; `src/app` is the page Codex renders. To work on the page in a browser, serve the repository root and open:

- `/preview/` for the demo threads in `preview/fixture.json`;
- `/preview/gallery.html` for every issue and state, after `npm run gallery` builds them with the server's own rules.

## Limitations

- Codex only. Linux and Windows paths are handled but untested.
- When the start of a thread's history is missing from `~/.codex/sessions`, only the latest totals are shown.
- Tools are one number: Codex doesn't record which tool definitions went into a request, so the plugin measures them as what's left.

## License

[MIT](LICENSE)
