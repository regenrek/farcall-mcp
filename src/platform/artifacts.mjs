import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  writeFile,
  rename,
  open,
  unlink,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import {
  lockIdentity,
  staleLockReason,
  recoveryReason,
} from "./lock-identity.mjs";
import { checkoutRoot } from "./checkout.mjs";

export const sha256 = (value) =>
  createHash("sha256").update(value).digest("hex");
export async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, file);
}
export const readJson = async (file) =>
  JSON.parse(await readFile(file, "utf8"));
export async function containedDirectory(parent, name) {
  const directory = path.join(parent, name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (
    (await lstat(directory)).isSymbolicLink() ||
    (await realpath(directory)) !== directory
  ) {
    throw new Error(`Artifact directory must not be a symlink: ${directory}`);
  }
  return directory;
}
export async function prepare(input, preflight) {
  const cwd = await realpath(input.cwd);
  const artifacts = await containedDirectory(cwd, "artifacts");
  const root = await containedDirectory(artifacts, "farcall");
  let prompt = "Deterministic MCP preflight. No model call.";
  if (!preflight) {
    if (input.prompt !== undefined) {
      prompt = input.prompt;
    } else {
      const file = await realpath(input.prompt_file);
      if (!file.startsWith(`${artifacts}${path.sep}`))
        throw new Error("prompt_file must be inside cwd/artifacts");
      const handle = await open(file, "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 1_000_000)
          throw new Error("Prompt must be a file under 1 MB");
        prompt = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
    }
  }
  if (!prompt.trim() || Buffer.byteLength(prompt) > 1_000_000)
    throw new Error("Invalid prompt size");
  const checkout = await checkoutRoot(cwd);
  const lockArtifacts = await containedDirectory(checkout, "artifacts");
  const lockRoot = await containedDirectory(lockArtifacts, "farcall");
  return { cwd, root, prompt, checkout, lockRoot };
}
export async function inspectLock(file) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("not a regular lock file");
    const text = await readFile(file, "utf8");
    const lock = JSON.parse(text);
    return { lock, text, reason: staleLockReason(lock) };
  } catch (error) {
    if (error.code === "ENOENT") throw error;
    return { reason: `unreadable or incomplete lock: ${error.message}` };
  }
}

export function lockRefusal(file, reason, cause) {
  return new Error(
    `Checkout already has an active or stale worker lock (${reason}). Inspect ${file} and its worker processes before removing it.`,
    { cause },
  );
}

export function lockRecoveryError(error, recoveries) {
  if (!recoveries?.length) return error;
  const diagnostic = error instanceof Error ? error : new Error(String(error));
  diagnostic.lock_recoveries = recoveries;
  diagnostic.message += ` Recovered locks: ${JSON.stringify(recoveries)}`;
  return diagnostic;
}

export async function recoverLock(file, recoveries, inspected) {
  const current = await inspectLock(file);
  if (current.reason) throw lockRefusal(file, current.reason);
  if (inspected && current.text !== inspected.text)
    throw lockRefusal(file, "lock changed during recovery");
  await unlink(file);
  recoveries.push({
    file,
    lock_id: current.lock.lock_id,
    reason: recoveryReason,
  });
}

export async function acquireLock(root, info, { recoveries = [] } = {}) {
  const file = path.join(root, ".active");
  const fenceFile = `${file}.recovery`;
  try {
    await lstat(fenceFile);
    throw lockRefusal(
      fenceFile,
      "recovery already in progress or interrupted",
      { code: "EEXIST" },
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const identity =
    info.worker_identity_version === 1
      ? info
      : lockIdentity({ ...info, lock_id: randomUUID() });
  let handle;
  try {
    handle = await open(file, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    try {
      const inspected = await inspectLock(file);
      if (inspected.reason) throw lockRefusal(file, inspected.reason, error);
    } catch (probe) {
      if (probe.code !== "ENOENT") throw probe;
    }
    // Serialize competing recovery attempts, including the global admission
    // mutex itself. An orphaned recovery fence fails closed for manual inspection.
    let fence;
    try {
      fence = await open(fenceFile, "wx", 0o600);
    } catch {
      throw lockRefusal(
        fenceFile,
        "recovery already in progress or interrupted",
        error,
      );
    }
    try {
      try {
        await recoverLock(file, recoveries);
      } catch (probe) {
        if (probe.code !== "ENOENT") {
          probe.cause = error;
          throw probe;
        }
      }
      try {
        handle = await open(file, "wx", 0o600);
      } catch (replacement) {
        if (replacement.code === "EEXIST")
          throw lockRefusal(
            file,
            "another admission acquired the lock during recovery",
            replacement,
          );
        throw replacement;
      }
    } finally {
      await fence.close();
      await unlink(fenceFile);
    }
  }
  try {
    await handle.writeFile(JSON.stringify(identity));
  } catch (error) {
    await handle.close();
    await unlink(file);
    throw error;
  }
  const release = async () => {
    await handle.close();
    await unlink(file);
  };
  release.update = (value) => atomicJson(file, value);
  return release;
}
export async function existingRecord(directory) {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error("Delegation directory must be a real directory");
    return await readJson(path.join(directory, "request.json"));
  } catch (error) {
    if (error.code === "ENOENT") {
      // An interrupted directory without its request must never be reused.
      try {
        await lstat(directory);
      } catch (missing) {
        if (missing.code === "ENOENT") return null;
        throw missing;
      }
      throw new Error(
        "Incomplete delegation record. Use a new ID after inspecting the old record.",
        { cause: error },
      );
    }
    throw error;
  }
}
