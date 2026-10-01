# Parallel batches

`run_batch` runs **1–5 tasks concurrently** through one pending MCP call. It is
available on both provider servers; every task targets that server's provider.
It is not a queue. More than five tasks are rejected, not serialized.

Each task is the provider's existing `run` input plus `task_id`. Models, efforts,
permissions, prompts, prompt files, result limits and trace settings keep their
existing meanings. Farcall adds no worker instructions or implicit models.

## Parallel call

For example, call `codex_worker.run_batch` with two prepared, independent checkouts.
The same shape supports up to five workers; use the Claude `run` permission fields
when calling `claude_worker.run_batch`.

```json
{
  "batch_id": "build-1",
  "tasks": [
    {
      "task_id": "core",
      "cwd": "/work/worker-1/core",
      "delegation_id": "core-build-1",
      "model": "gpt-6.1-sol",
      "effort": "high",
      "sandbox": "workspace-write",
      "prompt": "Implement the requested core changes and run their tests.",
      "trace": true,
      "timeout_seconds": 7100
    },
    {
      "task_id": "ui",
      "cwd": "/work/worker-2/ui",
      "delegation_id": "ui-build-1",
      "model": "gpt-6.1-sol",
      "effort": "high",
      "sandbox": "workspace-write",
      "prompt": "Implement the requested UI changes and run their tests.",
      "trace": true,
      "timeout_seconds": 7100
    }
  ]
}
```

All schemas, canonical paths, prompt contents, delegation identities and resume
references are checked before dispatch. Every checkout lock must be acquired and
every task reserved before any new worker starts. Admission failure releases
acquired locks and starts zero workers. Existing completed delegations can be
reused. A conflicting or interrupted delegation is not silently restarted.

Task IDs and delegation IDs must each be unique within a batch. ID syntax is the
same as `delegation_id`. A batch ID is scoped to the provider and local Farcall
state directory, not to its first checkout.

## Isolation

Working directories are canonicalized through symlinks. Tasks must have distinct,
non-overlapping checkout roots and working directories. Two subdirectories of one
checkout are rejected. Linked Git worktrees have independent roots and can run
concurrently. Tasks that alias the same per-worktree Git directory through `.git`
symlinks or pointer files are rejected within a batch. Outside Git the canonical working directory serves as the root;
Codex still requires the explicit `allow_non_git: true` option.

Batches use the same checkout locks as single `run` calls and other provider
servers. Farcall never creates checkouts, moves files, merges branches or provisions
databases. Directory validation is **not an OS sandbox**. Shared databases,
services, ports, browser sessions and other editors remain the caller's responsibility.
Keep checkout topology stable during a call. Locks outside Git cover the selected
working directory, as with `run`; they are not a global filesystem lock manager.
For Codex workspace-write tasks, `writable_roots` and `network_access` are explicit
per-task options, as described in [usage](usage.md). Additional roots participate
in admission, including ancestor/descendant overlap, shared checkouts and Git
directory aliases. This also excludes conflicting separate `run`/`run_batch`
calls and calls through the other provider. Multiple roots belonging to one task
may overlap; roots belonging to different tasks may not. Different subdirectories
of one checkout are still a single lock scope.

A provider-neutral claim registry under `FARCALL_STATE_DIR/write-scopes` coordinates
admission across server processes, alongside the existing checkout `.active` files.
All coordinating servers must use the same state directory and this version or newer.
Only filesystem admission is serialized; accepted workers still run concurrently.
The admission mutex waits at most five seconds. Cancellation and normal completion
remove the claims and all checkout locks. A crash can leave claims or the registry's
`.active` admission mutex; inspect their owner and worker evidence before removing
them. Recovery never automatically steals a stale claim. Checkout topology must
remain stable while a job runs.

Claims cover `cwd` and explicitly supplied roots. They cannot discover additional
write access inherited from provider configuration, custom tools or an external
service. Use explicit roots for reproducible worker permissions. Directory admission
remains a coordination mechanism, not an OS sandbox.

Codex tasks can explicitly select `sandbox: "danger-full-access"` when authorized.
Modes may differ within a batch; they are never upgraded automatically. Additional
`writable_roots` still participate in admission, but in full-access mode they are
coordination claims only. Full-access workers can access other paths with the OS
user's permissions. `network_access` is rejected for full-access tasks. See
[full-access usage and browser requirements](usage.md#explicit-full-access).

## Completion, cancellation and timeouts

The first invocation stays pending until every admitted task reaches an outcome.
Failures and per-task timeouts leave unrelated siblings running. No automatic
retries, relay agents or status tool are involved.

Use an **outer MCP timeout of at least 7200 seconds**. The maximum per-task timeout
is 7100 seconds; process cleanup allows one second for termination escalation and
one second for output draining. Workers run concurrently, so task timeouts are not
summed. The remaining margin covers admission and local result persistence under
normal filesystem operation. Existing plugin MCP configuration already sets 7200
seconds. For a Claude Code parent, retain the documented setup:

```sh
CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0 MCP_TOOL_TIMEOUT=7200000 claude
```

Caller cancellation and graceful server shutdown signal every active worker
process group, await bounded process cleanup and release checkout locks. Already
completed results survive. If the transport is closed or the client aborts its
request, delivery of the final response is not guaranteed; durable results remain
available to an identical retry. A per-task timeout does not cancel siblings.

`SIGKILL`, power loss and storage failure cannot run graceful cleanup. Such a
retry never launches replacement workers. It reports the recorded outcomes and
unknown tasks, retaining conservative locks where applicable. Inspect the recorded
checkout locks and worker processes before removing stale locks. Farcall does not
kill arbitrary PIDs or guess replacement sessions during recovery. macOS and
Linux process groups are supported; Windows and children that deliberately escape
their process group are not an OS containment guarantee.

## Results and limits

The MCP response contains the complete batch object in `structuredContent` and
mirrors it as JSON text for hosts that consume only text content. `tasks` always follows input order. Each entry includes
`task_id`, `delegation_id`, `status`, `session_id`, `evidence_directory`,
`worker_result_file`, and the existing completion object in `worker_result`.
Native usage, model and cost fields retain their original values, including
`unknown` and `null`. Farcall does not sum cumulative counters or estimate costs.

Aggregate statuses:

| Status            | Meaning                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `completed`       | Every task completed successfully.                                                                     |
| `partial_failure` | At least one failed or timed out; all available results are retained, including when all tasks failed. |
| `cancelled`       | Batch cancellation affected the run; completed results are retained.                                   |
| `rejected`        | Admission failed; no new workers started. The error and all task identifiers are returned.             |
| `active`          | Another server owns this identical batch; this response is a recovery snapshot, not a new dispatch.    |
| `interrupted`     | No safe automatic completion/recovery is available; inspect the retained evidence.                     |

A schema/path error before batch admission is an MCP error and has no batch
record. For recovery, per-task `not_started` means there is no durable dispatch
intent. `unknown` means dispatch was intended but no terminal outcome is recorded;
it includes the crash window immediately before process spawn. Neither state is
silently retried. A cancelled task that never reached dispatch also carries
`dispatch_state: "not_started"`.

The serialized batch object is limited to **256 KiB**, in addition to each task's
existing 256–24,000-character result-preview setting (default 4,000). If provider
metadata or previews exceed that aggregate budget, the largest `worker_result`
objects are externalized: `worker_result` becomes `null`, `result_externalized`
is `true`, and `worker_result_file` references the original, unchanged completion.
Status, IDs, session and evidence references are never dropped. Read those files
only when the omitted details are needed. Per-task `result_file` still references
the full answer when its preview was truncated. Including the JSON text mirror
and MCP wrapper, the serialized response stays below 1 MiB.

## Retries and correction batches

An identical completed retry returns the saved batch result, even after server
restart. A changed request under the same batch ID is rejected. Prompt file
contents participate in identity through their hash. A simultaneous retry in the
same server joins the existing promise; cancelling that retry does not cancel the
original caller's work. A retry in another server returns `active` or `interrupted`
with existing evidence, without redispatching any task. No polling is required
for recovery. After a rejected admission, use a new batch ID for a deliberate new
attempt; a retry of the rejected ID returns its recorded rejection.

A correction uses a new batch ID and new delegation IDs. Include only tasks that
need changes, with their exact saved session and previous delegation ID. Here the
two session UUIDs are illustrative; replace them with the actual first results.
Keep each task in its original working directory.

```json
{
  "batch_id": "build-2",
  "tasks": [
    {
      "task_id": "core",
      "cwd": "/work/worker-1/core",
      "delegation_id": "core-build-2",
      "resume_delegation_id": "core-build-1",
      "resume_session_id": "11111111-1111-4111-8111-111111111111",
      "model": "gpt-6.1-sol",
      "effort": "high",
      "sandbox": "workspace-write",
      "prompt": "Address the core findings from the review."
    },
    {
      "task_id": "ui",
      "cwd": "/work/worker-2/ui",
      "delegation_id": "ui-build-2",
      "resume_delegation_id": "ui-build-1",
      "resume_session_id": "22222222-2222-4222-8222-222222222222",
      "model": "gpt-6.1-sol",
      "effort": "high",
      "sandbox": "workspace-write",
      "prompt": "Address the UI findings from the review."
    }
  ]
}
```

Missing, wrong-provider, wrong-checkout and mismatched saved sessions fail
admission for the entire correction batch. A CLI reporting a different session
at runtime fails that task via the existing session check. An unknown session
cannot be resumed. Batch recovery never substitutes a new session.

## Local state and evidence

Task evidence stays under each task's `cwd/artifacts/farcall/<delegation_id>`.
Batch identity, task dispatch states and results live under
`$XDG_STATE_HOME/farcall/batches/<provider>/<batch_id>` (default
`~/.local/state/farcall/batches/...`). Set an absolute `FARCALL_STATE_DIR` to
replace the `farcall` state root, for example in an isolated test environment.
Keep that root stable across retries and server restarts. It is local runtime
state, not a change to Claude/Codex configuration. Do not delete recovery state
while retries may occur. The registry is not a distributed coordinator.

Tracing is opt-in for each task. Without trace, batches do not copy prompts or
raw CLI events; they persist hashes, dispatch state and results needed for
identity, recovery and delivery. With trace, each task's `lifecycle.jsonl` records
dispatch, worker start, termination requests and finish timestamps. Compare those
events to verify real overlap. The batch ledger never needs extra prompt copies.

## Server concurrency versus host scheduling

Both `run` and `run_batch` truthfully advertise `readOnlyHint: false`,
`destructiveHint: true`, `idempotentHint: true` and `openWorldHint: true`.
A host may serialize separate write-capable MCP calls. A batch moves fan-out
inside one call, so that scheduling policy does not serialize its tasks.

Farcall's pending call does not guarantee how a host schedules its own model or
whether it backgrounds long calls. Host-level claims still require the parent
trace. The deterministic test suite verifies server-side overlap and one terminal
MCP result, without paid model calls or benchmark changes.
