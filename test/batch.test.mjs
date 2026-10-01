import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  realpath,
  rename,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { MAX_BATCH_RESULT_BYTES } from "../src/platform/batches.mjs";
import { runBatch } from "../src/application/batch.mjs";
import { delegate } from "../src/application/delegate.mjs";

const json = async (file) => JSON.parse(await readFile(file, "utf8"));
async function waitFor(file, check = () => true) {
  const deadline = performance.now() + 7000;
  while (performance.now() < deadline) {
    try {
      const value = await readFile(file, "utf8");
      if (check(value)) return value;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${file}`);
}
async function absent(file) {
  await assert.rejects(readFile(file), { code: "ENOENT" });
}
async function setup(t, provider = "codex", count = 5, configs = []) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "batch-")));
  const fixture = path.join(root, "provider.mjs");
  await writeFile(
    fixture,
    `#!${process.execPath}\nawait import(${JSON.stringify(new URL("./fixtures/batch-provider.mjs", import.meta.url).href)});\n`,
    { mode: 0o700 },
  );
  const tasks = [];
  for (let i = 0; i < count; i++) {
    const cwd = path.join(root, `w${i}`);
    await mkdir(cwd);
    execFileSync("git", ["init", "-q", cwd]);
    await writeFile(
      path.join(cwd, "fixture.json"),
      JSON.stringify({
        provider,
        session: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`,
        ...configs[i],
      }),
    );
    tasks.push({
      task_id: `w${i}`,
      cwd,
      delegation_id: "first-" + i,
      prompt: `Task ${i}`,
      model: provider === "claude" ? "claude-opus-5-5" : "gpt-6.1-sol",
      effort: "high",
      trace: true,
      timeout_seconds: 10,
    });
  }
  const bundle = path.join(root, "server.mjs");
  await writeFile(
    bundle,
    await readFile(path.resolve(`plugins/${provider}-worker/server.mjs`)),
  );
  const clients = [];
  const connect = async () => {
    const client = new Client({ name: "batch-test", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle],
      cwd: root,
      stderr: "pipe",
      env: {
        ...process.env,
        FARCALL_STATE_DIR: path.join(root, "state"),
        [provider === "claude"
          ? "CLAUDE_WORKER_BINARY"
          : "CODEX_WORKER_BINARY"]: fixture,
      },
    });
    await client.connect(transport);
    clients.push(client);
    return { client, transport };
  };
  const { client, transport } = await connect();
  t.after(async () => {
    await Promise.allSettled(clients.map((c) => c.close()));
    await rm(root, { recursive: true, force: true });
  });
  const batch = { batch_id: "batch", tasks };
  const call = (input = batch, options) =>
    client.callTool(
      { name: "run_batch", arguments: input },
      undefined,
      options,
    );
  const ledger = path.join(root, "state/batches", provider, batch.batch_id);
  return { root, tasks, batch, call, client, transport, connect, ledger };
}
async function configure(task, values) {
  const file = path.join(task.cwd, "fixture.json");
  await writeFile(file, JSON.stringify({ ...(await json(file)), ...values }));
}
const evidence = (task) =>
  path.join(task.cwd, "artifacts/farcall", task.delegation_id);
async function noStarts(tasks) {
  for (const task of tasks) await absent(path.join(task.cwd, "started.json"));
}
async function unlocked(tasks) {
  for (const task of tasks)
    await absent(path.join(task.cwd, "artifacts/farcall/.active"));
}
async function dead(pid) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    // Linux may retain a dead orphan as a zombie until the runner's init reaps it.
    if (process.platform === "linux") {
      try {
        if (
          (await readFile(`/proc/${pid}/stat`, "utf8"))
            .split(") ")[1]
            .startsWith("Z")
        )
          return;
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
    }
    await delay(20);
  }
  assert.fail(`Process ${pid} is still alive`);
}

for (const provider of ["claude", "codex"]) {
  test(
    `${provider}: five processes overlap and return one ordered terminal MCP result`,
    { timeout: 15000 },
    async (t) => {
      const { tasks, batch, call, connect } = await setup(t, provider);
      for (const task of tasks)
        await configure(task, {
          barrier: tasks.map((value) => value.cwd),
          delay: 150,
        });
      const response = await call();
      assert.equal(response.isError, false);
      const result = response.structuredContent;
      assert.deepEqual(JSON.parse(response.content[0].text), result);
      assert.equal(result.batch_id, batch.batch_id);
      assert.equal(result.status, "completed");
      assert.deepEqual(
        result.tasks.map((task) => task.task_id),
        tasks.map((task) => task.task_id),
      );
      const starts = [],
        ends = [];
      for (let i = 0; i < tasks.length; i++) {
        const worker = result.tasks[i].worker_result;
        assert.equal(worker.status, "completed");
        assert.equal(worker.result, tasks[i].prompt);
        assert.equal(worker.native_usage.input_tokens, 12);
        assert.equal(worker.native_total_cost_usd, null);
        const events = (
          await readFile(
            path.join(evidence(tasks[i]), "lifecycle.jsonl"),
            "utf8",
          )
        )
          .trim()
          .split("\n")
          .map(JSON.parse);
        starts.push(
          Date.parse(
            events.find((event) => event.type === "worker_started").utc,
          ),
        );
        ends.push(
          Date.parse(events.find((event) => event.type === "finished").utc),
        );
      }
      assert.ok(
        Math.max(...starts) < Math.min(...ends),
        "All five started before the first finished",
      );
      await unlocked(tasks);
      const replay = await call();
      assert.deepEqual(replay.structuredContent, result);
      const { client: freshClient } = await connect();
      const replayAfterRestart = await freshClient.callTool({
        name: "run_batch",
        arguments: batch,
      });
      assert.deepEqual(replayAfterRestart.structuredContent, result);
      const changed = await call({
        ...batch,
        tasks: tasks.map((task, i) =>
          i ? task : { ...task, prompt: "Changed" },
        ),
      });
      assert.equal(changed.isError, true);
      assert.match(changed.content[0].text, /different request/);
    },
  );
}

test(
  "failure and timeout preserve independently completing siblings and process cleanup",
  { timeout: 15000 },
  async (t) => {
    const { tasks, call } = await setup(t, "codex", 3, [
      { fail: true, delay: 50 },
      { tree: true, delay: 20000 },
      { delay: 1600 },
    ]);
    tasks[1].timeout_seconds = 1;
    const result = (await call()).structuredContent;
    assert.equal(result.status, "partial_failure");
    assert.deepEqual(
      result.tasks.map((task) => task.status),
      ["failed", "timeout", "completed"],
    );
    for (const name of ["descendant.pid", "started.json"]) {
      const text = await readFile(path.join(tasks[1].cwd, name), "utf8");
      await dead(name.endsWith("json") ? JSON.parse(text).pid : Number(text));
    }
    await unlocked(tasks);
  },
);

for (const mode of ["cancel", "shutdown", "eof"]) {
  test(
    `batch ${mode} preserves completed results and cleans all active process groups`,
    { timeout: 15000 },
    async (t) => {
      const { tasks, batch, call, transport, client, ledger } = await setup(
        t,
        "claude",
        3,
        [
          { delay: 10 },
          { tree: true, delay: 20000 },
          { tree: true, delay: 20000 },
        ],
      );
      const controller = new AbortController();
      const pending = call(batch, { signal: controller.signal }).catch(
        (error) => error,
      );
      await waitFor(path.join(evidence(tasks[0]), "completion.json"));
      for (const task of tasks.slice(1))
        await waitFor(path.join(task.cwd, "descendant.pid"));
      if (mode === "cancel") controller.abort();
      else if (mode === "shutdown") process.kill(transport.pid, "SIGTERM");
      else await client.close();
      await pending;
      await waitFor(path.join(ledger, "completion.json"));
      const result = await json(path.join(ledger, "completion.json"));
      assert.equal(result.status, "cancelled");
      assert.deepEqual(
        result.tasks.map((task) => task.status),
        ["completed", "cancelled", "cancelled"],
      );
      for (const task of tasks.slice(1)) {
        await dead((await json(path.join(task.cwd, "started.json"))).pid);
        await dead(
          Number(await readFile(path.join(task.cwd, "descendant.pid"), "utf8")),
        );
        const events = await readFile(
          path.join(evidence(task), "lifecycle.jsonl"),
          "utf8",
        );
        assert.match(events, /termination_requested/);
      }
      await unlocked(tasks);
    },
  );
}

for (const mode of [
  "duplicate",
  "symlink",
  "shared-checkout",
  "git-marker-symlink",
  "shared-git-symlink",
  "shared-git-file",
  "non-git-overlap",
  "nested-checkout",
  "invalid",
  "prompt-file",
  "lock",
  "resume",
  "six",
  "duplicate-id",
]) {
  test(`admission rejects ${mode} before starting any task`, async (t) => {
    const { tasks, batch, call, root } = await setup(t, "codex", 2);
    if (mode === "duplicate") tasks[1].cwd = tasks[0].cwd;
    if (mode === "symlink") {
      const alias = path.join(root, "alias");
      await symlink(tasks[0].cwd, alias);
      tasks[1].cwd = alias;
    }
    if (mode === "shared-git-symlink" || mode === "shared-git-file") {
      const marker = path.join(tasks[1].cwd, ".git");
      await rm(marker, { recursive: true });
      const target = path.join(tasks[0].cwd, ".git");
      if (mode === "shared-git-symlink") await symlink(target, marker);
      else await writeFile(marker, `gitdir: ${target}\n`);
    }
    if (
      [
        "shared-checkout",
        "nested-checkout",
        "git-marker-symlink",
        "non-git-overlap",
      ].includes(mode)
    ) {
      if (mode === "git-marker-symlink") {
        const storage = path.join(root, "git-storage");
        await rename(path.join(tasks[0].cwd, ".git"), storage);
        await symlink(storage, path.join(tasks[0].cwd, ".git"));
      }
      if (mode === "non-git-overlap")
        await rm(path.join(tasks[0].cwd, ".git"), { recursive: true });
      const nested = path.join(tasks[0].cwd, "nested");
      await mkdir(nested);
      if (mode === "nested-checkout")
        execFileSync("git", ["init", "-q", nested]);
      tasks[1].cwd = nested;
    }
    if (mode === "invalid") tasks[1].effort = "invalid";
    if (mode === "prompt-file") {
      delete tasks[1].prompt;
      tasks[1].prompt_file = path.join(root, "missing");
    }
    if (mode === "six")
      batch.tasks = Array.from({ length: 6 }, (_, i) => ({
        ...tasks[0],
        task_id: `six${i}`,
        delegation_id: `six${i}`,
      }));
    if (mode === "duplicate-id") tasks[1].task_id = tasks[0].task_id;
    if (mode === "resume") {
      tasks[1].resume_session_id = "11111111-1111-4111-8111-111111111111";
      tasks[1].resume_delegation_id = "absent";
    }
    if (mode === "lock") {
      await mkdir(path.join(tasks[1].cwd, "artifacts/farcall"), {
        recursive: true,
      });
      await writeFile(
        path.join(tasks[1].cwd, "artifacts/farcall/.active"),
        "{}",
      );
    }
    const result = await call();
    assert.equal(result.isError, true);
    if (result.structuredContent) {
      assert.equal(result.structuredContent.status, "rejected");
      assert.ok(
        result.structuredContent.tasks.every(
          (task) => task.status === "not_started",
        ),
      );
    }
    await noStarts(tasks);
    await absent(path.join(tasks[0].cwd, "artifacts/farcall/.active"));
    if (mode === "lock")
      assert.equal(
        await readFile(
          path.join(tasks[1].cwd, "artifacts/farcall/.active"),
          "utf8",
        ),
        "{}",
      );
  });
}

test(
  "active retries join locally, observe remotely, and never create another process",
  { timeout: 15000 },
  async (t) => {
    const { tasks, batch, call, connect } = await setup(t, "codex", 2, [
      { delay: 1000 },
      { delay: 1000 },
    ]);
    const first = call();
    await Promise.all(
      tasks.map((task) => waitFor(path.join(task.cwd, "started.json"))),
    );
    const second = call();
    const { client } = await connect();
    const remote = await client.callTool({
      name: "run_batch",
      arguments: batch,
    });
    assert.equal(remote.structuredContent.status, "active");
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a.structuredContent, b.structuredContent);
    for (const task of tasks) {
      const events = await readFile(
        path.join(evidence(task), "lifecycle.jsonl"),
        "utf8",
      );
      assert.equal(events.match(/worker_started/g).length, 1);
    }
  },
);

test("interrupted retry distinguishes never-started tasks from unknown outcomes without redispatch", async (t) => {
  const { tasks, call, ledger, connect, batch } = await setup(t, "codex", 3);
  await call();
  // Simulate durable crash boundaries without starting or leaking another process.
  await rm(path.join(ledger, "completion.json"));
  const request = await json(path.join(ledger, "request.json"));
  request.hostname = "interrupted-test-other-host";
  await writeFile(path.join(ledger, "request.json"), JSON.stringify(request));
  await writeFile(
    path.join(ledger, "task-0.json"),
    JSON.stringify({ phase: "started" }),
  );
  await writeFile(
    path.join(ledger, "task-1.json"),
    JSON.stringify({ phase: "not_started" }),
  );
  await rm(path.join(evidence(tasks[0]), "completion.json"));
  await rm(path.join(evidence(tasks[1]), "completion.json"));
  const { client } = await connect();
  const result = (
    await client.callTool({ name: "run_batch", arguments: batch })
  ).structuredContent;
  assert.equal(result.status, "interrupted");
  assert.deepEqual(
    result.tasks.map((task) => task.status),
    ["unknown", "not_started", "completed"],
  );
  for (const task of tasks)
    assert.equal(
      (
        await readFile(path.join(evidence(task), "lifecycle.jsonl"), "utf8")
      ).match(/worker_started/g).length,
      1,
    );
});

for (const provider of ["claude", "codex"]) {
  test(`${provider}: correction batch resumes only the two exact sessions, validates every resume before dispatch`, async (t) => {
    const { tasks, call, batch } = await setup(t, provider, 3);
    const original = (await call()).structuredContent;
    const correction = {
      batch_id: "correction",
      tasks: [0, 2].map((i) => ({
        ...tasks[i],
        delegation_id: "correct-" + i,
        resume_delegation_id: tasks[i].delegation_id,
        resume_session_id: original.tasks[i].session_id,
        prompt: "Correction",
      })),
    };
    const bad = structuredClone(correction);
    bad.batch_id = "bad-resume";
    bad.tasks[1].resume_session_id = "22222222-2222-4222-8222-222222222222";
    assert.equal((await call(bad)).structuredContent.status, "rejected");
    for (const task of correction.tasks)
      await absent(path.join(evidence(task), "request.json"));
    const fixed = (await call(correction)).structuredContent;
    assert.equal(fixed.status, "completed");
    assert.deepEqual(
      fixed.tasks.map((task) => task.session_id),
      [original.tasks[0].session_id, original.tasks[2].session_id],
    );
    for (const task of correction.tasks) {
      const args = (await json(path.join(task.cwd, "started.json"))).args;
      assert.equal(
        args[args.indexOf(provider === "claude" ? "--resume" : "resume") + 1],
        task.resume_session_id,
      );
    }
    const mismatch = {
      batch_id: "wrong-session",
      tasks: [{ ...correction.tasks[0], delegation_id: "wrong-session" }],
    };
    await configure(tasks[0], {
      wrongSession: "22222222-2222-4222-8222-222222222222",
    });
    assert.equal(
      (await call(mismatch)).structuredContent.tasks[0].status,
      "session_mismatch",
    );
    assert.equal(batch.tasks.length, 3);
  });
}

test("trace-off and prompt files retain only identity/recovery/results; aggregate limit externalizes without data loss", async (t) => {
  const { tasks, call, ledger } = await setup(t, "claude", 5);
  for (const task of tasks) {
    task.trace = false;
    task.max_result_chars = 24000;
    await mkdir(path.join(task.cwd, "artifacts"));
    task.prompt_file = path.join(task.cwd, "artifacts/task.txt");
    await writeFile(task.prompt_file, task.prompt);
    delete task.prompt;
    await configure(task, { large: true, largeUsage: true });
  }
  const response = await call();
  const result = response.structuredContent;
  assert.equal(result.status, "completed");
  assert.ok(Buffer.byteLength(JSON.stringify(response)) < 1024 * 1024);
  assert.deepEqual(JSON.parse(response.content[0].text), result);
  assert.ok(
    Buffer.byteLength(JSON.stringify(result)) <= MAX_BATCH_RESULT_BYTES,
  );
  assert.equal(result.tasks.length, 5);
  for (const task of result.tasks) {
    assert.equal(task.status, "completed");
    assert.ok(
      task.task_id &&
        task.delegation_id &&
        task.session_id &&
        task.evidence_directory,
    );
    assert.equal(task.result_externalized, true);
    const original = await json(task.worker_result_file);
    assert.equal(original.native_usage.opaque.length, 300000);
    assert.equal(original.result.length, 24000);
    assert.deepEqual((await readdir(task.evidence_directory)).toSorted(), [
      "completion.json",
      "request.json",
    ]);
  }
  const request = await readFile(path.join(ledger, "request.json"), "utf8");
  assert.ok(!request.includes("Task 0"));
  assert.deepEqual((await readdir(ledger)).toSorted(), [
    "completion.json",
    "request.json",
    ...tasks.map((_, i) => `task-${i}.json`),
  ]);
});

test("batch admission shares locks with an active single run and rolls back earlier locks", async (t) => {
  const { tasks, call, client } = await setup(t, "codex", 2, [
    {},
    { delay: 2000 },
  ]);
  const { task_id: ignored, ...single } = tasks[1];
  assert.equal(ignored, "w1");
  single.delegation_id = "single";
  const pending = client.callTool({ name: "run", arguments: single });
  await waitFor(path.join(tasks[1].cwd, "started.json"));
  const result = (await call()).structuredContent;
  assert.equal(result.status, "rejected");
  await absent(path.join(tasks[0].cwd, "started.json"));
  await absent(path.join(tasks[0].cwd, "artifacts/farcall/.active"));
  assert.equal((await pending).isError, false);
});

test("linked Git worktrees share objects but have independent canonical checkout locks", async (t) => {
  const { tasks, call, root } = await setup(t, "codex", 2);
  const repository = tasks[0].cwd;
  execFileSync("git", [
    "-C",
    repository,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  ]);
  const linked = path.join(root, "linked");
  execFileSync(
    "git",
    ["-C", repository, "worktree", "add", "--detach", linked],
    { stdio: "pipe" },
  );
  const nested = path.join(repository, "core");
  await mkdir(nested);
  await writeFile(
    path.join(nested, "fixture.json"),
    await readFile(path.join(repository, "fixture.json")),
  );
  await writeFile(
    path.join(linked, "fixture.json"),
    await readFile(path.join(tasks[1].cwd, "fixture.json")),
  );
  tasks[0].cwd = nested;
  tasks[1].cwd = linked;
  const result = (await call()).structuredContent;
  assert.equal(result.status, "completed");
  assert.equal(
    (await json(path.join(evidence(tasks[0]), "request.json"))).checkout_root,
    repository,
  );
  assert.equal(
    (await json(path.join(evidence(tasks[1]), "request.json"))).checkout_root,
    linked,
  );
  await absent(path.join(repository, "artifacts/farcall/.active"));
  await absent(path.join(linked, "artifacts/farcall/.active"));
});

test(
  "hard server interruption never redispatches tasks or invents replacement sessions",
  { timeout: 15000 },
  async (t) => {
    const { tasks, call, batch, transport, connect } = await setup(
      t,
      "codex",
      2,
      [{ delay: 10 }, { delay: 20000 }],
    );
    const pending = call().catch((error) => error);
    await waitFor(path.join(evidence(tasks[0]), "completion.json"));
    await waitFor(path.join(tasks[1].cwd, "started.json"));
    const workerPid = (await json(path.join(tasks[1].cwd, "started.json"))).pid;
    t.after(() => {
      try {
        process.kill(-workerPid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    });
    const serverPid = transport.pid;
    process.kill(serverPid, "SIGKILL");
    await pending;
    await dead(serverPid);
    const { client } = await connect();
    const result = (
      await client.callTool({ name: "run_batch", arguments: batch })
    ).structuredContent;
    assert.equal(result.status, "interrupted");
    assert.deepEqual(
      result.tasks.map((task) => task.status),
      ["completed", "unknown"],
    );
    assert.equal(result.tasks[1].session_id, "unknown");
    assert.equal(
      (await json(path.join(tasks[1].cwd, "started.json"))).pid,
      workerPid,
    );
  },
);

test("same-server retry after lost aggregate persistence is interrupted, never falsely active", async (t) => {
  const { tasks, call, ledger } = await setup(t, "codex", 1);
  await call();
  await rm(path.join(ledger, "completion.json"));
  const recovered = (await call()).structuredContent;
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.tasks[0].status, "completed");
  assert.equal(
    (
      await readFile(path.join(evidence(tasks[0]), "lifecycle.jsonl"), "utf8")
    ).match(/worker_started/g).length,
    1,
  );
});

test("pre-dispatch cancellation records a reusable worker completion and trace without spawning", async (t) => {
  const { root, tasks, batch } = await setup(t, "codex", 1);
  const previous = process.env.FARCALL_STATE_DIR;
  process.env.FARCALL_STATE_DIR = path.join(root, "state");
  t.after(() => {
    if (previous === undefined) delete process.env.FARCALL_STATE_DIR;
    else process.env.FARCALL_STATE_DIR = previous;
  });
  const controller = new AbortController();
  controller.abort();
  const result = await runBatch("codex", batch, { signal: controller.signal });
  assert.equal(result.status, "cancelled");
  assert.equal(result.tasks[0].dispatch_state, "not_started");
  const saved = await json(path.join(evidence(tasks[0]), "completion.json"));
  assert.equal(saved.status, "cancelled");
  const events = await readFile(
    path.join(evidence(tasks[0]), "lifecycle.jsonl"),
    "utf8",
  );
  assert.match(events, /not_started/);
  assert.doesNotMatch(events, /worker_started/);
  const { task_id: ignored, ...single } = tasks[0];
  assert.equal(ignored, "w0");
  assert.deepEqual(await delegate("codex", single), saved);
  await noStarts(tasks);
  await unlocked(tasks);
});

test("an aborted signal does not relabel existing completed and failed outcomes", async (t) => {
  const { root, tasks, call } = await setup(t, "codex", 2, [
    {},
    { fail: true },
  ]);
  const original = (await call()).structuredContent;
  assert.equal(original.status, "partial_failure");
  const previous = process.env.FARCALL_STATE_DIR;
  const previousBinary = process.env.CODEX_WORKER_BINARY;
  process.env.FARCALL_STATE_DIR = path.join(root, "state");
  process.env.CODEX_WORKER_BINARY = path.join(root, "provider.mjs");
  t.after(() => {
    if (previous === undefined) delete process.env.FARCALL_STATE_DIR;
    else process.env.FARCALL_STATE_DIR = previous;
    if (previousBinary === undefined) delete process.env.CODEX_WORKER_BINARY;
    else process.env.CODEX_WORKER_BINARY = previousBinary;
  });
  const controller = new AbortController();
  controller.abort();
  const replay = await runBatch(
    "codex",
    { batch_id: "cached-outcomes", tasks },
    { signal: controller.signal },
  );
  assert.equal(replay.status, "partial_failure");
  assert.deepEqual(replay.tasks, original.tasks);
});

for (const mode of [
  "same-extra",
  "extra-alias",
  "extra-cwd",
  "extra-parent",
  "extra-checkout",
  "missing-extra",
  "file-extra",
  "relative-extra",
  "readonly-network",
  "readonly-roots",
]) {
  test(`writable scope admission rejects ${mode} before any dispatch`, async (t) => {
    const { root, tasks, call } = await setup(t, "codex", 2);
    for (const task of tasks) task.sandbox = "workspace-write";
    const extra = path.join(root, "shared");
    await mkdir(extra);
    tasks[0].writable_roots = [extra];
    if (mode === "same-extra") tasks[1].writable_roots = [extra];
    if (mode === "extra-alias") {
      const alias = path.join(root, "alias");
      await symlink(extra, alias);
      tasks[1].writable_roots = [alias];
    }
    if (mode === "extra-cwd") tasks[0].writable_roots = [tasks[1].cwd];
    if (mode === "extra-parent") tasks[0].writable_roots = [root];
    if (mode === "extra-checkout") {
      const nested = path.join(tasks[1].cwd, "nested");
      await mkdir(nested);
      tasks[0].writable_roots = [nested];
    }
    if (mode === "missing-extra")
      tasks[1].writable_roots = [path.join(root, "missing")];
    if (mode === "file-extra") {
      const file = path.join(root, "file");
      await writeFile(file, "fixture");
      tasks[1].writable_roots = [file];
    }
    if (mode === "relative-extra") tasks[1].writable_roots = ["relative"];
    if (mode === "readonly-network") {
      tasks[1].sandbox = "read-only";
      tasks[1].network_access = false;
    }
    if (mode === "readonly-roots") {
      tasks[1].sandbox = "read-only";
      tasks[1].writable_roots = [];
    }
    assert.equal((await call()).isError, true);
    await noStarts(tasks);
    await unlocked(tasks);
  });
}

test("batch permissions are canonical, per-task, fingerprinted and preserved on exact resume", async (t) => {
  const { root, tasks, batch, call } = await setup(t, "codex", 2);
  const extra = path.join(root, 'plugin "quoted" \\ path');
  await mkdir(extra);
  const alias = path.join(root, "alias");
  await symlink(extra, alias);
  Object.assign(tasks[0], {
    sandbox: "workspace-write",
    writable_roots: [alias, extra],
    network_access: true,
  });
  Object.assign(tasks[1], {
    sandbox: "workspace-write",
    writable_roots: [],
    network_access: false,
  });
  const original = (await call()).structuredContent;
  assert.equal(original.status, "completed");
  for (const [i, task] of tasks.entries()) {
    const args = (await json(path.join(task.cwd, "started.json"))).args;
    assert.ok(
      args.includes(`sandbox_workspace_write.network_access=${i === 0}`),
    );
    assert.ok(
      args.includes(
        `sandbox_workspace_write.writable_roots=${JSON.stringify(i === 0 ? [extra] : [])}`,
      ),
    );
  }
  await absent(path.join(extra, "artifacts/farcall/.active"));
  assert.deepEqual(await readdir(path.join(root, "state/write-scopes")), []);
  assert.equal(
    (
      await call({
        ...batch,
        tasks: tasks.map((task, i) =>
          i ? task : { ...task, network_access: false },
        ),
      })
    ).isError,
    true,
  );
  const changedRoot = path.join(root, "different");
  await mkdir(changedRoot);
  assert.equal(
    (
      await call({
        ...batch,
        tasks: tasks.map((task, i) =>
          i ? task : { ...task, writable_roots: [changedRoot] },
        ),
      })
    ).isError,
    true,
  );
  const correction = {
    batch_id: "permissions-resume",
    tasks: tasks.map((task, i) => ({
      ...task,
      delegation_id: `fix-${i}`,
      resume_delegation_id: task.delegation_id,
      resume_session_id: original.tasks[i].session_id,
    })),
  };
  assert.equal((await call(correction)).structuredContent.status, "completed");
  for (const [i, task] of tasks.entries()) {
    const args = (await json(path.join(task.cwd, "started.json"))).args;
    assert.ok(
      args.indexOf(`sandbox_workspace_write.network_access=${i === 0}`) <
        args.indexOf("resume"),
    );
    assert.equal(
      args[args.indexOf("resume") + 1],
      original.tasks[i].session_id,
    );
  }
});

for (const mode of ["nested-extra", "git-alias", "cross-provider"]) {
  test(`separate calls reject ${mode} overlap against an active worker and release extra locks`, async (t) => {
    const { root, tasks, call, client, connect } = await setup(t, "codex", 2, [
      { delay: 600 },
      {},
    ]);
    const extra = path.join(root, "runtime");
    await mkdir(extra);
    const child = path.join(extra, "db");
    await mkdir(child);
    const { task_id: ignored, ...single } = tasks[0];
    assert.equal(ignored, "w0");
    Object.assign(single, {
      sandbox: "workspace-write",
      writable_roots: [extra],
      trace: false,
    });
    const pending = client.callTool({ name: "run", arguments: single });
    await waitFor(path.join(tasks[0].cwd, "started.json"));
    let response;
    if (mode === "git-alias") {
      await rm(path.join(tasks[1].cwd, ".git"), { recursive: true });
      await symlink(
        path.join(tasks[0].cwd, ".git"),
        path.join(tasks[1].cwd, ".git"),
      );
      response = await call({ batch_id: "alias-active", tasks: [tasks[1]] });
    } else if (mode === "cross-provider") {
      // A second provider process uses the same provider-neutral scope registry.
      const claudeClient = new Client({ name: "scope-check", version: "1" });
      try {
        await claudeClient.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [path.resolve("plugins/claude-worker/server.mjs")],
            env: {
              ...process.env,
              FARCALL_STATE_DIR: path.join(root, "state"),
            },
          }),
        );
        response = await claudeClient.callTool({
          name: "preflight",
          arguments: {
            cwd: child,
            delegation_id: "overlap",
            duration_seconds: 0,
          },
        });
      } finally {
        await claudeClient.close();
      }
    } else {
      const { client: other } = await connect();
      response = await other.callTool({
        name: "run_batch",
        arguments: {
          batch_id: "nested-active",
          tasks: [
            {
              ...tasks[1],
              sandbox: "workspace-write",
              writable_roots: [child],
            },
          ],
        },
      });
    }
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response), /active or stale worker lock/);
    assert.equal((await pending).isError, false);
    await absent(path.join(extra, "artifacts/farcall/.active"));
    assert.deepEqual(await readdir(path.join(root, "state/write-scopes")), []);
  });
}

for (const mode of ["cancel", "shutdown", "timeout", "locked-extra"]) {
  test(`additional write scope cleanup on ${mode}`, async (t) => {
    const { root, tasks, batch, call, transport, ledger } = await setup(
      t,
      "codex",
      2,
      [
        { tree: true, delay: 20000 },
        { tree: true, delay: 20000 },
      ],
    );
    for (const [i, task] of tasks.entries()) {
      const extra = path.join(root, `runtime-${i}`);
      await mkdir(extra);
      Object.assign(task, {
        sandbox: "workspace-write",
        writable_roots: [extra],
        timeout_seconds: mode === "timeout" ? 1 : 10,
      });
    }
    if (mode === "locked-extra") {
      const lock = path.join(tasks[1].writable_roots[0], "artifacts/farcall");
      await mkdir(lock, { recursive: true });
      await writeFile(path.join(lock, ".active"), "{}");
      assert.equal((await call()).structuredContent.status, "rejected");
      await noStarts(tasks);
      await absent(
        path.join(tasks[0].writable_roots[0], "artifacts/farcall/.active"),
      );
    } else {
      const controller = new AbortController();
      const pending = call(batch, { signal: controller.signal }).catch(
        (error) => error,
      );
      for (const task of tasks)
        await waitFor(path.join(task.cwd, "descendant.pid"));
      if (mode === "cancel") controller.abort();
      if (mode === "shutdown") process.kill(transport.pid, "SIGTERM");
      await pending;
      await waitFor(path.join(ledger, "completion.json"));
      // Persistence precedes final lock cleanup after transport cancellation.
      const deadline = performance.now() + 3000;
      while (
        (await readdir(path.join(root, "state/write-scopes"))).length &&
        performance.now() < deadline
      )
        await delay(20);
      for (const task of tasks) {
        await absent(
          path.join(task.writable_roots[0], "artifacts/farcall/.active"),
        );
        await dead((await json(path.join(task.cwd, "started.json"))).pid);
        await dead(
          Number(await readFile(path.join(task.cwd, "descendant.pid"), "utf8")),
        );
      }
    }
    await unlocked(tasks);
    assert.deepEqual(await readdir(path.join(root, "state/write-scopes")), []);
  });
}

test("simultaneous admissions from separate servers dispatch only one writer to a shared extra root", async (t) => {
  const { root, tasks, client, connect } = await setup(t, "codex", 2, [
    { delay: 600 },
    { delay: 600 },
  ]);
  const shared = path.join(root, "runtime");
  await mkdir(shared);
  const { client: second } = await connect();
  const responses = await Promise.all(
    tasks.map((task, i) => {
      const { task_id: ignored, ...single } = task;
      assert.equal(ignored, `w${i}`);
      return [client, second][i].callTool({
        name: "run",
        arguments: {
          ...single,
          sandbox: "workspace-write",
          writable_roots: [shared],
        },
      });
    }),
  );
  assert.equal(responses.filter((response) => !response.isError).length, 1);
  assert.equal(responses.filter((response) => response.isError).length, 1);
  assert.match(
    JSON.stringify(responses.find((response) => response.isError)),
    /active or stale worker lock/,
  );
  let starts = 0;
  for (const task of tasks) {
    try {
      await readFile(path.join(task.cwd, "started.json"));
      starts++;
    } catch (error) {
      assert.equal(error.code, "ENOENT");
    }
  }
  assert.equal(starts, 1);
  await absent(path.join(shared, "artifacts/farcall/.active"));
  assert.deepEqual(await readdir(path.join(root, "state/write-scopes")), []);
});
