---
name: codex-worker
description: Delegate an explicitly authorized task to Codex through a direct MCP call that waits for completion. Use when the user asks for this worker, not for unrelated work.
---

# Codex worker

1. Confirm the requested task already authorizes delegation. Read project guidance, name the worker's scope, and use an isolated checkout if another worker is editing.
2. Pass the task directly in `prompt`, including scope, acceptance criteria, permissions, model, effort, and whether the worker may edit or only review. Alternatively use `prompt_file` under the checkout's `artifacts/`; never supply both. No recursive delegation unless explicitly requested.
3. Call `codex_worker.run` directly. Never wrap it in Code Mode, a shell background job, a status loop, or a sleep loop. The call stays pending until completion, failure, cancellation, or timeout. Do not duplicate the worker's implementation while waiting.
4. Use a unique delegation ID. A retry with the same ID and identical input returns its saved result; changing the request requires a new ID. Inspect failures before retrying.
5. For corrections, pass both the exact returned `session_id` and its `delegation_id` as `resume_session_id` and `resume_delegation_id`, using a new delegation ID. Never resume the latest session implicitly.
6. Ask for a concise final answer and review the returned changes and executed checks. Full logs are off by default; use `trace: true` only for debugging or requested evidence capture. The default result preview is 4,000 characters; `result_file` points to a longer answer when truncated. Read it only when needed. Small retry/resume records remain under `artifacts/farcall/`. Unknown metadata stays unknown; do not sum cumulative usage.

Before claiming a host avoids polling, use the deterministic `preflight` tool with a 150-second duration and a longer client timeout. Check the parent host's response trace for extra model turns. The tool cannot observe parent inference. If the host times out, fix its timeout instead of adding polling.

Use an exact Codex model identifier and supported effort. Reviews default to read-only; explicitly select workspace-write for implementation. The worker uses codex exec, not the Codex desktop UI. Do not promise browser tools unless they are configured and verified in the child CLI.

When Claude Code is the parent, start it with `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` so it does not background the call after two minutes. The plugin supplies a two-hour per-server timeout. When Codex is the parent, keep the actual worker namespace in `features.code_mode.direct_only_tool_namespaces`. These are parent-host settings, not worker arguments.
