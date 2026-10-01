// Token counts with the o200k_base encoding. The ranks load lazily so they stay in their
// own chunk; without them counts fall back to Codex's own estimate, ceil(bytes / 4).
import { createHash } from "node:crypto";

type Counter = (text: string) => number;

// BPE merging slows down superlinearly on long unbroken runs; count those in slices.
const LONG_RUN = /(\S)\1{255,}|\s{256,}|\S{2048,}/g;
const SLICE = 256;
const CACHE_LIMIT = 20_000;
// Special-token strings such as <|endoftext|> in a file are plain text to the model.
const PLAIN = { disallowedSpecial: new Set<string>() };

let encoder: Counter | null = null;
let loading: Promise<void> | null = null;
const cache = new Map<string, number>();

export const estimateTokens = (text: string) => Math.ceil(Buffer.byteLength(text) / 4);

export function loadTokenizer(): Promise<void> {
  // A runtime path keeps the ranks out of the server bundle; see o200k.ts.
  const module = new URL("./o200k.js", import.meta.url).href;
  loading ??= (import(module) as Promise<typeof import("./o200k.js")>).then(
    ({ countTokens }) => {
      encoder = (text) => countTokens(text, PLAIN);
    },
    () => {
      // Retry on the next request, e.g. after a reinstall replaced the files.
      loading = null;
    },
  );
  return loading;
}

export const exactTokens = () => encoder !== null;

function guarded(text: string, count: Counter): number {
  let total = 0;
  let last = 0;
  for (const match of text.matchAll(LONG_RUN)) {
    total += count(text.slice(last, match.index));
    for (let i = 0; i < match[0].length; i += SLICE) total += count(match[0].slice(i, i + SLICE));
    last = match.index + match[0].length;
  }
  return total + count(text.slice(last));
}

export function countTokens(text: string): number {
  if (!text) return 0;
  if (!encoder) return estimateTokens(text);
  const key = createHash("sha1").update(text).digest("base64");
  let tokens = cache.get(key);
  if (tokens === undefined) {
    tokens = guarded(text, encoder);
    if (cache.size >= CACHE_LIMIT) cache.clear();
    cache.set(key, tokens);
  }
  return tokens;
}
