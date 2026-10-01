import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export async function stateDirectory() {
  const base =
    process.env.FARCALL_STATE_DIR ??
    path.join(
      process.env.XDG_STATE_HOME ?? path.join(homedir(), ".local/state"),
      "farcall",
    );
  if (!path.isAbsolute(base))
    throw new Error("FARCALL_STATE_DIR must be absolute");
  await mkdir(base, { recursive: true, mode: 0o700 });
  return realpath(base);
}
