import { VERSION } from "../src/core/version.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, cp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

for (const provider of ["claude", "codex"]) {
  for (const host of ["claude", "codex"]) {
    test(`${host} manifest launches the copied ${provider} plugin`, async (t) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "manifest-worker-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const plugin = path.join(root, `${provider}-worker`);
      await cp(
        new URL(`../plugins/${provider}-worker/`, import.meta.url),
        plugin,
        { recursive: true },
      );
      const manifest = JSON.parse(
        await readFile(
          path.join(plugin, `.${host}-plugin/plugin.json`),
          "utf8",
        ),
      );
      assert.equal(manifest.name, `${provider}-worker`);
      assert.equal(manifest.version, VERSION);
      const declarations =
        typeof manifest.mcpServers === "string"
          ? JSON.parse(
              await readFile(path.join(plugin, manifest.mcpServers), "utf8"),
            ).mcpServers
          : manifest.mcpServers;
      const config = declarations[`${provider}_worker`];
      const args = config.args.map((arg) =>
        arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", plugin),
      );
      const cwd = config.cwd ? path.resolve(plugin, config.cwd) : root;
      assert.equal(
        host === "claude" ? config.timeout : config.tool_timeout_sec * 1000,
        7200000,
      );
      // Codex must expose the waiting tool directly, never through Code Mode.
      if (host === "codex")
        assert.deepEqual(config.omit_tools_from, ["code_mode", "deferred"]);
      const client = new Client({ name: "manifest-test", version: "1" });
      t.after(() => client.close());
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args,
          cwd,
          env: { FARCALL_STATE_DIR: path.join(root, "state") },
        }),
      );
      const result = await client.callTool({
        name: "preflight",
        arguments: {
          cwd: root,
          delegation_id: "manifest",
          duration_seconds: 0,
        },
      });
      assert.equal(result.isError, false);
    });
  }
}

test("Claude overrides every auto-loaded Codex server with its own configuration", async () => {
  for (const provider of ["claude", "codex"]) {
    const plugin = new URL(`../plugins/${provider}-worker/`, import.meta.url);
    const defaults = JSON.parse(
      await readFile(new URL(".mcp.json", plugin), "utf8"),
    ).mcpServers;
    const manifest = JSON.parse(
      await readFile(new URL(".claude-plugin/plugin.json", plugin), "utf8"),
    );
    assert.deepEqual(
      Object.keys(defaults).toSorted(),
      Object.keys(manifest.mcpServers).toSorted(),
    );
    for (const entry of Object.values(manifest.mcpServers)) {
      assert.ok(entry.args[0].startsWith("${CLAUDE_PLUGIN_ROOT}/"));
      assert.equal(entry.timeout, 7200000);
      assert.equal(entry.cwd, undefined);
    }
  }
});

test("each bundle enforces the security floor before initializing dependencies", async () => {
  const { runInNewContext } = await import("node:vm");
  for (const file of [
    "dist/cli.mjs",
    "plugins/claude-worker/server.mjs",
    "plugins/codex-worker/server.mjs",
  ]) {
    const source = await readFile(
      new URL(`../${file}`, import.meta.url),
      "utf8",
    );
    const prefix = source.slice(
      source.indexOf("\n") + 1,
      source.indexOf("import { createRequire"),
    );
    for (const version of [
      "22.23.4",
      "24.19.0",
      "24.21.99",
      "24.22.0",
      "25.9.0",
      "26.11.99",
      "26.12.0",
      "26.12.1-rc.1",
      "27.0.0",
      "invalid",
    ]) {
      assert.throws(
        () =>
          runInNewContext(prefix, { process: { versions: { node: version } } }),
        /CVE-2026-111497/,
        `${file}: ${version}`,
      );
    }
    for (const version of [
      "24.22.1",
      "24.22.2",
      "24.23.0",
      "26.12.1",
      "26.13.0",
    ]) {
      assert.doesNotThrow(
        () =>
          runInNewContext(prefix, { process: { versions: { node: version } } }),
        `${file}: ${version}`,
      );
    }
  }
});
