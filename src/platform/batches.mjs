import { mkdir, realpath } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { containedDirectory, atomicJson, readJson } from "./artifacts.mjs";

export const MAX_BATCH_RESULT_BYTES = 256 * 1024;

// A per-user, provider-scoped ID registry, independent of the task directories.
export async function batchDirectory(provider, id) {
  const base =
    process.env.FARCALL_STATE_DIR ??
    path.join(
      process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local/state"),
      "farcall",
    );
  if (!path.isAbsolute(base))
    throw new Error("FARCALL_STATE_DIR must be absolute");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await containedDirectory(await realpath(base), "batches");
  const providers = await containedDirectory(root, provider);
  return path.join(providers, id);
}

export const taskStateFile = (directory, index) =>
  path.join(directory, `task-${index}.json`);

export function taskResult(task, worker = null, status = "not_started") {
  return {
    task_id: task.task_id,
    delegation_id: task.delegation_id,
    status: worker?.status ?? status,
    session_id: worker?.session_id ?? "unknown",
    evidence_directory: task.evidence_directory,
    worker_result_file: worker
      ? path.join(task.evidence_directory, "completion.json")
      : null,
    worker_result: worker,
  };
}

// Unbounded provider fields remain in the original completion file. No counters
// are combined, fabricated or selectively discarded to make the envelope fit.
export function boundBatchResult(result) {
  const bounded = {
    ...result,
    tasks: result.tasks.map((task) => ({ ...task })),
  };
  const bytes = () => Buffer.byteLength(JSON.stringify(bounded));
  const bySize = bounded.tasks.toSorted(
    (a, b) =>
      JSON.stringify(b.worker_result).length -
      JSON.stringify(a.worker_result).length,
  );
  for (const task of bySize) {
    if (bytes() <= MAX_BATCH_RESULT_BYTES) break;
    if (task.worker_result) {
      task.worker_result = null;
      task.result_externalized = true;
    }
  }
  if (bytes() > MAX_BATCH_RESULT_BYTES)
    throw new Error("Batch metadata exceeds result limit");
  return bounded;
}

export async function saveBatchResult(directory, result) {
  const bounded = boundBatchResult(result);
  await atomicJson(path.join(directory, "completion.json"), bounded);
  return bounded;
}

export async function readOptional(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// A different server never takes over an admitted batch or guesses new sessions.
// A crash between the durable dispatch intent and spawn is conservatively unknown.
export async function recoverBatch(directory, request) {
  const completed = await readOptional(path.join(directory, "completion.json"));
  if (completed) return completed;
  let active = false;
  // Same-process work is already joined through the application's active map.
  // A live server PID alone cannot revive an operation that has unwound.
  if (request.hostname === hostname() && request.server_pid !== process.pid) {
    try {
      process.kill(request.server_pid, 0);
      active = true;
    } catch (error) {
      if (error.code !== "ESRCH") active = true;
    }
  }
  const tasks = await Promise.all(
    request.tasks.map(async (task, index) => {
      const state = await readOptional(taskStateFile(directory, index));
      if (state?.phase === "terminal") return state.result;
      const identity = await readOptional(
        path.join(task.evidence_directory, "request.json"),
      );
      const worker =
        identity?.fingerprint === task.fingerprint
          ? await readOptional(
              path.join(task.evidence_directory, "completion.json"),
            )
          : null;
      if (worker) return taskResult(task, worker);
      return taskResult(
        task,
        null,
        state?.phase === "started" ? "unknown" : "not_started",
      );
    }),
  );
  return boundBatchResult({
    batch_id: request.batch_id,
    provider: request.provider,
    status: active ? "active" : "interrupted",
    evidence_directory: directory,
    tasks,
    recovery_note:
      "No tasks were redispatched. Unknown includes dispatch intent without a recorded outcome. Inspect existing evidence and worker processes before recovery; never substitute a new session.",
  });
}
