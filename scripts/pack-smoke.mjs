import { VERSION } from "../src/core/version.mjs";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = await mkdtemp(path.join(os.tmpdir(), "worker-package-"));
const archive = path.resolve(
  process.argv[2] ?? `artifacts/agent-worker-mcp-${VERSION}.tgz`,
);
try {
  execFileSync(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--prefix",
      root,
      "--cache",
      path.join(root, "cache"),
      archive,
    ],
    { stdio: "pipe" },
  );
  const executable = path.join(root, "node_modules/.bin/agent-worker-mcp");
  assert.equal(
    execFileSync(executable, ["--version"], {
      encoding: "utf8",
      cwd: root,
    }).trim(),
    VERSION,
  );
  for (const provider of ["claude", "codex"]) {
    const cwd = path.join(root, provider);
    await mkdir(cwd);
    const client = new Client({ name: "package-smoke", version: "1" });
    await client.connect(
      new StdioClientTransport({ command: executable, args: [provider], cwd }),
    );
    try {
      const response = await client.callTool({
        name: "preflight",
        arguments: { cwd, delegation_id: "packed", duration_seconds: 0.1 },
      });
      assert.equal(response.isError, false);
      console.log(
        `${provider}: installed offline, CLI entrypoint and MCP preflight passed`,
      );
    } finally {
      await client.close();
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
