import { realpath, stat, readdir, lstat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireLock,
  atomicJson,
  containedDirectory,
  readJson,
  inspectLock,
  recoverLock,
  lockRefusal,
  lockRecoveryError,
} from "./artifacts.mjs";
import { checkoutRoot, gitDirectory } from "./checkout.mjs";
import { stateDirectory } from "./state.mjs";
import { lockIdentity } from "./lock-identity.mjs";

export async function canonicalWritableRoots(roots) {
  const resolved = [];
  for (const root of roots) {
    // JSON and TOML string escapes differ for some controls; reject them explicitly.
    const canonical = await realpath(root);
    if (
      [root, canonical].some((value) =>
        [...value].some(
          (char) => char.codePointAt(0) < 32 || char.codePointAt(0) === 127,
        ),
      )
    )
      throw new Error("Writable paths must not contain control characters");
    if (!(await stat(canonical)).isDirectory())
      throw new Error("Writable roots must be existing directories");
    resolved.push(canonical);
  }
  return [...new Set(resolved)].toSorted();
}

export async function delegationScopes(roots) {
  const scopes = new Map();
  for (const root of roots) {
    const checkout = await checkoutRoot(root);
    if (scopes.has(checkout)) continue;
    scopes.set(checkout, {
      root: checkout,
      git_directory: await gitDirectory(checkout),
      lock_root: await containedDirectory(
        await containedDirectory(checkout, "artifacts"),
        "farcall",
      ),
    });
  }
  return [...scopes.values()];
}

const contains = (a, b) => {
  const relative = path.relative(a, b);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};
export const scopesOverlap = (a, b) =>
  a.some((left) =>
    b.some(
      (right) =>
        contains(left.root, right.root) ||
        contains(right.root, left.root) ||
        (left.git_directory && left.git_directory === right.git_directory),
    ),
  );

export function validateScopeIsolation(plans) {
  for (let i = 0; i < plans.length; i++)
    for (const other of plans.slice(i + 1))
      if (scopesOverlap(plans[i].scopes, other.scopes))
        throw new Error(
          "Batch requires distinct, non-overlapping checkout and writable roots, including Git directory aliases",
        );
}

// Serialize only filesystem admission, never worker execution. The mutex and
// claims recover only with complete, dead-owner identity. Live reused PIDs block.
async function admissionGuard(registry, recoveries) {
  const deadline = performance.now() + 5000;
  for (;;) {
    try {
      return await acquireLock(
        registry,
        { server_pid: process.pid },
        { recoveries },
      );
    } catch (error) {
      if (error.cause?.code !== "EEXIST" || performance.now() >= deadline)
        throw error;
      await delay(25);
    }
  }
}

async function releaseAll(releases) {
  const settled = await Promise.allSettled(
    releases.map((release) => release()),
  );
  const errors = settled
    .filter((item) => item.status === "rejected")
    .map((item) => item.reason);
  if (errors.length)
    throw new AggregateError(
      errors,
      "Failed to release worker locks; inspect evidence",
    );
}

export async function acquireDelegationLocks(plans, info) {
  validateScopeIsolation(plans);
  const registry = await containedDirectory(
    await stateDirectory(),
    "write-scopes",
  );
  const recoveries = [];
  const releaseGuard = await admissionGuard(registry, recoveries);
  const identity = lockIdentity(
    { ...info, lock_id: randomUUID() },
    plans.map((plan) => plan.input.delegation_id),
  );
  const claim = path.join(registry, `${randomUUID()}.json`);
  const scopes = plans.flatMap((plan) => plan.scopes);
  const releases = [];
  try {
    for (const name of await readdir(registry)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(registry, name);
      if (!(await lstat(file)).isFile())
        throw lockRefusal(file, "invalid write-scope claim");
      let previous;
      try {
        previous = await readJson(file);
      } catch (error) {
        throw lockRefusal(
          file,
          `unreadable or incomplete write-scope claim: ${error.message}`,
        );
      }
      if (
        !Array.isArray(previous?.scopes) ||
        previous.scopes.some(
          (scope) =>
            typeof scope?.root !== "string" || !path.isAbsolute(scope.root),
        )
      )
        throw lockRefusal(file, "incomplete write-scope claim");
      if (!scopesOverlap(scopes, previous.scopes)) continue;
      const inspected = await inspectLock(file);
      if (inspected.reason) throw lockRefusal(file, inspected.reason);
      const matching = [];
      for (const scope of previous.scopes) {
        if (scope.lock_root !== path.join(scope.root, "artifacts", "farcall"))
          throw lockRefusal(file, "incomplete checkout lock path");
        const checkoutFile = path.join(scope.lock_root, ".active");
        try {
          const checkout = await inspectLock(checkoutFile);
          if (
            !checkout.lock?.lock_id ||
            checkout.lock.lock_id === previous.lock_id
          ) {
            if (checkout.reason)
              throw lockRefusal(checkoutFile, checkout.reason);
            matching.push([checkoutFile, checkout]);
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      // Check every matching checkout before changing anything. A batch claim
      // represents all its worker groups, including siblings in other checkouts.
      for (const [checkoutFile, checkout] of matching)
        await recoverLock(checkoutFile, recoveries, checkout);
      await recoverLock(file, recoveries, inspected);
    }
    // Keep legacy checkout locks so existing single-run servers also exclude jobs.
    for (const root of [
      ...new Set(scopes.map((scope) => scope.lock_root)),
    ].toSorted())
      releases.push(await acquireLock(root, identity, { recoveries }));
    await atomicJson(claim, { ...identity, scopes });
  } catch (error) {
    await releaseAll(releases);
    throw lockRecoveryError(error, recoveries);
  } finally {
    await releaseGuard();
  }
  const release = async () => {
    await updating.catch(() => {});
    const unlock = await admissionGuard(registry, recoveries);
    try {
      await releaseAll(releases);
      await unlink(claim);
    } finally {
      await unlock();
    }
  };
  // Batch workers can spawn concurrently; serialize snapshots across all files.
  let updating = Promise.resolve();
  const updateWorker = (delegationId, worker) => {
    updating = updating.then(async () => {
      const index = identity.workers.findIndex(
        (item) => item.delegation_id === delegationId,
      );
      if (index < 0) throw new Error("Unknown lock worker identity");
      identity.workers[index] = { delegation_id: delegationId, ...worker };
      for (const checkout of releases) await checkout.update(identity);
      await atomicJson(claim, { ...identity, scopes });
    });
    return updating;
  };
  release.lifecycle = (delegationId) => ({
    beforeSpawn: () => updateWorker(delegationId, { state: "spawning" }),
    onSpawn: (process_group_id) =>
      updateWorker(delegationId, { state: "spawned", process_group_id }),
  });
  release.recoveries = recoveries;
  return release;
}
