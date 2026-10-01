import { stat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

// .git is a directory in a checkout and a file in a linked worktree.
// Do not invoke Git with caller-controlled environment or repository hooks.
export async function checkoutRoot(cwd) {
  let directory = cwd;
  for (;;) {
    try {
      const marker = await stat(path.join(directory, ".git"));
      if (marker.isDirectory() || marker.isFile()) return directory;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return cwd;
    directory = parent;
  }
}

// Resolve the per-worktree Git directory, not commondir: linked worktrees have
// independent HEAD/index files even though they legitimately share objects.
export async function gitDirectory(checkout) {
  const marker = path.join(checkout, ".git");
  let entry;
  try {
    entry = await stat(marker);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (entry.isDirectory()) return realpath(marker);
  const text = await readFile(marker, "utf8");
  const match = /^gitdir: (.+?)[\r\n]*$/.exec(text);
  if (!match) throw new Error("Invalid Git directory reference");
  const directory = await realpath(path.resolve(checkout, match[1]));
  if (!(await stat(directory)).isDirectory())
    throw new Error("Git directory reference must target a directory");
  return directory;
}
