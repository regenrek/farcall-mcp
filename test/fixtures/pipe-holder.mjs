import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [mode, task = "success"] = process.argv.slice(2);
const descendant = spawn(
  process.execPath,
  ["-e", "setTimeout(() => {}, 60000)"],
  {
    stdio: ["ignore", "inherit", "ignore"],
    detached: mode === "session",
  },
);
descendant.unref();
writeFileSync("pipe-holder.pid", String(descendant.pid));
process.stdin.resume();
console.log(
  JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: "11111111-1111-4111-8111-111111111111",
    model: "claude-opus-5-5",
  }),
);
if (task === "success") {
  process.stdout.write(
    JSON.stringify({ type: "result", is_error: false, result: "done" }) + "\n",
    () => process.exit(0),
  );
} else {
  process.on("SIGTERM", () => {});
  setTimeout(() => {}, 60000);
}
