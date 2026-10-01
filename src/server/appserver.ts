// A small JSON-RPC client for `codex app-server`, Codex's own API, so plugins read and change
// Codex state the supported way and never touch its credentials. The child starts on the
// first request and exits shortly after the last one, since Codex runs one plugin server per
// open thread.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

const CANDIDATES = [
  process.env.CODEX_BIN,
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
];
const IDLE_MS = 15_000;
const TIMEOUT_MS = 20_000;

function codexBinary(): string {
  return CANDIDATES.find((path) => path && existsSync(path)) ?? "codex";
}

export class AppServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private idle: NodeJS.Timeout | null = null;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  constructor(private readonly client: { name: string; title: string; version: string }) {}

  async request<T = any>(method: string, params?: unknown): Promise<T> {
    if (this.idle) clearTimeout(this.idle);
    try {
      await this.start();
      return await this.send<T>(method, params);
    } finally {
      this.idle = setTimeout(() => this.stop(), IDLE_MS);
      this.idle.unref();
    }
  }

  stop(reason = "codex app-server stopped"): void {
    this.child?.kill();
    this.child = null;
    this.ready = null;
    for (const { reject } of this.pending.values()) reject(new Error(reason));
    this.pending.clear();
  }

  private send<T>(method: string, params?: unknown): Promise<T> {
    if (!this.child) return Promise.reject(new Error("codex app-server is not running"));
    const id = ++this.nextId;
    this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
    });
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    // A fixed working directory: Codex keeps plugin servers running across reinstalls, which
    // delete the plugin folder they started in, and a child can't start in a missing folder.
    // On Windows the PATH fallback is `codex.cmd`, which needs a shell.
    const proc = spawn(codexBinary(), ["app-server"], {
      cwd: homedir(),
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    this.child = proc;
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-500);
    });
    proc.on("error", (error) => this.stop(`codex app-server failed to start: ${error.message}`));
    proc.on("exit", (code) => {
      if (this.child === proc) this.stop(`codex app-server exited (${code ?? "signal"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
    });
    createInterface({ input: proc.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const waiter = message.id != null ? this.pending.get(message.id) : undefined;
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? "app-server error"));
      else waiter.resolve(message.result);
    });
    this.ready = this.send("initialize", { clientInfo: this.client, capabilities: null }).then(() => {
      proc.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    });
    this.ready.catch(() => this.stop());
    return this.ready;
  }
}
