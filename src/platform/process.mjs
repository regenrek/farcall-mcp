import { spawn } from "node:child_process";
import { openSync, closeSync, writeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { timestamp } from "../core/contracts.mjs";

// Process lifetime is owned here. There is no status endpoint or periodic timer.
export async function runProcess({
  command,
  args,
  cwd,
  directory,
  prompt,
  signal,
  timeout,
  onEvent,
  graceMs = 1000,
}) {
  if (process.platform === "win32")
    throw new Error("Windows process-tree cancellation is not supported yet");
  if (signal?.aborted) return { status: "cancelled" };
  const handles = [];
  const logFile = (name) => {
    const handle = openSync(path.join(directory, name), "wx", 0o600);
    handles.push(handle);
    return handle;
  };
  let child;
  try {
    const stdout = logFile("events.jsonl");
    const stderr = logFile("stderr.log");
    const lifecycle = logFile("lifecycle.jsonl");
    let evidenceError = false;
    const record = (type, data = {}) => {
      try {
        writeSync(
          lifecycle,
          `${JSON.stringify({ utc: timestamp(), type, ...data })}\n`,
        );
      } catch {
        evidenceError = true;
      }
    };
    record("dispatch", { command, args, cwd });
    if (evidenceError) throw new Error("Cannot record dispatch evidence");
    child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", stderr],
    });
    let reason;
    let killTimer;
    const killGroup = (sig) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, sig);
      } catch (error) {
        if (error.code !== "ESRCH")
          record("signal_error", { message: error.message });
      }
    };
    const terminate = (cause) => {
      if (reason) return;
      reason = cause;
      record("termination_requested", { cause });
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), graceMs);
    };
    const decoder = new StringDecoder("utf8");
    let pending = "";
    const consume = (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      const violation = onEvent(event);
      if (violation) terminate(violation);
    };
    child.stdout.on("data", (chunk) => {
      try {
        writeSync(stdout, chunk);
        pending += decoder.write(chunk);
        let newline;
        while ((newline = pending.indexOf("\n")) !== -1) {
          if (newline > 10_000_000) {
            terminate("oversize_event");
            pending = "";
            return;
          }
          consume(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
        }
        if (pending.length > 10_000_000) {
          terminate("oversize_event");
          pending = "";
        }
      } catch {
        terminate("evidence_error");
      }
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") terminate("stdin_error");
    });
    const abort = () => terminate("cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const deadline = setTimeout(() => terminate("timeout"), timeout * 1000);
    child.stdin.end(prompt);
    const outcome = await new Promise((resolve) => {
      let spawnError;
      child.once("error", (error) => {
        spawnError = error.message;
      });
      child.once("close", (exit_code, exit_signal) =>
        resolve({
          exit_code,
          exit_signal,
          ...(spawnError ? { error: spawnError } : {}),
        }),
      );
    });
    clearTimeout(deadline);
    clearTimeout(killTimer);
    signal?.removeEventListener("abort", abort);
    // Kill remaining group members even if the main process exited first.
    killGroup("SIGKILL");
    pending += decoder.end();
    if (pending.trim()) {
      try {
        consume(pending);
      } catch {
        reason ??= "invalid_event";
      }
    }
    clearTimeout(killTimer);
    const status =
      (evidenceError ? "evidence_error" : reason) ??
      (outcome.error
        ? "spawn_error"
        : outcome.exit_code === 0
          ? "exited"
          : "failed");
    record("finished", { status, ...outcome });
    return { status, ...outcome };
  } finally {
    for (const handle of handles) closeSync(handle);
  }
}
