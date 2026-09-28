# Models, calls & local state

## Choose your models

Set `model` & `effort` on each worker call. Farcall passes them to the selected CLI; it has no fixed list of model names. These settings choose the worker model, not the parent agent.

| Worker              | Example model ID  | Runs through |
| ------------------- | ----------------- | ------------ |
| `codex_worker.run`  | `gpt-6-astra`     | Codex CLI    |
| `claude_worker.run` | `claude-opus-5-5` | Claude Code  |

When a new model becomes available, update the CLI if needed & replace the `model` value in your next call. For example, if your Codex CLI supports `gpt-6.1-astra`, use that instead of `gpt-6-astra`. That name is an example, not a claim of availability. A new model name alone does not require a Farcall update or reinstall.

Use the exact model identifier supported by the CLI, rather than a display name such as “Opus 5.5”. Claude's reported identifier is checked against your request, so aliases that resolve to a different identifier can fail that check. Choose an effort level supported by both the model & Farcall.

- Codex effort values are `minimal`, `low`, `medium`, `high`, `xhigh`, `max` & `ultra`.
- Claude effort values are `low`, `medium`, `high`, `xhigh` & `max`.

To keep your preference across tasks, add this to the parent agent's `AGENTS.md` or `CLAUDE.md` & change the IDs when you want to switch.

```text
When using Farcall, pass these worker settings unless I request otherwise.
Codex worker: model gpt-6-astra, effort high.
Claude worker: model claude-opus-5-5, effort high.
Call the worker directly and wait for its result without polling.
```

These are instructions for the parent, not a Farcall configuration file. Every call still requires explicit `model` & `effort` values. Use a new delegation ID for a new request; an existing ID cannot be reused with changed settings.

New effort values or incompatible CLI changes may require a Farcall update.

## Run & resume

Pass the task directly in `prompt`. An implementation call to `claude_worker.run` can look like this.

```json
{
  "cwd": "/absolute/path/project",
  "delegation_id": "feature-001",
  "prompt": "Implement the agreed feature. Run the relevant checks and return a concise summary.",
  "model": "claude-opus-5-5",
  "effort": "high",
  "permission_mode": "acceptEdits",
  "allowed_tools": ["Bash(pnpm test *)", "Bash(pnpm build *)"],
  "timeout_seconds": 3600
}
```

Choose allowed tools for the actual task. The default permission mode does not approve shell commands automatically. `acceptEdits` allows file edits; shell operations still need existing CLI permissions or explicit allowed tool patterns. Chrome is opt-in through `chrome: true` & needs a working Claude Chrome setup.

For `codex_worker.run`, use the same common fields, any model your Codex CLI supports (for example `gpt-6-astra`), & `sandbox: "read-only"` for reviews or `"workspace-write"` for implementation. Omit Claude-specific fields. Codex runs with approval requests disabled, so disallowed operations fail instead of waiting for input. No bypass mode is exposed.

For a correction, supply a new prompt & use a new delegation ID. Include the exact returned `session_id` as `resume_session_id` & the previous `delegation_id` as `resume_delegation_id`. Both must belong to the same provider & checkout. There is no implicit “latest session” option.

`completed` means the CLI returned a successful native result, not that every requested action happened. The response includes permission denials & `result_truncated` when the preview was shortened. The default preview limit is 4,000 characters. Set `max_result_chars` between 256 & 24,000 to change it. When truncated, `result_file` points to the full answer. This limits what returns to the parent, not how much the worker generates.

An identical request with the same ID returns the saved result. A changed request with that ID fails. A crash leaves evidence to inspect rather than silently starting paid work again.

`trace` & `max_result_chars` are part of request identity. Changing either requires a new delegation ID and starts a new call; a cached result cannot create logs retroactively. To read an already saved longer answer, use `result_file` instead of rerunning the task.

## Optional traces

Full logging is off by default. Set `trace: true` on a `run` or `preflight` call when debugging or recording a benchmark. It saves the prompt copy, native events, stderr, lifecycle records & native final response under `artifacts/farcall/<delegation_id>/`. Logging locally does not itself use model tokens; reading those files into an agent's context does.

You can still use `prompt_file` instead of `prompt`. Supply exactly one. The file must resolve inside the target checkout's `artifacts/` directory. Both forms are limited to 1 MB of UTF-8 text. No prompt file is needed for inline calls.

## State kept without tracing

Farcall always keeps two small records under `artifacts/farcall/<delegation_id>/`.

- `request.json` stores the request fingerprint, provider, checkout & timestamp, without copying the prompt.
- `completion.json` stores the outcome, session, returned preview, permission denials & available usage. When a failed process returns `stderr_tail`, that diagnostic excerpt is also persisted, limited to 2,000 characters.

A truncated answer additionally creates `result.txt`. Failed CLI processes can return a bounded stderr excerpt without saving a full stderr log. These records preserve resume & retry behavior even when tracing is off. An interrupted request without a completion is not automatically rerun. Do not delete its state to force a retry until you have checked whether its worker is still active.

The records can contain private output. Add `artifacts/` to the target project's ignore rules. Disabling Farcall traces does not disable the CLI's own session history. Full traces cannot be recovered retroactively from a run with tracing off.

## Limits

Codex exec does not provide a verified model ID or price in its standard JSONL result. Those fields remain unknown. Claude's init-reported model is checked against the request; this does not detect later provider fallbacks. Resumed usage totals may be cumulative. A missing cost is not zero.

A shared lock at the nearest Git root prevents overlapping Farcall workers, including calls from different subdirectories. Linked Git worktrees have separate locks. Outside Git, the lock covers only `cwd`. It cannot prevent unrelated editors from changing files. Use separate checkouts for parallel implementation.

Cancellation & timeout terminate the child's process group. A child that deliberately detaches into another group is outside that boundary. Captured stdout & stderr share a drain window of at most one second after process exit; forced pipe closure is reported as `stdout_truncated` or `stderr_truncated`. With tracing enabled, stderr goes directly to its log file. After a hard server crash, inspect `artifacts/farcall/.active` & its processes before removing the lock.

Farcall is a trusted local CLI bridge, not an isolation boundary for untrusted agents.
