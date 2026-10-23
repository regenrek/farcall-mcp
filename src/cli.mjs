import { requireSupportedNode } from "./core/runtime.mjs";
requireSupportedNode();
const [provider] = process.argv.slice(2);
if (provider === "--version") {
  const { VERSION } = await import("./core/version.mjs");
  console.log(VERSION);
} else if (provider === "claude" || provider === "codex") {
  const { startServer } = await import("./transport/server.mjs");
  await startServer(provider);
} else {
  console.error(
    "Usage: farcall-mcp <claude|codex>\n       farcall-mcp --version",
  );
  process.exitCode = provider === "--help" ? 0 : 1;
}
