import assert from "node:assert/strict";

const args = process.argv.slice(2);
const session = "11111111-1111-4111-8111-111111111111";
for await (const _chunk of process.stdin) {
  // Drain the prompt without starting a model.
}
if (!args.includes("--skip-git-repo-check")) {
  process.stderr.write("Not inside a trusted directory");
  process.exit(1);
}
assert.equal(args.filter((arg) => arg === "--skip-git-repo-check").length, 1);
assert.ok(args.includes('approval_policy="never"'));
assert.doesNotMatch(args.join(" "), /dangerously|trust_level|--last/);
if (args.includes("resume")) {
  assert.ok(args.indexOf("--skip-git-repo-check") < args.indexOf("resume"));
  assert.deepEqual(args.slice(-3), ["resume", session, "-"]);
}
for (const event of [
  { type: "thread.started", thread_id: session },
  {
    type: "item.completed",
    item: { type: "agent_message", text: JSON.stringify(args) },
  },
  { type: "turn.completed", usage: {} },
]) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}
