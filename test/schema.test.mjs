import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { claudeInput, codexInput } from "../src/core/contracts.mjs";

for (const provider of ["claude", "codex"]) {
  for (const entry of ["plugin", "cli"]) {
    test(`${provider} ${entry} advertises a portable model pattern`, async (t) => {
      const client = new Client({ name: "schema-test", version: "1" });
      t.after(() => client.close());
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args:
            entry === "plugin"
              ? [`plugins/${provider}-worker/server.mjs`]
              : ["dist/cli.mjs", provider],
        }),
      );
      const { tools } = await client.listTools();
      const batch = tools.find((tool) => tool.name === "run_batch");
      const run = tools.find((tool) => tool.name === "run");
      assert.deepEqual(batch.annotations, run.annotations);
      assert.equal(batch.annotations.readOnlyHint, false);
      assert.equal(batch.inputSchema.additionalProperties, false);
      assert.equal(batch.inputSchema.properties.tasks.minItems, 1);
      assert.equal(batch.inputSchema.properties.tasks.maxItems, 5);
      const task = batch.inputSchema.properties.tasks.items;
      assert.equal(task.additionalProperties, false);
      assert.ok(task.required.includes("task_id"));
      for (const [key, value] of Object.entries(run.inputSchema.properties))
        assert.deepEqual(task.properties[key], value, key);
      const model = tools.find((tool) => tool.name === "run").inputSchema
        .properties.model;
      // Unicode sets reject the unescaped nested '[' that JS's legacy regex
      // mode accepts but Rust-based JSON Schema validators reject.
      const pattern = new RegExp(model.pattern, "v");
      const contract = provider === "claude" ? claudeInput : codexInput;
      for (const [value, accepted] of [
        ["gpt-6-astra", true],
        ["claude-opus-5-5[1m]", true],
        ["provider/model:v1.2_test", true],
        ["", false],
        ["model name", false],
        ["model;command", false],
        ["model\\path", false],
        ["model$variable", false],
      ]) {
        assert.equal(pattern.test(value), accepted, value);
        assert.equal(
          contract.shape.model.safeParse(value).success,
          accepted,
          value,
        );
      }
    });
  }
}
