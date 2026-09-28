import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

for (const entry of ["plugin", "cli"]) {
  test(`${entry} non-Git opt-in reaches Codex start/resume without changing configuration`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "farcall-non-git-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const name of [".codex", ".claude"]) {
      await mkdir(path.join(root, name));
    }
    const configs = {
      ".codex/config.toml": 'model = "unchanged"\n',
      ".claude/settings.json": '{"permissions":{}}\n',
    };
    for (const [file, content] of Object.entries(configs)) {
      await writeFile(path.join(root, file), content);
    }
    const fakeCli = path.join(root, "codex.mjs");
    const fixture = new URL("./fixtures/codex-non-git.mjs", import.meta.url);
    await writeFile(
      fakeCli,
      `#!${process.execPath}\nawait import(${JSON.stringify(fixture.href)});\n`,
      { mode: 0o700 },
    );
    const client = new Client({ name: "non-git-test", version: "1" });
    t.after(() => client.close());
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args:
          entry === "plugin"
            ? ["plugins/codex-worker/server.mjs"]
            : ["dist/cli.mjs", "codex"],
        env: { ...process.env, CODEX_WORKER_BINARY: fakeCli },
      }),
    );
    const { tools } = await client.listTools();
    const option = tools.find((tool) => tool.name === "run").inputSchema
      .properties.allow_non_git;
    assert.equal(option.type, "boolean");
    assert.equal(option.default, false);
    const call = (args) =>
      client.callTool({
        name: "run",
        arguments: {
          cwd: root,
          prompt: "Inspect this directory.",
          model: "gpt-6-astra",
          effort: "low",
          ...args,
        },
      });
    for (const sandbox of ["read-only", "workspace-write"]) {
      for (const allow_non_git of [undefined, false]) {
        const result = await call({
          delegation_id: `${sandbox}-${allow_non_git}`,
          sandbox,
          ...(allow_non_git === undefined ? {} : { allow_non_git }),
        });
        assert.equal(result.isError, true);
        assert.equal(JSON.parse(result.content[0].text).exit_code, 1);
      }
      const args = { delegation_id: sandbox, sandbox, allow_non_git: true };
      const first = await call(args);
      assert.equal(first.isError, false);
      const completion = JSON.parse(first.content[0].text);
      const argv = JSON.parse(completion.result);
      assert.equal(argv[argv.indexOf("--sandbox") + 1], sandbox);
      assert.deepEqual(await call(args), first);
      const changed = await call({ ...args, allow_non_git: false });
      assert.equal(changed.isError, true);
      assert.match(changed.content[0].text, /different request/);
      const resume = {
        ...args,
        delegation_id: `${sandbox}-resume`,
        resume_session_id: completion.session_id,
        resume_delegation_id: sandbox,
      };
      assert.equal((await call(resume)).isError, false);
      assert.equal(
        (
          await call({
            ...resume,
            delegation_id: `${sandbox}-resume-disabled`,
            allow_non_git: false,
          })
        ).isError,
        true,
      );
    }
    await assert.rejects(stat(path.join(root, ".git")), { code: "ENOENT" });
    for (const [file, content] of Object.entries(configs)) {
      assert.equal(await readFile(path.join(root, file), "utf8"), content);
    }
  });
}
