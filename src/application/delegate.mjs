import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { claude } from "../adapters/claude.mjs";
import { codex } from "../adapters/codex.mjs";
import { parseInput, VERSION, timestamp } from "../core/contracts.mjs";
import {
  prepare,
  acquireLock,
  atomicJson,
  existingRecord,
  readJson,
  sha256,
} from "../platform/artifacts.mjs";
import { runProcess } from "../platform/process.mjs";

const adapters = { claude, codex };
const preflightScript = `
  process.stdin.resume();
  setTimeout(() => {
    console.log(JSON.stringify({ type: 'preflight.completed' }));
    process.exit(process.argv[2] === 'failure' ? 1 : 0);
  }, Number(process.argv[1]) * 1000);
`;

// Preparation has no process side effects. Batch admission reuses these stages.
export async function prepareDelegation(
  provider,
  value,
  { preflight = false } = {},
) {
  if (!adapters[provider]) throw new Error("Unknown provider");
  const input = parseInput(provider, value, preflight);
  const { cwd, root, prompt, checkout, lockRoot } = await prepare(
    input,
    preflight,
  );
  const adapter = adapters[provider];
  const command = preflight ? process.execPath : adapter.executable();
  const args = preflight
    ? ["-e", preflightScript, String(input.duration_seconds), input.outcome]
    : adapter.args(input);
  const settings = { ...input };
  // Only the hash participates in identity; inline prompt text is not state.
  delete settings.prompt;
  const request = {
    ...settings,
    cwd,
    checkout_root: checkout,
    lock_root: lockRoot,
    provider,
    preflight,
    bridge_version: VERSION,
    command,
    args,
    prompt_sha256: sha256(prompt),
  };
  const fingerprint = sha256(JSON.stringify(request));
  const directory = path.join(root, input.delegation_id);
  return {
    input,
    cwd,
    root,
    prompt,
    checkout,
    lockRoot,
    adapter,
    command,
    args,
    request,
    fingerprint,
    directory,
    provider,
    preflight,
  };
}

export async function inspectDelegation(plan) {
  const { directory, fingerprint, input, root, provider, cwd } = plan;
  const previous = await existingRecord(directory);
  if (previous) {
    if (previous.fingerprint !== fingerprint)
      throw new Error("Delegation ID already used for a different request");
    try {
      return await readJson(path.join(directory, "completion.json"));
    } catch (error) {
      if (error.code === "ENOENT")
        throw new Error(
          "Delegation was dispatched without a completion record. Inspect it before using a new ID.",
          { cause: error },
        );
      throw error;
    }
  }
  if (input.resume_session_id) {
    const oldDirectory = path.join(root, input.resume_delegation_id);
    const oldRequest = await existingRecord(oldDirectory);
    if (
      !oldRequest ||
      oldRequest.provider !== provider ||
      oldRequest.cwd !== cwd ||
      oldRequest.preflight
    ) {
      throw new Error(
        "Resume must refer to a previous real delegation from this provider and checkout",
      );
    }
    const oldCompletion = await readJson(
      path.join(oldDirectory, "completion.json"),
    );
    if (oldCompletion.session_id !== input.resume_session_id)
      throw new Error("Resume session does not match its saved completion");
  }
  return null;
}

export async function reserveDelegation(
  plan,
  { commandOverride, onReserved } = {},
) {
  const {
    directory,
    fingerprint,
    provider,
    cwd,
    checkout,
    preflight,
    input,
    request,
    command,
    args,
    prompt,
  } = plan;
  await mkdir(directory, { mode: 0o700 });
  onReserved?.(directory);
  const identity = {
    fingerprint,
    provider,
    cwd,
    checkout_root: checkout,
    preflight,
    requested_at: timestamp(),
  };
  await atomicJson(
    path.join(directory, "request.json"),
    input.trace
      ? {
          ...request,
          ...identity,
          execution_command: commandOverride?.command ?? command,
          execution_args: commandOverride?.args ?? args,
          test_command_override: Boolean(commandOverride),
        }
      : identity,
  );
  if (input.trace) {
    await writeFile(path.join(directory, "prompt.txt"), prompt, {
      flag: "wx",
      mode: 0o600,
    });
  }
}

export async function executeDelegation(
  plan,
  { signal, commandOverride } = {},
) {
  const {
    input,
    directory,
    command,
    args,
    cwd,
    prompt,
    adapter,
    preflight,
    provider,
  } = plan;
  const state = {};
  const execution = await runProcess({
    command: commandOverride?.command ?? command,
    args: commandOverride?.args ?? args,
    cwd,
    directory,
    prompt,
    signal,
    timeout: input.timeout_seconds,
    trace: input.trace,
    onEvent(event) {
      if (!event || typeof event !== "object") return;
      if (preflight) {
        if (event.type === "preflight.completed") state.native_result = event;
        return;
      }
      adapter.consume(state, event);
      if (
        state.reported_model &&
        !adapter.modelMatches(input.model, state.reported_model)
      )
        return "model_mismatch";
      if (
        input.resume_session_id &&
        state.session_id &&
        state.session_id !== input.resume_session_id
      )
        return "session_mismatch";
    },
  });
  const status =
    execution.status === "exited"
      ? state.failed
        ? "failed"
        : state.native_result
          ? "completed"
          : "missing_result"
      : execution.status;
  const resultLimit = input.max_result_chars ?? 4000;
  const resultTruncated =
    typeof state.result === "string" && state.result.length > resultLimit;
  const resultFile = resultTruncated
    ? path.join(directory, "result.txt")
    : null;
  if (resultFile) {
    await writeFile(resultFile, state.result, { flag: "wx", mode: 0o600 });
  }
  const completion = {
    bridge_version: VERSION,
    provider,
    delegation_id: input.delegation_id,
    ...execution,
    status,
    completed_at: timestamp(),
    session_id: state.session_id ?? "unknown",
    requested_model: input.model ?? null,
    reported_model: state.reported_model ?? "unknown",
    requested_effort: input.effort ?? null,
    permission_denials: state.permission_denials ?? [],
    permission_denials_count: state.permission_denials?.length ?? 0,
    result_truncated: resultTruncated,
    result_file: resultFile,
    result_characters:
      typeof state.result === "string" ? state.result.length : 0,
    result:
      typeof state.result === "string"
        ? state.result.slice(0, resultLimit)
        : null,
    native_usage: state.native_usage ?? null,
    native_model_usage: state.native_model_usage ?? null,
    native_total_cost_usd: state.native_total_cost_usd ?? null,
    usage_note:
      "Raw provider fields. Missing values are unknown; resumed totals may be cumulative. No API cost estimate is made.",
    evidence_directory: directory,
    trace: input.trace,
  };
  if (input.trace && state.native_result)
    await atomicJson(
      path.join(directory, "native-result.json"),
      state.native_result,
    );
  await atomicJson(path.join(directory, "completion.json"), completion);
  return completion;
}

export async function delegate(provider, value, options = {}) {
  const plan = await prepareDelegation(provider, value, options);
  const release = await acquireLock(plan.lockRoot, {
    delegation_id: plan.input.delegation_id,
    provider,
    server_pid: process.pid,
    started_at: timestamp(),
  });
  try {
    const cached = await inspectDelegation(plan);
    if (cached) return cached;
    await reserveDelegation(plan, options);
    return await executeDelegation(plan, options);
  } finally {
    await release();
  }
}
