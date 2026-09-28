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
      assert.equal(manifest.version, "0.1.0");
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
      const client = new Client({ name: "manifest-test", version: "1" });
      t.after(() => client.close());
      await client.connect(
        new StdioClientTransport({ command: process.execPath, args, cwd }),
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
