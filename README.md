# farcall-mcp

Let Claude Code call Codex, or Codex call Claude Code, through one pending MCP call.

![Bar chart of estimated API-equivalent cost for the same task. Run I, where Astra polled for status, cost $43.22, with Claude at $21.10 and Astra at $22.12 including $9.75 of identified polling. Run J, with a direct MCP wait, cost $31.10, with Claude at $22.99 and Astra at $8.11. Claude rose by $1.89 & Astra dropped by $14.01.](docs/images/polling-cost.png)

Estimated API-equivalent costs from two runs of the same task, not subscription spend. Implementation & review also differed, so polling does not explain the whole difference. Run J tested an earlier MCP implementation, not this package.

[See the full experiment, results & cost breakdown](https://kevinkern.dev/benchmarks/marlies-workflows/).

The parent makes one MCP call. The server starts the other CLI & keeps that call open until the task finishes. Corrections resume the same session. Prompts, native events, usage & failures stay in the checkout.

I built this after [trying different Astra & Opus workflows on the same feature](https://kevinkern.dev/benchmarks/marlies-workflows/). Polling added avoidable cost in some runs. A direct MCP call removed that polling in a later run. That is a reason to fix the waiting mechanism, not evidence that two models always produce better work.

## What you get

| Plugin          | Typical parent | Worker      |
| --------------- | -------------- | ----------- |
| `claude-worker` | Codex          | Claude Code |
| `codex-worker`  | Claude Code    | Codex CLI   |

Both workers accept any model their CLI supports. Pick it per call.

Both plugins provide `run` & `preflight`. There is no status endpoint. Each plugin includes its own built server, so marketplace users do not need to install this repository's dependencies.

You need Node 24+, macOS or Linux, & the worker CLI installed & signed in. Codex tasks require a Git working tree; the deterministic preflight also works outside Git. The model name & effort are explicit inputs. Your existing CLI account pays for the model work. This package neither supplies credentials nor estimates subscription costs.

## Install in Claude Code

Run the following in Claude Code. Start a new session after installation.

```text
/plugin marketplace add regenrek/farcall-mcp
/plugin install codex-worker@farcall
```

From a local clone, pass its absolute path instead of `regenrek/farcall-mcp`.

For long tasks, disable automatic MCP backgrounding in the parent. The plugin sets a two-hour server timeout.

```sh
CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0 MCP_TOOL_TIMEOUT=7200000 claude
```

To keep that setting across sessions, put `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` with the string value `"0"` in the `env` object of your Claude user settings. The plugin cannot change a running parent's environment.

Use `/codex-worker:codex-worker` with a task, or ask Claude to use the Codex worker. For example,

```text
Use the Codex worker to review my current changes with gpt-6-astra at high effort.
Keep it read-only. Save the review prompt under artifacts/ and call the MCP tool
once. Wait for its result without checking status. Return concrete findings with
file references, then let me decide which changes to make.
```

## Install in Codex

Register this repository's Codex marketplace & install the Claude worker. From a local clone, pass its absolute path instead.

```sh
codex plugin marketplace add regenrek/farcall-mcp
codex plugin add claude-worker@farcall
```

Start a new Codex session, then invoke `$claude-worker` with your task. The plugin sets a two-hour tool timeout. Keep the worker tool outside Code Mode. Plugin tool namespaces depend on the host version; check the actual namespace before adding it to `features.code_mode.direct_only_tool_namespaces`.

For explicit control over the server name & timeout, use a direct MCP entry instead of the plugin. Build first, then add this to your Codex configuration, replacing the absolute path.

```toml
[mcp_servers.claude_worker]
command = "node"
args = ["/absolute/path/farcall-mcp/dist/cli.mjs", "claude"]
startup_timeout_sec = 20
tool_timeout_sec = 7200

[features.code_mode]
direct_only_tool_namespaces = ["mcp__claude_worker", "claude_worker"]
```

Merge these values with your existing configuration. Do not register the same server twice. This package does not edit your host settings.

```text
Use the Claude worker to implement this feature with claude-opus-5-5 at high
effort. Follow the repository's architecture and design system. Give Claude
ownership of implementation and verification, then independently review the
returned changes. Save the prompt under artifacts/. Call the worker directly
and wait for completion. Resume the same session for corrections.
```

## Verify waiting before spending tokens

Call `preflight` directly from the parent agent with the following arguments. Use an existing checkout & a new ID each time.

```json
{
  "cwd": "/absolute/path/project",
  "delegation_id": "wait-check-001",
  "duration_seconds": 150,
  "timeout_seconds": 180
}
```

This waits on a local process without calling a model. The host should remain in one pending tool call. Check its response trace for extra model turns, status checks, or Code Mode yields. The MCP server cannot observe parent inference or prevent a host from timing out. A successful preflight proves transport waiting only.

## Run & resume

Save the task in `artifacts/task.md`. An implementation call to `claude_worker.run` can look like this.

```json
{
  "cwd": "/absolute/path/project",
  "delegation_id": "feature-001",
  "prompt_file": "/absolute/path/project/artifacts/task.md",
  "model": "claude-opus-5-5",
  "effort": "high",
  "permission_mode": "acceptEdits",
  "allowed_tools": ["Bash(pnpm test *)", "Bash(pnpm build *)"],
  "timeout_seconds": 3600
}
```

Choose allowed tools for the actual task. The default permission mode does not approve shell commands automatically. `acceptEdits` allows file edits; shell operations still need existing CLI permissions or explicit allowed tool patterns. Chrome is opt-in through `chrome: true` & needs a working Claude Chrome setup.

For `codex_worker.run`, use the same common fields, any model your Codex CLI supports (for example `gpt-6-astra`), & `sandbox: "read-only"` for reviews or `"workspace-write"` for implementation. Omit Claude-specific fields. Codex runs with approval requests disabled, so disallowed operations fail instead of waiting for input. No bypass mode is exposed.

For a correction, save a new prompt & use a new delegation ID. Include the exact returned `session_id` as `resume_session_id` & the previous `delegation_id` as `resume_delegation_id`. Both must belong to the same provider & checkout. There is no implicit “latest session” option.

`completed` means the CLI returned a successful native result, not that every requested action happened. The response includes `permission_denials`, their count, & `result_truncated` when the 24,000-character preview was shortened. Read `native-result.json` for the full result.

An identical request with the same ID returns the saved result. A changed request with that ID fails. A crash leaves evidence to inspect rather than silently starting paid work again.

## Evidence & limits

Each call writes under `artifacts/farcall/<delegation_id>/`.

- `request.json` & `prompt.txt` preserve the requested settings & exact task.
- `events.jsonl`, `stderr.log` & `lifecycle.jsonl` preserve the CLI output & process timing.
- `native-result.json` preserves the provider's final event.
- `completion.json` records the outcome, session, available usage & evidence path.

Codex exec does not provide a verified model ID or price in its standard JSONL result. Those fields remain unknown. Claude's init-reported model is checked against the requested identifier; this does not detect later provider fallbacks. Native usage is kept as reported; resumed totals may be cumulative. A missing cost is not zero.

A shared lock at the nearest Git root prevents these two workers from starting overlapping jobs, including calls from different subdirectories. Linked Git worktrees have separate locks. Outside Git, the lock covers only the supplied `cwd`. It cannot stop another editor or unrelated process from changing files. Use separate checkouts for parallel implementation. On cancellation or timeout, the server terminates the child's process group. A child that deliberately detaches into another group is outside that cleanup boundary. It cannot keep the call open indefinitely. After the CLI exits, output drains for at most one second; forced pipe closure is reported as `stdout_truncated`. After a hard server crash, inspect the lock & processes before removing `artifacts/farcall/.active`.

Prompts & tool output can contain private data. Add `artifacts/` to the target project's ignore rules. These files are local evidence, not material to publish. This is a trusted local CLI bridge, not an isolation boundary for untrusted agents.

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack
```

Oxlint checks the handwritten source. Prettier keeps it readable. Tests use deterministic provider fixtures & real MCP stdio connections, including detached copies of both plugin bundles. They do not spend model tokens.

`src/` is the source of truth. `pnpm build` regenerates `dist/` & the two plugin servers. Commit generated bundles with a release so marketplace installation works without a build step. See [architecture](docs/architecture.md), [verification](docs/verification.md) & [release steps](docs/releasing.md).
