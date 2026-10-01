import { spawn } from "node:child_process";
import { openSync, closeSync, writeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import { timestamp } from "../core/contracts.mjs";

// Exit determines the job outcome. Pipe draining has its own bounded lifetime.
export async function runProcess({
  command,
  args,
  cwd,
  directory,
  prompt,
  signal,
  timeout,
  onEvent,
  trace = false,
  graceMs = 1000,
  drainMs = 1000,
}) {
  if (process.platform === "win32")
    throw new Error("Windows process-tree cancellation is not supported yet");
  const handles = [];
  const logFile = (name) => {
    if (!trace) return null;
    const handle = openSync(path.join(directory, name), "wx", 0o600);
    handles.push(handle);
    return handle;
  };
  let child;
  let deadline, killTimer, drainTimer;
  let abort;
  try {
    const stdout = logFile("events.jsonl");
    const stderr = logFile("stderr.log");
    const lifecycle = logFile("lifecycle.jsonl");
    let evidenceError = false;
    const record = (type, data = {}) => {
      if (!trace) return;
      try {
        writeSync(
          lifecycle,
          `${JSON.stringify({ utc: timestamp(), type, ...data })}\n`,
        );
      } catch {
        evidenceError = true;
      }
    };
    if (signal?.aborted) {
      record("finished", {
        status: "cancelled",
        dispatch_state: "not_started",
      });
      return { status: "cancelled" };
    }
    record("dispatch", { command, args, cwd });
    if (evidenceError) throw new Error("Cannot record dispatch evidence");
    child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", stderr ?? "pipe"],
    });
    let stderrTail = "";
    const stderrDecoder = new StringDecoder("utf8");
    const onStderr = (chunk) => {
      stderrTail = (stderrTail + stderrDecoder.write(chunk)).slice(-2000);
    };
    if (child.stderr) {
      child.stderr.on("data", onStderr);
      child.stderr.on("error", () => {});
    }
    record("worker_started", { pid: child.pid });
    let reason;
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
      try {
        const violation = onEvent(event);
        if (violation) terminate(violation);
      } catch (error) {
        record("invalid_event", { message: error.message });
        terminate("invalid_event");
      }
    };
    const onData = (chunk) => {
      try {
        if (stdout !== null) writeSync(stdout, chunk);
      } catch {
        terminate("evidence_error");
        return;
      }
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
    };
    child.stdout.on("data", onData);
    child.stdout.on("error", () => terminate("stdout_error"));
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") terminate("stdin_error");
    });
    const drained = Promise.all(
      [child.stdout, child.stderr].map((stream) =>
        !stream || stream.readableEnded || stream.destroyed
          ? Promise.resolve()
          : new Promise((resolve) => {
              stream.once("end", resolve);
              stream.once("close", resolve);
            }),
      ),
    );
    const exited = new Promise((resolve) => {
      const finish = (outcome) => {
        clearTimeout(deadline);
        killGroup("SIGKILL");
        resolve(outcome);
      };
      child.once("error", (error) => finish({ error: error.message }));
      child.once("exit", (exit_code, exit_signal) =>
        finish({ exit_code, exit_signal }),
      );
    });
    abort = () => terminate("cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    deadline = setTimeout(() => terminate("timeout"), timeout * 1000);
    child.stdin.end(prompt);
    const outcome = await exited;
    clearTimeout(killTimer);
    let stdoutTruncated = false;
    let stderrTruncated = false;
    await Promise.race([
      drained,
      new Promise((resolve) => {
        drainTimer = setTimeout(() => {
          stdoutTruncated = !child.stdout.readableEnded;
          stderrTruncated = Boolean(
            child.stderr && !child.stderr.readableEnded,
          );
          record("output_drain_expired", {
            stdout_truncated: stdoutTruncated,
            stderr_truncated: stderrTruncated,
          });
          child.stdout.destroy();
          child.stderr?.destroy();
          resolve();
        }, drainMs);
      }),
    ]);
    clearTimeout(drainTimer);
    child.stdout.off("data", onData);
    child.stderr?.off("data", onStderr);
    stderrTail = (stderrTail + stderrDecoder.end()).slice(-2000);
    pending += decoder.end();
    if (pending.trim()) consume(pending);
    let status =
      (evidenceError ? "evidence_error" : reason) ??
      (outcome.error
        ? "spawn_error"
        : outcome.exit_code === 0
          ? "exited"
          : "failed");
    record("finished", {
      status,
      ...outcome,
      stdout_truncated: stdoutTruncated,
      stderr_truncated: stderrTruncated,
    });
    if (evidenceError) status = "evidence_error";
    return {
      status,
      ...outcome,
      stdout_truncated: stdoutTruncated,
      stderr_truncated: stderrTruncated,
      ...(status !== "exited" && stderrTail ? { stderr_tail: stderrTail } : {}),
    };
  } finally {
    clearTimeout(deadline);
    clearTimeout(killTimer);
    clearTimeout(drainTimer);
    if (abort) signal?.removeEventListener("abort", abort);
    child?.stdin.destroy();
    child?.stdout.destroy();
    child?.stderr?.destroy();
    for (const handle of handles) closeSync(handle);
  }
}
