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
  sandbox: z.enum(["read-only", "workspace-write"]).default("read-only"),
});
export const preflightInput = z.strictObject({
  ...common,
  duration_seconds: z.number().min(0).max(300).default(10),
  outcome: z.enum(["success", "failure"]).default("success"),
});
export function parseInput(provider, value, preflight) {
  const schema = preflight
    ? preflightInput
    : provider === "claude"
      ? claudeInput
      : codexInput;
  const input = schema.parse(value);
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
