# Verification

## Explicit full access (0.1.7)

On 1 October 2026, a model-free macOS check used Codex CLI 0.159.2's sandbox
command with the adapter's generated options and Playwright 1.63.0. Chromium
failed under workspace-write with a Mach bootstrap permission denial. With
explicit full access, Chromium 153.0.8010.12 launched, loaded a local fixture,
clicked a button, verified the resulting value, saved a screenshot and closed.
Evidence is local under `artifacts/full-access/`. This does not establish that a
model discovers browser tools or that desktop Browser Use is configured.

Deterministic MCP regressions cover explicit selection, unchanged read-only
defaults, no automatic escalation after failure, exact-session permission changes,
mixed-mode batches, overlapping coordination roots and cached/changed retries.
Emitted schemas expose the native mode on both Codex entrypoints.
All 107 tests, lint, formatting, bundle generation, offline package smoke tests
and strict validation of all 12 emitted MCP schemas passed locally.

## Explicit Codex permissions (0.1.6)

On 1 October 2026, the local macOS check passed all 104 deterministic tests,
lint, formatting and bundle generation. Both offline npm entrypoints completed
their MCP preflights; both plugin manifests and the marketplace passed strict
validation. All 12 emitted tool schemas passed Draft 2020-12 meta-schema checking
and compilation with `jsonschema-rs` 0.58.2.

New regressions cover optional permission overrides, explicit false/empty values,
invalid roots, symlink and Git aliases, overlapping extra directories, concurrent
admission from separate servers, cross-provider conflicts, exact-session resume,
changed retry rejection and cleanup after cancellation, shutdown or timeout.

A separate model-free check used the real Codex CLI 0.159.2 sandbox with the
adapter's generated configuration arguments. Writes succeeded in the working
directory and two explicitly added directories. An unrelated directory and Git
metadata remained protected. A local HTTP fixture was unreachable with
`network_access: false` and reachable with `true`. This establishes local TCP
and filesystem behavior on macOS, not external connectivity, browser startup,
Linux sandbox behavior or a real model task. Evidence is local under
`artifacts/sandbox-diagnosis/`; no benchmark inputs or active installations changed.

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

The current delegation guidance passes the user's task and requested result,
preserving explicit constraints and adding only essential context unavailable
to the worker. It replaces the earlier 0.1.3 guidance that asked parents to add
source scope and data exclusions. Host and CLI permissions still apply; prompt
text is not an enforced filesystem filter. Deterministic tests and skill
validation do not prove that a parent follows this guidance or a worker applies
project skills. Those behaviors still need real host traces.

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

Codex plugins use a relative `cwd` rooted at the installed plugin & a `tool_timeout_sec` of 7200. They also set `omit_tools_from` to `code_mode` & `deferred`, so Codex 0.157.0 or newer exposes the worker as a direct tool without parent configuration. Verify the direct call with the parent trace. Native plugin config & Agent Plugins v1 config are different formats; these packages use native `.codex-plugin` manifests.

The CLI/API boundaries were checked against the local Codex source at `88235f881d`, including `codex-rs/exec/src/exec_events.rs`, `codex-rs/codex-mcp/src/plugin_config.rs` & `codex-rs/core/src/config/config_tests.rs`. Claude packaging follows the [plugin reference](https://code.claude.com/docs/en/plugins-reference). Source inspection verifies argument & config assumptions; it does not replace the host acceptance above.

## Parallel batch verification (0.1.5)

The deterministic batch suite uses real MCP stdio connections to both plugin
bundles copied outside the repository. It checks five simultaneous processes by
comparing `worker_started` and `finished` lifecycle events, one ordered terminal
response, sibling independence after failure/timeout, cancellation, shutdown/EOF,
all-or-nothing admission, symlink/checkout isolation, shared single-run locks,
active/completed/interrupted retries, exact-session corrections, trace privacy and
aggregate result bounds. Hard-interruption tests never redispatch a worker.
Fixtures also cover Git worktrees and symlinked Git metadata. No paid models are
invoked, and no benchmark or active installation is changed.

Run `pnpm check` for lint, formatting, generated bundles and the full test suite. For the
isolated offline npm package check, run:

```sh
pnpm pack --pack-destination artifacts/run-batch/package
node scripts/pack-smoke.mjs artifacts/run-batch/package/farcall-mcp-0.1.5.tgz
```

The 12 emitted tool schemas (three tools, two providers, plugin and CLI entrypoints)
were also checked against the Draft 2020-12 meta-schema and compiled with the
Rust-backed `jsonschema-rs` 0.58.2 validator. The checked schema snapshot is local
under `artifacts/run-batch/schemas.json`. Automated schema tests preserve provider
contract parity and portable regexes. These checks establish server behavior, not
host scheduling or model adherence to a task. Model-assisted host acceptance and
installation remain separate from the deterministic suite.

An isolated Claude Code 2.1.284 acceptance run used Opus 5.5 high as the parent
and five deterministic Codex fixtures. The unchanged worker skill selected one
`run_batch` call. The parent trace showed a 150.615-second completion wait with
no intervening assistant messages or status calls; all five processes overlapped
for 150.510 seconds and returned completed results. Worker processes exited and
checkout locks were released. This used print mode with auto-backgrounding
disabled. It does not establish interactive-host behavior or real Codex model
execution. Raw session evidence remains local and is not shipped.
