# Verification

## What was checked locally

On 28 September 2026, Node 24.19.0 on macOS passed the deterministic tests, Oxlint with zero warnings, formatting, the local Codex scaffold validator on both plugins & both Claude plugin validators. That initial check used the external Codex plugin-creator scaffold validator, which is not part of this repository; it is not a native host installation test. The CLI argument shapes were checked against Claude Code 2.1.283 & Codex CLI 0.157.0 without invoking a model.

A real MCP stdio client held one `preflight` call open for 150 seconds for each provider. Both completed successfully. The calls ran against the bundled plugin servers; no model was involved. Local raw records are under `artifacts/preflight-2026-09-28T16-30-42.497Z/` in the build checkout. They are excluded from the public repository.

The npm tarball installed offline into a temporary directory with no existing dependencies. Its installed command started both MCP servers & completed their preflights. Plugin bundles also ran after being copied outside the source checkout.

The suite covers native success & failure, missing final results, oversized events, a missing CLI executable, cancellation, timeout, process-group cleanup, cross-provider checkout locking, duplicate requests, changed retries, prompt containment & exact-session resume.

## Fixes after independent review

The initial 24-test suite missed inherited output pipes, stdin EOF & overlapping subdirectory jobs. The first expanded suite passed 37 tests. These cases now have deterministic regressions, including detached pipe holders during success, timeout & cancellation. Git-root locking records the requested working directory separately from the lock scope. Permission denials & shortened result previews are explicit in the completion.

The optional-trace update passes 42 tests. Both providers accept inline prompts through detached MCP bundles. Tests verify that default runs omit raw logs & prompt copies while preserving cached retries, changed-request rejection & exact-session resume. Traced runs retain their evidence. Longer answers remain available when the preview is truncated, and failed processes return a bounded stderr diagnostic without tracing.

The stderr follow-up brings the suite to 45 passing tests. Its regressions cover UTF-8 characters split across chunks, stderr arriving after the worker exits & a detached child holding only stderr open. Both captured pipes share the bounded drain window; truncation is reported separately for each.

The Codex marketplace is now `farcall`. The build takes all versions from `package.json` & inserts the Node 24 guard before bundled initialization. CI runs the offline package smoke test. Claude's documented inline-MCP override is retained, with a test requiring identical keys so the Codex declaration cannot accidentally launch in Claude.

## Non-Git directories

Version 0.1.2 adds `allow_non_git`, a Codex-only boolean that defaults to false.
Deterministic tests exercise the bundled plugin and CLI with a fixture executable:
omitted/false values preserve the directory check, while true forwards the flag
for start and exact-session resume in both supported sandboxes. They also check
cached retries, changed-request rejection, unchanged project configuration and
the absence of an initialized Git repository. These fixture checks do not invoke
a model or prove a real provider task completes.

A separate local check used Codex CLI 0.157.0 in a temporary non-Git directory
with an HTTP stub bound to loopback and invocation-only provider overrides.
Without the option, Codex failed at the Git check before reaching the stub.
With it, Codex reached the stub, which deliberately rejected the request.
No Git directory was created and no paid model was invoked. This proves the
native directory gate is passed, not that a real review completes.

## Schema compatibility

Version 0.1.1 fixes the shared model-name regex advertised by both workers.
The original pattern was accepted by JavaScript but rejected by jsonschema-rs
0.58.2 as an invalid regex. Escaping literal character-class punctuation keeps
the allowed model names unchanged. Four regressions inspect `tools/list` from
both plugin bundles and both CLI modes, compile the model pattern with Unicode
sets syntax, and check accepted and rejected identifiers against the runtime
contract. They fail on 0.1.0. The corrected schemas also pass the independent
Rust validator; this does not establish Anthropic API acceptance.

## What still needs host acceptance

Version 0.1.3's delegation instructions carry existing task authorization, exact source
scope and data exclusions in the worker prompt, instead of adding a routine
consent round or preflight. Host rejections still apply. This is a prompt/skill
change, not an enforced filesystem filter. Deterministic tests and skill
validation cannot establish whether a host's approval model will accept the
bounded call; that behavior still needs a real host trace. No paid model jobs
were run to validate this instruction change.

These checks do not measure a parent model's inference or cost. Before using this package for a comparative run, test the actual parent host with `preflight`, then a small real task & a correction using the returned session. Use `trace: true` to retain worker events. Record the parent's response trace & CLI versions separately.

The new package has not been used for a paid Claude → Codex or Codex → Claude run. The earlier benchmark used the previous Claude worker. Neither its model results nor its host behavior are automatically transferred to this implementation. Linux has a CI job but has not been exercised in this local macOS session. Windows is unsupported.

## Repeat the checks

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:pack
pnpm test:long 150
claude plugin validate --strict plugins/claude-worker
claude plugin validate --strict plugins/codex-worker
claude plugin validate --strict .claude-plugin/marketplace.json
```

The long preflight saves a timestamped summary & raw lifecycle records under ignored `artifacts/`. All test jobs use deterministic local children.

## Host settings matter

Claude Code currently backgrounds a pending MCP call after two minutes by default. Set `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=0` in the parent to keep it pending. Each Claude plugin declaration sets `timeout` to 7200000 milliseconds, which also raises that server's idle timeout floor. These settings are documented in the [Claude Code environment reference](https://code.claude.com/docs/en/env-vars).

Codex plugins use a relative `cwd` rooted at the installed plugin & a `tool_timeout_sec` of 7200. The direct-only Code Mode namespace setting belongs to the parent configuration. Keep the actual exposed namespace outside Code Mode, then verify it with the parent trace. Native plugin config & Agent Plugins v1 config are different formats; these packages use native `.codex-plugin` manifests.

The CLI/API boundaries were checked against the local Codex source at `88235f881d`, including `codex-rs/exec/src/exec_events.rs`, `codex-rs/codex-mcp/src/plugin_config.rs` & `codex-rs/core/src/config/config_tests.rs`. Claude packaging follows the [plugin reference](https://code.claude.com/docs/en/plugins-reference). Source inspection verifies argument & config assumptions; it does not replace the host acceptance above.
