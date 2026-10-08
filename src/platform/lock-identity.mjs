import { hostname } from "node:os";

const positivePid = (value) => Number.isSafeInteger(value) && value > 0;
const absent = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // Permission failures and unsupported probes must fail closed.
    return error.code === "ESRCH";
  }
};

export function lockIdentity(info, delegationIds = []) {
  return {
    ...info,
    hostname: hostname(),
    server_pid: process.pid,
    started_at: info.started_at ?? new Date().toISOString(),
    worker_identity_version: 1,
    workers: delegationIds.map((delegation_id) => ({
      delegation_id,
      state: "not_spawned",
    })),
  };
}

// A reused live PID/PGID deliberately blocks recovery. We never use elapsed
// wall time or a mismatching process start time to override a live probe.
export function staleLockReason(lock) {
  if (lock.hostname !== hostname()) return "foreign or unknown hostname";
  if (!positivePid(lock.server_pid)) return "missing or invalid server_pid";
  if (!absent(lock.server_pid))
    return `server PID ${lock.server_pid} is alive or cannot be probed`;
  if (
    lock.worker_identity_version !== 1 ||
    typeof lock.lock_id !== "string" ||
    !lock.lock_id ||
    typeof lock.started_at !== "string" ||
    !Number.isFinite(Date.parse(lock.started_at)) ||
    !Array.isArray(lock.workers)
  )
    return "legacy or incomplete worker identity";
  for (const worker of lock.workers) {
    if (
      worker?.state === "not_spawned" &&
      worker.process_group_id === undefined
    )
      continue;
    if (worker?.state !== "spawned" || !positivePid(worker.process_group_id))
      return "worker spawn in progress or incomplete process-group identity";
    if (!absent(-worker.process_group_id))
      return `worker process group ${worker.process_group_id} is alive or cannot be probed`;
  }
  return null;
}

export const recoveryReason =
  "same hostname; server PID absent; all worker groups absent or never spawned";
