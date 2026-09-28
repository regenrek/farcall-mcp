import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
  realpath,
} from "node:fs/promises";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { delegate } from "../src/application/delegate.mjs";
import { runProcess } from "../src/platform/process.mjs";

async function setup(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "lifecycle-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(path.join(cwd, "artifacts"));
  const prompt_file = path.join(cwd, "artifacts/task.md");
  await writeFile(prompt_file, "Task");
  return {
    cwd,
    prompt_file,
    delegation_id: "review",
    model: "claude-opus-5-5",
    effort: "high",
    timeout_seconds: 5,
  };
}
const fixture = (name, ...args) => ({
  command: process.execPath,
  args: [path.join(import.meta.dirname, "fixtures", name), ...args],
});
// Poll instead of fs.watch: macOS FSEvents can drop events between checks.
async function waitForText(file, ready = (text) => text !== "") {
  const deadline = performance.now() + 5000;
  for (;;) {
    try {
      const text = await readFile(file, "utf8");
      if (ready(text)) return text;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (performance.now() > deadline) throw new Error(`Timed out: ${file}`);
    await delay(20);
  }
}
const waitForFile = (directory, name) =>
  waitForText(path.join(directory, name));

for (const mode of ["group", "session"]) {
  for (const task of ["success", "timeout", "cancel"]) {
    test(
      `pipe holder ${mode}: bounded ${task}`,
      { timeout: 8000 },
      async (t) => {
        const input = await setup(t);
        const controller = new AbortController();
        const start = performance.now();
        const resultPromise = delegate(
          "claude",
          { ...input, timeout_seconds: task === "success" ? 5 : 1 },
          {
            commandOverride: fixture("pipe-holder.mjs", mode, task),
            signal: controller.signal,
          },
        );
        const pid = Number(await waitForFile(input.cwd, "pipe-holder.pid"));
        t.after(() => {
          try {
            process.kill(pid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        });
        if (task === "cancel") controller.abort();
        const result = await resultPromise;
        assert.equal(
          result.status,
          task === "success"
            ? "completed"
            : task === "cancel"
              ? "cancelled"
              : "timeout",
        );
        assert.ok(performance.now() - start < 4500);
        assert.equal(result.stdout_truncated, mode === "session");
        if (task === "success") assert.equal(result.result, "done");
        await assert.rejects(
          access(path.join(input.cwd, "artifacts/farcall/.active")),
          { code: "ENOENT" },
        );
      },
    );
  }
}

test("root and subdirectory jobs share the Git checkout lock", async (t) => {
  const input = await setup(t);
  execFileSync("git", ["init", "-q", input.cwd]);
  const nested = path.join(input.cwd, "packages/web");
  await mkdir(nested, { recursive: true });
  const controller = new AbortController();
  const pending = delegate("claude", input, {
    commandOverride: fixture("pipe-holder.mjs", "group", "timeout"),
    signal: controller.signal,
  });
  await waitForFile(input.cwd, "pipe-holder.pid");
  try {
    await assert.rejects(
      delegate(
        "codex",
        { cwd: nested, delegation_id: "nested", duration_seconds: 0 },
        { preflight: true },
      ),
      /worker lock/,
    );
  } finally {
    controller.abort();
    await pending;
  }
  const nestedRun = await delegate(
    "codex",
    { cwd: nested, delegation_id: "nested", duration_seconds: 0 },
    { preflight: true },
  );
  assert.equal(nestedRun.status, "completed");
  const request = JSON.parse(
    await readFile(
      path.join(nestedRun.evidence_directory, "request.json"),
      "utf8",
    ),
  );
  assert.equal(request.checkout_root, await realpath(input.cwd));
  assert.equal(request.cwd, await realpath(nested));
});

for (const provider of ["claude", "codex"]) {
  test(
    `${provider} server cancels on stdin EOF without a signal`,
    { timeout: 8000 },
    async (t) => {
      const input = await setup(t);
      const child = spawn(
        process.execPath,
        [path.resolve(`plugins/${provider}-worker/server.mjs`)],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      t.after(() => child.kill("SIGKILL"));
      const exited = once(child, "exit");
      child.stdout.resume();
      child.stderr.resume();
      const send = (value) => child.stdin.write(JSON.stringify(value) + "\n");
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "eof", version: "1" },
        },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
      send({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "preflight",
          arguments: {
            cwd: input.cwd,
            delegation_id: "eof",
            duration_seconds: 1,
          },
        },
      });
      // A completed first request is the readiness handshake for the long request.
      const root = path.join(input.cwd, "artifacts/farcall");
      await waitForText(path.join(root, "eof/completion.json"));
      send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "preflight",
          arguments: {
            cwd: input.cwd,
            delegation_id: "long",
            duration_seconds: 60,
            trace: true,
          },
        },
      });
      await waitForText(path.join(root, "long/lifecycle.jsonl"), (log) =>
        log.includes("worker_started"),
      );
      child.stdin.end();
      const [code] = await exited;
      assert.equal(code, 0);
      const completion = JSON.parse(
        await readFile(path.join(root, "long/completion.json"), "utf8"),
      );
      assert.equal(completion.status, "cancelled");
      await assert.rejects(access(path.join(root, ".active")), {
        code: "ENOENT",
      });
    },
  );
}

test("evidence and adapter failures have different outcomes", async (t) => {
  const input = await setup(t);
  const directory = path.join(input.cwd, "artifacts/failure");
  await mkdir(directory);
  const result = await runProcess({
    ...fixture("provider.mjs", "claude"),
    cwd: input.cwd,
    directory,
    prompt: "test",
    timeout: 2,
    onEvent() {
      throw new Error("Invalid native event");
    },
  });
  assert.equal(result.status, "invalid_event");
  const broken = path.join(input.cwd, "artifacts/broken");
  await mkdir(broken);
  await mkdir(path.join(broken, "events.jsonl"));
  await assert.rejects(
    runProcess({
      ...fixture("provider.mjs", "claude"),
      cwd: input.cwd,
      directory: broken,
      trace: true,
      prompt: "test",
      timeout: 2,
      onEvent() {},
    }),
  );
});

for (const mode of ["split", "late", "held"]) {
  test(
    `stderr drain preserves diagnostics: ${mode}`,
    { timeout: 5000 },
    async (t) => {
      const input = await setup(t);
      let holderPid;
      if (mode !== "split") {
        t.after(() => {
          if (!holderPid) return;
          try {
            process.kill(holderPid, "SIGKILL");
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        });
      }
      const started = performance.now();
      const pending = runProcess({
        ...fixture("stderr-drain.mjs", mode),
        cwd: input.cwd,
        directory: path.join(input.cwd, "unused-without-tracing"),
        prompt: "test",
        timeout: 2,
        drainMs: 500,
        onEvent() {},
      });
      if (mode !== "split") {
        holderPid = Number(await waitForFile(input.cwd, "stderr-holder.pid"));
      }
      const result = await pending;
      assert.equal(result.status, "failed");
      assert.equal(result.stdout_truncated, false);
      assert.equal(result.stderr_truncated, mode === "held");
      assert.equal(
        result.stderr_tail,
        {
          split: "Fehler café ✓ 😀",
          late: "late diagnostic ✓",
          held: "held diagnostic",
        }[mode],
      );
      assert.ok(performance.now() - started < 2000);
    },
  );
}
