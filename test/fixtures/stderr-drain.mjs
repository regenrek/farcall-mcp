import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const mode = process.argv[2];
process.stdin.resume();
process.stdout.end();

if (mode === "split") {
  const bytes = Buffer.from("Fehler café ✓ 😀");
  // Force multi-byte characters across separate writes and event-loop turns.
  for (const byte of bytes) {
    process.stderr.write(Buffer.from([byte]));
    await delay(10);
  }
  process.exitCode = 1;
} else {
  const code =
    mode === "late"
      ? 'setTimeout(() => process.stderr.write("late diagnostic ✓"), 100);'
      : 'process.stderr.write("held diagnostic"); setTimeout(() => {}, 60000);';
  const child = spawn(process.execPath, ["-e", code], {
    detached: true,
    stdio: ["ignore", "ignore", "inherit"],
  });
  child.unref();
  writeFileSync("stderr-holder.pid", String(child.pid));
  process.exit(1);
}
