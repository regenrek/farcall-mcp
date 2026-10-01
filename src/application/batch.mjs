import { mkdir, lstat, rm } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { gitDirectory } from "../platform/checkout.mjs";
import { parseBatch, timestamp, VERSION } from "../core/contracts.mjs";
import { acquireLock, atomicJson, sha256 } from "../platform/artifacts.mjs";
import {
  batchDirectory,
  taskStateFile,
  taskResult,
  readOptional,
  saveBatchResult,
  recoverBatch,
} from "../platform/batches.mjs";
import {
  prepareDelegation,
  inspectDelegation,
  reserveDelegation,
  executeDelegation,
} from "./delegate.mjs";

const activeBatches = new Map();
const contains = (a, b) => {
  const relative = path.relative(a, b);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
};
function validateIsolation(plans) {
  for (let i = 0; i < plans.length; i++) {
    for (const other of plans.slice(i + 1)) {
      if (plans[i].gitDirectory && plans[i].gitDirectory === other.gitDirectory)
        throw new Error("Batch tasks must not share a Git directory");
      for (const key of ["cwd", "checkout"]) {
        if (
          contains(plans[i][key], other[key]) ||
          contains(other[key], plans[i][key])
        )
          throw new Error(
            "Batch requires distinct, non-overlapping working directories and checkout roots",
          );
      }
    }
  }
}

export async function runBatch(provider, value, options = {}) {
  const input = parseBatch(provider, value);
  // Complete all schema, path, prompt and isolation checks before admission.
  const plans = [];
  for (const { task_id, ...task } of input.tasks) {
    const plan = await prepareDelegation(provider, task);
    plans.push({
      ...plan,
      task_id,
      gitDirectory: await gitDirectory(plan.checkout),
    });
  }
  validateIsolation(plans);
  const tasks = plans.map((plan) => ({
    task_id: plan.task_id,
    delegation_id: plan.input.delegation_id,
    fingerprint: plan.fingerprint,
    evidence_directory: plan.directory,
  }));
  const fingerprint = sha256(JSON.stringify({ provider, tasks }));
  const directory = await batchDirectory(provider, input.batch_id);
  const existing = activeBatches.get(directory);
  if (existing) {
    if (existing.fingerprint !== fingerprint)
      throw new Error("Batch ID already used for a different request");
    // A retry joins the original work. Cancelling the retry does not cancel its owner.
    return existing.pending;
  }
  const pending = admitBatch(
    provider,
    input,
    plans,
    tasks,
    fingerprint,
    directory,
    options,
  );
  activeBatches.set(directory, { fingerprint, pending });
  try {
    return await pending;
  } finally {
    activeBatches.delete(directory);
  }
}

async function admitBatch(
  provider,
  input,
  plans,
  tasks,
  fingerprint,
  directory,
  options,
) {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Batch directory must be a real directory", {
        cause: error,
      });
    const previous = await readOptional(path.join(directory, "request.json"));
    if (!previous)
      throw new Error(
        "Incomplete batch identity; no workers redispatched. Inspect batch evidence.",
        { cause: error },
      );
    if (previous.fingerprint !== fingerprint)
      throw new Error("Batch ID already used for a different request", {
        cause: error,
      });
    return recoverBatch(directory, previous);
  }
  const request = {
    batch_id: input.batch_id,
    provider,
    fingerprint,
    bridge_version: VERSION,
    server_pid: process.pid,
    hostname: hostname(),
    requested_at: timestamp(),
    tasks,
  };
  await atomicJson(path.join(directory, "request.json"), request);
  const result = (status, results, extra = {}) => ({
    batch_id: input.batch_id,
    provider,
    status,
    tasks: results,
    evidence_directory: directory,
    ...extra,
  });
  const releases = [];
  const reserved = [];
  let admitted = false;
  try {
    // Acquire every existing single-run checkout lock before reserving or starting.
    for (const plan of plans.toSorted((a, b) =>
      a.lockRoot.localeCompare(b.lockRoot),
    )) {
      releases.push(
        await acquireLock(plan.lockRoot, {
          batch_id: input.batch_id,
          delegation_id: plan.input.delegation_id,
          provider,
          server_pid: process.pid,
          started_at: timestamp(),
        }),
      );
    }
    const cached = [];
    for (const plan of plans) cached.push(await inspectDelegation(plan));
    for (let i = 0; i < plans.length; i++) {
      if (!cached[i]) {
        // Track only directories created by this admission for rollback.
        await reserveDelegation(plans[i], {
          ...options,
          onReserved: (folder) => reserved.push(folder),
        });
      }
      await atomicJson(
        taskStateFile(directory, i),
        cached[i]
          ? { phase: "terminal", result: taskResult(tasks[i], cached[i]) }
          : { phase: "not_started" },
      );
    }
    admitted = true;
    const results = await Promise.all(
      plans.map(async (plan, index) => {
        if (cached[index]) return taskResult(tasks[index], cached[index]);
        let started = false;
        let terminal;
        try {
          if (!options.signal?.aborted) {
            await atomicJson(taskStateFile(directory, index), {
              phase: "started",
              dispatched_at: timestamp(),
            });
            started = true;
          }
          // The shared lifecycle records cancellation even when no process starts.
          terminal = taskResult(
            tasks[index],
            await executeDelegation(plan, options),
          );
          if (!started) terminal.dispatch_state = "not_started";
        } catch (error) {
          // Errors do not short-circuit Promise.all or terminate unrelated siblings.
          terminal = taskResult(
            tasks[index],
            null,
            started ? "unknown" : "not_started",
          );
          terminal.error = String(error?.message ?? error).slice(0, 2000);
        }
        try {
          await atomicJson(taskStateFile(directory, index), {
            phase: "terminal",
            result: terminal,
          });
        } catch (error) {
          terminal.persistence_error = String(error?.message ?? error).slice(
            0,
            2000,
          );
        }
        return terminal;
      }),
    );
    const status = results.every((task) => task.status === "completed")
      ? "completed"
      : results.some((task) => task.status === "cancelled")
        ? "cancelled"
        : results.some((task) => task.status === "unknown")
          ? "interrupted"
          : "partial_failure";
    return await saveBatchResult(directory, result(status, results));
  } catch (error) {
    if (admitted) throw error;
    await Promise.all(
      reserved.map((folder) => rm(folder, { recursive: true, force: true })),
    );
    return await saveBatchResult(
      directory,
      result(
        "rejected",
        tasks.map((task) => taskResult(task)),
        {
          error: String(error?.message ?? error).slice(0, 2000),
        },
      ),
    );
  } finally {
    // Cleanup every acquired lock, even when releasing a different lock fails.
    await releaseLocks(releases);
  }
}

async function releaseLocks(releases) {
  const cleanup = await Promise.allSettled(
    releases.map((release) => release()),
  );
  const errors = cleanup
    .filter((entry) => entry.status === "rejected")
    .map((entry) => entry.reason);
  if (errors.length)
    throw new AggregateError(
      errors,
      "Failed to release batch locks; inspect evidence",
    );
}
