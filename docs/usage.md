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

## Worker accounts

`codex-worker` starts `codex exec` on the machine running the Farcall server.
By default it uses that OS user's Codex login: `CODEX_HOME` (normally `~/.codex`)
and the configured credential store, which may be the OS keychain. API-key or
custom-provider authentication configured for that CLI can change this. See
[Codex authentication](https://developers.openai.com/codex/auth/).

Farcall does not select accounts, balance subscription allowances, or copy the
coordinator's account, proxy or pool settings into the worker. The child inherits
the Farcall server's process environment, so an explicitly configured CLI or
inherited environment can affect routing. A pool used only by the parent does
not establish which account the worker will use. Check each worker host with the
same OS user and `CODEX_HOME` as its Farcall server.

Before a long run, choose an account with remaining subscription allowance.
Check `/status` in an interactive Codex session on that host or the account's
usage dashboard, as described in [Codex usage guidance](https://developers.openai.com/codex/pricing/).
`codex login status` checks the CLI's authentication mode, not remaining quota.

Session-file `rate_limits` and nested `credits` fields, when present under
`CODEX_HOME/sessions`, are version-dependent diagnostics, not a stable quota API.
Match the record's account and timestamp to the worker login and time you are
checking; an old record or one from another login is not evidence of current
allowance. Missing fields or an unverified account/time match mean unknown.
Exhausted subscription allowance may consume credits if enabled for that account.
Farcall neither switches to another account nor enforces a credit budget.

To switch accounts, finish active workers, then use `codex logout` and
`codex login` in that same host environment and check `codex login status` again.
Prefer a fresh login. OpenAI also documents [copying the auth cache as a headless
fallback](https://developers.openai.com/codex/auth/#fallback-authenticate-locally-and-copy-your-auth-cache).
Use that fallback only when needed; never run the source and copied login in
parallel at two locations, because rotating tokens can leave a copy stale.
This concerns duplicated login credentials, not separate fresh logins to the
same account.
The [CLI reference](https://developers.openai.com/codex/cli/reference/#codex-login)
describes the login commands. Farcall does not edit login or user configuration.

## Run & resume

Ask for the worker, give it a task and say what you want back. The same pattern works for implementation and review:

```text
Use Claude worker with this task: "Add CSV export to the reports page and run the tests." Give me the changes and test results back.

Use Claude worker with this task: "Review the authentication changes for bugs." Give me concrete findings with file references back.
```

The parent passes the task and desired result, preserving the user's wording and explicit constraints. It adds only essential context the worker cannot otherwise see, such as resolving "this bug" or supplying prior findings. It does not add its own workflow, file restrictions, data exclusions, skill instructions or reporting requirements. The worker CLI discovers guidance and skills according to its own configuration; Farcall does not inject them or guarantee they are applied.

`cwd`, model, effort, permissions and timeout are call parameters, not extra task text. Existing host and CLI permissions still apply. Preflight is for requested host verification, not ordinary tasks. Report host rejections instead of disguising or rerouting the call.

Pass the task directly in `prompt`. An implementation call to `claude_worker.run` can look like this.

```json
{
  "cwd": "/absolute/path/project",
  "delegation_id": "feature-001",
  "prompt": "Add CSV export to the reports page and run pnpm test and pnpm build. Return the changes and check results.",
  "model": "claude-opus-5-5",
  "effort": "high",
  "permission_mode": "acceptEdits",
  "allowed_tools": ["Bash(pnpm test *)", "Bash(pnpm build *)"],
  "timeout_seconds": 3600
}
```

Choose allowed tools for the actual task. The default permission mode does not approve shell commands automatically. `acceptEdits` allows file edits; shell operations still need existing CLI permissions or explicit allowed tool patterns. Chrome is opt-in through `chrome: true` & needs a working Claude Chrome setup.

For `codex_worker.run`, use the same common fields, any model your Codex CLI supports (for example `gpt-6-astra`), & `sandbox: "read-only"` for reviews or `"workspace-write"` for implementation. Omit Claude-specific fields. Codex runs with approval requests disabled, so disallowed operations fail instead of waiting for input.

For a workspace-write task that needs sibling directories or network access, pass
explicit per-call permissions. Both fields also work on each `run_batch` task:

```json
{
  "sandbox": "workspace-write",
  "writable_roots": ["/absolute/path/plugin", "/absolute/path/runtime"],
  "network_access": true
}
```

`writable_roots` accepts up to 16 existing absolute directories. Farcall resolves
symlinks, removes duplicates and locks the corresponding checkout roots; it does
not create missing directories. `network_access: false` explicitly disables network
access. An explicit empty roots list overrides Codex's configured extra roots.
Omitting either field preserves Codex's existing configuration. `network_access`
requires `sandbox: "workspace-write"`. Extra roots are rejected in read-only mode;
their full-access behavior is described below.
Repeat the intended permissions on exact-session resume. Changed permissions need
a new delegation ID, and a new batch ID when applicable.

The adapter passes `sandbox_workspace_write.writable_roots` and
`sandbox_workspace_write.network_access` as CLI config overrides for that invocation.
It never changes project trust or user/project config files. Project-local Codex
config loads only for trusted projects, so do not rely on it to convey a worker's
required permissions. Admin policy and Codex's protected paths still apply;
adding a checkout does not make its `.git` or `.codex` metadata writable. Network
access alone does not guarantee that browser automation or dependencies work.

### Explicit full access

When the user authorizes execution without the Codex sandbox, set
`sandbox: "danger-full-access"` on the run or individual batch task. Farcall passes
that native mode for this invocation only. The default remains `read-only`; a
failure never triggers an automatic permission upgrade. No user configuration is
edited, and operating-system or administrator restrictions still apply.

Full access permits commands with the OS user's permissions. Checkout locks are
coordination, not filesystem isolation. Use an external container or VM when an
enforced boundary is required. Optional `writable_roots` still reserve additional
work areas through Farcall's shared locks, but do not limit full-access commands
and are not forwarded as workspace sandbox settings. `network_access` is rejected
in this mode, including `false`, because it cannot impose a network restriction.

For a correction, use a new delegation ID (and batch ID) and the exact previous
session/delegation pair. Supply the chosen sandbox mode and coordination roots
again. Changing permissions under an existing ID is rejected.

Full access does not install or enable Browser Use, Playwright, or a desktop
browser connection. The child Codex CLI must already have a usable browser tool
or automation library. Verify an actual launch, navigation, interaction, artifact
capture and shutdown before relying on browser acceptance. `preflight` tests only
the completion wait and does not establish browser capability.

For a task outside Git, explicitly set `allow_non_git: true` (default: `false`). The worker passes `--skip-git-repo-check` for that invocation, including resume. It does not initialize Git or edit Claude/Codex configuration. The sandbox and approval policy remain unchanged; `read-only` alone does not enable this option. Set it again when resuming outside Git. Changing the option requires a new delegation ID, including when retrying a failed call with an unknown session ID.

```json
{
  "cwd": "/absolute/path/plain-directory",
  "delegation_id": "review-non-git-001",
  "prompt": "Review src/ and test/ for bugs. Return concrete findings with file references.",
  "model": "gpt-6-astra",
  "effort": "low",
  "sandbox": "read-only",
  "allow_non_git": true
}
```

For a correction, supply a new prompt & use a new delegation ID. Include the exact returned `session_id` as `resume_session_id` & the previous `delegation_id` as `resume_delegation_id`. Both must belong to the same provider & checkout. There is no implicit “latest session” option.

`completed` means the CLI returned a successful native result, not that every requested action happened. The response includes permission denials & `result_truncated` when the preview was shortened. The default preview limit is 4,000 characters. Set `max_result_chars` between 256 & 24,000 to change it. When truncated, `result_file` points to the full answer. This limits what returns to the parent, not how much the worker generates.

An identical request with the same ID returns the saved result. A changed request with that ID fails. A crash leaves evidence to inspect rather than silently starting paid work again.

`trace` & `max_result_chars` are part of request identity. Changing either requires a new delegation ID and starts a new call; a cached result cannot create logs retroactively. To read an already saved longer answer, use `result_file` instead of rerunning the task.

## Keep results short

Every returned worker result enters the coordinator's context, including each
task in a batch. Ask for a short summary of changes, checks and blockers, with
file references for details. If the task permits writing a report, keep the full
report in an agreed file and return its path instead of pasting it into chat.

`max_result_chars` bounds the returned preview (default 4,000 characters, range
256–24,000). If the answer exceeds it, Farcall saves the full text as `result.txt`
in the returned `evidence_directory` and returns its path in `result_file`, even
with tracing off. `result_file` is an output field, not an input destination;
it is `null` when no truncation was needed. Read the file only when its details
are needed, rather than rerunning the worker or loading all evidence into the
coordinator's context. A preview limit does not reduce the worker's generated
output, so request a concise answer as well.

For example: “Return a brief summary and test results. Save detailed findings to
`artifacts/review.md` and include the path.” Use a report-writing task only when
file writes are authorized. [Batch result limits](batches.md) also apply.

## Optional traces

Full logging is off by default. Set `trace: true` on a `run` or `preflight` call when debugging or recording a benchmark. It saves the prompt copy, native events, stderr, lifecycle records & native final response under `artifacts/farcall/<delegation_id>/`. Logging locally does not itself use model tokens; reading those files into an agent's context does.

You can still use `prompt_file` instead of `prompt`. Supply exactly one. The file must resolve inside the target checkout's `artifacts/` directory. Both forms are limited to 1 MB of UTF-8 text. No prompt file is needed for inline calls.

## State kept without tracing

Farcall always keeps two small records under `artifacts/farcall/<delegation_id>/`.

- `request.json` stores the request fingerprint, provider, checkout & timestamp, without copying the prompt.
- `completion.json` stores the outcome, session, returned preview, permission denials & available usage. When a failed process returns `stderr_tail`, that diagnostic excerpt is also persisted, limited to 2,000 characters.

A truncated answer additionally creates `result.txt`. Failed CLI processes can return a bounded stderr excerpt without saving a full stderr log. These records preserve resume & retry behavior even when tracing is off. An interrupted request without a completion is not automatically rerun. Do not delete its state to force a retry until you have checked whether its worker is still active.

The records can contain private output. Add `artifacts/` to the target project's ignore rules. Disabling Farcall traces does not disable the CLI's own session history. Full traces cannot be recovered retroactively from a run with tracing off.

## Checkout locks & crash recovery

New checkout locks (`artifacts/farcall/.active`) and global write-scope claims
(`~/.local/state/farcall/write-scopes/*.json`, or the configured state directory)
record a shared `lock_id`, `server_pid`, `hostname`, `started_at` and versioned
worker identities. Each worker starts as `not_spawned`; Farcall persists `spawning`
before launching it, then records `spawned` with its detached process-group ID.
A batch records every worker group in all of its locks and its shared claim.

On admission, Farcall automatically removes an overlapping claim and its matching
checkout locks only when the hostname matches, the server PID is absent, and every
worker group is absent or explicitly never spawned. An orphan checkout lock is
checked by the same rule. Each removed file and the reason are returned in the
additive `lock_recoveries` field and saved with the completion or batch result.
Recovery clears coordination records; it does not redispatch interrupted work or
remove delegation evidence. Claims unrelated to the requested scopes are left alone.

Foreign-host records, live servers or worker groups, legacy records without worker
identity, incomplete records, and interrupted `spawning` states require inspection.
Errors name the exact file and the blocking condition. Only an `ESRCH` process probe
counts as absence; permission errors fail closed. Never remove a lock just because
its server died: its worker group can still be writing.

Live reused PIDs or process-group IDs also block recovery, even if their start time
would differ. `started_at` is the lock admission time, not an OS process birth time;
Farcall does not infer death from record age. This conservative rule can leave a
stale lock blocked by an unrelated reused ID. Probes and unlinking are not an atomic
OS operation, so ID reuse between them remains a small residual race. Hostname
uniqueness and the local PID namespace must be reliable. Workers that deliberately
detach into another process group remain outside Farcall's tracking boundary.

Admission is serialized by a short-lived global `.active` mutex. Competing stale
mutex recovery uses an exclusive `.active.recovery` fence. If the server dies during
recovery and leaves a fence, inspect that exact file and the locks/processes before
removing it; fences are never automatically recovered. Legacy admission mutexes
also require manual inspection.

Before removing a worker checkout, copy `artifacts/farcall/<delegation_id>/` to a
location outside that checkout to preserve retry and resume records (and optional
traces). **Never copy or remove these records while `artifacts/farcall/.active`
exists**, including at the enclosing Git checkout root when the worker's `cwd` is
a subdirectory. Finish or safely recover the run first. Archiving the records
preserves the evidence; Farcall still requires the original provider and checkout
identity for exact-session resume, so moving a checkout does not automatically make
its records resumable from a new path.

## Limits

Codex exec does not provide a verified model ID or price in its standard JSONL result. Those fields remain unknown. Claude's init-reported model is checked against the request; this does not detect later provider fallbacks. Resumed usage totals may be cumulative. A missing cost is not zero.

A shared lock at the nearest Git root prevents overlapping Farcall workers, including calls from different subdirectories. Linked Git worktrees have separate locks. Outside Git, the lock covers only `cwd`. It cannot prevent unrelated editors from changing files. Use separate checkouts for parallel implementation.

Cancellation & timeout terminate the child's process group. A child that deliberately detaches into another group is outside that boundary. Captured stdout & stderr share a drain window of at most one second after process exit; forced pipe closure is reported as `stdout_truncated` or `stderr_truncated`. With tracing enabled, stderr goes directly to its log file. Hard-crash recovery follows the checks below.

Farcall is a trusted local CLI bridge, not an isolation boundary for untrusted agents.

For multiple concurrent tasks through one pending call, see [parallel batches](batches.md). Each task keeps the `run` contract above.
