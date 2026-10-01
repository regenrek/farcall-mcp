import path from "node:path";
import { z } from "zod";

export { VERSION } from "./version.mjs";
const absolutePath = z.string().refine(path.isAbsolute, "Use an absolute path");
const common = {
  cwd: absolutePath,
  delegation_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/),
  timeout_seconds: z.number().int().min(1).max(7100).default(3600),
  trace: z.boolean().default(false),
};
const run = {
  ...common,
  prompt: z.string().min(1).max(1_000_000).optional(),
  prompt_file: absolutePath.optional(),
  max_result_chars: z.number().int().min(256).max(24000).default(4000),
  model: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9._:\[\]\/\-]+$/v),
  resume_session_id: z.uuid().optional(),
  resume_delegation_id: common.delegation_id.optional(),
};

export const claudeInput = z.strictObject({
  ...run,
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]),
  permission_mode: z.enum(["default", "acceptEdits"]).default("default"),
  allowed_tools: z.array(z.string().min(1).max(200)).max(30).default([]),
  chrome: z.boolean().default(false),
});
export const codexInput = z.strictObject({
  ...run,
  effort: z.enum(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]),
  sandbox: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("read-only")
    .describe(
      "Codex execution policy. Full access must be explicitly authorized; it removes the Codex sandbox, not OS restrictions, and does not configure browser tools.",
    ),
  writable_roots: z
    .array(absolutePath)
    .max(16)
    .optional()
    .describe(
      "Additional existing directories, canonicalized and locked. Grants writes in workspace-write; coordination only in danger-full-access, never an access boundary. Also supply on resume.",
    ),
  network_access: z
    .boolean()
    .optional()
    .describe(
      "Explicit workspace-write network policy for this invocation. Omit to retain Codex configuration; false disables, true enables. Also supply on resume.",
    ),
  allow_non_git: z
    .boolean()
    .default(false)
    .describe(
      "Allow this invocation outside a Git repository. Also set on resume. Does not change sandbox permissions or edit Git/user configuration.",
    ),
});
export const preflightInput = z.strictObject({
  ...common,
  duration_seconds: z.number().min(0).max(300).default(10),
  outcome: z.enum(["success", "failure"]).default("success"),
});
const batchSchema = (task) =>
  z.strictObject({
    batch_id: common.delegation_id,
    tasks: z
      .array(task.extend({ task_id: common.delegation_id }))
      .min(1)
      .max(5),
  });
export const claudeBatchInput = batchSchema(claudeInput);
export const codexBatchInput = batchSchema(codexInput);
export function parseBatch(provider, value) {
  const input = (
    provider === "claude" ? claudeBatchInput : codexBatchInput
  ).parse(value);
  for (const key of ["task_id", "delegation_id"]) {
    if (
      new Set(input.tasks.map((task) => task[key])).size !== input.tasks.length
    )
      throw new Error(`Batch tasks must have distinct ${key} values`);
  }
  return input;
}
export function parseInput(provider, value, preflight) {
  const schema = preflight
    ? preflightInput
    : provider === "claude"
      ? claudeInput
      : codexInput;
  const input = schema.parse(value);
  if (
    !preflight &&
    provider === "codex" &&
    input.sandbox !== "workspace-write" &&
    input.network_access !== undefined
  )
    throw new Error(
      "network_access requires sandbox workspace-write; full access does not restrict network access",
    );
  if (
    !preflight &&
    provider === "codex" &&
    input.sandbox === "read-only" &&
    input.writable_roots !== undefined
  )
    throw new Error("writable_roots requires a writable sandbox mode");
  if (
    !preflight &&
    (input.prompt !== undefined) === (input.prompt_file !== undefined)
  ) {
    throw new Error("Provide exactly one of prompt or prompt_file");
  }
  if (
    !preflight &&
    Boolean(input.resume_session_id) !== Boolean(input.resume_delegation_id)
  ) {
    throw new Error(
      "Resume requires both the exact session ID and its previous delegation ID",
    );
  }
  return input;
}
export const timestamp = () => new Date().toISOString();
