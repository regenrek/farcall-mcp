import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { delegate } from "../src/application/delegate.mjs";
import { claude } from "../src/adapters/claude.mjs";
import { codex } from "../src/adapters/codex.mjs";

const session = "11111111-1111-4111-8111-111111111111";
async function setup(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "worker-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, "artifacts"));
  const prompt_file = path.join(cwd, "artifacts/prompt.md");
  await writeFile(prompt_file, "Review this checkout.");
  return {
    cwd,
    prompt_file,
    delegation_id: "build",
    model: "claude-opus-5-5",
    effort: "high",
    timeout_seconds: 5,
  };
}
const override = (provider, scenario = "success", id = session) => ({
  commandOverride: {
    command: process.execPath,
    args: [
      path.join(import.meta.dirname, "fixtures/provider.mjs"),
      provider,
      scenario,
      id,
    ],
  },
});
for (const provider of ["claude", "codex"]) {
  test(`${provider} preserves evidence, resumes exact sessions, rejects changed retries`, async (t) => {
    const input = await setup(t);
    const first = await delegate(provider, input, override(provider));
    assert.equal(first.status, "completed");
    assert.equal(first.result, "Reviewed café ✓");
    assert.equal(first.session_id, session);
    assert.equal(first.native_usage.input_tokens, 12);
    assert.equal(
      first.reported_model,
      provider === "claude" ? input.model : "unknown",
    );
    assert.equal(
      first.native_total_cost_usd,
      provider === "claude" ? 0.002 : null,
    );
    const cached = await delegate(provider, input, {
      commandOverride: { command: "/does-not-exist", args: [] },
    });
    assert.deepEqual(cached, first);
    await assert.rejects(
      delegate(provider, { ...input, effort: "low" }, override(provider)),
      /different request/,
    );
    const resumed = await delegate(
      provider,
      {
        ...input,
        delegation_id: "fix",
        resume_delegation_id: "build",
        resume_session_id: session,
      },
      override(provider),
    );
    assert.equal(resumed.session_id, session);
    await assert.rejects(
      delegate(
        provider,
        {
          ...input,
          delegation_id: "bad",
          resume_delegation_id: "build",
          resume_session_id: "22222222-2222-4222-8222-222222222222",
        },
        override(provider),
      ),
      /does not match/,
    );
    await assert.rejects(
      delegate(
        provider,
        { ...input, delegation_id: "bad", resume_session_id: session },
        override(provider),
      ),
      /requires both/,
    );
    const raw = await readFile(
      path.join(first.evidence_directory, "events.jsonl"),
      "utf8",
    );
    assert.match(raw, /input_tokens/);
    assert.equal(
      await readFile(path.join(first.evidence_directory, "prompt.txt"), "utf8"),
      "Review this checkout.",
    );
  });
  for (const [scenario, expected] of [
    ["failure", "failed"],
    ["missing", "missing_result"],
    ["slow", "timeout"],
    ["oversize", "oversize_event"],
  ]) {
    test(`${provider} reports ${expected}`, async (t) => {
      const input = await setup(t);
      const result = await delegate(
        provider,
        { ...input, timeout_seconds: 1 },
        override(provider, scenario),
      );
      assert.equal(result.status, expected);
    });
  }
}
test("model mismatch, missing executable and cancellation have distinct outcomes", async (t) => {
  const input = await setup(t);
  assert.equal(
    (await delegate("claude", input, override("claude", "mismatch"))).status,
    "model_mismatch",
  );
  assert.equal(
    (
      await delegate(
        "claude",
        { ...input, delegation_id: "missing" },
        { commandOverride: { command: "/no-such-worker", args: [] } },
      )
    ).status,
    "spawn_error",
  );
  const controller = new AbortController();
  const pending = delegate(
    "codex",
    { ...input, delegation_id: "cancel" },
    { ...override("codex", "slow"), signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 100);
  assert.equal((await pending).status, "cancelled");
});
test("both providers share the checkout lock and kill descendants on timeout", async (t) => {
  const input = await setup(t);
  const first = delegate(
    "claude",
    { ...input, timeout_seconds: 1 },
    override("claude", "tree"),
  );
  // Wait for deterministic child evidence, not a model status loop.
  await new Promise((resolve) => setTimeout(resolve, 200));
  await assert.rejects(
    delegate("codex", { ...input, delegation_id: "other" }, override("codex")),
    /worker lock/,
  );
  assert.equal((await first).status, "timeout");
  const pid = Number(
    await readFile(path.join(input.cwd, "descendant.pid"), "utf8"),
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
test("reject path escapes, symlinks and incomplete records", async (t) => {
  const input = await setup(t);
  await assert.rejects(
    delegate("claude", { ...input, delegation_id: "../escape" }),
    /Invalid/,
  );
  const outside = path.join(input.cwd, "outside.md");
  await writeFile(outside, "outside");
  await assert.rejects(
    delegate("claude", { ...input, prompt_file: outside }),
    /inside cwd/,
  );
  await symlink(outside, path.join(input.cwd, "artifacts/link.md"));
  await assert.rejects(
    delegate("claude", {
      ...input,
      prompt_file: path.join(input.cwd, "artifacts/link.md"),
    }),
    /inside cwd/,
  );
  const root = path.join(input.cwd, "artifacts/farcall");
  await mkdir(path.join(root, "build"));
  await assert.rejects(
    delegate("claude", input, override("claude")),
    /Incomplete/,
  );
});
test("preflight waits, caches identical requests and rejects changed duration", async (t) => {
  const { cwd } = await setup(t);
  const input = {
    cwd,
    delegation_id: "preflight",
    duration_seconds: 0.15,
    timeout_seconds: 2,
  };
  const started = performance.now();
  const result = await delegate("codex", input, { preflight: true });
  assert.ok(performance.now() - started >= 150);
  assert.equal(result.status, "completed");
  assert.equal(result.native_usage, null);
  await assert.rejects(
    delegate("codex", { ...input, duration_seconds: 1 }, { preflight: true }),
    /different request/,
  );
});
test("provider commands keep prompts off argv and omit bypass flags", () => {
  const input = {
    model: "gpt-6-astra",
    effort: "high",
    sandbox: "read-only",
    resume_session_id: session,
  };
  assert.deepEqual(codex.args(input).slice(-3), ["resume", session, "-"]);
  assert.ok(codex.args(input).includes("--sandbox"));
  assert.ok(
    !claude
      .args({ ...input, allowed_tools: [], permission_mode: "default" })
      .includes("--allowedTools"),
  );
  assert.doesNotMatch(
    [
      ...codex.args(input),
      ...claude.args({
        ...input,
        allowed_tools: [],
        permission_mode: "default",
      }),
    ].join(" "),
    /bypass|--last|skip-permissions/,
  );
});

test("resume rejects a different provider and a CLI returning the wrong session", async (t) => {
  const input = await setup(t);
  await delegate("claude", input, override("claude"));
  const resumed = {
    ...input,
    delegation_id: "fix",
    resume_delegation_id: "build",
    resume_session_id: session,
  };
  await assert.rejects(
    delegate("codex", resumed, override("codex")),
    /same provider|this provider/,
  );
  const result = await delegate(
    "claude",
    resumed,
    override("claude", "success", "22222222-2222-4222-8222-222222222222"),
  );
  assert.equal(result.status, "session_mismatch");
});

test("symlinked delegation directories cannot redirect evidence writes", async (t) => {
  const input = await setup(t);
  const root = path.join(input.cwd, "artifacts/farcall");
  await mkdir(root);
  await symlink(input.cwd, path.join(root, "build"));
  await assert.rejects(
    delegate("claude", input, override("claude")),
    /real directory/,
  );
});

test("permission denials and result truncation remain visible to the parent", async (t) => {
  const input = await setup(t);
  const denied = await delegate("claude", input, override("claude", "denied"));
  assert.equal(denied.status, "completed");
  assert.equal(denied.permission_denials_count, 1);
  assert.equal(denied.permission_denials[0].tool_name, "Bash");
  const long = await delegate(
    "claude",
    { ...input, delegation_id: "long" },
    override("claude", "long-result"),
  );
  assert.equal(long.result_truncated, true);
  assert.equal(long.result.length, 24000);
  assert.equal(long.result_characters, 25000);
  const native = JSON.parse(
    await readFile(
      path.join(long.evidence_directory, "native-result.json"),
      "utf8",
    ),
  );
  assert.equal(native.result.length, 25000);
  const invalid = await delegate(
    "claude",
    { ...input, delegation_id: "invalid" },
    override("claude", "invalid-model"),
  );
  assert.equal(invalid.status, "invalid_event");
});
