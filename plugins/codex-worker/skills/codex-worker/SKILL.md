---
name: codex-worker
description: Delegate an explicitly authorized task to Codex through a direct MCP call that waits for completion. Use when the user asks for this worker, not for unrelated work.
---

# Codex worker

1. Use the user's existing request to establish authorization for this worker and task. Do not ask them to repeat that authorization merely because the worker uses an external model service. This does not authorize unrelated delegation, sensitive-data disclosure, or broader access.
2. Resolve `cwd` to the intended source version. Read project guidance and identify task-relevant source paths. Put those paths, a brief factual summary of the user's request, read/edit permissions, and these exclusions in `prompt`: no credentials, `.env` files, private databases/customer data, raw logs, sessions, or artifacts in task context; stop if the task requires excluded or out-of-scope data. Do not inspect excluded content to prepare the call. Use existing context and only focused inspection, not a separate audit or confirmation round. Ask only if the target or necessary scope is unresolved. These instructions are not a filesystem access boundary.
3. Send one compact `prompt`, or a `prompt_file` under `cwd/artifacts`, never both. State acceptance criteria and a concise result format. Do not copy the repository into the prompt. No recursive delegation unless requested. For a review, specify static analysis and no changes unless the user requested more. For implementation, allow only the requested edits and checks; isolate the checkout if another worker is editing.
4. Call `codex_worker.run` directly, outside Code Mode. Wait for its result without status/sleep loops, background jobs, or duplicate implementation. If host approval rejects the call, respect the rejection and report its exact reason. A narrower call is appropriate only when it addresses that reason within existing authorization and the user's call limit permits it; never disguise or reroute the rejected action. If still blocked, ask only for the specific missing authorization, not blanket repository consent.
5. Use a unique delegation ID. Identical retries return the saved result; changed input requires a new ID. For corrections, pass both the exact returned `session_id` and its `delegation_id` as `resume_session_id` and `resume_delegation_id`. Never resume an unknown or implicit latest session.
6. Review the returned changes and executed checks. Logs are opt-in with `trace: true`. The default preview is 4,000 characters; read `result_file` only when the truncated answer is needed. Small retry/resume records remain under `artifacts/farcall/`. Unknown metadata stays unknown; do not sum cumulative usage.

Preflight is for requested host verification or diagnosing changed host behavior, not a prerequisite for ordinary tasks. To measure waiting, use a fresh delegation ID; a cached result proves no new wait. Before claiming a host avoids polling, use a 150-second preflight (or the user's specified duration) with a longer client timeout and inspect the parent trace. The tool cannot observe parent inference. Fix timeouts rather than adding polling.

Use an exact Codex model identifier and supported effort. Reviews default to read-only; explicitly select workspace-write for implementation. The worker uses codex exec, not the Codex desktop UI. Do not promise browser tools unless they are configured and verified in the child CLI.

For an authorized task in a directory outside Git, set `allow_non_git: true` explicitly, also on resume. Its default is false. This only passes `--skip-git-repo-check` for that invocation; sandbox permissions stay unchanged. Do not initialize Git or edit user configuration to work around this check. Retry a failed call with a new delegation ID; an unknown session ID cannot be resumed.

When Claude Code is the parent, start it with `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` so it does not background the call after two minutes. The plugin supplies a two-hour per-server timeout. When Codex is the parent, keep the actual worker namespace in `features.code_mode.direct_only_tool_namespaces`. These are parent-host settings, not worker arguments.
