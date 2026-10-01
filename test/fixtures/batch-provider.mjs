import { readFile, writeFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";

const config = JSON.parse(await readFile("fixture.json", "utf8"));
const args = process.argv.slice(2);
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
await writeFile(
  "started.json",
  JSON.stringify({ pid: process.pid, args, prompt }),
);
if (config.tree) {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  await writeFile("descendant.pid", String(child.pid));
  process.on("SIGTERM", () => {});
}
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const resume = args.indexOf(
  config.provider === "claude" ? "--resume" : "resume",
);
const session =
  config.wrongSession ?? (resume < 0 ? config.session : args[resume + 1]);
if (config.provider === "claude")
  emit({
    type: "system",
    subtype: "init",
    session_id: session,
    model: args[args.indexOf("--model") + 1],
  });
else emit({ type: "thread.started", thread_id: session });
if (config.barrier) {
  while (
    !(
      await Promise.all(
        config.barrier.map(async (cwd) => {
          try {
            await access(path.join(cwd, "started.json"));
            return true;
          } catch {
            return false;
          }
        }),
      )
    ).every(Boolean)
  )
    await delay(10);
}
await delay(config.delay ?? 100);
const result = config.large ? "界".repeat(24000) : prompt;
const usage = {
  input_tokens: 12,
  output_tokens: 4,
  ...(config.largeUsage ? { opaque: "u".repeat(300000) } : {}),
};
if (config.provider === "claude")
  emit({
    type: "result",
    session_id: session,
    result,
    is_error: Boolean(config.fail),
    usage,
    total_cost_usd: null,
  });
else {
  emit({
    type: "item.completed",
    item: { type: "agent_message", text: result },
  });
  emit({ type: config.fail ? "turn.failed" : "turn.completed", usage });
}
await new Promise((resolve) => process.stdout.end(resolve));
process.exit(0);
