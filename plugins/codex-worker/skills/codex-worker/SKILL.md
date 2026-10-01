---
name: codex-worker
description: Delegate an explicitly authorized task to Codex through a direct MCP call that waits for completion. Use when the user asks for this worker, not for unrelated work.
---

# Codex worker

1. Pass the user's task and desired result as `prompt`, preserving their wording and explicit constraints. Add only essential context the worker cannot otherwise see, such as what "this bug" refers to. Do not add your own workflow, file restrictions, data exclusions, skill instructions or reporting requirements. Alternatively, use a `prompt_file` under `cwd/artifacts`, never both.
2. Resolve `cwd` from the task context. Set model, effort, permissions and timeout as call parameters appropriate to the authorized task. Ask only for missing information needed to make the call, not repeat consent.
3. Call `codex_worker.run` directly, outside Code Mode, and wait without status/sleep loops or duplicate work. Report host rejections and execution failures; do not disguise or reroute a rejected call.
4. Use a unique delegation ID. Identical retries return the saved result; changed input requires a new ID. For corrections, pass both the exact returned `session_id` and its `delegation_id` as `resume_session_id` and `resume_delegation_id`. Never resume an unknown or implicit latest session.
5. Return the requested result. If it is truncated, read `result_file` for the needed remainder. Logs are opt-in with `trace: true`; retry/resume records remain under `artifacts/farcall/`. Unknown metadata stays unknown; do not sum cumulative usage.

For an authorized parallel set of 1–5 tasks in distinct, non-overlapping checkouts, call `codex_worker.run_batch` once instead of separate `run` calls. Supply `batch_id` and a stable `task_id` plus the usual run arguments for each task. Wait for the whole batch; use its structured result in input order. Corrections use a new batch ID and new delegation IDs with each exact previous session and delegation ID. An active/interrupted recovery result is not permission to redispatch unknown work. Keep the outer MCP timeout at least 7200 seconds.

Preflight is for requested host verification or diagnosing changed host behavior, not a prerequisite for ordinary tasks. To measure waiting, use a fresh delegation ID; a cached result proves no new wait. Before claiming a host avoids polling, use a 150-second preflight (or the user's specified duration) with a longer client timeout and inspect the parent trace. The tool cannot observe parent inference. Fix timeouts rather than adding polling.

Use an exact Codex model identifier and supported effort. Reviews default to read-only; explicitly select workspace-write for implementation. The worker uses codex exec, not the Codex desktop UI. Do not promise browser tools unless they are configured and verified in the child CLI.

For an authorized task in a directory outside Git, set `allow_non_git: true` explicitly, also on resume. Its default is false. This only passes `--skip-git-repo-check` for that invocation; sandbox permissions stay unchanged. Do not initialize Git or edit user configuration to work around this check. Retry a failed call with a new delegation ID; an unknown session ID cannot be resumed.

When Claude Code is the parent, start it with `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` so it does not background the call after two minutes. The plugin supplies a two-hour per-server timeout. When Codex is the parent, keep the actual worker namespace in `features.code_mode.direct_only_tool_namespaces`. These are parent-host settings, not worker arguments.
