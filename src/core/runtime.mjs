export function requireSupportedNode(version = process.versions.node) {
  // October 2026 security releases, including CVE-2026-111497.
  // Keep this function self-contained: build.mjs embeds it before bundle code.
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const [major, minor, patch] = match ? match.slice(1).map(Number) : [];
  const minimum = { 24: [22, 1], 26: [12, 1] }[major];
  if (
    !minimum ||
    minor < minimum[0] ||
    (minor === minimum[0] && patch < minimum[1])
  ) {
    throw new Error(
      `farcall-mcp requires Node 24.22.1+ (24.x) or 26.12.1+ (26.x); found ${version}. ` +
        "This security baseline includes CVE-2026-111497. Check the parent host's PATH. " +
        "After active jobs finish, restart the parent client and any persistent daemon with a supported Node version.",
    );
  }
}
