# Installation & host setup

Node 24+, macOS or Linux, and an installed, signed-in worker CLI are required. Codex tasks need a Git working tree by default. For an authorized task in a plain directory, set `allow_non_git: true` on the worker call (and on resume). This passes `--skip-git-repo-check` for that invocation without initializing Git or changing user configuration; the selected sandbox still applies.

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
Keep it read-only. Pass the review as the prompt argument and call the MCP tool once. Wait for its result without checking status. Return concrete findings with
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
returned changes. Pass the task in the prompt argument. Call the worker directly
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
