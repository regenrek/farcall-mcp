import { startServer } from "./transport/server.mjs";
import { VERSION } from "./core/contracts.mjs";

const [provider] = process.argv.slice(2);
if (provider === "--version") {
  console.log(VERSION);
} else if (provider === "claude" || provider === "codex") {
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("Node 24 or newer is required");
  await startServer(provider);
} else {
  console.error(
    "Usage: agent-worker-mcp <claude|codex>\n       agent-worker-mcp --version",
  );
  process.exitCode = provider === "--help" ? 0 : 1;
}
