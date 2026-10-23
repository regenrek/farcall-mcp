import { VERSION } from "../src/core/version.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  cp,
  readFile,
  writeFile,
  readdir,
} from "node:fs/promises";
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
    const fakeCli = path.join(root, "fixture-cli.mjs");
    const fixtureUrl = new URL("./fixtures/provider.mjs", import.meta.url).href;
    await writeFile(
      fakeCli,
      `#!${process.execPath}\nprocess.argv = [process.execPath, "fixture", ${JSON.stringify(provider)}, "echo"];\nawait import(${JSON.stringify(fixtureUrl)});\n`,
      { mode: 0o700 },
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundle],
      stderr: "pipe",
      env: {
        ...process.env,
        [provider === "claude"
          ? "CLAUDE_WORKER_BINARY"
          : "CODEX_WORKER_BINARY"]: fakeCli,
      },
    });
    t.after(() => client.close());
    await client.connect(transport);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).toSorted(),
      ["preflight", "run", "run_batch"],
    );
    const response = await client.callTool({
      name: "preflight",
      arguments: { cwd: root, delegation_id: "wait", duration_seconds: 0.2 },
    });
    assert.equal(response.isError, false);
    assert.equal(JSON.parse(response.content[0].text).status, "completed");
    const inline = await client.callTool({
      name: "run",
      arguments: {
        cwd: root,
        delegation_id: "inline",
        prompt: "Read-only boundary review.",
        model: "claude-opus-5-5",
        effort: "high",
      },
    });
    assert.equal(inline.isError, false);
    const inlineResult = JSON.parse(inline.content[0].text);
    assert.equal(inlineResult.result, "Read-only boundary review.");
    assert.equal(inlineResult.trace, false);
    assert.deepEqual(
      (await readdir(inlineResult.evidence_directory)).toSorted(),
      ["completion.json", "request.json"],
    );
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
        path.join(root, "artifacts/farcall/cancel/completion.json"),
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
      env: { FARCALL_STATE_DIR: path.join(root, "state") },
    }),
  );
  const result = await client.callTool({
    name: "preflight",
    arguments: { cwd: root, delegation_id: "cli", duration_seconds: 0 },
  });
  assert.equal(result.isError, false);
});
