import { VERSION } from "../src/core/version.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, cp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

for (const provider of ["claude", "codex"]) {
  test(`${provider} plugin is self-contained and returns one pending MCP result`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "packed-worker-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const bundle = path.join(root, "server.mjs");
    await cp(
      new URL(`../plugins/${provider}-worker/server.mjs`, import.meta.url),
      bundle,
    );
    const client = new Client({ name: "worker-test", version: "1" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle],
      stderr: "pipe",
    });
    t.after(() => client.close());
    await client.connect(transport);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).toSorted(),
      ["preflight", "run"],
    );
    const response = await client.callTool({
      name: "preflight",
      arguments: { cwd: root, delegation_id: "wait", duration_seconds: 0.2 },
    });
    assert.equal(response.isError, false);
    assert.equal(JSON.parse(response.content[0].text).status, "completed");
    const failure = await client.callTool({
      name: "preflight",
      arguments: {
        cwd: root,
        delegation_id: "fail",
        duration_seconds: 0,
        outcome: "failure",
      },
    });
    assert.equal(failure.isError, true);
    const controller = new AbortController();
    const pending = client.callTool(
      {
        name: "preflight",
        arguments: { cwd: root, delegation_id: "cancel", duration_seconds: 20 },
      },
      undefined,
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(pending);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const completion = JSON.parse(
      await readFile(
        path.join(root, "artifacts/agent-workers/cancel/completion.json"),
        "utf8",
      ),
    );
    assert.equal(completion.status, "cancelled");
  });
}

test("npm CLI bundle starts outside the repository", async (t) => {
  const { execFileSync } = await import("node:child_process");
  const root = await mkdtemp(path.join(os.tmpdir(), "worker-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = path.join(root, "cli.mjs");
  await cp(new URL("../dist/cli.mjs", import.meta.url), entry);
  assert.equal(
    execFileSync(process.execPath, [entry, "--version"], {
      encoding: "utf8",
      cwd: root,
    }).trim(),
    VERSION,
  );
  const client = new Client({ name: "cli-smoke", version: "1" });
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [entry, "codex"],
    }),
  );
  const result = await client.callTool({
    name: "preflight",
    arguments: { cwd: root, delegation_id: "cli", duration_seconds: 0 },
  });
  assert.equal(result.isError, false);
});
