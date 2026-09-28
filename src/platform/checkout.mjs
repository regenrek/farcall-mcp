import { lstat } from "node:fs/promises";
import path from "node:path";

// .git is a directory in a checkout and a file in a linked worktree.
// Do not invoke Git with caller-controlled environment or repository hooks.
export async function checkoutRoot(cwd) {
  let directory = cwd;
  for (;;) {
    try {
      const marker = await lstat(path.join(directory, ".git"));
      if (marker.isDirectory() || marker.isFile()) return directory;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return cwd;
    directory = parent;
  }
}
