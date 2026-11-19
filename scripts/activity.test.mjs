import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";

const { outputFiles } = await build({
  entryPoints: ["src/server/rollout.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { readRollout } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString("base64")}`);

const record = (type, payload, timestamp = "2026-01-01T00:00:00Z") => JSON.stringify({ timestamp, type, payload }) + "\n";
const event = (type, turn_id) => record("event_msg", { type, turn_id });
const timed = (type, turn_id, fields, timestamp) => record("event_msg", { type, turn_id, ...fields }, timestamp);
const item = (type, fields) => record("response_item", { type, ...fields });
const message = (role, text) => item("message", { role, content: [{ type: "input_text", text }] });
const usage = (input_tokens) => record("event_msg", { type: "token_count", info: { last_token_usage: { input_tokens } } });

async function rollout(t, lines) {
  const dir = await mkdtemp(join(tmpdir(), "context-activity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const id = `context-fixture-${dir.split("-").at(-1)}`;
  const path = join(dir, "fixture.jsonl");
  await writeFile(path, record("session_meta", { base_instructions: "Instructions" }) + lines.join(""));
  return { read: (limit) => readRollout(id, path, limit), append: (...more) => appendFile(path, more.join("")) };
}

test("records turn growth, associates MCP and terminal outputs, and keeps text private", async (t) => {
  const f = await rollout(t, [
    event("task_started", "first"),
    message("user", "# AGENTS.md instructions\n<INSTRUCTIONS>private policy</INSTRUCTIONS>"),
    message("user", "private question"),
    usage(1500),
    item("function_call", { namespace: "mcp__example_server__", name: "search", call_id: "mcp" }),
    item("function_call_output", {
      call_id: "mcp",
      output: [{ type: "input_text", text: "private log data ".repeat(15) }, { type: "input_image", image_url: "a".repeat(10000) }],
    }),
    item("function_call_output", { name: "exec_command", output: "terminal text" }),
    message("assistant", "private answer"),
    usage(1800),
    event("task_complete", "first"),
    event("task_started", "second"),
    usage(2300),
  ]);

  const { recentTurns, latest } = await f.read();
  assert.equal(latest.inputTokens, 2300);
  assert.deepEqual(recentTurns.map(({ status, inputTokens, inputDelta }) => [status, inputTokens, inputDelta]), [
    ["in-progress", 2300, 500],
    ["finished", 1800, null],
  ]);
  assert.equal(recentTurns[1].largest[0].label, "example_server / search");
  assert.equal(recentTurns[1].largest[0].kind, "mcp");
  assert.equal(recentTurns[1].largest[0].tokens, Math.ceil("private log data ".repeat(15).length / 4));
  assert.ok(recentTurns[1].largest.some(({ kind }) => kind === "terminal"));
  assert.equal(recentTurns[1].largest.filter(({ kind }) => kind === "user").length, 1);
  assert.doesNotMatch(JSON.stringify(recentTurns), /private/);

  await f.append(event("turn_aborted", "second"));
  assert.equal((await f.read()).recentTurns[0].status, "interrupted");
});

test("starts a new baseline after compaction and reports oversized results", async (t) => {
  const f = await rollout(t, [
    event("task_started", "first"), usage(1500), event("task_complete", "first"),
    event("task_started", "compact"), record("compacted", { replacement_history: [] }), usage(0), event("task_complete", "compact"),
    event("task_started", "after"), usage(500),
    item("custom_tool_call_output", { call_id: "huge", output: "x".repeat(9 * 1024 * 1024) }),
    event("task_complete", "after"),
  ]);
  const { recentTurns } = await f.read();
  assert.deepEqual(recentTurns.map(({ inputTokens, inputDelta, compacted, skippedItems }) => [inputTokens, inputDelta, compacted, skippedItems]), [
    [500, null, false, 1],
    [null, null, true, 0],
    [1500, null, false, 0],
  ]);
  await f.append(event("task_started", "next"), usage(460), event("task_complete", "next"));
  assert.equal((await f.read()).recentTurns[0].inputDelta, -40);
});

test("reports native and fallback durations for completed, interrupted, and running turns", async (t) => {
  const start = 1_767_225_600; // 2026-01-01T00:00:00Z
  const f = await rollout(t, [
    timed("task_started", "first", { started_at: start }),
    timed("task_complete", "first", { completed_at: start + 75, duration_ms: 74_600 }),
    timed("task_started", "second", {}, "2026-01-01T00:02:00.600Z"),
    timed("turn_aborted", "second", {}, "2026-01-01T00:02:10.800Z"),
    timed("task_started", "third", { started_at: start + 180 }),
  ]);
  assert.deepEqual((await f.read()).recentTurns.map(({ status, startedAt, durationMs }) => [status, startedAt, durationMs]), [
    ["in-progress", (start + 180) * 1000, null],
    ["interrupted", start * 1000 + 120_600, 10_200],
    ["finished", start * 1000, 74_600],
  ]);

  await f.append(timed("task_started", "fourth", { started_at: start + 300 }));
  assert.equal((await f.read()).recentTurns[1].status, "incomplete");
  assert.equal((await f.read()).recentTurns[1].durationMs, null);
});

test("loads older turns on request and keeps timing unavailable when the start is missing", async (t) => {
  const lines = [usage(900), event("task_complete", "old")];
  for (let i = 1; i <= 6; i++) {
    const id = `recorded-${i}`;
    lines.push(event("task_started", id), timed("task_complete", id, { duration_ms: i * 1000 }));
  }
  const f = await rollout(t, lines);
  const recent = await f.read();
  assert.equal(recent.turnCount, 7);
  assert.deepEqual(recent.recentTurns.map(({ durationMs }) => durationMs), [6000, 5000, 4000, 3000, 2000]);
  const all = await f.read(10);
  assert.equal(all.recentTurns.length, 7);
  assert.equal(all.recentTurns.at(-1).inputTokens, 900);
  assert.equal(all.recentTurns.at(-1).durationMs, null);
});
