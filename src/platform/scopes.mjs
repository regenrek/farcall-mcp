import { realpath, stat, readdir, lstat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireLock,
  atomicJson,
  containedDirectory,
  readJson,
} from "./artifacts.mjs";
import { checkoutRoot, gitDirectory } from "./checkout.mjs";
import { stateDirectory } from "./state.mjs";

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
// claims fail closed after an unclean interruption; never infer safety from PID reuse.
async function admissionGuard(registry) {
  const deadline = performance.now() + 5000;
  for (;;) {
    try {
      return await acquireLock(registry, { server_pid: process.pid });
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
  const releaseGuard = await admissionGuard(registry);
  const claim = path.join(registry, `${randomUUID()}.json`);
  const scopes = plans.flatMap((plan) => plan.scopes);
  const releases = [];
  try {
    for (const name of await readdir(registry)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(registry, name);
      if (!(await lstat(file)).isFile())
        throw new Error("Invalid write-scope claim; inspect registry");
      const previous = await readJson(file);
      if (
        !Array.isArray(previous.scopes) ||
        previous.scopes.some(
          (scope) =>
            typeof scope.root !== "string" || !path.isAbsolute(scope.root),
        )
      )
        throw new Error("Incomplete write-scope claim; inspect registry");
      if (scopesOverlap(scopes, previous.scopes))
        throw new Error(
          `Checkout already has an active or stale worker lock (overlapping writable scope). Inspect ${file} before recovery.`,
        );
    }
    // Keep legacy checkout locks so existing single-run servers also exclude jobs.
    for (const root of [
      ...new Set(scopes.map((scope) => scope.lock_root)),
    ].toSorted())
      releases.push(await acquireLock(root, info));
    await atomicJson(claim, { ...info, hostname: hostname(), scopes });
  } catch (error) {
    await releaseAll(releases);
    throw error;
  } finally {
    await releaseGuard();
  }
  return async () => {
    const unlock = await admissionGuard(registry);
    try {
      await releaseAll(releases);
      await unlink(claim);
    } finally {
      await unlock();
    }
  };
}
