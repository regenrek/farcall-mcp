---
name: claude-worker
description: Delegate an explicitly authorized task to Claude through a direct MCP call that waits for completion. Use when the user asks for this worker, not for unrelated work.
---

# Claude worker

1. Confirm the requested task already authorizes delegation. Read project guidance, name the worker's scope, and use an isolated checkout if another worker is editing.
2. Save the exact prompt under the target checkout's `artifacts/`. Include acceptance criteria, allowed files, permissions, model, effort, and whether the worker may edit or only review. No recursive delegation unless the user explicitly requests it.
3. Call `claude_worker.run` directly. Never wrap it in Code Mode, a shell background job, a status loop, or a sleep loop. The call stays pending until completion, failure, cancellation, or timeout. Do not duplicate the worker's implementation while waiting.
4. Use a unique delegation ID. A retry with the same ID and identical input returns its saved result; changing the request requires a new ID. Inspect failures before retrying.
5. For corrections, pass both the exact returned `session_id` and its `delegation_id` as `resume_session_id` and `resume_delegation_id`, using a new delegation ID. Never resume the latest session implicitly.
6. Review the returned changes and executed checks. Keep raw evidence under `artifacts/farcall/`. Unknown usage or model metadata stays unknown. Do not sum cumulative session totals.

Before claiming a host avoids polling, use the deterministic `preflight` tool with a 150-second duration and a longer client timeout. Check the parent host's response trace for extra model turns. The tool cannot observe parent inference. If the host times out, fix its timeout instead of adding polling.

Use an exact Claude model identifier. Default permissions do not auto-approve shell commands. Add only the allowed tool patterns needed for the authorized task. `acceptEdits` permits file edits, not arbitrary shell work. Chrome is opt-in.

When Claude Code is the parent, start it with `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` so it does not background the call after two minutes. The plugin supplies a two-hour per-server timeout. When Codex is the parent, keep the actual worker namespace in `features.code_mode.direct_only_tool_namespaces`. These are parent-host settings, not worker arguments.
