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
import { hostname } from "node:os";
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
    if (!prompt.trim() || Buffer.byteLength(prompt) > 1_000_000)
      throw new Error("Invalid prompt size");
  }
  const checkout = await checkoutRoot(cwd);
  const lockArtifacts = await containedDirectory(checkout, "artifacts");
  const lockRoot = await containedDirectory(lockArtifacts, "farcall");
  return { cwd, root, prompt, checkout, lockRoot };
}
export async function acquireLock(root, info) {
  const file = path.join(root, ".active");
  let handle;
  try {
    handle = await open(file, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      let owner = "unknown";
      try {
        const lock = await readJson(file);
        let alive = "unknown";
        if (
          lock.hostname === hostname() &&
          Number.isSafeInteger(lock.server_pid) &&
          lock.server_pid > 0
        ) {
          try {
            process.kill(lock.server_pid, 0);
            alive = "yes";
          } catch (probe) {
            if (probe.code === "ESRCH") alive = "no";
          }
        }
        owner = `PID ${lock.server_pid ?? "unknown"}, host ${lock.hostname ?? "unknown"}, server alive ${alive}`;
      } catch {
        /* A partially written lock still excludes a second job. */
      }
      throw new Error(
        `Checkout already has an active or stale worker lock (${owner}). Inspect ${file} and its worker processes before removing it.`,
        { cause: error },
      );
    }
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ ...info, hostname: hostname() }));
  } catch (error) {
    await handle.close();
    await unlink(file);
    throw error;
  }
  return async () => {
    await handle.close();
    await unlink(file);
  };
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
