import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [
  provider,
  scenario = "success",
  session = "11111111-1111-4111-8111-111111111111",
] = process.argv.slice(2);
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
process.stdin.resume();
if (scenario === "tree") {
  const descendant = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  writeFileSync("descendant.pid", String(descendant.pid));
  process.on("SIGTERM", () => process.exit(0));
}
if (provider === "claude")
  emit({
    type: "system",
    subtype: "init",
    session_id: session,
    model: scenario === "mismatch" ? "wrong-model" : "claude-opus-5-5",
  });
else emit({ type: "thread.started", thread_id: session });
if (scenario === "missing") process.exit(0);
if (scenario === "oversize") {
  process.stdout.write("x".repeat(10_000_002) + "\n", () => process.exit(0));
  await new Promise(() => {});
}
setTimeout(
  () => {
    if (provider === "claude")
      emit({
        type: "result",
        session_id: session,
        is_error: scenario === "failure",
        result: "Reviewed café ✓",
        usage: { input_tokens: 12 },
        total_cost_usd: 0.002,
      });
    else {
      emit({
        type: "item.completed",
        item: { type: "agent_message", text: "Reviewed café ✓" },
      });
      emit({
        type: scenario === "failure" ? "turn.failed" : "turn.completed",
        usage: { input_tokens: 12, cached_input_tokens: 4, output_tokens: 8 },
      });
    }
    process.exit(0);
  },
  ["slow", "tree"].includes(scenario) ? 20000 : 40,
);
