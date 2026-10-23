import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  rm,
  realpath,
  readdir,
  access,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  delegate,
  prepareDelegation,
  reserveDelegation,
} from "../src/application/delegate.mjs";
import { runBatch } from "../src/application/batch.mjs";
import {
  atomicJson,
  readJson,
  acquireLock,
} from "../src/platform/artifacts.mjs";

async function setup(t) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "stale-lock-")),
  );
  const previous = process.env.FARCALL_STATE_DIR;
  process.env.FARCALL_STATE_DIR = path.join(root, "state");
  t.after(async () => {
    if (previous === undefined) delete process.env.FARCALL_STATE_DIR;
    else process.env.FARCALL_STATE_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const cwd = path.join(root, "checkout");
  const lockRoot = path.join(cwd, "artifacts/farcall");
  const registry = path.join(root, "state/write-scopes");
  await mkdir(lockRoot, { recursive: true });
  await mkdir(registry, { recursive: true });
  return {
    root,
    cwd,
    lockRoot,
    registry,
    file: path.join(lockRoot, ".active"),
  };
}
async function waitFor(read, ready = Boolean) {
  const deadline = performance.now() + 5000;
  for (;;) {
    try {
      const value = await read();
      if (ready(value)) return value;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError))
        throw error;
    }
    if (performance.now() > deadline)
      throw new Error("Timed out waiting for lock lifecycle");
    await delay(20);
  }
}
async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], {
    stdio: "ignore",
    detached: true,
  });
  const pid = child.pid;
  await once(child, "exit");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  return pid;
}
const input = (cwd, id = "new") => ({
  cwd,
  delegation_id: id,
  duration_seconds: 0,
});
const run = (cwd, id) => delegate("codex", input(cwd, id), { preflight: true });
async function fixture(
  ctx,
  overrides = {},
  { claim = true, checkout = true } = {},
) {
  const lock = {
    lock_id: "interrupted-owner",
    delegation_id: "old",
    provider: "codex",
    server_pid: await deadPid(),
    hostname: hostname(),
    started_at: "2026-10-01T00:00:00.000Z",
    worker_identity_version: 1,
    workers: [{ delegation_id: "old", state: "not_spawned" }],
    ...overrides,
  };
  if (checkout) await atomicJson(ctx.file, lock);
  const claimFile = path.join(ctx.registry, "old.json");
  if (claim)
    await atomicJson(claimFile, {
      ...lock,
      scopes: [{ root: ctx.cwd, git_directory: null, lock_root: ctx.lockRoot }],
    });
  return { lock, claimFile };
}
async function absent(file) {
  await assert.rejects(access(file), { code: "ENOENT" });
}

for (const location of ["checkout", "claim"]) {
  for (const mode of [
    "live server",
    "live worker",
    "foreign host",
    "legacy",
    "spawning",
    "unprobeable group",
  ]) {
    test(`${location}: refuses ${mode} with exact evidence path`, async (t) => {
      const ctx = await setup(t);
      let worker;
      if (mode === "live worker") {
        worker = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          { detached: true, stdio: "ignore" },
        );
        await once(worker, "spawn");
        t.after(async () => {
          const exited = once(worker, "exit");
          process.kill(-worker.pid, "SIGKILL");
          await exited;
        });
      }
      const overrides = {
        "live server": { server_pid: process.pid },
        "live worker": {
          workers: [{ state: "spawned", process_group_id: worker?.pid }],
        },
        "foreign host": { hostname: "other-machine" },
        legacy: { worker_identity_version: undefined, workers: undefined },
        spawning: { workers: [{ state: "spawning" }] },
        "unprobeable group": {
          workers: [{ state: "spawned", process_group_id: -1 }],
        },
      }[mode];
      const { claimFile } = await fixture(ctx, overrides, {
        claim: location === "claim",
        checkout: location === "checkout",
      });
      const expected = location === "claim" ? claimFile : ctx.file;
      await assert.rejects(run(ctx.cwd), (error) => {
        assert.ok(error.message.includes(expected));
        assert.match(error.message, /active or stale worker lock/);
        assert.match(
          error.message,
          {
            "live server": /server PID .* alive/,
            "live worker": /worker process group .* alive/,
            "foreign host": /foreign or unknown hostname/,
            legacy: /legacy or incomplete worker identity/,
            spawning: /spawn in progress/,
            "unprobeable group": /incomplete process-group identity/,
          }[mode],
        );
        return true;
      });
      await access(expected);
      await absent(path.join(ctx.registry, ".active"));
    });
  }
}

for (const state of ["not_spawned", "spawned"]) {
  for (const records of ["both", "checkout only", "claim only"]) {
    test(`recovers ${state} worker (${records}), proceeds and reports cleanup`, async (t) => {
      const ctx = await setup(t);
      const workers = [
        {
          delegation_id: "old",
          state,
          ...(state === "spawned" ? { process_group_id: await deadPid() } : {}),
        },
      ];
      const { claimFile } = await fixture(
        ctx,
        { workers },
        {
          claim: records !== "checkout only",
          checkout: records !== "claim only",
        },
      );
      const result = await run(ctx.cwd);
      assert.equal(result.status, "completed");
      assert.deepEqual(
        result.lock_recoveries.map((item) => item.file).toSorted(),
        [
          ...(records !== "claim only" ? [ctx.file] : []),
          ...(records !== "checkout only" ? [claimFile] : []),
        ].toSorted(),
      );
      for (const recovery of result.lock_recoveries)
        assert.match(
          recovery.reason,
          /server PID absent; all worker groups absent or never spawned/,
        );
      assert.deepEqual(
        (
          await readJson(
            path.join(result.evidence_directory, "completion.json"),
          )
        ).lock_recoveries,
        result.lock_recoveries,
      );
      await absent(ctx.file);
      await absent(claimFile);
      assert.deepEqual(await readdir(ctx.registry), []);
    });
  }
}

test("actual server crash retains child group identity and refuses until worker exits", async (t) => {
  const ctx = await setup(t);
  const module = new URL("../src/application/delegate.mjs", import.meta.url)
    .href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { delegate } from ${JSON.stringify(module)};
    await delegate('codex', ${JSON.stringify({ ...input(ctx.cwd, "crashed"), duration_seconds: 60, timeout_seconds: 120 })}, { preflight: true });
  `,
    ],
    { stdio: "ignore" },
  );
  t.after(() => child.kill("SIGKILL"));
  const lock = await waitFor(
    () => readJson(ctx.file),
    (value) => value.workers?.[0]?.state === "spawned",
  );
  const pgid = lock.workers[0].process_group_id;
  t.after(() => {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  });
  const names = await waitFor(
    () => readdir(ctx.registry),
    (entries) => entries.some((entry) => entry.endsWith(".json")),
  );
  const claimName = names.find((entry) => entry.endsWith(".json"));
  const claimFile = path.join(ctx.registry, claimName);
  await waitFor(
    () => readJson(claimFile),
    (value) => value.workers[0].state === "spawned",
  );
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  process.kill(-pgid, 0);
  await assert.rejects(run(ctx.cwd), /worker process group .* alive/);
  await access(ctx.file);
  await access(claimFile);
  process.kill(-pgid, "SIGKILL");
  await waitFor(async () => {
    try {
      process.kill(-pgid, 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  });
  const result = await run(ctx.cwd);
  assert.equal(result.status, "completed");
  assert.equal(result.lock_recoveries.length, 2);
  await absent(claimFile);
});

for (const mode of ["completion", "cancellation", "timeout"]) {
  test(`normal ${mode} records group in both files and removes both`, async (t) => {
    const ctx = await setup(t);
    const controller = new AbortController();
    const pending = delegate(
      "codex",
      {
        ...input(ctx.cwd),
        duration_seconds: mode === "completion" ? 1 : 60,
        timeout_seconds: mode === "timeout" ? 1 : 5,
      },
      { preflight: true, signal: controller.signal },
    );
    const lock = await waitFor(
      () => readJson(ctx.file),
      (value) => value.workers?.[0]?.state === "spawned",
    );
    const names = await readdir(ctx.registry);
    const claimFile = path.join(
      ctx.registry,
      names.find((name) => name.endsWith(".json")),
    );
    const claim = await waitFor(
      () => readJson(claimFile),
      (value) => value.workers[0].state === "spawned",
    );
    assert.equal(lock.server_pid, process.pid);
    assert.equal(lock.hostname, hostname());
    assert.equal(lock.lock_id, claim.lock_id);
    assert.deepEqual(lock.workers, claim.workers);
    process.kill(-lock.workers[0].process_group_id, 0);
    if (mode === "cancellation") controller.abort();
    const result = await pending;
    assert.equal(
      result.status,
      {
        completion: "completed",
        cancellation: "cancelled",
        timeout: "timeout",
      }[mode],
    );
    await absent(ctx.file);
    assert.deepEqual(await readdir(ctx.registry), []);
  });
}

test("stale claim cannot remove a matching checkout with a live worker", async (t) => {
  const ctx = await setup(t);
  await fixture(ctx);
  const lock = await readJson(ctx.file);
  lock.workers = [{ state: "spawned" }];
  const worker = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { detached: true, stdio: "ignore" },
  );
  await once(worker, "spawn");
  t.after(async () => {
    const exited = once(worker, "exit");
    process.kill(-worker.pid, "SIGKILL");
    await exited;
  });
  lock.workers[0].process_group_id = worker.pid;
  await atomicJson(ctx.file, lock);
  await assert.rejects(run(ctx.cwd), /worker process group .* alive/);
  await access(ctx.file);
  await access(path.join(ctx.registry, "old.json"));
});

test("stale admission mutex recovers, interrupted recovery fence fails closed", async (t) => {
  const ctx = await setup(t);
  const { lock } = await fixture(ctx, {}, { checkout: false, claim: false });
  const mutex = path.join(ctx.registry, ".active");
  await atomicJson(mutex, { ...lock, workers: [] });
  const result = await run(ctx.cwd);
  assert.deepEqual(
    result.lock_recoveries.map((item) => item.file),
    [mutex],
  );
  await atomicJson(ctx.file, lock);
  const fence = `${ctx.file}.recovery`;
  await writeFile(fence, "");
  await assert.rejects(run(ctx.cwd, "blocked"), (error) =>
    error.message.includes(fence),
  );
  await access(ctx.file);
  await rm(ctx.file);
  await assert.rejects(run(ctx.cwd, "fence-only"), (error) =>
    error.message.includes(fence),
  );
  await access(fence);
  await absent(ctx.file);
});

test("concurrent recovery admits only one owner", async (t) => {
  const ctx = await setup(t);
  await fixture(ctx);
  const attempts = await Promise.allSettled(
    Array.from({ length: 6 }, (_, index) =>
      delegate(
        "codex",
        { ...input(ctx.cwd, `run-${index}`), duration_seconds: 1 },
        { preflight: true },
      ),
    ),
  );
  assert.equal(
    attempts.filter((item) => item.status === "fulfilled").length,
    1,
  );
  for (const item of attempts.filter(
    (attempt) => attempt.status === "rejected",
  ))
    assert.match(item.reason.message, /worker lock/);
  assert.deepEqual(await readdir(ctx.registry), []);
});

test("batch recovery reports cleanup and records every worker group", async (t) => {
  const ctx = await setup(t);
  await fixture(ctx);
  const second = path.join(ctx.root, "second");
  await mkdir(second);
  const pending = runBatch(
    "claude",
    {
      batch_id: "recovered-batch",
      tasks: [ctx.cwd, second].map((cwd, index) => ({
        task_id: `task-${index}`,
        cwd,
        delegation_id: `batch-${index}`,
        prompt: "fixture",
        model: "claude-opus-5-5",
        effort: "high",
        timeout_seconds: 5,
      })),
    },
    {
      commandOverride: {
        command: process.execPath,
        args: [
          "--input-type=module",
          "-e",
          `
          import { access } from 'node:fs/promises';
          import { setTimeout as delay } from 'node:timers/promises';
          for await (const chunk of process.stdin) { /* drain prompt */ }
          for (;;) {
            try { await access(${JSON.stringify(path.join(ctx.root, "go"))}); break; }
            catch { await delay(20); }
          }
          console.log(JSON.stringify({ type: 'result', session_id: 'fixture', result: 'done' }));
        `,
        ],
      },
    },
  );
  const lock = await waitFor(
    () => readJson(ctx.file),
    (value) =>
      value.workers?.length === 2 &&
      value.workers.every((worker) => worker.state === "spawned"),
  );
  const secondFile = path.join(second, "artifacts/farcall/.active");
  const secondLock = await waitFor(
    () => readJson(secondFile),
    (value) => value.workers?.every((worker) => worker.state === "spawned"),
  );
  const claimName = (await readdir(ctx.registry)).find((entry) =>
    entry.endsWith(".json"),
  );
  const claim = await waitFor(
    () => readJson(path.join(ctx.registry, claimName)),
    (value) => value.workers.every((worker) => worker.state === "spawned"),
  );
  assert.equal(lock.lock_id, secondLock.lock_id);
  assert.equal(lock.lock_id, claim.lock_id);
  assert.deepEqual(lock.workers, secondLock.workers);
  assert.deepEqual(lock.workers, claim.workers);
  for (const worker of lock.workers) process.kill(-worker.process_group_id, 0);
  await writeFile(path.join(ctx.root, "go"), "ready");
  const result = await pending;
  assert.equal(result.status, "completed");
  assert.equal(result.lock_recoveries.length, 2);
  assert.deepEqual(await readdir(ctx.registry), []);
  await absent(ctx.file);
  await absent(secondFile);
});

test("direct lock recovery contenders never remove a replacement live lock", async (t) => {
  const ctx = await setup(t);
  await fixture(ctx, {}, { claim: false });
  const outcomes = await Promise.allSettled(
    Array.from({ length: 6 }, () =>
      acquireLock(ctx.lockRoot, { server_pid: process.pid }),
    ),
  );
  const owners = outcomes.filter((item) => item.status === "fulfilled");
  assert.equal(owners.length, 1);
  assert.equal((await readJson(ctx.file)).server_pid, process.pid);
  await owners[0].value();
});

test("recovery is reported when an interrupted delegation is refused without redispatch", async (t) => {
  const ctx = await setup(t);
  const plan = await prepareDelegation("codex", input(ctx.cwd), {
    preflight: true,
  });
  await reserveDelegation(plan);
  const { claimFile } = await fixture(ctx);
  await assert.rejects(run(ctx.cwd), (error) => {
    assert.match(error.message, /dispatched without a completion record/);
    assert.match(error.message, /Recovered locks:/);
    assert.deepEqual(
      error.lock_recoveries.map((item) => item.file).toSorted(),
      [ctx.file, claimFile].toSorted(),
    );
    return true;
  });
  await access(path.join(plan.directory, "request.json"));
  await absent(path.join(plan.directory, "completion.json"));
  await absent(ctx.file);
  await absent(claimFile);
  assert.deepEqual(await readdir(ctx.registry), []);
});
