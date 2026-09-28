export function requireNode24(version = process.versions.node) {
  if (Number(version.split(".")[0]) < 24) {
    throw new Error(
      "farcall-mcp requires Node 24 or newer. Check the parent host's PATH.",
    );
  }
}
