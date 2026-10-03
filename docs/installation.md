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
Use Codex worker with this task: "Review my current changes for bugs."
Give me concrete findings with file references back.
```

## Install in Codex

Register this repository's Codex marketplace & install the Claude worker. From a local clone, pass its absolute path instead.

```sh
codex plugin marketplace add regenrek/farcall-mcp
codex plugin add claude-worker@farcall
```

Start a new Codex session, then invoke `$claude-worker` with your task. The plugin sets a two-hour tool timeout & keeps the worker tool outside Code Mode, so your Codex configuration stays unchanged. This requires Codex 0.147.0 or newer; older versions ignore the setting. If the tool does not appear at all, its server did not start. Codex must find Node 24 or newer as `node` on its PATH.

For explicit control over the server name & timeout, use a direct MCP entry instead of the plugin. Build first, then add this to your Codex configuration, replacing the absolute path.

```toml
[mcp_servers.claude_worker]
command = "node"
args = ["/absolute/path/farcall-mcp/dist/cli.mjs", "claude"]
startup_timeout_sec = 20
tool_timeout_sec = 7200
omit_tools_from = ["code_mode", "deferred"]
```

Merge these values with your existing configuration. Do not register the same server twice. This package does not edit your host settings.

```text
Use Claude worker with this task: "Add CSV export to the reports page and run the tests."
Give me the changes and test results back.
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
