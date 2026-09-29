---
name: claude-worker
description: Delegate an explicitly authorized task to Claude through a direct MCP call that waits for completion. Use when the user asks for this worker, not for unrelated work.
---

# Claude worker

1. Pass the user's task and desired result as `prompt`, preserving their wording and explicit constraints. Add only essential context the worker cannot otherwise see, such as what "this bug" refers to. Do not add your own workflow, file restrictions, data exclusions, skill instructions or reporting requirements. Alternatively, use a `prompt_file` under `cwd/artifacts`, never both.
2. Resolve `cwd` from the task context. Set model, effort, permissions and timeout as call parameters appropriate to the authorized task. Ask only for missing information needed to make the call, not repeat consent.
3. Call `claude_worker.run` directly, outside Code Mode, and wait without status/sleep loops or duplicate work. Report host rejections and execution failures; do not disguise or reroute a rejected call.
4. Use a unique delegation ID. Identical retries return the saved result; changed input requires a new ID. For corrections, pass both the exact returned `session_id` and its `delegation_id` as `resume_session_id` and `resume_delegation_id`. Never resume an unknown or implicit latest session.
5. Return the requested result. If it is truncated, read `result_file` for the needed remainder. Logs are opt-in with `trace: true`; retry/resume records remain under `artifacts/farcall/`. Unknown metadata stays unknown; do not sum cumulative usage.

Preflight is for requested host verification or diagnosing changed host behavior, not a prerequisite for ordinary tasks. To measure waiting, use a fresh delegation ID; a cached result proves no new wait. Before claiming a host avoids polling, use a 150-second preflight (or the user's specified duration) with a longer client timeout and inspect the parent trace. The tool cannot observe parent inference. Fix timeouts rather than adding polling.

Use an exact Claude model identifier. Default permissions do not auto-approve shell commands. Add only the allowed tool patterns needed for the authorized task. `acceptEdits` permits file edits, not arbitrary shell work. Chrome is opt-in.

When Claude Code is the parent, start it with `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` so it does not background the call after two minutes. The plugin supplies a two-hour per-server timeout. When Codex is the parent, keep the actual worker namespace in `features.code_mode.direct_only_tool_namespaces`. These are parent-host settings, not worker arguments.
