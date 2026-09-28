import { mkdir, writeFile, mkdtemp, cp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const duration = Number(process.argv[2] ?? 150);
assert.ok(duration >= 1 && duration <= 300);
const runId = new Date().toISOString().replaceAll(":", "-");
const root = path.resolve("artifacts", `preflight-${runId}`);
await mkdir(root, { recursive: true });
const results = await Promise.all(
  ["claude", "codex"].map(async (provider) => {
    const cwd = await mkdtemp(
      path.join(os.tmpdir(), `worker-preflight-${provider}-`),
    );
    const client = new Client({ name: "long-preflight", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve(`plugins/${provider}-worker/server.mjs`)],
        stderr: "inherit",
      }),
    );
    try {
      const start = performance.now();
      const response = await client.callTool(
        {
          name: "preflight",
          arguments: {
            cwd,
            delegation_id: "long-wait",
            duration_seconds: duration,
            timeout_seconds: duration + 20,
          },
        },
        undefined,
        { timeout: (duration + 30) * 1000 },
      );
      const elapsed_ms = performance.now() - start;
      assert.equal(response.isError, false);
      assert.ok(elapsed_ms >= duration * 1000);
      const saved = path.join(root, provider);
      await cp(path.join(cwd, "artifacts"), saved, { recursive: true });
      return {
        archived_artifacts: saved,
        provider,
        elapsed_ms,
        calls: 1,
        ...JSON.parse(response.content[0].text),
      };
    } finally {
      await client.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }),
);
await writeFile(
  path.join(root, "summary.json"),
  JSON.stringify(
    {
      note: "Deterministic MCP client test. No parent model or paid worker invocation.",
      results,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    {
      evidence: root,
      results: results.map(({ provider, elapsed_ms, status }) => ({
        provider,
        elapsed_ms,
        status,
      })),
    },
    null,
    2,
  ),
);
